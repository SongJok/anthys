import { and, eq, gte, lt, sql } from 'drizzle-orm';
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
  UsageBreakdownRow,
  UsageLedgerInput,
  UsageLedgerStore,
  UsageSummary,
} from '../types/admin-and-console.js';

/** 每次模型调用的用量流水，用于配额判定与账单报表 */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    conversationType: varchar('conversation_type', { length: 1 })
      .notNull()
      .default('1'),
    senderStaffId: text('sender_staff_id').notNull().default(''),
    senderNick: text('sender_nick').notNull().default(''),
    model: text('model').notNull().default(''),
    totalTokens: integer('total_tokens').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_input_tokens').notNull().default(0),
    /** 人民币 micros；priced=false 表示未配置该模型价格，不能当作 0 元 */
    costMicros: integer('cost_micros').notNull().default(0),
    priced: boolean('priced').notNull().default(false),
    steps: integer('steps').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    proactive: boolean('proactive').notNull().default(false),
    jobId: text('job_id'),
    jobKind: varchar('job_kind', { length: 24 }),
    worker: varchar('worker', { length: 24 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('usage_ledger_created_idx').on(table.createdAt),
    index('usage_ledger_user_created_idx').on(
      table.senderStaffId,
      table.createdAt,
    ),
    index('usage_ledger_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class DrizzleUsageLedgerStore implements UsageLedgerStore {
  constructor(private readonly db: Database) {}

  public async append(input: UsageLedgerInput): Promise<void> {
    await this.db.insert(usageLedger).values({
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      senderStaffId: input.senderStaffId,
      senderNick: input.senderNick,
      model: input.model,
      totalTokens: Math.max(0, Math.round(input.totalTokens)),
      inputTokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
      cachedTokens: Math.max(0, Math.round(input.cachedTokens ?? 0)),
      costMicros: Math.max(0, Math.round(input.costMicros ?? 0)),
      priced: input.priced === true,
      steps: Math.max(0, Math.round(input.steps)),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      proactive: input.proactive,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.jobKind ? { jobKind: input.jobKind } : {}),
      ...(input.worker ? { worker: input.worker } : {}),
    });
  }

  public async tokensSince(filter: {
    sinceMs: number;
    senderStaffId?: string;
    conversationId?: string;
  }): Promise<number> {
    const conditions = [gte(usageLedger.createdAt, new Date(filter.sinceMs))];
    if (filter.senderStaffId) {
      conditions.push(eq(usageLedger.senderStaffId, filter.senderStaffId));
    }
    if (filter.conversationId) {
      conditions.push(eq(usageLedger.conversationId, filter.conversationId));
    }
    const rows = await this.db
      .select({
        tokens: sql<string>`coalesce(sum(${usageLedger.totalTokens}), 0)`,
      })
      .from(usageLedger)
      .where(and(...conditions));
    return toNumber(rows[0]?.tokens);
  }

  public async summarySince(sinceMs: number): Promise<UsageSummary> {
    const since = new Date(sinceMs);
    const tokens = sql<string>`coalesce(sum(${usageLedger.totalTokens}), 0)`;
    const inputTokens = sql<string>`coalesce(sum(${usageLedger.inputTokens}), 0)`;
    const outputTokens = sql<string>`coalesce(sum(${usageLedger.outputTokens}), 0)`;
    const costMicros = sql<string>`coalesce(sum(${usageLedger.costMicros}), 0)`;
    const turns = sql<string>`count(*)`;
    const pricedTurns = sql<string>`coalesce(sum(case when ${usageLedger.priced} then 1 else 0 end), 0)`;

    const userRows = await this.db
      .select({
        key: usageLedger.senderStaffId,
        label: sql<string>`max(${usageLedger.senderNick})`,
        tokens,
        inputTokens,
        outputTokens,
        costMicros,
        turns,
        pricedTurns,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.senderStaffId);
    const conversationRows = await this.db
      .select({
        key: usageLedger.conversationId,
        label: usageLedger.conversationId,
        tokens,
        costMicros,
        turns,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.conversationId);
    const modelRows = await this.db
      .select({
        key: usageLedger.model,
        label: usageLedger.model,
        tokens,
        costMicros,
        turns,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.model);
    const workerRows = await this.db
      .select({
        key: sql<string>`coalesce(${usageLedger.worker}, '')`,
        label: sql<string>`coalesce(${usageLedger.worker}, '')`,
        tokens,
        costMicros,
        turns,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(sql`coalesce(${usageLedger.worker}, '')`);
    const jobKindRows = await this.db
      .select({
        key: sql<string>`coalesce(${usageLedger.jobKind}, '')`,
        label: sql<string>`coalesce(${usageLedger.jobKind}, '')`,
        tokens,
        costMicros,
        turns,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(sql`coalesce(${usageLedger.jobKind}, '')`);

    const toRows = (
      rows: Array<{
        key: string;
        label: string | null;
        tokens: string;
        costMicros: string;
        turns: string;
      }>,
      emptyLabel: string,
    ): UsageBreakdownRow[] =>
      rows
        .filter((row) => row.key.trim().length > 0)
        .map((row) => ({
          key: row.key,
          label: row.label?.trim() || emptyLabel,
          tokens: toNumber(row.tokens),
          turns: toNumber(row.turns),
          costMicros: toNumber(row.costMicros),
        }))
        .sort((a, b) => b.tokens - a.tokens);

    const users = toRows(userRows, '未知员工');
    const conversations = toRows(conversationRows, '未知会话');
    return {
      sinceMs,
      totalTokens: users.reduce((sum, row) => sum + row.tokens, 0),
      totalInputTokens: userRows.reduce(
        (sum, row) => sum + toNumber(row.inputTokens),
        0,
      ),
      totalOutputTokens: userRows.reduce(
        (sum, row) => sum + toNumber(row.outputTokens),
        0,
      ),
      totalTurns: users.reduce((sum, row) => sum + row.turns, 0),
      totalCostMicros: users.reduce((sum, row) => sum + row.costMicros, 0),
      pricedTurns: userRows.reduce(
        (sum, row) => sum + toNumber(row.pricedTurns),
        0,
      ),
      byUser: users,
      byConversation: conversations,
      byModel: toRows(modelRows, '未知模型'),
      byWorker: toRows(workerRows, '直接对话'),
      byJobKind: toRows(jobKindRows, '直接对话'),
    };
  }

  public async purgeBefore(epochMs: number): Promise<number> {
    const rows = await this.db
      .delete(usageLedger)
      .where(lt(usageLedger.createdAt, new Date(epochMs)))
      .returning({ id: usageLedger.id });
    return rows.length;
  }
}
