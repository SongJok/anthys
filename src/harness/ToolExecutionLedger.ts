import { createHash } from 'node:crypto';

export type LedgerStatus = 'executing' | 'succeeded' | 'failed';

export interface ToolExecutionLedgerEntry {
  idempotencyKey: string;
  jobId?: string;
  actionId?: string;
  toolName: string;
  argsHash: string;
  status: LedgerStatus;
  result?: string;
  error?: string;
  createdAt: number;
  settledAt?: number;
}

export interface ToolExecutionLedgerPersistence {
  /** INSERT ON CONFLICT DO NOTHING；true=首次登记，false=键已存在 */
  insertExecuting(entry: {
    idempotencyKey: string;
    jobId?: string;
    actionId?: string;
    toolName: string;
    argsHash: string;
    createdAt: number;
  }): Promise<boolean>;
  get(idempotencyKey: string): Promise<ToolExecutionLedgerEntry | null>;
  /** CAS：failed → executing，成功返回 true */
  reclaimFailed(idempotencyKey: string, nowMs: number): Promise<boolean>;
  settle(
    idempotencyKey: string,
    status: 'succeeded' | 'failed',
    detail: string,
    nowMs: number,
  ): Promise<void>;
  purgeSettled(beforeMs: number): Promise<number>;
}

export type LedgerBegin =
  | { outcome: 'claimed' }
  | { outcome: 'replay'; result: string }
  | { outcome: 'blocked'; reason: string };

/** 键序无关的稳定序列化，保证相同参数跨进程得到同一哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

export function hashToolArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex');
}

/** 写操作幂等键：同一作用域（job:<id> / confirm:<actionId>）内同工具同参数只执行一次 */
export function writeLedgerKey(
  scope: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  return `${scope}:${toolName}:${hashToolArgs(args)}`;
}

export interface ToolExecutionLedgerOptions {
  persistence?: ToolExecutionLedgerPersistence;
  now?: () => number;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * 写执行台账：执行前登记幂等键，成功结果可重放，
 * 中断（executing）的写操作 fail-closed 阻止重复执行，失败允许重试。
 */
export class ToolExecutionLedger {
  private readonly persistence?: ToolExecutionLedgerPersistence;
  private readonly now: () => number;
  private readonly logger?: ToolExecutionLedgerOptions['logger'];

  constructor(options: ToolExecutionLedgerOptions = {}) {
    this.persistence = options.persistence;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  public async begin(
    idempotencyKey: string,
    meta: {
      jobId?: string;
      actionId?: string;
      toolName: string;
      argsHash: string;
    },
  ): Promise<LedgerBegin> {
    const persistence = this.persistence;
    if (!persistence) return { outcome: 'claimed' };
    const inserted = await persistence.insertExecuting({
      idempotencyKey,
      ...meta,
      createdAt: this.now(),
    });
    if (inserted) return { outcome: 'claimed' };
    const existing = await persistence.get(idempotencyKey);
    if (!existing) return { outcome: 'claimed' };
    if (existing.status === 'succeeded') {
      return { outcome: 'replay', result: existing.result ?? '' };
    }
    if (existing.status === 'failed') {
      const reclaimed = await persistence.reclaimFailed(
        idempotencyKey,
        this.now(),
      );
      if (reclaimed) return { outcome: 'claimed' };
      return {
        outcome: 'blocked',
        reason: '该写操作上次失败后正被其他进程重试，已阻止并发执行。',
      };
    }
    return {
      outcome: 'blocked',
      reason:
        '该写操作曾在本任务中执行但结果未知（进程中断或仍在执行），已阻止重复执行；请人工核实外部系统后再决定是否重新发起。',
    };
  }

  public async settle(
    idempotencyKey: string,
    status: 'succeeded' | 'failed',
    detail: string,
  ): Promise<boolean> {
    if (!this.persistence) return true;
    try {
      await this.persistence.settle(idempotencyKey, status, detail, this.now());
      return true;
    } catch (error) {
      this.logger?.warn(
        {
          idempotencyKey,
          status,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to settle tool execution ledger entry',
      );
      return false;
    }
  }

  public async purgeSettled(beforeMs: number): Promise<number> {
    if (!this.persistence) return 0;
    return this.persistence.purgeSettled(beforeMs);
  }
}