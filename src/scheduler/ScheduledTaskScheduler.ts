import type {
  ScheduledTask,
  ScheduledTaskStore,
} from '../types/admin-and-console.js';
import { nextCronRun } from './CronSchedule.js';

export interface SchedulerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** 根据任务配置计算下一次触发时间；停用或一次性提醒返回 null */
export function computeNextRun(
  task: Pick<ScheduledTask, 'enabled' | 'cron' | 'intervalSeconds'> & {
    kind?: ScheduledTask['kind'];
  },
  fromMs: number,
): number | null {
  if (!task.enabled) return null;
  if (task.kind === 'reminder') return null;
  if (task.cron?.trim()) return nextCronRun(task.cron, fromMs);
  if (task.intervalSeconds && task.intervalSeconds > 0) {
    return fromMs + task.intervalSeconds * 1_000;
  }
  throw new Error('定时任务必须配置 cron 或 intervalSeconds');
}

export interface ScheduledTaskSchedulerOptions {
  store: ScheduledTaskStore;
  execute: (task: ScheduledTask) => Promise<void>;
  intervalMs?: number;
  logger?: SchedulerLogger;
  now?: () => number;
}

/**
 * 轮询到期任务并串行执行。单个任务失败不会阻塞后续任务，
 * 失败后仍推进 nextRunAt，避免故障任务被反复重试。
 */
export class ScheduledTaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInFlight: Promise<void> | null = null;
  private readonly store: ScheduledTaskStore;
  private readonly execute: (task: ScheduledTask) => Promise<void>;
  private readonly intervalMs: number;
  private readonly logger?: SchedulerLogger;
  private readonly now: () => number;

  constructor(options: ScheduledTaskSchedulerOptions) {
    this.store = options.store;
    this.execute = options.execute;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.tick();
    this.logger?.info({ intervalMs: this.intervalMs }, 'scheduler started');
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickInFlight;
    this.logger?.info({}, 'scheduler stopped');
  }

  public tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const task = (async () => {
      const nowMs = this.now();
      const due = await this.store.listDue(nowMs);
      for (const item of due) {
        try {
          await this.execute(item);
        } catch (error) {
          this.logger?.warn(
            {
              taskId: item.id,
              conversationId: item.conversationId,
              error: error instanceof Error ? error.message : String(error),
            },
            'scheduled task execution failed',
          );
        }
        try {
          const next = computeNextRun(item, nowMs);
          if (next === null && item.enabled) {
            await this.store.update(item.id, { enabled: false }, null);
          }
          await this.store.markRun(item.id, nowMs, next);
        } catch (error) {
          this.logger?.warn(
            {
              taskId: item.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'failed to advance scheduled task',
          );
        }
      }
    })().finally(() => {
      this.tickInFlight = null;
    });
    this.tickInFlight = task;
    return task;
  }
}
