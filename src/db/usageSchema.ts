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
    steps: integer('steps').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    proactive: boolean('proactive').notNull().default(false),
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
      steps: Math.max(0, Math.round(input.steps)),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      proactive: input.proactive,
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
    const userRows = await this.db
      .select({
        key: usageLedger.senderStaffId,
        label: sql<string>`max(${usageLedger.senderNick})`,
        tokens: sql<string>`coalesce(sum(${usageLedger.totalTokens}), 0)`,
        turns: sql<string>`count(*)`,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.senderStaffId);
    const conversationRows = await this.db
      .select({
        key: usageLedger.conversationId,
        label: usageLedger.conversationId,
        tokens: sql<string>`coalesce(sum(${usageLedger.totalTokens}), 0)`,
        turns: sql<string>`count(*)`,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.conversationId);

    const toRows = (
      rows: Array<{
        key: string;
        label: string | null;
        tokens: string;
        turns: string;
      }>,
    ): UsageBreakdownRow[] =>
      rows
        .map((row) => ({
          key: row.key,
          label: row.label ?? row.key,
          tokens: toNumber(row.tokens),
          turns: toNumber(row.turns),
        }))
        .sort((a, b) => b.tokens - a.tokens);

    const users = toRows(userRows);
    const conversations = toRows(conversationRows);
    return {
      sinceMs,
      totalTokens: users.reduce((sum, row) => sum + row.tokens, 0),
      totalTurns: users.reduce((sum, row) => sum + row.turns, 0),
      byUser: users,
      byConversation: conversations,
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
