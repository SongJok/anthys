import { describe, expect, it } from 'vitest';
import { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';
import {
  findMentionOnlyContext,
  MENTION_ONLY_MERGE_WINDOW_MS,
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
