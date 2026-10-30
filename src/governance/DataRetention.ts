import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type RetentionKind =
  | 'messages'
  | 'summaries'
  | 'traces'
  | 'audit'
  | 'usage'
  | 'attachments';

export interface RetentionPolicy {
  /** 会话消息与情景摘要保留天数 */
  messagesDays: number;
  /** ReAct 轨迹保留天数 */
  tracesDays: number;
  /** 入站附件保留小时数 */
  attachmentsHours: number;
  /** 管理审计日志保留天数 */
  auditDays: number;
  /** 用量流水保留天数 */
  usageDays: number;
}

export interface RetentionStats {
  policy: RetentionPolicy;
  now: number;
  totals: Record<RetentionKind, number>;
  expired: Record<RetentionKind, number>;
  attachmentBytes: number;
}

export interface CleanupResult {
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  deleted: Record<RetentionKind, number>;
}

export interface DeletionResult {
  target: string;
  deleted: Record<string, number>;
  attachmentsRemoved: number;
}

export interface RetentionCutoffs {
  messages: number;
  traces: number;
  audit: number;
  usage: number;
}

export interface RetentionStore {
  counts(
    cutoffs: RetentionCutoffs,
  ): Promise<{
    totals: Record<RetentionKind, number>;
    expired: Record<RetentionKind, number>;
  }>;
  purge(
    kind: Exclude<RetentionKind, 'attachments'>,
    cutoffMs: number,
    limit: number,
  ): Promise<number>;
  deleteConversation(
    conversationId: string,
  ): Promise<{ deleted: Record<string, number>; messageIds: string[] }>;
  deleteUser(
    staffId: string,
  ): Promise<{ deleted: Record<string, number>; messageIds: string[] }>;
  loadPolicy?(): Promise<Partial<RetentionPolicy> | null>;
  savePolicy?(policy: RetentionPolicy): Promise<void>;
}

export interface DataGovernancePort {
  getPolicy(): RetentionPolicy;
  updatePolicy(input: Partial<RetentionPolicy>): Promise<RetentionPolicy>;
  stats(): Promise<RetentionStats>;
  cleanup(input?: { dryRun?: boolean }): Promise<CleanupResult>;
  deleteConversation(conversationId: string): Promise<DeletionResult>;
  deleteUser(staffId: string): Promise<DeletionResult>;
}

export interface DataRetentionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DataRetentionOptions {
  store: RetentionStore;
  policy: RetentionPolicy;
  attachmentsDir?: string;
  logger?: DataRetentionLogger;
  now?: () => number;
  /** 单次清理每张表的最大删除行数，默认 5000 */
  batchSize?: number;
  /** 集群模式下仅 leader 执行定时清理 */
  canRun?: () => boolean;
  /** 定时清理时是否只统计不删除 */
  scheduledDryRun?: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  messagesDays: 180,
  tracesDays: 90,
  attachmentsHours: 24,
  auditDays: 365,
  usageDays: 365,
};

const LIMITS: Record<keyof RetentionPolicy, { min: number; max: number }> = {
  messagesDays: { min: 1, max: 3_650 },
  tracesDays: { min: 1, max: 3_650 },
  attachmentsHours: { min: 1, max: 8_760 },
  auditDays: { min: 1, max: 3_650 },
  usageDays: { min: 1, max: 3_650 },
};

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 从环境变量读取保留策略，非法值回退默认 */
export function resolveRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RetentionPolicy {
  return normalizeRetentionPolicy({
    messagesDays: readNumber(
      env.RETENTION_MESSAGES_DAYS,
      DEFAULT_RETENTION_POLICY.messagesDays,
    ),
    tracesDays: readNumber(
      env.RETENTION_TRACES_DAYS,
      DEFAULT_RETENTION_POLICY.tracesDays,
    ),
    attachmentsHours: readNumber(
      env.RETENTION_ATTACHMENTS_HOURS,
      DEFAULT_RETENTION_POLICY.attachmentsHours,
    ),
    auditDays: readNumber(
      env.RETENTION_AUDIT_DAYS,
      DEFAULT_RETENTION_POLICY.auditDays,
    ),
    usageDays: readNumber(
      env.RETENTION_USAGE_DAYS,
      DEFAULT_RETENTION_POLICY.usageDays,
    ),
  });
}

