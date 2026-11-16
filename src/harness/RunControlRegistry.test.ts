import { describe, expect, it } from 'vitest';
import { RunControlRegistry } from './RunControlRegistry.js';
import type { InboundMessage } from '../types/core.js';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '你好',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RunControlRegistry', () => {
  it('同一会话的新消息排队，不打断进行中的回答', async () => {
    const registry = new RunControlRegistry();
    const first = registry.begin(message({ messageId: 'm1' }));
    expect(first.queuedAhead).toBe(0);
    await first.started;

    const second = registry.begin(message({ messageId: 'm2' }));
    expect(second.queuedAhead).toBe(1);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);

    let secondStarted = false;
    void second.started.then(() => {
      secondStarted = true;
    });
    await flush();
    expect(secondStarted).toBe(false);
    expect(registry.activeCount()).toBe(1);
    expect(registry.pendingCount()).toBe(1);
  });

  it('前一条结束后下一条按顺序开始', async () => {
    const registry = new RunControlRegistry();
    const first = registry.begin(message({ messageId: 'm1' }));
    const second = registry.begin(message({ messageId: 'm2' }));
    const third = registry.begin(message({ messageId: 'm3' }));
    expect(second.queuedAhead).toBe(1);
    expect(third.queuedAhead).toBe(2);

    first.finish();
    await second.started;
    expect(second.signal.aborted).toBe(false);
    expect(registry.activeRuns().map((run) => run.messageId)).toEqual(['m2']);
    expect(registry.pendingCount()).toBe(1);

    second.finish();
    await third.started;
    third.finish();
    expect(registry.isBusy('cid-1')).toBe(false);
  });

  it('不同会话并行，不互相排队', async () => {
    const registry = new RunControlRegistry();
    const a = registry.begin(message({ conversationId: 'a' }));
    const b = registry.begin(message({ conversationId: 'b' }));
    expect(a.queuedAhead).toBe(0);
    expect(b.queuedAhead).toBe(0);
    expect(registry.activeCount()).toBe(2);
    expect(registry.pendingCount()).toBe(0);
  });

  it('/stop 中止当前回答并清空排队', async () => {
    const registry = new RunControlRegistry();
    const first = registry.begin(message({ messageId: 'm1' }));
    const second = registry.begin(message({ messageId: 'm2' }));
    expect(registry.stop('cid-1')).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    await second.started;
    expect(registry.stop('cid-1')).toBe(0);
    expect(registry.isBusy('cid-1')).toBe(false);
  });

  it('finish 幂等，且不会误删后续运行', async () => {
    const registry = new RunControlRegistry();
    const first = registry.begin(message({ messageId: 'm1' }));
    const second = registry.begin(message({ messageId: 'm2' }));
    first.finish();
    first.finish();
    await second.started;
    expect(registry.isBusy('cid-1')).toBe(true);
    expect(second.signal.aborted).toBe(false);
    second.finish();
    expect(registry.isBusy('cid-1')).toBe(false);
  });

  it('记录最后一条消息供 /retry 使用，并按上限淘汰', () => {
    const registry = new RunControlRegistry(Date.now, { lastMessageLimit: 2 });
    registry.remember(message({ conversationId: 'a', text: 'A' }));
    registry.remember(message({ conversationId: 'b', text: 'B' }));
    registry.remember(message({ conversationId: 'c', text: 'C' }));
    expect(registry.lastMessage('a')).toBeNull();
    expect(registry.lastMessage('c')?.text).toBe('C');
  });

  it('stopAll 用于进程退出，连排队任务一起中止', async () => {
    const registry = new RunControlRegistry();
    const a = registry.begin(message({ conversationId: 'a' }));
    const b = registry.begin(message({ conversationId: 'b' }));
    const queued = registry.begin(message({ conversationId: 'a', messageId: 'a2' }));
    expect(registry.stopAll()).toBe(3);
    expect(a.signal.aborted && b.signal.aborted && queued.signal.aborted).toBe(
      true,
    );
    expect(registry.activeCount()).toBe(0);
    expect(registry.pendingCount()).toBe(0);
  });

  it('supports pushSteering and consumes queued instructions once', async () => {
    const registry = new RunControlRegistry();
    expect(registry.pushSteering('cid-1', 'no active run')).toBe(false);

    const run = registry.begin(message({ conversationId: 'cid-1' }));
    await run.started;

    expect(registry.pushSteering('cid-1', '请改用表格输出')).toBe(true);
    expect(registry.pushSteering('cid-1', '只看近 7 天')).toBe(true);
    expect(registry.consumeSteering('cid-1')).toEqual([
      '请改用表格输出',
      '只看近 7 天',
    ]);
    expect(registry.consumeSteering('cid-1')).toEqual([]);

    // stop cleans up remaining steering queue
    registry.pushSteering('cid-1', 'pending note');
    registry.stop('cid-1');
    expect(registry.consumeSteering('cid-1')).toEqual([]);
  });
});

