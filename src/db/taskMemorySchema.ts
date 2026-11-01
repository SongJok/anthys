import { and, desc, eq, gte, ilike, or, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  SaveTaskResultInput,
  TaskResultRecord,
  TaskResultSearchQuery,
  TaskResultStore,
} from '../types/task-memory.js';
import type { AgentJobKind } from '../types/jobs.js';

/** 已完成后台任务的结果快照；与会话语义绑定，供 task_result_search 检索 */
export const taskResults = pgTable(
  'task_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    conversationType: varchar('conversation_type', { length: 1 })
      .notNull()
      .default('2'),
    taskId: text('task_id'),
    senderStaffId: text('sender_staff_id').notNull().default(''),
    senderNick: text('sender_nick').notNull().default(''),
    kind: varchar('kind', { length: 24 }).notNull().default('task'),
    worker: text('worker'),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
    totalTokens: integer('total_tokens').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('task_results_job_idx').on(table.jobId),
    index('task_results_conversation_completed_idx').on(
      table.conversationId,
      table.completedAt,
    ),
    index('task_results_sender_completed_idx').on(
      table.senderStaffId,
      table.completedAt,
    ),
  ],
);

type TaskResultRow = typeof taskResults.$inferSelect;

function toRecord(row: TaskResultRow): TaskResultRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    conversationId: row.conversationId,
    conversationType: row.conversationType === '1' ? '1' : '2',
    taskId: row.taskId,
    senderStaffId: row.senderStaffId,
    senderNick: row.senderNick,
    kind: row.kind as AgentJobKind,
    worker: row.worker,
    question: row.question,
    answer: row.answer,
    keywords: row.keywords,
    totalTokens: row.totalTokens,
    completedAt: row.completedAt.getTime(),
    createdAt: row.createdAt.getTime(),
  };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .split(/[\s,，。;；、/|:：]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  ].slice(0, 8);
}

/** PostgreSQL 持久化实现；job_id 唯一，重试完成只保留最后一份结果 */
export class DrizzleTaskResultStore implements TaskResultStore {
  constructor(private readonly db: Database) {}

  public async save(input: SaveTaskResultInput): Promise<TaskResultRecord> {
    const rows = await this.db
      .insert(taskResults)
      .values({
        jobId: input.jobId,
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        taskId: input.taskId ?? null,
        senderStaffId: input.senderStaffId,
        senderNick: input.senderNick,
        kind: input.kind,
        worker: input.worker ?? null,
        question: input.question,
        answer: input.answer,
        keywords: input.keywords,
        totalTokens: Math.max(0, Math.round(input.totalTokens)),
        completedAt: new Date(input.completedAt),
      })
      .onConflictDoUpdate({
        target: taskResults.jobId,
        set: {
          question: input.question,
          answer: input.answer,
          keywords: input.keywords,
          totalTokens: Math.max(0, Math.round(input.totalTokens)),
          completedAt: new Date(input.completedAt),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to save task result memory');
    return toRecord(row);
  }

  public async search(
    query: TaskResultSearchQuery,
  ): Promise<TaskResultRecord[]> {
    const conditions = [
      eq(taskResults.conversationId, query.conversationId),
    ];
    if (query.sinceMs !== undefined) {
      conditions.push(gte(taskResults.completedAt, new Date(query.sinceMs)));
    }
    const terms = searchTerms(query.query ?? '');
    if (terms.length > 0) {
      conditions.push(
        or(
          ...terms.flatMap((term) => {
            const pattern = `%${escapeLike(term)}%`;
            return [
              ilike(taskResults.question, pattern),
              ilike(taskResults.answer, pattern),
              sql`${taskResults.keywords} ? ${term}`,
            ];
          }),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(taskResults)
      .where(and(...conditions))
      .orderBy(desc(taskResults.completedAt))
      .limit(Math.max(1, Math.min(10, query.limit ?? 5)));
    return rows.map(toRecord);
  }

  public async prune(conversationId: string, keep: number): Promise<number> {
    const limit = Math.max(1, Math.trunc(keep));
    const result = await this.db.execute(sql`
      DELETE FROM ${taskResults}
      WHERE ${taskResults.conversationId} = ${conversationId}
        AND ${taskResults.id} NOT IN (
          SELECT ${taskResults.id}
          FROM ${taskResults}
          WHERE ${taskResults.conversationId} = ${conversationId}
          ORDER BY ${taskResults.completedAt} DESC
          LIMIT ${limit}
        )
    `);
    return result.rowCount ?? 0;
  }
}
