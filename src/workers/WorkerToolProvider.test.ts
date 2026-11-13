import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../types/core.js';
import type { AgentJob } from '../types/jobs.js';
import { WorkerToolProvider } from './WorkerToolProvider.js';

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-1',
    conversationType: '1',
    messageId: 'mid-1',
    senderStaffId: 'staff-1',
    senderNick: 'Alice',
    deadlineAt: Date.now() + 60_000,
    now: Date.now,
    ...overrides,
  };
}

function fakeJob(id = 'job-1234567890'): AgentJob {
  const now = Date.now();
  return {
    id,
    conversationId: 'cid-1',
    conversationType: '1',
    messageId: 'worker_mid',
    senderStaffId: 'staff-1',
    senderNick: 'Alice',
    kind: 'worker',
    prompt: 'check logs',
    status: 'queued',
    result: null,
    error: null,
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    leaseOwner: null,
    leaseExpiresAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

describe('WorkerToolProvider', () => {
  it('hides dispatch_worker inside worker or proactive contexts', async () => {
    const provider = new WorkerToolProvider({
      jobStore: { enqueue: vi.fn() },
    });

    expect(await provider.getTools(ctx())).toHaveLength(1);
    expect(await provider.getTools(ctx({ worker: 'research' }))).toHaveLength(0);
    expect(await provider.getTools(ctx({ proactive: true }))).toHaveLength(0);
  });

  it('enqueues background job by default or for ops worker', async () => {
    const enqueue = vi.fn(async () => fakeJob('job-abcdef123456'));
    const runInline = vi.fn();
    const provider = new WorkerToolProvider({
      jobStore: { enqueue },
      runInline,
    });

    const [tool] = await provider.getTools(ctx());
    const out = await tool!.executeStructured!(
      { worker: 'ops', task: '重启 staging 服务', background: false },
      ctx(),
    );

    // ops 默认非只读，拒绝 inline 直接落后台队列
    expect(runInline).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'worker',
        prompt: '重启 staging 服务',
        metadata: expect.objectContaining({
          source: 'dispatch_worker',
          worker: 'ops',
        }),
      }),
    );
    expect(out.text).toContain('job-abcd');
  });

  it('runs research/report worker inline when background=false and returns traces', async () => {
    const enqueue = vi.fn();
    const runInline = vi.fn(async () => ({
      answer: '发现 2 个关键错误。',
      usage: {
        totalTokens: 320,
        inputTokens: 220,
        outputTokens: 100,
        steps: 3,
        durationMs: 420,
      },
    }));
    const provider = new WorkerToolProvider({
      jobStore: { enqueue },
      runInline,
    });

    const [tool] = await provider.getTools(ctx());
    const out = await tool!.executeStructured!(
      { worker: 'research', task: '检索认证超时根因', background: false },
      ctx(),
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(runInline).toHaveBeenCalledWith(
      'research',
      '检索认证超时根因',
      expect.objectContaining({ conversationId: 'cid-1' }),
    );
    expect(out.text).toContain('[Worker:research 同步执行结果]');
    expect(out.usage?.totalTokens).toBe(320);
    expect(out.traces).toEqual([
      {
        kind: 'subagent',
        name: 'worker:research',
        steps: 3,
        tokens: 320,
        durationMs: 420,
      },
    ]);
  });

  it('guards against unknown worker or empty task', async () => {
    const provider = new WorkerToolProvider({
      jobStore: { enqueue: vi.fn() },
    });
    const [tool] = await provider.getTools(ctx());

    const invalidWorker = await tool!.execute(
      { worker: 'hacker', task: 'test' },
      ctx(),
    );
    expect(invalidWorker).toContain('不支持的 worker 类型');

    const emptyTask = await tool!.execute(
      { worker: 'report', task: '   ' },
      ctx(),
    );
    expect(emptyTask).toContain('非空的 task 描述');
  });
});
