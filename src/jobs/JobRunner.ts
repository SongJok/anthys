import type { AgentStreamEvent } from '../types/core.js';
import type {
  AgentJob,
  AgentJobResult,
  AgentJobStore,
} from '../types/jobs.js';

export interface JobRunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobExecutionContext {
  emit(event: AgentStreamEvent): void;
  signal: AbortSignal;
  /** false 表示租约已丢失，应立即停止本轮 */
  heartbeat(): Promise<boolean>;
}

export interface JobRunnerOptions {
  store: AgentJobStore;
  execute: (
    job: AgentJob,
    context: JobExecutionContext,
  ) => Promise<AgentJobResult>;
  owner?: string;
  intervalMs?: number;
  /** 租约时长，默认 30 分钟，需大于单个任务的最长执行时间 */
  leaseMs?: number;
  maxConcurrency?: number;
  logger?: JobRunnerLogger;
  now?: () => number;
  onCompleted?: (
    job: AgentJob,
    result: AgentJobResult,
  ) => Promise<void> | void;
  onFailed?: (job: AgentJob, error: string) => Promise<void> | void;
}

function eventPayload(event: AgentStreamEvent): {
  type: string;
  payload: Record<string, unknown>;
} | null {
  switch (event.type) {
    case 'status':
      return { type: 'status', payload: { message: event.message } };
    case 'tool_start':
      return {
        type: 'tool_start',
        payload: { toolName: event.toolName, args: event.args },
      };
    case 'tool_end':
      return {
        type: 'tool_end',
        payload: {
          toolName: event.toolName,
          summary: event.summary,
          isError: event.isError,
          durationMs: event.durationMs,
        },
      };
    case 'answer_delta':
      return event.final
        ? { type: 'answer', payload: { content: event.content } }
        : null;
    case 'error':
      return { type: 'error', payload: { message: event.message } };
    case 'completed':
      return { type: 'usage', payload: { ...event.usage } };
    default:
      return null;
  }
}

/**
 * 持久化任务执行器：按 PG 租约领取任务，后台执行并写回状态与事件。
 * 与 Web 进程生命周期解耦，重启后 queued/running 任务可继续被领取。
 */
export class JobRunner {
  private readonly store: AgentJobStore;
  private readonly execute: JobRunnerOptions['execute'];
  private readonly owner: string;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly maxConcurrency: number;
  private readonly logger?: JobRunnerLogger;
  private readonly now: () => number;
  private readonly onCompleted?: JobRunnerOptions['onCompleted'];
  private readonly onFailed?: JobRunnerOptions['onFailed'];
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private stopped = true;

  constructor(options: JobRunnerOptions) {
    this.store = options.store;
    this.execute = options.execute;
    this.owner = options.owner ?? `job-runner:${process.pid}`;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
    this.leaseMs = Math.max(30_000, options.leaseMs ?? 30 * 60_000);
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 2);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.onCompleted = options.onCompleted;
    this.onFailed = options.onFailed;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.tick();
    this.logger?.info(
      {
        owner: this.owner,
        intervalMs: this.intervalMs,
        leaseMs: this.leaseMs,
        maxConcurrency: this.maxConcurrency,
      },
      'job runner started',
    );
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
    await this.tickInFlight;
    this.logger?.info({ owner: this.owner }, 'job runner stopped');
  }

  public tick(): Promise<void> {
    if (this.tickInFlight || this.stopped) {
      return this.tickInFlight ?? Promise.resolve();
    }
    const task = (async () => {
      while (!this.stopped && this.active.size < this.maxConcurrency) {
        const job = await this.store.claimNext({
          owner: this.owner,
          nowMs: this.now(),
          leaseMs: this.leaseMs,
        });
        if (!job) break;
        this.startJob(job);
      }
    })().finally(() => {
      this.tickInFlight = null;
    });
    this.tickInFlight = task;
    return task;
  }

  private startJob(job: AgentJob): void {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const promise = this.runJob(job, controller).finally(() => {
      this.active.delete(job.id);
      this.controllers.delete(job.id);
    });
    this.active.set(job.id, promise);
    this.logger?.info(
      {
        jobId: job.id,
        kind: job.kind,
        conversationId: job.conversationId,
        attempts: job.attempts,
      },
      'job claimed',
    );
  }

  private async runJob(
    job: AgentJob,
    controller: AbortController,
  ): Promise<void> {
    let leaseLost = false;
    const heartbeatTimer = setInterval(() => {
      void this.store
        .heartbeat(job.id, this.owner, this.now(), this.leaseMs)
        .then((ok) => {
          if (!ok) {
            leaseLost = true;
            controller.abort();
          }
        })
        .catch((error) => {
          this.logger?.warn(
            {
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'job heartbeat failed',
          );
        });
    }, Math.max(1_000, Math.min(Math.floor(this.leaseMs / 3), 30_000)));
    heartbeatTimer.unref?.();

    const emit = (event: AgentStreamEvent): void => {
      const mapped = eventPayload(event);
      if (!mapped) return;
      void this.store
        .appendEvent({ jobId: job.id, ...mapped })
        .catch((error) => {
          this.logger?.warn(
            {
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'failed to append job event',
          );
        });
    };

    try {
      await this.store.appendEvent({
        jobId: job.id,
        type: 'started',
        payload: { kind: job.kind, attempts: job.attempts },
      });
      const result = await this.execute(job, {
        emit,
        signal: controller.signal,
        heartbeat: () =>
          this.store.heartbeat(job.id, this.owner, this.now(), this.leaseMs),
      });
      const completed = await this.store.complete(job.id, this.owner, result);
      if (!completed) {
        this.logger?.warn(
          { jobId: job.id },
          'job finished but lease was lost; result not persisted',
        );
        return;
      }
      await this.store.appendEvent({
        jobId: job.id,
        type: 'completed',
        payload: {
          answer: result.answer.slice(0, 1_000),
          totalTokens: result.usage.totalTokens,
          steps: result.usage.steps,
          durationMs: result.usage.durationMs,
        },
      });
      this.logger?.info(
        {
          jobId: job.id,
          kind: job.kind,
          tokens: result.usage.totalTokens,
          steps: result.usage.steps,
          durationMs: result.usage.durationMs,
        },
        'job completed',
      );
      await this.onCompleted?.(completed, result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        const current = await this.store.get(job.id);
        if (current?.status === 'cancelled') {
          await this.store.appendEvent({
            jobId: job.id,
            type: 'cancelled',
            payload: { reason: 'cancelled by user' },
          });
        } else if (current?.status === 'running') {
          await this.store.fail(
            job.id,
            this.owner,
            leaseLost ? 'job lease lost' : 'job aborted',
            true,
          );
        }
        return;
      }
      const failed = await this.store.fail(
        job.id,
        this.owner,
        message,
        true,
      );
      this.logger?.warn({ jobId: job.id, error: message }, 'job failed');
      if (failed) {
        await this.store.appendEvent({
          jobId: job.id,
          type: 'failed',
          payload: { error: message, status: failed.status },
        });
        await this.onFailed?.(failed, message);
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}
