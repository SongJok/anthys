import { describe, expect, it } from 'vitest';
import { JobPauseError, JobRunner } from './JobRunner.js';
import type {
  AgentJob,
  AgentJobEvent,
  AgentJobResult,
  AgentJobStore,
  ClaimJobInput,
  EnqueueAgentJobInput,
  ListJobsInput,
} from '../types/jobs.js';

class MemoryJobStore implements AgentJobStore {
  public readonly jobs = new Map<string, AgentJob>();
  public readonly events = new Map<string, AgentJobEvent[]>();
  private seq = 0;
  private counter = 0;

  async enqueue(input: EnqueueAgentJobInput): Promise<AgentJob> {
    this.counter += 1;
    const now = Date.now();
    const job: AgentJob = {
      id: `job-${this.counter}`,
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      messageId: input.messageId,
      senderStaffId: input.senderStaffId,
      senderNick: input.senderNick,
      kind: input.kind,
      status: 'queued',
      prompt: input.prompt,
      metadata: input.metadata ?? {},
      result: null,
      error: null,
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async claimNext(input: ClaimJobInput): Promise<AgentJob | null> {
    const job = [...this.jobs.values()].find((item) => item.status === 'queued');
    if (!job) return null;
    job.status = 'running';
    job.leaseOwner = input.owner;
    job.leaseExpiresAt = input.nowMs + input.leaseMs;
    job.attempts += 1;
    job.startedAt = input.nowMs;
    return { ...job };
  }

  async heartbeat(
    jobId: string,
    owner: string,
    nowMs: number,
    leaseMs: number,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner || job.status !== 'running') {
      return false;
    }
    job.leaseExpiresAt = nowMs + leaseMs;
    return true;
  }

  async complete(
    jobId: string,
    owner: string,
    result: AgentJobResult,
  ): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner || job.status !== 'running') {
      return null;
    }
    job.status = 'succeeded';
    job.result = result;
    job.finishedAt = Date.now();
    return { ...job };
  }

  async fail(
    jobId: string,
    owner: string,
    error: string,
    retryable = true,
  ): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner || job.status !== 'running') {
      return null;
    }
    job.error = error;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.status =
      retryable && job.attempts < job.maxAttempts ? 'queued' : 'failed';
    return { ...job };
  }

  async cancel(jobId: string): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (
      job.status === 'queued' ||
      job.status === 'running' ||
      job.status === 'paused'
    ) {
      job.status = 'cancelled';
      return { ...job };
    }
    return { ...job };
  }

  async pause(
    jobId: string,
    owner: string,
    reason: string,
  ): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner || job.status !== 'running') {
      return null;
    }
    job.status = 'paused';
    job.error = reason;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.finishedAt = Date.now();
    return { ...job };
  }

  async resume(
    jobId: string,
    patch: { prompt?: string } = {},
  ): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'paused') return null;
    job.status = 'queued';
    if (patch.prompt) job.prompt = patch.prompt;
    job.error = null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.startedAt = null;
    job.finishedAt = null;
    return { ...job };
  }

  async get(jobId: string): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async list(input: ListJobsInput = {}): Promise<AgentJob[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          !input.conversationId || job.conversationId === input.conversationId,
      )
      .slice(0, input.limit ?? 20);
  }

  async appendEvent(input: {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.seq += 1;
    const list = this.events.get(input.jobId) ?? [];
    list.push({
      jobId: input.jobId,
      seq: this.seq,
      type: input.type,
      payload: input.payload,
      createdAt: Date.now(),
    });
    this.events.set(input.jobId, list);
  }

  async listEvents(jobId: string, limit = 50): Promise<AgentJobEvent[]> {
    return (this.events.get(jobId) ?? []).slice(-limit);
  }
}

const sampleInput: EnqueueAgentJobInput = {
  conversationId: 'cid-1',
  conversationType: '1',
  messageId: 'msg-1',
  senderStaffId: 'staff-1',
  senderNick: '张三',
  kind: 'task',
  prompt: '整理本周反馈',
};

