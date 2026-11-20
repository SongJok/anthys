import { describe, expect, it } from 'vitest';
import {
  collectContentStream,
  reportBackgroundUsage,
  type BackgroundUsageRecord,
} from './backgroundUsage.js';
import type { ChatStreamChunk } from '../types/core.js';

async function* stream(
  chunks: ChatStreamChunk[],
): AsyncIterable<ChatStreamChunk> {
  for (const chunk of chunks) yield chunk;
}

const baseRecord: BackgroundUsageRecord = {
  worker: 'triage',
  model: 'm',
  conversationId: 'c',
  conversationType: '2',
  senderStaffId: 's',
  senderNick: 'n',
  totalTokens: 10,
  durationMs: 5,
};

describe('collectContentStream', () => {
  it('累积正文并取最后一次 usage 上报', async () => {
    const result = await collectContentStream(
      stream([
        { contentDelta: 'a' },
        { usage: { totalTokens: 5 } },
        { contentDelta: 'b' },
        { usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } },
      ]),
    );
    expect(result.content).toBe('ab');
    expect(result.usage).toEqual({
      totalTokens: 12,
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it('无 usage 时返回 undefined，时长按 now 差值计算', async () => {
    let clock = 1_000;
    const result = await collectContentStream(
      stream([{ contentDelta: 'x' }]),
      () => {
        const value = clock;
        clock += 40;
        return value;
      },
    );
    expect(result.content).toBe('x');
    expect(result.usage).toBeUndefined();
    expect(result.durationMs).toBe(40);
  });
});

describe('reportBackgroundUsage', () => {
  it('totalTokens<=0 或无 recorder 时跳过', async () => {
    const calls: unknown[] = [];
    await reportBackgroundUsage((r) => {
      calls.push(r);
    }, { ...baseRecord, totalTokens: 0 });
    await reportBackgroundUsage(undefined, baseRecord);
    expect(calls).toHaveLength(0);
  });

  it('正常转发记录', async () => {
    const calls: BackgroundUsageRecord[] = [];
    await reportBackgroundUsage((r) => {
      calls.push(r);
    }, baseRecord);
    expect(calls).toEqual([baseRecord]);
  });

  it('吞掉同步抛出与异步拒绝，不向上冒泡', async () => {
    await expect(
      reportBackgroundUsage(() => {
        throw new Error('sync');
      }, baseRecord),
    ).resolves.toBeUndefined();
    await expect(
      reportBackgroundUsage(async () => {
        throw new Error('async');
      }, baseRecord),
    ).resolves.toBeUndefined();
  });
});