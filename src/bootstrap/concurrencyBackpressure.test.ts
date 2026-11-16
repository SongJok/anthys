import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent, InboundMessage } from '../types/core.js';
import type { AgentJob, EnqueueAgentJobInput } from '../types/jobs.js';
import {
  divertTurnToBackground,
  shouldDivertForBackpressure,
  type ConcurrencyBackpressureDeps,
} from './concurrencyBackpressure.js';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '帮我查一下季度报表',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConcurrencyBackpressureDeps> = {}) {
  const enqueue = vi.fn(
    async (input: EnqueueAgentJobInput): Promise<AgentJob> =>
      ({ id: 'job-abcdef123456', ...input }) as AgentJob,
  );
  const info = vi.fn();
  const warn = vi.fn();
  const inc = vi.fn();
  const deps: ConcurrencyBackpressureDeps = {
    jobStore: { enqueue },
    concurrencyLimit: () => 10,
    activeRuns: () => 10,
    metrics: { inc },
    logger: { info, warn },
    ...overrides,
  };
  return { deps, enqueue, info, warn, inc };
}

function makeStreamer(finishError?: Error) {
  const events: AgentStreamEvent[] = [];
  const finish = vi.fn(async () => {
    if (finishError) throw finishError;
  });
  return {
    events,
    finish,
    handle: (event: AgentStreamEvent) => {
      events.push(event);
    },
  };
}

describe('shouldDivertForBackpressure', () => {
  it('仅在开关开启、等待全局槽位且无附件时转后台', () => {
    expect(
      shouldDivertForBackpressure({ waitForSlot: true }, message(), true),
    ).toBe(true);
    expect(
      shouldDivertForBackpressure({ waitForSlot: true }, message(), false),
    ).toBe(false);
    expect(
      shouldDivertForBackpressure({ waitForSlot: false }, message(), true),
    ).toBe(false);
  });

  it('带附件的消息不转后台，避免丢掉图片与文档解析结果', () => {
    const withAttachment = message({
      attachments: [{ type: 'image', downloadCode: 'code-1', fileName: 'a.png' }],
    });
    expect(
      shouldDivertForBackpressure({ waitForSlot: true }, withAttachment, true),
    ).toBe(false);
    expect(
      shouldDivertForBackpressure(
        { waitForSlot: true },
        message({ attachments: [] }),
        true,
      ),
    ).toBe(true);
  });
});

describe('divertTurnToBackground', () => {
  it('入队后台任务并告知任务 ID，随后收尾卡片', async () => {
    const { deps, enqueue, inc, info } = makeDeps();
    const streamer = makeStreamer();
    await divertTurnToBackground(message(), streamer, deps);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0]![0];
    expect(input).toMatchObject({
      conversationId: 'cid-1',
      conversationType: '2',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      kind: 'task',
      prompt: '帮我查一下季度报表',
    });
    expect(input.messageId).toMatch(/^backpressure_msg-1_\d+$/);
    expect(input.metadata).toMatchObject({
      source: 'backpressure',
      originalMessageId: 'msg-1',
    });

    expect(inc).toHaveBeenCalledWith('agent_backpressure_total');
    expect(info).toHaveBeenCalledTimes(1);
    expect(streamer.finish).toHaveBeenCalledTimes(1);
    expect(streamer.events).toHaveLength(1);
    const event = streamer.events[0]!;
    expect(event.type).toBe('answer_delta');
    if (event.type === 'answer_delta') {
      expect(event.content).toContain('job-abcd');
      expect(event.content).toContain('/job-status job-abcd');
      expect(event.content).toContain('同时最多 10 个回答');
    }
  });

  it('入队失败时向上抛出，不通知也不计数，交由调用方回退前台', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('数据库不可用');
    });
    const { deps, inc, info } = makeDeps({ jobStore: { enqueue } });
    const streamer = makeStreamer();
    await expect(
      divertTurnToBackground(message(), streamer, deps),
    ).rejects.toThrow('数据库不可用');
    expect(inc).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(streamer.events).toHaveLength(0);
    expect(streamer.finish).not.toHaveBeenCalled();
  });

  it('入队成功后通知失败只记日志，不抛出以免同一问题被执行两次', async () => {
    const { deps, enqueue, inc, warn } = makeDeps();
    const streamer = makeStreamer(new Error('卡片收尾失败'));
    await expect(
      divertTurnToBackground(message(), streamer, deps),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith('agent_backpressure_total');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toBe(
      'backpressure notice failed; job remains queued',
    );
  });
});