export function normalizeRetentionPolicy(
  input: Partial<RetentionPolicy>,
  base: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionPolicy {
  const next: RetentionPolicy = { ...base };
  for (const key of Object.keys(LIMITS) as Array<keyof RetentionPolicy>) {
    const value = input[key];
    if (value === undefined) continue;
    const { min, max } = LIMITS[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${key} 必须在 ${min}–${max} 之间`);
    }
    next[key] = Math.floor(value);
  }
  return next;
}

function emptyCounts(): Record<RetentionKind, number> {
  return {
    messages: 0,
    summaries: 0,
    traces: 0,
    audit: 0,
    usage: 0,
    attachments: 0,
  };
}

function safeAttachmentSegment(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/u, '')
    .slice(0, 80);
}

export class DataRetentionService implements DataGovernancePort {
  private policy: RetentionPolicy;
  private readonly store: RetentionStore;
  private readonly attachmentsDir?: string;
  private readonly logger?: DataRetentionLogger;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly canRun?: () => boolean;
  private readonly scheduledDryRun: boolean;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: DataRetentionOptions) {
    this.policy = normalizeRetentionPolicy(options.policy);
    this.store = options.store;
    this.attachmentsDir = options.attachmentsDir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.batchSize = Math.max(1, options.batchSize ?? 5_000);
    this.canRun = options.canRun;
    this.scheduledDryRun = options.scheduledDryRun ?? false;
  }

  /** 加载管理端保存的覆盖值；失败时沿用 env 默认 */
  public async init(): Promise<this> {
    if (!this.store.loadPolicy) return this;
    try {
      const stored = await this.store.loadPolicy();
      if (stored) this.policy = normalizeRetentionPolicy(stored, this.policy);
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'failed to load retention policy, using env defaults',
      );
    }
    return this;
  }

  public getPolicy(): RetentionPolicy {
    return { ...this.policy };
  }

  public async updatePolicy(
    input: Partial<RetentionPolicy>,
  ): Promise<RetentionPolicy> {
    const next = normalizeRetentionPolicy(input, this.policy);
    if (this.store.savePolicy) await this.store.savePolicy(next);
    this.policy = next;
    this.logger?.info({ policy: next }, 'retention policy updated');
    return { ...next };
  }

  public async stats(): Promise<RetentionStats> {
    const now = this.now();
    const counts = await this.store.counts(this.cutoffs(now));
    const attachment = await this.scanAttachments();
    return {
      policy: this.getPolicy(),
      now,
      totals: { ...counts.totals, attachments: attachment.dirs.length },
      expired: {
        ...counts.expired,
        attachments: attachment.expiredDirs.length,
      },
      attachmentBytes: attachment.bytes,
    };
  }

  public async cleanup(input: { dryRun?: boolean } = {}): Promise<CleanupResult> {
    const dryRun = input.dryRun ?? false;
    const startedAt = this.now();
    const cutoffs = this.cutoffs(startedAt);
    const deleted = emptyCounts();
    const jobs: Array<[Exclude<RetentionKind, 'attachments'>, number]> = [
      ['messages', cutoffs.messages],
      ['summaries', cutoffs.messages],
      ['traces', cutoffs.traces],
      ['audit', cutoffs.audit],
      ['usage', cutoffs.usage],
    ];
    const dryRunCounts = dryRun ? await this.store.counts(cutoffs) : undefined;
    for (const [kind, cutoff] of jobs) {
      deleted[kind] = dryRun
        ? (dryRunCounts?.expired[kind] ?? 0)
        : await this.store.purge(kind, cutoff, this.batchSize);
    }
    if (this.attachmentsDir) {
      const cutoff = startedAt - this.policy.attachmentsHours * 3_600_000;
      const attachment = await this.scanAttachments();
      const expired = attachment.expiredDirs;
      deleted.attachments = expired.length;
      if (!dryRun) {
        for (const dir of expired) {
          await rm(dir.path, { recursive: true, force: true });
        }
      }
    }
    const result: CleanupResult = {
      dryRun,
      startedAt,
      finishedAt: this.now(),
      deleted,
    };
    this.logger?.info(
      { dryRun, deleted: result.deleted },
      'data retention cleanup finished',
    );
    return result;
  }

  public async deleteConversation(
    conversationId: string,
  ): Promise<DeletionResult> {
    const id = conversationId.trim();
    if (!id) throw new Error('conversationId 不能为空');
    const outcome = await this.store.deleteConversation(id);
    const attachmentsRemoved = await this.removeAttachments(outcome.messageIds);
    this.logger?.info(
      { conversationId: id, deleted: outcome.deleted, attachmentsRemoved },
      'conversation data deleted',
    );
    return { target: id, deleted: outcome.deleted, attachmentsRemoved };
  }

  public async deleteUser(staffId: string): Promise<DeletionResult> {
    const id = staffId.trim();
    if (!id) throw new Error('staffId 不能为空');
    const outcome = await this.store.deleteUser(id);
    const attachmentsRemoved = await this.removeAttachments(outcome.messageIds);
    this.logger?.info(
      { staffId: id, deleted: outcome.deleted, attachmentsRemoved },
      'user data deleted',
    );
    return { target: id, deleted: outcome.deleted, attachmentsRemoved };
  }

  /** 定时清理；集群模式下 canRun 返回 false（standby）时跳过本轮 */
  public start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.canRun && !this.canRun()) return;
      void this.cleanup({ dryRun: this.scheduledDryRun }).catch((error) => {
        this.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'scheduled data retention cleanup failed',
        );
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private cutoffs(now: number): RetentionCutoffs {
    const days = (value: number) => now - value * 86_400_000;
    return {
      messages: days(this.policy.messagesDays),
      traces: days(this.policy.tracesDays),
      audit: days(this.policy.auditDays),
      usage: days(this.policy.usageDays),
    };
  }

  private async scanAttachments(): Promise<{
    dirs: string[];
    expiredDirs: Array<{ path: string; mtimeMs: number }>;
    bytes: number;
  }> {
    if (!this.attachmentsDir) {
      return { dirs: [], expiredDirs: [], bytes: 0 };
    }
    const cutoff = this.now() - this.policy.attachmentsHours * 3_600_000;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(this.attachmentsDir, { withFileTypes: true });
    } catch {
      return { dirs: [], expiredDirs: [], bytes: 0 };
    }
    const dirs: string[] = [];
    const expiredDirs: Array<{ path: string; mtimeMs: number }> = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.attachmentsDir, entry.name);
      dirs.push(path);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) expiredDirs.push({ path, mtimeMs: info.mtimeMs });
        bytes += await this.directoryBytes(path);
      } catch {
        continue;
      }
    }
    return { dirs, expiredDirs, bytes };
  }

  private async directoryBytes(dir: string): Promise<number> {
    let total = 0;
    let entries: Array<{ name: string; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        total += (await stat(join(dir, entry.name))).size;
      } catch {
        continue;
      }
    }
    return total;
  }

  private async removeAttachments(messageIds: string[]): Promise<number> {
    if (!this.attachmentsDir || messageIds.length === 0) return 0;
    let removed = 0;
    for (const raw of new Set(messageIds)) {
      const name = safeAttachmentSegment(raw);
      if (!name) continue;
      try {
        await rm(join(this.attachmentsDir, name), {
          recursive: true,
          force: true,
        });
        removed += 1;
      } catch {
        continue;
      }
    }
    return removed;
  }
}
