import { describe, expect, it } from 'vitest';
import {
  parseStreamMessage,
  stripLeadingMentions,
} from './MessageParser.js';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    msgtype: 'text',
    createAt: 1_700_000_000_000,
    chatbotUserId: 'bot-1',
    text: { content: '@小钉 帮我算一下 1+1' },
    ...overrides,
  };
}

describe('parseStreamMessage', () => {
  it('单聊消息始终视为已 @ 机器人，并去掉开头 @ 前缀', () => {
    const message = parseStreamMessage(
      payload({ conversationType: '1', text: { content: '@小钉 你好' } }),
    );
    expect(message).not.toBeNull();
    expect(message).toMatchObject({
      messageId: 'msg-1',
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      isAtBot: true,
      text: '你好',
    });
  });

  it('群聊 isInAtList 为 true 时识别为 @ 机器人', () => {
    const message = parseStreamMessage(payload({ isInAtList: true }));
    expect(message?.isAtBot).toBe(true);
    expect(message?.text).toBe('帮我算一下 1+1');
  });

  it('群聊通过 atUsers 中的 chatbotUserId 识别 @', () => {
    const message = parseStreamMessage(
      payload({ atUsers: [{ dingtalkId: 'bot-1' }] }),
    );
    expect(message?.isAtBot).toBe(true);
  });

  it('群聊未 @ 机器人时 isAtBot 为 false', () => {
    const message = parseStreamMessage(
      payload({ atUsers: [{ dingtalkId: 'someone-else' }] }),
    );
    expect(message?.isAtBot).toBe(false);
  });

  it('非文本消息返回 null', () => {
    expect(parseStreamMessage(payload({ msgtype: 'picture' }))).toBeNull();
  });

  it('缺少必要字段时返回 null', () => {
    expect(parseStreamMessage(payload({ msgId: '' }))).toBeNull();
    expect(parseStreamMessage(payload({ senderStaffId: undefined }))).toBeNull();
    expect(parseStreamMessage(payload({ conversationId: null }))).toBeNull();
    expect(parseStreamMessage(null)).toBeNull();
    expect(parseStreamMessage('not-an-object')).toBeNull();
  });

  it('只有 @ 没有正文的消息返回 null', () => {
    expect(
      parseStreamMessage(payload({ text: { content: '@小钉   ' } })),
    ).toBeNull();
  });

  it('createAt 缺失时使用注入的时钟', () => {
    const message = parseStreamMessage(
      payload({ createAt: undefined }),
      () => 42,
    );
    expect(message?.timestamp).toBe(42);
  });

  it('stripLeadingMentions 只移除开头连续 @', () => {
    expect(stripLeadingMentions('@小钉 @助手 你好 @同事')).toBe('你好 @同事');
    expect(stripLeadingMentions('没有 @ 前缀')).toBe('没有 @ 前缀');
  });
});