const sampleResult: AgentJobResult = {
  answer: '已完成',
  reasoning: '',
  usage: { totalTokens: 10, steps: 1, durationMs: 5 },
};

describe('JobRunner', () => {
  it('领取任务后执行、回写结果并记录事件', async () => {
    const store = new MemoryJobStore();
    const job = await store.enqueue(sampleInput);
    let finished: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const events: string[] = [];
    const runner = new JobRunner({
      store,
      intervalMs: 1_000,
      now: () => 1_000,
      execute: async (_job, context) => {
        context.emit({
          type: 'tool_start',
          toolName: 'demo',
          args: {},
          stepId: 's1',
          turnId: 't1',
        });
        return sampleResult;
      },
      onCompleted: async () => {
        events.push('completed');
        finished?.();
      },
    });

    await runner.start();
    await done;

    const stored = await store.get(job.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.result?.answer).toBe('已完成');
    expect(events).toEqual(['completed']);
    const jobEvents = await store.listEvents(job.id);
    expect(jobEvents.map((event) => event.type)).toEqual([
      'started',
      'tool_start',
      'completed',
    ]);
    await runner.stop();
  });

  it('执行失败且达到重试上限时标记失败并回调', async () => {
    const store = new MemoryJobStore();
    const job = await store.enqueue({ ...sampleInput, maxAttempts: 1 });
    const failedJobs: AgentJob[] = [];
    let finished: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const runner = new JobRunner({
      store,
      intervalMs: 1_000,
      now: () => 1_000,
      execute: async () => {
        throw new Error('模型不可用');
      },
      onFailed: async (failed) => {
        failedJobs.push(failed);
        finished?.();
      },
    });

    await runner.start();
    await done;

    const stored = await store.get(job.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('模型不可用');
    expect(failedJobs[0]?.id).toBe(job.id);
    await runner.stop();
  });

  it('任务已被取消时不再覆盖完成状态', async () => {
    const store = new MemoryJobStore();
    const job = await store.enqueue(sampleInput);
    let cancelled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new JobRunner({
      store,
      intervalMs: 1_000,
      now: () => 1_000,
      execute: async () => {
        cancelled?.();
        await gate;
        return sampleResult;
      },
    });

    await runner.start();
    await started;
    await store.cancel(job.id);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = await store.get(job.id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.result).toBeNull();
    await runner.stop();
  });

  it('看门狗暂停后保留任务，resume 后重新执行', async () => {
    const store = new MemoryJobStore();
    const job = await store.enqueue(sampleInput);
    const pausedJobs: AgentJob[] = [];
    let paused: (() => void) | undefined;
    const pausedDone = new Promise<void>((resolve) => {
      paused = resolve;
    });
    let executions = 0;
    const runner = new JobRunner({
      store,
      intervalMs: 60_000,
      now: () => 1_000,
      execute: async () => {
        executions += 1;
        if (executions === 1) {
          throw new JobPauseError('预算使用率达到 95%', 'budget');
        }
        return sampleResult;
      },
      onPaused: async (pausedJob, reason) => {
        pausedJobs.push(pausedJob);
        expect(reason).toBe('预算使用率达到 95%');
        paused?.();
      },
    });

    await runner.start();
    await pausedDone;

    const stored = await store.get(job.id);
    expect(stored?.status).toBe('paused');
    expect(stored?.error).toBe('预算使用率达到 95%');
    expect(pausedJobs[0]?.id).toBe(job.id);
    expect(
      (await store.listEvents(job.id)).map((event) => event.type),
    ).toEqual(['started', 'paused']);

    const resumed = await store.resume(job.id, { prompt: '只输出结论' });
    expect(resumed?.status).toBe('queued');
    expect(resumed?.prompt).toBe('只输出结论');
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executions).toBe(2);
    expect((await store.get(job.id))?.status).toBe('succeeded');

    await runner.stop();
  });
});
