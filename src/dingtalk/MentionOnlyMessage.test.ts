import { describe, expect, it } from 'vitest';
import { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';
import {
  findMentionOnlyContext,
  MENTION_ONLY_CONTEXT_PROMPT,
  MENTION_ONLY_MERGE_WINDOW_MS,
  MENTION_ONLY_QUOTE_PROMPT,
  resolveMentionOnlyMessage,
} from './MentionOnlyMessage.js';

const BASE = 1_700_000_000_000;

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    conversationId: 'cid-1',
    messageId: 'm-question',
    senderStaffId: 'open-ding-1',
    senderNick: '大梅',
    text: '下个版本什么时候排档？',
    isAtBot: false,
    timestamp: BASE,
    ...overrides,
  };
}

function mentionOnly(
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    messageId: 'm-mention',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '大梅',
    isAtBot: true,
    text: '',
    mentionOnly: true,
    rawPayload: {},
    timestamp: BASE + 6_000,
    ...overrides,
  };
}

describe('findMentionOnlyContext', () => {
  it('ID 来源不同但昵称一致时合并窗口内的上一条消息', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry());

    expect(findMentionOnlyContext(mentionOnly(), buffer)).toEqual({
      messageId: 'm-question',
      text: '下个版本什么时候排档？',
      senderNick: '大梅',
    });
  });

  it('上一条消息以 @ 开头时只合并正文', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry({ text: '@小美 下个版本什么时候排档？' }));

    expect(findMentionOnlyContext(mentionOnly(), buffer)?.text).toBe(
      '下个版本什么时候排档？',
    );
  });

  it('忽略其他发言人', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry({ senderStaffId: 'other', senderNick: '大橘' }));

    expect(findMentionOnlyContext(mentionOnly(), buffer)).toBeNull();
  });

  it('忽略窗口之外的上一条消息', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(
      entry({ timestamp: BASE - MENTION_ONLY_MERGE_WINDOW_MS - 1 }),
    );

    expect(findMentionOnlyContext(mentionOnly(), buffer)).toBeNull();
  });

  it('忽略只有 @ 的上一条消息', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry({ text: '@小美 ' }));

    expect(findMentionOnlyContext(mentionOnly(), buffer)).toBeNull();
  });

  it('忽略上一条 @ 机器人的消息', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry({ isAtBot: true }));

    expect(findMentionOnlyContext(mentionOnly(), buffer)).toBeNull();
  });

  it('没有上文时返回 null', () => {
    const buffer = new GroupTranscriptBuffer();

    expect(findMentionOnlyContext(mentionOnly(), buffer)).toBeNull();
  });
});

describe('resolveMentionOnlyMessage', () => {
  it('引用消息优先于紧邻上文，交给模型围绕引用作答', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry());

    const resolved = resolveMentionOnlyMessage(
      mentionOnly({
        quotedMessage: {
          messageId: 'orig-9',
          senderNick: '李四',
          text: 'Error: ECONNRESET',
        },
      }),
      buffer,
    );

    expect(resolved?.source).toBe('quoted');
    expect(resolved?.message.text).toBe(MENTION_ONLY_QUOTE_PROMPT);
    expect(resolved?.message.mentionOnly).toBe(false);
    expect(resolved?.message.quotedMessage?.messageId).toBe('orig-9');
    expect(resolved?.message.mentionOnlySource).toBe('quoted');
  });

  it('只带引用 ID 没有引用正文时也按引用作答，正文留给后续回查', () => {
    const buffer = new GroupTranscriptBuffer();

    const resolved = resolveMentionOnlyMessage(
      mentionOnly({ quotedMessage: { messageId: 'orig-10' } }),
      buffer,
    );

    expect(resolved?.source).toBe('quoted');
    expect(resolved?.message.text).toBe(MENTION_ONLY_QUOTE_PROMPT);
  });

  it('没有引用时沿用同一发言人紧邻上一条消息', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry());

    const resolved = resolveMentionOnlyMessage(mentionOnly(), buffer);

    expect(resolved?.source).toBe('merged');
    expect(resolved?.mergedFromMessageId).toBe('m-question');
    expect(resolved?.message.text).toBe('下个版本什么时候排档？');
    expect(resolved?.message.mentionOnlySource).toBe('merged');
    expect(resolved?.message.rawPayload.mergedFromMessageId).toBe('m-question');
  });

  it('群聊没有紧邻上文但有其他成员发言时，交给模型结合旁听记录判断', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(
      entry({
        messageId: 'm-other',
        senderStaffId: 'other',
        senderNick: '大橘',
        text: '支付回调又超时了，帮忙看下？',
      }),
    );

    const resolved = resolveMentionOnlyMessage(mentionOnly(), buffer);

    expect(resolved?.source).toBe('transcript');
    expect(resolved?.message.text).toBe(MENTION_ONLY_CONTEXT_PROMPT);
    expect(resolved?.message.mentionOnly).toBe(false);
    expect(resolved?.message.mentionOnlySource).toBe('transcript');
  });

  it('群聊旁听记录只有空白消息时仍走静态兜底', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(entry({ messageId: 'm-empty', text: '   ' }));

    expect(resolveMentionOnlyMessage(mentionOnly(), buffer)).toBeNull();
  });

  it('群聊最近记录为空时返回 null，由调用方静态兜底', () => {
    const buffer = new GroupTranscriptBuffer();

    expect(resolveMentionOnlyMessage(mentionOnly(), buffer)).toBeNull();
  });

  it('单聊没有引用时用会话历史作答', () => {
    const buffer = new GroupTranscriptBuffer();

    const resolved = resolveMentionOnlyMessage(
      mentionOnly({ conversationType: '1' }),
      buffer,
    );

    expect(resolved?.source).toBe('history');
    expect(resolved?.message.text).toBe(MENTION_ONLY_CONTEXT_PROMPT);
  });
});
