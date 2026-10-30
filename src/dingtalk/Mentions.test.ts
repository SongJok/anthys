import { describe, expect, it } from 'vitest';
import { replyMention } from './Mentions.js';
import type { InboundMessage } from '../types/core.js';

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '你好',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

describe('replyMention', () => {
  it('群聊直接回复时以 @提问人 开头', () => {
    expect(replyMention(inbound())).toBe('@张三\n');
  });

  it('单聊不加 @', () => {
    expect(replyMention(inbound({ conversationType: '1' }))).toBe('');
  });

  it('群内主动回复与定时播报不加 @', () => {
    expect(replyMention(inbound(), true)).toBe('');
  });

  it('昵称为空时退回归一化后的 StaffId', () => {
    expect(replyMention(inbound({ senderNick: '  ' }))).toBe('@staff-1\n');
  });

  it('压平昵称中的换行，避免打乱 Markdown 结构', () => {
    expect(replyMention(inbound({ senderNick: '张\n  三' }))).toBe('@张 三\n');
  });
});
