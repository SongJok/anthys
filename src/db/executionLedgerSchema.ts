import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  ToolExecutionLedgerEntry,
  ToolExecutionLedgerPersistence,
} from '../harness/ToolExecutionLedger.js';

/**
 * 写执行台账：幂等键唯一，executing → succeeded / failed。
 * 进程中断遗留的 executing 行不会被自动重放（begin 返回 blocked），
 * 与审批状态机的 unknown 语义一致：重复副作用 = 0 优先于可用性。
 */
export const toolExecutionLedger = pgTable(
  'tool_execution_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    jobId: uuid('job_id'),
    actionId: uuid('action_id'),
    toolName: text('tool_name').notNull(),
    argsHash: varchar('args_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('executing'),
    result: text('result'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    index('tool_execution_ledger_job_idx').on(table.jobId),
    index('tool_execution_ledger_settled_idx').on(table.settledAt),
  ],
);

function toEntry(
  row: typeof toolExecutionLedger.$inferSelect,
): ToolExecutionLedgerEntry {
  return {
    idempotencyKey: row.idempotencyKey,
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.actionId ? { actionId: row.actionId } : {}),
    toolName: row.toolName,
    argsHash: row.argsHash,
    status:
      row.status === 'succeeded' || row.status === 'failed'
        ? row.status
        : 'executing',
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.createdAt.getTime(),
    ...(row.settledAt ? { settledAt: row.settledAt.getTime() } : {}),
  };
}

export class DrizzleToolExecutionLedgerPersistence
  implements ToolExecutionLedgerPersistence
{
  constructor(private readonly db: Database) {}

  public async insertExecuting(entry: {
    idempotencyKey: string;
    jobId?: string;
    actionId?: string;
    toolName: string;
    argsHash: string;
    createdAt: number;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(toolExecutionLedger)
      .values({
        idempotencyKey: entry.idempotencyKey,
        jobId: entry.jobId ?? null,
        actionId: entry.actionId ?? null,
        toolName: entry.toolName,
        argsHash: entry.argsHash,
        status: 'executing',
        createdAt: new Date(entry.createdAt),
      })
      .onConflictDoNothing({ target: toolExecutionLedger.idempotencyKey })
      .returning({ id: toolExecutionLedger.id });
    return rows.length > 0;
  }

  public async get(
    idempotencyKey: string,
  ): Promise<ToolExecutionLedgerEntry | null> {
    const rows = await this.db
      .select()
      .from(toolExecutionLedger)
      .where(eq(toolExecutionLedger.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0] ? toEntry(rows[0]) : null;
  }

  public async reclaimFailed(
    idempotencyKey: string,
    _nowMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(toolExecutionLedger)
      .set({ status: 'executing', error: null, settledAt: null })
      .where(
        and(
          eq(toolExecutionLedger.idempotencyKey, idempotencyKey),
          eq(toolExecutionLedger.status, 'failed'),
        ),
      )
      .returning({ id: toolExecutionLedger.id });
    return rows.length > 0;
  }

  public async settle(
    idempotencyKey: string,
    status: 'succeeded' | 'failed',
    detail: string,
    nowMs: number,
  ): Promise<void> {
    const clipped = detail.length > 4_000 ? `${detail.slice(0, 4_000)}…` : detail;
    await this.db
      .update(toolExecutionLedger)
      .set({
        status,
        ...(status === 'failed' ? { error: clipped } : { result: clipped }),
        settledAt: new Date(nowMs),
      })
      .where(
        and(
          eq(toolExecutionLedger.idempotencyKey, idempotencyKey),
          inArray(toolExecutionLedger.status, ['executing', 'failed']),
        ),
      );
  }

  public async purgeSettled(beforeMs: number): Promise<number> {
    const rows = await this.db
      .delete(toolExecutionLedger)
      .where(
        and(
          inArray(toolExecutionLedger.status, ['succeeded', 'failed']),
          lt(toolExecutionLedger.settledAt, new Date(beforeMs)),
        ),
      )
      .returning({ id: toolExecutionLedger.id });
    return rows.length;
  }
}