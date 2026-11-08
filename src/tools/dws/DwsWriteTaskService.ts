import { randomUUID } from 'node:crypto';
import type { InboundMessage } from '../../types/core.js';
import type {
  DwsWriteTask,
  DwsWriteTaskInput,
  DwsWriteTaskStore,
} from '../../types/dws-write-task.js';
import type { DwsIdentityService } from './DwsIdentityService.js';

export interface DwsWriteTaskLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn?(obj: Record<string, unknown>, msg: string): void;
}

export interface DwsWriteTaskServiceOptions {
  store: DwsWriteTaskStore;
  identity: Pick<DwsIdentityService, 'status'>;
  /** 授权完成后按保存的工具与参数精确执行；失败时抛出以保留失败记录 */
  resume: (task: DwsWriteTask) => Promise<void>;
  notify: (message: InboundMessage, text: string) => Promise<void>;
  logger?: DwsWriteTaskLogger;
  now?: () => number;
  ttlMs?: number;
  /** 每次检查前的等待时间；用尽后按最后一个值循环 */
  pollDelaysMs?: number[];
  pollIntervalMs?: number;
}

interface TrackedTask {
  task: DwsWriteTask;
  nextCheckAt: number;
}

const DEFAULT_TTL_MS = 20 * 60_000;
const DEFAULT_POLL_DELAYS_MS = [5_000, 15_000, 30_000];
const DEFAULT_POLL_INTERVAL_MS = 5_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 等待本人 DWS 授权完成后自动续跑写操作的任务服务。
 * - 轮询授权状态，授权通过后原子抢锁并恢复原问题；
 * - 多实例部署时靠 store.claim 的 compare-and-set 保证只执行一次；
 * - 重启后从持久层恢复未过期的 waiting_auth 任务。
 */
