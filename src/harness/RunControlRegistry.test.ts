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
});
