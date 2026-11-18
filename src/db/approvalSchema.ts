import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  PendingActionPersistence,
  PendingToolAction,
} from '../harness/ToolApprovalGate.js';

/**
 * 待确认写操作 + 执行状态机：
 * pending → executing → succeeded / failed；
 * pending → cancelled / expired；executing 在进程重启后 → unknown（绝不自动重放）。
 * 终态行保留供审计，由 purgeSettled 按保留期清理。
 */
export const pendingActions = pgTable(
  'pending_actions',
  {
    id: uuid('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    risk: varchar('risk', { length: 16 }).notNull(),
    requestedBy: jsonb('requested_by')
      .$type<PendingToolAction['requestedBy']>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    result: text('result'),
    error: text('error'),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    index('pending_actions_conv_idx').on(table.conversationId),
    index('pending_actions_expires_idx').on(table.expiresAt),
    index('pending_actions_status_idx').on(table.status),
  ],
);

export const TERMINAL_PENDING_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'unknown',
] as const;

function toAction(row: typeof pendingActions.$inferSelect): PendingToolAction {
  return {
    id: row.id,
    conversationId: row.conversationId,
    toolName: row.toolName,
    args: row.args ?? {},
    risk:
      row.risk === 'write' || row.risk === 'destructive' ? row.risk : 'read',
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export class DrizzlePendingActionPersistence
  implements PendingActionPersistence
{
  constructor(private readonly db: Database) {}

  public async load(nowMs: number): Promise<PendingToolAction[]> {
    const rows = await this.db
      .select()
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.status, 'pending'),
          gt(pendingActions.expiresAt, new Date(nowMs)),
        ),
      );
    return rows.map(toAction);
  }

  public async save(action: PendingToolAction): Promise<void> {
    await this.db
      .insert(pendingActions)
      .values({
        id: action.id,
        conversationId: action.conversationId,
        toolName: action.toolName,
        args: action.args,
        risk: action.risk,
        requestedBy: action.requestedBy,
        createdAt: new Date(action.createdAt),
        expiresAt: new Date(action.expiresAt),
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: pendingActions.id,
        set: {
          conversationId: action.conversationId,
          toolName: action.toolName,
          args: action.args,
          risk: action.risk,
          requestedBy: action.requestedBy,
          createdAt: new Date(action.createdAt),
          expiresAt: new Date(action.expiresAt),
          status: 'pending',
        },
      });
  }

  /** 容量淘汰专用：直接删除（用户取消走 cancelPending 保留审计） */
  public async remove(
    conversationId: string,
    actionId?: string,
  ): Promise<void> {
    if (actionId) {
      await this.db
        .delete(pendingActions)
        .where(
          and(
            eq(pendingActions.conversationId, conversationId),
            eq(pendingActions.id, actionId),
          ),
        );
      return;
    }
    await this.db
      .delete(pendingActions)
      .where(eq(pendingActions.conversationId, conversationId));
  }

  /** CAS 抢占：只有 pending 且未过期的动作能被登记为 executing */
  public async claim(
    actionId: string,
    owner: string,
    nowMs: number,
  ): Promise<PendingToolAction | null> {
    const rows = await this.db
      .update(pendingActions)
      .set({
        status: 'executing',
        claimedBy: owner,
        claimedAt: new Date(nowMs),
      })
      .where(
        and(
          eq(pendingActions.id, actionId),
          eq(pendingActions.status, 'pending'),
          gt(pendingActions.expiresAt, new Date(nowMs)),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toAction(row) : null;
  }

  public async settle(
    actionId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    detail: string,
    nowMs: number,
  ): Promise<void> {
    const clipped = detail.length > 4_000 ? `${detail.slice(0, 4_000)}…` : detail;
    await this.db
      .update(pendingActions)
      .set({
        status,
        ...(status === 'failed' ? { error: clipped } : { result: clipped }),
        settledAt: new Date(nowMs),
      })
      .where(
        and(
          eq(pendingActions.id, actionId),
          inArray(pendingActions.status, ['executing', 'pending']),
        ),
      );
  }

  public async cancelPending(
    conversationId: string,
    actionId?: string,
    nowMs?: number,
  ): Promise<number> {
    const rows = await this.db
      .update(pendingActions)
      .set({ status: 'cancelled', settledAt: new Date(nowMs ?? Date.now()) })
      .where(
        and(
          eq(pendingActions.conversationId, conversationId),
          eq(pendingActions.status, 'pending'),
          ...(actionId ? [eq(pendingActions.id, actionId)] : []),
        ),
      )
      .returning({ id: pendingActions.id });
    return rows.length;
  }

  /** 重启恢复：上一进程 executing 的动作结果未知，标记 unknown，绝不自动重放 */
  public async recoverExecuting(nowMs: number): Promise<PendingToolAction[]> {
    const rows = await this.db
      .update(pendingActions)
      .set({ status: 'unknown', settledAt: new Date(nowMs) })
      .where(eq(pendingActions.status, 'executing'))
      .returning();
    return rows.map(toAction);
  }

  public async markExpired(nowMs: number): Promise<number> {
    const rows = await this.db
      .update(pendingActions)
      .set({ status: 'expired', settledAt: new Date(nowMs) })
      .where(
        and(
          eq(pendingActions.status, 'pending'),
          lt(pendingActions.expiresAt, new Date(nowMs)),
        ),
      )
      .returning({ id: pendingActions.id });
    return rows.length;
  }

  public async purgeSettled(beforeMs: number): Promise<number> {
    const rows = await this.db
      .delete(pendingActions)
      .where(
        and(
          inArray(pendingActions.status, [...TERMINAL_PENDING_STATUSES]),
          lt(pendingActions.settledAt, new Date(beforeMs)),
        ),
      )
      .returning({ id: pendingActions.id });
    return rows.length;
  }
}