describe('RunControlRegistry 全局并发上限', () => {
  function capped(limit: number): RunControlRegistry {
    return new RunControlRegistry(Date.now, { maxActiveRuns: limit });
  }

  it('槽位满时新会话只等待，不开始执行', async () => {
    const registry = capped(2);
    const a = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    const c = registry.begin(message({ conversationId: 'c', messageId: 'c1' }));
    await a.started;
    await b.started;

    expect(a.waitForSlot).toBe(false);
    expect(b.waitForSlot).toBe(false);
    expect(c.waitForSlot).toBe(true);
    expect(c.queuedAhead).toBe(0);

    let cStarted = false;
    void c.started.then(() => {
      cStarted = true;
    });
    await flush();
    expect(cStarted).toBe(false);
    expect(registry.activeCount()).toBe(2);
    expect(registry.slotWaiterCount()).toBe(1);
    expect(registry.pendingCount()).toBe(1);
    expect(registry.concurrencyLimit()).toBe(2);
    expect(registry.activeRuns().map((run) => run.messageId)).toEqual([
      'a1',
      'b1',
    ]);
  });

  it('槽位释放后按到达顺序唤醒等待者', async () => {
    const registry = capped(1);
    const a = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    const c = registry.begin(message({ conversationId: 'c', messageId: 'c1' }));
    await a.started;

    a.finish();
    await b.started;
    expect(b.signal.aborted).toBe(false);
    expect(registry.activeCount()).toBe(1);
    expect(registry.slotWaiterCount()).toBe(1);

    b.finish();
    await c.started;
    expect(registry.activeCount()).toBe(1);
    expect(registry.slotWaiterCount()).toBe(0);
    c.finish();
    expect(registry.activeCount()).toBe(0);
    expect(registry.pendingCount()).toBe(0);
  });

  it('同一会话持续排队不会插队饿死其他会话', async () => {
    const registry = capped(1);
    const a1 = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b1 = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    const a2 = registry.begin(message({ conversationId: 'a', messageId: 'a2' }));
    await a1.started;
    expect(a2.queuedAhead).toBe(1);
    expect(a2.waitForSlot).toBe(false);

    a1.finish();
    // a2 排到全局等待队尾，先到的 b1 拿到槽位
    await b1.started;
    let a2Started = false;
    void a2.started.then(() => {
      a2Started = true;
    });
    await flush();
    expect(a2Started).toBe(false);

    b1.finish();
    await a2.started;
    expect(a2.signal.aborted).toBe(false);
    a2.finish();
    expect(registry.activeCount()).toBe(0);
  });

  it('/stop 等待中的会话不占用槽位，也不影响其他会话', async () => {
    const registry = capped(1);
    const a = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    await a.started;
    expect(registry.stop('b')).toBe(1);
    expect(b.signal.aborted).toBe(true);
    await b.started;
    expect(registry.slotWaiterCount()).toBe(0);
    expect(registry.activeCount()).toBe(1);

    a.finish();
    expect(registry.activeCount()).toBe(0);
    const c = registry.begin(message({ conversationId: 'c', messageId: 'c1' }));
    expect(c.waitForSlot).toBe(false);
    await c.started;
    c.finish();
  });

  it('/stop 正在执行的会话会立即把槽位让给等待者', async () => {
    const registry = capped(1);
    const a = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    await a.started;
    expect(registry.stop('a')).toBe(1);
    await b.started;
    expect(b.signal.aborted).toBe(false);
    expect(registry.activeCount()).toBe(1);
    b.finish();
    expect(registry.activeCount()).toBe(0);
  });

  it('finish 幂等，重复释放不会把在途计数减成负数', async () => {
    const registry = capped(1);
    const a = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    await a.started;
    a.finish();
    a.finish();
    await b.started;
    expect(registry.activeCount()).toBe(1);
    b.finish();
    b.finish();
    expect(registry.activeCount()).toBe(0);
    expect(registry.slotWaiterCount()).toBe(0);
  });

  it('stopAll 同时清空在途与等待槽位的任务', async () => {
    const registry = capped(1);
    const a = registry.begin(message({ conversationId: 'a', messageId: 'a1' }));
    const b = registry.begin(message({ conversationId: 'b', messageId: 'b1' }));
    const a2 = registry.begin(message({ conversationId: 'a', messageId: 'a2' }));
    await a.started;
    expect(registry.stopAll()).toBe(3);
    expect(a.signal.aborted && b.signal.aborted && a2.signal.aborted).toBe(true);
    expect(registry.activeCount()).toBe(0);
    expect(registry.pendingCount()).toBe(0);
    expect(registry.slotWaiterCount()).toBe(0);
  });

  it('上限为 0 时不限流，所有会话立即开始', async () => {
    const registry = capped(0);
    const runs = ['a', 'b', 'c', 'd'].map((conversationId) =>
      registry.begin(message({ conversationId })),
    );
    for (const run of runs) {
      expect(run.waitForSlot).toBe(false);
      await run.started;
    }
    expect(registry.activeCount()).toBe(4);
    expect(registry.slotWaiterCount()).toBe(0);
    expect(registry.concurrencyLimit()).toBe(0);
  });
});
