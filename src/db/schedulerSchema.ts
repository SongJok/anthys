import { and, asc, eq, lte } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskStore,
  ScheduledTaskUpdate,
} from '../types/admin-and-console.js';

/** 定时主动播报：按固定间隔或 cron 向指定会话推送 */
export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    conversationType: varchar('conversation_type', { length: 1 })
      .notNull()
      .default('2'),
    kind: varchar('kind', { length: 20 }).notNull().default('prompt'),
    title: text('title').notNull().default(''),
    prompt: text('prompt').notNull(),
    intervalSeconds: integer('interval_seconds'),
    cron: text('cron'),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('scheduled_tasks_next_run_idx').on(table.enabled, table.nextRunAt),
  ],
);

function normalizeKind(value: string): ScheduledTaskKind {
  return value === 'reminder' ||
    value === 'daily_report' ||
    value === 'weekly_report' ||
    value === 'monthly_report'
    ? value
    : 'prompt';
}

function toTask(row: typeof scheduledTasks.$inferSelect): ScheduledTask {
  return {
    id: row.id,
    conversationId: row.conversationId,
    conversationType: row.conversationType === '1' ? '1' : '2',
    kind: normalizeKind(row.kind),
    title: row.title,
    prompt: row.prompt,
    intervalSeconds: row.intervalSeconds ?? null,
    cron: row.cron ?? null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleScheduledTaskStore implements ScheduledTaskStore {
  constructor(private readonly db: Database) {}

  public async list(): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(scheduledTasks)
      .orderBy(asc(scheduledTasks.createdAt));
    return rows.map(toTask);
  }

  public async listDue(atMs: number): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.enabled, true),
          lte(scheduledTasks.nextRunAt, new Date(atMs)),
        ),
      )
      .orderBy(asc(scheduledTasks.nextRunAt));
    return rows.map(toTask);
  }

  public async create(
    input: ScheduledTaskInput,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    const rows = await this.db
      .insert(scheduledTasks)
      .values({
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        kind: input.kind ?? 'prompt',
        title: input.title,
        prompt: input.prompt,
        intervalSeconds: input.intervalSeconds ?? null,
        cron: input.cron ?? null,
        enabled: input.enabled ?? true,
        nextRunAt: nextRunAtMs === null ? null : new Date(nextRunAtMs),
        createdBy: input.createdBy ?? '',
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to create scheduled task');
    return toTask(row);
  }

  public async update(
    id: string,
    input: ScheduledTaskUpdate,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    const rows = await this.db
      .update(scheduledTasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.intervalSeconds !== undefined
          ? { intervalSeconds: input.intervalSeconds }
          : {}),
        ...(input.cron !== undefined ? { cron: input.cron } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(nextRunAtMs !== null
          ? { nextRunAt: new Date(nextRunAtMs) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(scheduledTasks.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`未找到定时任务: ${id}`);
    return toTask(row);
  }

  public async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(scheduledTasks)
      .where(eq(scheduledTasks.id, id))
      .returning({ id: scheduledTasks.id });
    return rows.length > 0;
  }

  public async markRun(
    id: string,
    lastRunAtMs: number,
    nextRunAtMs: number | null,
  ): Promise<void> {
    await this.db
      .update(scheduledTasks)
      .set({
        lastRunAt: new Date(lastRunAtMs),
        nextRunAt: nextRunAtMs === null ? null : new Date(nextRunAtMs),
        updatedAt: new Date(),
      })
      .where(eq(scheduledTasks.id, id));
  }
}
