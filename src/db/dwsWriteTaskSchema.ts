import { and, eq, gt, sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type { InboundMessage } from '../types/core.js';
import type {
  DwsWriteTask,
  DwsWriteTaskStore,
} from '../types/dws-write-task.js';

/**
 * 等待本人 DWS 授权后自动续跑的写任务。
 * 任务里保存原始消息快照，授权成功后按同一条消息重新执行，避免用户重复提问。
 */
export const dwsWriteTasks = pgTable('dws_write_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: text('conversation_id').notNull().unique(),
  staffId: text('staff_id').notNull(),
  message: jsonb('message').$type<InboundMessage>().notNull(),
  toolName: text('tool_name').notNull(),
  args: jsonb('args').$type<Record<string, unknown>>().notNull(),
  risk: text('risk').notNull(),
  state: text('state').notNull().default('waiting_auth'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

type Row = typeof dwsWriteTasks.$inferSelect;

function toTask(row: Row): DwsWriteTask {
  return {
    id: row.id,
    conversationId: row.conversationId,
    staffId: row.staffId,
    message: row.message,
    toolName: row.toolName,
    args: row.args,
    risk: row.risk === 'destructive' ? 'destructive' : 'write',
    state: row.state as DwsWriteTask['state'],
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export class DrizzleDwsWriteTaskStore implements DwsWriteTaskStore {
  constructor(private readonly db: Database) {}

  public async save(task: DwsWriteTask): Promise<void> {
    await this.db
      .insert(dwsWriteTasks)
      .values({
        id: task.id,
        conversationId: task.conversationId,
        staffId: task.staffId,
        message: task.message,
        toolName: task.toolName,
        args: task.args,
        risk: task.risk,
        state: task.state,
        attempts: task.attempts,
        lastError: task.lastError,
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
        expiresAt: new Date(task.expiresAt),
      })
      .onConflictDoUpdate({
        target: dwsWriteTasks.conversationId,
        set: {
          staffId: task.staffId,
          message: task.message,
          toolName: task.toolName,
          args: task.args,
          risk: task.risk,
          state: task.state,
          attempts: task.attempts,
          lastError: task.lastError,
          updatedAt: new Date(task.updatedAt),
          expiresAt: new Date(task.expiresAt),
        },
      });
  }

  public async getByConversation(
    conversationId: string,
  ): Promise<DwsWriteTask | null> {
    const rows = await this.db
      .select()
      .from(dwsWriteTasks)
      .where(eq(dwsWriteTasks.conversationId, conversationId))
      .limit(1);
    const row = rows[0];
    return row ? toTask(row) : null;
  }

  public async listWaiting(nowMs: number): Promise<DwsWriteTask[]> {
    const rows = await this.db
      .select()
      .from(dwsWriteTasks)
      .where(
        and(
          eq(dwsWriteTasks.state, 'waiting_auth'),
          gt(dwsWriteTasks.expiresAt, new Date(nowMs)),
        ),
      );
    return rows.map(toTask);
  }

  public async claim(
    id: string,
    nowMs: number,
  ): Promise<DwsWriteTask | null> {
    const rows = await this.db
      .update(dwsWriteTasks)
      .set({
        state: 'resuming',
        attempts: sql`${dwsWriteTasks.attempts} + 1`,
        updatedAt: new Date(nowMs),
      })
      .where(
        and(
          eq(dwsWriteTasks.id, id),
          eq(dwsWriteTasks.state, 'waiting_auth'),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toTask(row) : null;
  }

  public async update(task: DwsWriteTask): Promise<void> {
    await this.db
      .update(dwsWriteTasks)
      .set({
        state: task.state,
        attempts: task.attempts,
        lastError: task.lastError,
        updatedAt: new Date(task.updatedAt),
        expiresAt: new Date(task.expiresAt),
      })
      .where(eq(dwsWriteTasks.id, task.id));
  }

  public async remove(conversationId: string): Promise<void> {
    await this.db
      .delete(dwsWriteTasks)
      .where(eq(dwsWriteTasks.conversationId, conversationId));
  }
}
