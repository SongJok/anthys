import { and, eq, gt, lt } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  PendingActionPersistence,
  PendingToolAction,
} from '../harness/ToolApprovalGate.js';

/** 待确认写操作：支持按会话并发保留多条（按 action id 主键存储），重启后仍可继续 /confirm */
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
  },
  (table) => [
    index('pending_actions_conv_idx').on(table.conversationId),
    index('pending_actions_expires_idx').on(table.expiresAt),
  ],
);

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
      .where(gt(pendingActions.expiresAt, new Date(nowMs)));
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
        },
      });
  }

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

  public async purgeExpired(nowMs: number): Promise<number> {
    const rows = await this.db
      .delete(pendingActions)
      .where(lt(pendingActions.expiresAt, new Date(nowMs)))
      .returning({ id: pendingActions.id });
    return rows.length;
  }
}
