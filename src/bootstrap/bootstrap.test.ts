import { describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../admin-api/metrics.js';
import type { TraceCollector } from '../admin-api/runtime.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { DrizzleScheduledTaskStore } from '../db/schedulerSchema.js';
import type { DingTalkAdminTextSender } from '../dingtalk/AdminTextSender.js';
import type { CardStreamer } from '../dingtalk/CardStreamer.js';
import type { GroupWorkspaceService } from '../groups/GroupWorkspaceService.js';
import type { AgentHarness, HarnessLogger } from '../harness/AgentHarness.js';
import type { PersonalAssistantService } from '../personal/PersonalAssistantService.js';
import type { ScheduledTask } from '../types/admin-and-console.js';
import type {
  AgentStreamEvent,
  InboundMessage,
  RunResult,
} from '../types/core.js';
import type {
  AgentJob,
  AgentJobEvent,
  AgentJobResult,
  AgentJobStore,
  ClaimJobInput,
  EnqueueAgentJobInput,
  ListJobsInput,
} from '../types/jobs.js';
import type {
  AddAgentTaskLinkInput,
  AgentTask,
  AgentTaskLink,
  AgentTaskStore,
  AgentTaskSubscription,
  CreateAgentTaskInput,
  ExternalTaskLinkRef,
  ListAgentTasksInput,
  UpdateAgentTaskInput,
} from '../types/tasks.js';
import { createConsoleChatHandler } from './adminConsoleWiring.js';
import { setupBackgroundSchedulers } from './backgroundSchedulers.js';

class InMemoryJobStore implements AgentJobStore {
  public readonly jobs = new Map<string, AgentJob>();
  public readonly events = new Map<string, AgentJobEvent[]>();
  private counter = 0;
  private seq = 0;

  async enqueue(input: EnqueueAgentJobInput): Promise<AgentJob> {
    this.counter += 1;
    const now = Date.now();
    const job: AgentJob = {
      id: `job-${this.counter}-0000-4000-8000-000000000000`,
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

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async complete(
    jobId: string,
    owner: string,
    result: AgentJobResult,
  ): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner) return null;
    job.status = 'succeeded';
    job.result = result;
    job.finishedAt = Date.now();
    return { ...job };
  }

  async fail(
    jobId: string,
    owner: string,
    error: string,
  ): Promise<AgentJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseOwner !== owner) return null;
    job.status = 'failed';
    job.error = error;
    job.finishedAt = Date.now();
    return { ...job };
  }

  async pause(): Promise<AgentJob | null> {
    return null;
  }

  async resume(): Promise<AgentJob | null> {
    return null;
  }

  async cancel(): Promise<AgentJob | null> {
    return null;
  }

  async get(jobId: string): Promise<AgentJob | null> {
    return this.jobs.get(jobId) ?? null;
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

class InMemoryTaskStore implements AgentTaskStore {
  async create(input: CreateAgentTaskInput): Promise<AgentTask> {
    const now = Date.now();
    return {
      id: 'task-1',
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      ownerStaffId: input.ownerStaffId,
      ownerNick: input.ownerNick,
      title: input.title,
      prompt: input.prompt,
      status: 'active',
      summary: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
  }
  async get(): Promise<AgentTask | null> {
    return null;
  }
  async list(_input?: ListAgentTasksInput): Promise<AgentTask[]> {
    return [];
  }
  async update(_id: string, _patch: UpdateAgentTaskInput): Promise<AgentTask | null> {
    return null;
  }
  async addLink(input: AddAgentTaskLinkInput): Promise<AgentTaskLink> {
    return {
      id: 'link-1',
      taskId: input.taskId,
      kind: input.kind,
      ref: input.ref,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
    };
  }
  async listLinks(): Promise<AgentTaskLink[]> {
    return [];
  }
  async subscribe(): Promise<boolean> {
    return true;
  }
  async unsubscribe(): Promise<boolean> {
    return true;
  }
  async listSubscribers(): Promise<AgentTaskSubscription[]> {
    return [];
  }
  async findActiveByLinks(_refs: ExternalTaskLinkRef[]): Promise<AgentTask[]> {
    return [];
  }
}

const silentLogger: HarnessLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('createConsoleChatHandler', () => {
  it('routes console chat through AgentHarness with systemPromptOverride and trace persistence', async () => {
    const handleMessage = vi.fn(
      async (
        _msg: InboundMessage,
        opts: {
          emit: (event: AgentStreamEvent) => void;
          systemPromptOverride?: string;
        },
      ): Promise<RunResult> => {
        opts.emit({ type: 'answer_delta', content: 'console reply' });
        const result: RunResult = {
          answer: 'console reply',
          reasoning: '',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            steps: 1,
            durationMs: 20,
          },
          model: 'test-model',
        };
        opts.emit({
          type: 'completed',
          usage: { totalTokens: 15, steps: 1, durationMs: 20, stopped: false },
        });
        return result;
      },
    );
    const recordTrace = vi.fn<
      (
        collector: TraceCollector,
        message: InboundMessage,
        result: RunResult | null,
        proactive: boolean,
      ) => Promise<void>
    >(async () => {});

    const handler = createConsoleChatHandler({
      harness: { handleMessage } as unknown as AgentHarness,
      metrics: new MetricsRegistry(),
      harnessLogger: silentLogger,
      recordTrace,
    });

    const events: AgentStreamEvent[] = [];
    await handler(
      {
        question: '帮我查最近报错',
        systemPrompt: '你是巡检助手',
        conversationId: 'console:ops',
      },
      (event) => events.push(event),
    );

    expect(handleMessage).toHaveBeenCalledOnce();
    const [message, opts] = handleMessage.mock.calls[0]!;
    expect(message.conversationId).toBe('console:ops');
    expect(message.text).toBe('帮我查最近报错');
    expect(opts.systemPromptOverride).toBe('你是巡检助手');
    expect(events.map((e) => e.type)).toEqual(['answer_delta', 'completed']);
    expect(recordTrace).toHaveBeenCalledOnce();
  });

  it('emits stopped completion event and records fallback trace when aborted', async () => {
    const controller = new AbortController();
    const handleMessage = vi.fn(async () => {
      controller.abort();
      throw new Error('Aborted');
    });
    const recordTrace = vi.fn(async () => {});

    const handler = createConsoleChatHandler({
      harness: { handleMessage } as unknown as AgentHarness,
      metrics: new MetricsRegistry(),
      harnessLogger: silentLogger,
      recordTrace,
    });

    const events: AgentStreamEvent[] = [];
    await handler(
      { question: '取消这个问题', signal: controller.signal },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'completed',
      usage: { stopped: true },
    });
    expect(recordTrace).toHaveBeenCalledOnce();
  });
});