export class DwsWriteTaskService {
  private readonly store: DwsWriteTaskStore;
  private readonly identity: Pick<DwsIdentityService, 'status'>;
  private readonly resume: DwsWriteTaskServiceOptions['resume'];
  private readonly notify: DwsWriteTaskServiceOptions['notify'];
  private readonly logger?: DwsWriteTaskLogger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly pollDelaysMs: number[];
  private readonly pollIntervalMs: number;
  private readonly tasks = new Map<string, TrackedTask>();
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(options: DwsWriteTaskServiceOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.resume = options.resume;
    this.notify = options.notify;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.pollDelaysMs =
      options.pollDelaysMs && options.pollDelaysMs.length > 0
        ? options.pollDelaysMs
        : DEFAULT_POLL_DELAYS_MS;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  public async start(): Promise<void> {
    if (this.timer) return;
    try {
      const waiting = await this.store.listWaiting(this.now());
      for (const task of waiting) {
        this.tasks.set(task.conversationId, {
          task,
          nextCheckAt: this.now() + this.delayFor(0),
        });
      }
      if (waiting.length > 0) {
        this.logger?.info?.(
          { waiting: waiting.length },
          'restored dws write tasks waiting for authorization',
        );
      }
    } catch (error) {
      this.logger?.warn?.(
        { error: errorText(error) },
        'failed to restore dws write tasks',
      );
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  public async create(input: DwsWriteTaskInput): Promise<DwsWriteTask> {
    const now = this.now();
    const task: DwsWriteTask = {
      id: randomUUID(),
      conversationId: input.message.conversationId,
      staffId: input.message.senderStaffId,
      message: input.message,
      toolName: input.toolName,
      args: input.args,
      risk: input.risk,
      state: 'waiting_auth',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
    // 同一会话已有任务时，upsert 保留数据库里的原 id；后续 claim 必须用返回值
    const persisted = await this.store.save(task);
    this.tasks.set(persisted.conversationId, {
      task: persisted,
      nextCheckAt: now + this.delayFor(0),
    });
    this.logger?.info?.(
      {
        taskId: persisted.id,
        conversationId: persisted.conversationId,
        staffId: persisted.staffId,
        toolName: persisted.toolName,
      },
      'dws write task waiting for authorization',
    );
    return persisted;
  }

  /**
   * 登录成功事件到达时立即续跑该员工的任务。
   * 返回已抢到的会话 ID，调用方据此跳过同一会话的通用 pending 恢复。
   */
  public async resumeForStaff(staffId: string): Promise<string[]> {
    await this.syncWaiting(staffId);
    const claimed: string[] = [];
    for (const [conversationId, entry] of [...this.tasks]) {
      if (
        entry.task.staffId !== staffId ||
        entry.task.state !== 'waiting_auth'
      ) {
        continue;
      }
      if (await this.resumeTracked(entry)) claimed.push(conversationId);
    }
    return claimed;
  }

  public async failForStaff(
    staffId: string,
    reason: string,
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const [conversationId, entry] of [...this.tasks]) {
      if (
        entry.task.staffId !== staffId ||
        entry.task.state !== 'waiting_auth'
      ) {
        continue;
      }
      this.tasks.delete(conversationId);
      await this.finish(
        entry.task,
        'failed',
        reason,
        `本人 DWS 授权未完成：${reason}。刚才的写操作没有执行，请重新发起或发送「重新授权」重试。`,
      );
      failed.push(conversationId);
    }
    return failed;
  }

  public async cancelByConversation(
    conversationId: string,
  ): Promise<boolean> {
    const entry = this.tasks.get(conversationId);
    if (!entry || entry.task.state !== 'waiting_auth') return false;
    this.tasks.delete(conversationId);
    await this.finish(
      entry.task,
      'cancelled',
      null,
      '已取消等待授权后自动执行的写操作。',
    );
    return true;
  }

  /** 撤销授权或改回只读时，取消该员工所有等待中的写任务 */
  public async cancelForStaff(
    staffId: string,
    reason: string,
    text: string,
  ): Promise<string[]> {
    const cancelled: string[] = [];
    for (const [conversationId, entry] of [...this.tasks]) {
      if (
        entry.task.staffId !== staffId ||
        entry.task.state !== 'waiting_auth'
      ) {
        continue;
      }
      this.tasks.delete(conversationId);
      await this.finish(entry.task, 'cancelled', reason, text);
      cancelled.push(conversationId);
    }
    return cancelled;
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tasks.clear();
  }

  private delayFor(attempts: number): number {
    const index = Math.min(attempts, this.pollDelaysMs.length - 1);
    return this.pollDelaysMs[index] ?? DEFAULT_POLL_DELAYS_MS[0]!;
  }

  /** 登录事件可能落在没有本地内存记录的实例上，以持久层为准补齐 */
  private async syncWaiting(staffId?: string): Promise<void> {
    try {
      const waiting = await this.store.listWaiting(this.now());
      for (const task of waiting) {
        if (staffId && task.staffId !== staffId) continue;
        const existing = this.tasks.get(task.conversationId);
        this.tasks.set(task.conversationId, {
          task,
          nextCheckAt: existing?.nextCheckAt ?? this.now() + this.delayFor(0),
        });
      }
    } catch (error) {
      this.logger?.warn?.(
        { error: errorText(error) },
        'failed to sync dws write tasks from store',
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const entry of [...this.tasks.values()]) {
        if (entry.task.state !== 'waiting_auth') {
          this.tasks.delete(entry.task.conversationId);
          continue;
        }
        const now = this.now();
        if (now >= entry.task.expiresAt) {
          this.tasks.delete(entry.task.conversationId);
          await this.finish(
            entry.task,
            'expired',
            '授权等待超时',
            '授权链接已超时，刚才的写操作没有执行。请重新发起，或发送「重新授权」获取新的授权链接。',
          );
          continue;
        }
        if (now < entry.nextCheckAt) continue;
        let authenticated = false;
        try {
          const status = await this.identity.status(entry.task.staffId, {
            force: true,
          });
          authenticated = status.state === 'authenticated';
        } catch (error) {
          entry.task.lastError = errorText(error);
        }
        entry.task.attempts += 1;
        entry.task.updatedAt = now;
        if (authenticated) {
          this.tasks.delete(entry.task.conversationId);
          await this.resumeTracked(entry);
          continue;
        }
        entry.nextCheckAt = now + this.delayFor(entry.task.attempts);
      }
    } finally {
      this.checking = false;
    }
  }

  private async resumeTracked(entry: TrackedTask): Promise<boolean> {
    const now = this.now();
    const claimed = await this.store.claim(entry.task.id, now);
    if (!claimed) {
      this.tasks.delete(entry.task.conversationId);
      return false;
    }
    this.tasks.delete(claimed.conversationId);
    this.logger?.info?.(
      {
        taskId: claimed.id,
        conversationId: claimed.conversationId,
        staffId: claimed.staffId,
        toolName: claimed.toolName,
        attempts: claimed.attempts,
      },
      'dws write task resuming after authorization',
    );
    try {
      await this.notify(
        claimed.message,
        '已确认本人 DWS 授权完成，正在自动继续并执行刚才的写操作…',
      );
    } catch (error) {
      this.logger?.warn?.(
        {
          taskId: claimed.id,
          error: errorText(error),
        },
        'failed to notify dws write task resume',
      );
    }
    try {
      await this.resume(claimed);
      await this.store.remove(claimed.conversationId);
      return true;
    } catch (error) {
      const reason = errorText(error);
      this.logger?.warn?.(
        { taskId: claimed.id, error: reason },
        'dws write task resume failed',
      );
      await this.finish(
        claimed,
        'failed',
        reason,
        `授权已完成，但自动继续执行写操作失败：${reason}。可以重新发起该操作。`,
      );
      return true;
    }
  }

  private async finish(
    task: DwsWriteTask,
    state: DwsWriteTask['state'],
    lastError: string | null,
    text: string,
  ): Promise<void> {
    const updated: DwsWriteTask = {
      ...task,
      state,
      lastError,
      updatedAt: this.now(),
    };
    try {
      await this.store.update(updated);
    } catch (error) {
      this.logger?.warn?.(
        { taskId: task.id, error: errorText(error) },
        'failed to persist dws write task state',
      );
    }
    try {
      await this.notify(updated.message, text);
    } catch (error) {
      this.logger?.warn?.(
        { taskId: task.id, error: errorText(error) },
        'failed to notify dws write task state',
      );
    }
  }
}
