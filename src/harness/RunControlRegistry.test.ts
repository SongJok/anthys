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

describe('RunControlRegistry', () => {
  it('同一会话的新消息会中止上一条回答', () => {
    const registry = new RunControlRegistry();
    const first = registry.begin(message({ messageId: 'm1' }));
    expect(registry.isBusy('cid-1')).toBe(true);

    const second = registry.begin(message({ messageId: 'm2' }));
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.activeCount()).toBe(1);
  });

  it('/stop 中止当前会话并返回命中数量', () => {
    const registry = new RunControlRegistry();
    const run = registry.begin(message());
    expect(registry.stop('cid-1')).toBe(1);
    expect(run.signal.aborted).toBe(true);
    expect(registry.stop('cid-1')).toBe(0);
    expect(registry.isBusy('cid-1')).toBe(false);
  });

  it('finish 只清理自身，不误删后续运行', () => {
    const registry = new RunControlRegistry();
    const first = registry.begin(message({ messageId: 'm1' }));
    const second = registry.begin(message({ messageId: 'm2' }));
    first.finish();
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

  it('stopAll 用于进程退出', () => {
    const registry = new RunControlRegistry();
    const a = registry.begin(message({ conversationId: 'a' }));
    const b = registry.begin(message({ conversationId: 'b' }));
    expect(registry.stopAll()).toBe(2);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(registry.activeCount()).toBe(0);
  });
});