describe('setupBackgroundSchedulers', () => {
  it('offloads scheduled prompt tasks to JobStore and delivers result when JobRunner completes', async () => {
    const jobStore = new InMemoryJobStore();
    const scheduledTask: ScheduledTask = {
      id: 'sched-prompt-1',
      conversationId: 'cid-group-1',
      conversationType: '2',
      kind: 'prompt',
      title: '每日构建巡检',
      prompt: '检查最近构建失败原因',
      intervalSeconds: 3600,
      cron: null,
      enabled: true,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: 'staff-001',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const scheduledStore = {
      list: async () => [scheduledTask],
      listDue: async () => [],
      create: async () => scheduledTask,
      update: async () => scheduledTask,
      remove: async () => true,
      markRun: vi.fn(async () => {}),
    } as unknown as DrizzleScheduledTaskStore;

    const runJob = vi.fn(async () => ({
      answer: '构建均正常，无新增告警。',
      reasoning: '',
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        steps: 1,
        durationMs: 15,
      },
      model: 'gpt-test',
    }));

    const streamerEvents: AgentStreamEvent[] = [];
    const streamerFinish = vi.fn(async () => {});
    const createStreamer = vi.fn(
      () =>
        ({
          start: vi.fn(async () => {}),
          handle: (event: AgentStreamEvent) => streamerEvents.push(event),
          finish: streamerFinish,
        }) as unknown as CardStreamer,
    );

    const ctx = setupBackgroundSchedulers({
      configCenter: {
        isAdmin: () => true,
        recordAudit: async () => {},
      } as unknown as DynamicConfigCenter,
      jobStore,
      taskStore: new InMemoryTaskStore(),
      scheduledStore,
      harness: { runJob } as unknown as AgentHarness,
      taskMemory: null,
      personalAssistant: {} as unknown as PersonalAssistantService,
      groupWorkspace: {} as unknown as GroupWorkspaceService,
      adminTextSender: {
        send: vi.fn(async () => ({ ok: true, failed: [] })),
      } as unknown as DingTalkAdminTextSender,
      metrics: new MetricsRegistry(),
      harnessLogger: silentLogger,
      resolveEmployeeDisplayName: async () => '张三',
      createStreamer,
      clusterEnabled: false,
      isLeader: () => true,
      isProjectSyncRunning: () => false,
      isBystanderListenRunning: () => false,
    });

    await ctx.scheduledApi.runNow(scheduledTask.id);
    // Scheduler offload does not invoke harness.runJob synchronously
    expect(runJob).not.toHaveBeenCalled();
    const queued = await jobStore.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'scheduled',
      prompt: '检查最近构建失败原因',
      metadata: {
        source: 'scheduled_task',
        scheduledTaskId: scheduledTask.id,
        createdBy: 'staff-001',
      },
    });

    ctx.jobRunner.start();
    try {
      await vi.waitFor(() => {
        expect(runJob).toHaveBeenCalledOnce();
        expect(createStreamer).toHaveBeenCalledOnce();
        expect(streamerFinish).toHaveBeenCalledOnce();
      });
      expect(streamerEvents).toContainEqual({
        type: 'answer_delta',
        content: '构建均正常，无新增告警。',
      });
    } finally {
      await ctx.jobRunner.stop();
    }
  });
});
