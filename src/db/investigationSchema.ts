import { index, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  InvestigationAuditRecord,
  InvestigationAuditStore,
} from '../types/investigation.js';

/** 静默调查审计：每次真实调查都留痕，便于复盘成本与误报 */
export const silentInvestigations = pgTable(
  'silent_investigations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    triggerMessageId: text('trigger_message_id').notNull(),
    senderStaffId: text('sender_staff_id').notNull(),
    query: text('query').notNull(),
    status: text('status').notNull(),
    confidence: real('confidence').notNull().default(0),
    evidenceScore: real('evidence_score').notNull().default(0),
    reason: text('reason').notNull().default(''),
    answer: text('answer').notNull().default(''),
    tokens: integer('tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('silent_investigations_conversation_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    index('silent_investigations_status_idx').on(table.status, table.createdAt),
  ],
);

export class DrizzleSilentInvestigationStore implements InvestigationAuditStore {
  constructor(private readonly db: Database) {}

  public async append(record: InvestigationAuditRecord): Promise<void> {
    await this.db.insert(silentInvestigations).values({
      id: record.id,
      conversationId: record.conversationId,
      triggerMessageId: record.triggerMessageId,
      senderStaffId: record.senderStaffId,
      query: record.query,
      status: record.status,
      confidence: record.confidence,
      evidenceScore: record.evidenceScore,
      reason: record.reason,
      answer: record.answer,
      tokens: record.tokens,
      durationMs: record.durationMs,
      createdAt: new Date(record.createdAt),
    });
  }
}
