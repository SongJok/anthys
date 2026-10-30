import { describe, expect, it } from 'vitest';
import { GroupTranscriptBuffer } from './GroupTranscriptBuffer.js';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';

function entry(
  conversationId: string,
  messageId: string,
  text: string,
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    conversationId,
    messageId,
    senderStaffId: 'staff-a',
    senderNick: '王五',
    text,
    isAtBot: false,
    timestamp: Date.UTC(2026, 9, 30, 6, 5, 12),
    ...overrides,
  };
}

describe('GroupTranscriptBuffer', () => {
  it('按滑动窗口裁剪，只保留最近 N 条', () => {
    const buffer = new GroupTranscriptBuffer({ defaultWindowSize: 3 });
    for (let index = 1; index <= 5; index += 1) {
      buffer.append(entry('cid-1', `m${index}`, `消息 ${index}`));
    }

    expect(buffer.recent('cid-1').map((item) => item.messageId)).toEqual([
      'm3',
      'm4',
      'm5',
    ]);
  });

  it('多群并发写入互不串流且各自裁剪', async () => {
    const buffer = new GroupTranscriptBuffer({ defaultWindowSize: 2 });
    buffer.configure('cid-a', 2);
    buffer.configure('cid-b', 3);

    await Promise.all([
      Promise.all(
        [1, 2, 3, 4].map(async (index) => {
          buffer.append(
            entry('cid-a', `a-${index}`, `A 群消息 ${index}`, {
              senderStaffId: `a-${index}`,
            }),
          );
        }),
      ),
      Promise.all(
        [1, 2, 3, 4].map(async (index) => {
          buffer.append(
            entry('cid-b', `b-${index}`, `B 群消息 ${index}`, {
              senderStaffId: `b-${index}`,
            }),
          );
        }),
      ),
    ]);

    expect(buffer.recent('cid-a').map((item) => item.messageId)).toEqual([
      'a-3',
      'a-4',
    ]);
    expect(buffer.recent('cid-b').map((item) => item.messageId)).toEqual([
      'b-2',
      'b-3',
      'b-4',
    ]);
    expect(buffer.conversationCount).toBe(2);
  });

  it('同一 messageId 重复投递只保留一次', () => {
    const buffer = new GroupTranscriptBuffer();
    expect(buffer.append(entry('cid-1', 'm1', '第一次'))).toBe(true);
    expect(buffer.append(entry('cid-1', 'm1', '重投内容'))).toBe(false);

    const recent = buffer.recent('cid-1');
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe('重投内容');
  });

  it('格式化为带北京时间与发言人的记录，并可排除当前消息', () => {
    const buffer = new GroupTranscriptBuffer();
    buffer.append(
      entry('cid-1', 'm1', '订单接口怎么一直报 504 网关超时？', {
        senderNick: '王五',
        timestamp: Date.UTC(2026, 9, 30, 6, 5, 12),
      }),
    );
    buffer.append(
      entry('cid-1', 'm2', '我来看看\n先查网关日志', {
        senderNick: '李四',
        timestamp: Date.UTC(2026, 9, 30, 6, 6, 0),
      }),
    );

    expect(buffer.format('cid-1')).toBe(
      [
        '[14:05:12] 王五: 订单接口怎么一直报 504 网关超时？',
        '[14:06:00] 李四: 我来看看 / 先查网关日志',
      ].join('\n'),
    );
    expect(buffer.format('cid-1', { excludeMessageId: 'm1' })).toBe(
      '[14:06:00] 李四: 我来看看 / 先查网关日志',
    );
  });

  it('entriesSince 只返回防抢答窗口内其他成员的非 @ 消息', () => {
    const buffer = new GroupTranscriptBuffer();
    const base = Date.UTC(2026, 9, 30, 6, 0, 0);
    buffer.append(entry('cid-1', 'self', '报错了', { timestamp: base }));
    buffer.append(
      entry('cid-1', 'other', '我看下', {
        timestamp: base + 3_000,
        senderStaffId: 'staff-b',
      }),
    );
    buffer.append(
      entry('cid-1', 'bot', '机器人回复', {
        timestamp: base + 4_000,
        isAtBot: true,
      }),
    );

    const replies = buffer.entriesSince('cid-1', base, 'self');
    expect(replies.map((item) => item.messageId)).toEqual(['other']);
  });

  it('配置变小时立即裁剪，clear 后清空群上下文', () => {
    const buffer = new GroupTranscriptBuffer({ defaultWindowSize: 5 });
    for (let index = 1; index <= 4; index += 1) {
      buffer.append(entry('cid-1', `m${index}`, `消息 ${index}`));
    }
    buffer.configure('cid-1', 2);
    expect(buffer.recent('cid-1')).toHaveLength(2);

    buffer.clear('cid-1');
    expect(buffer.recent('cid-1')).toEqual([]);
    expect(buffer.conversationCount).toBe(0);
    expect(buffer.windowSize('cid-1')).toBe(5);
  });
});
