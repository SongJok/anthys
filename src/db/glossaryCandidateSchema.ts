import { and, desc, eq, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import {
  glossaryNameKey,
  isGlossarySensitivity,
  isGlossaryTimeliness,
  normalizeGlossaryList,
} from '../types/glossary.js';
import {
  type GlossaryCandidate,
  type GlossaryCandidateInput,
  type GlossaryCandidateListFilter,
  type GlossaryCandidateStatus,
  type GlossaryCandidateStore,
} from '../types/glossary-candidates.js';

/**
 * 黑话候选表：技能归纳的术语草稿先落这里（pending），
 * 管理员后台通过后才写入 glossary_terms。模板字段与术语表一致。
 */
export const glossaryCandidates = pgTable(
  'glossary_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    standardName: text('standard_name').notNull(),
    nameKey: text('name_key').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    definition: text('definition').notNull().default(''),
    usageScenarios: text('usage_scenarios').notNull().default(''),
    examples: jsonb('examples').$type<string[]>().notNull().default([]),
    misconceptions: text('misconceptions').notNull().default(''),
    department: text('department').notNull().default(''),
    timeliness: varchar('timeliness', { length: 16 })
      .notNull()
      .default('long_term'),
    sensitivity: varchar('sensitivity', { length: 16 })
      .notNull()
      .default('team'),
    docLinks: jsonb('doc_links').$type<string[]>().notNull().default([]),
    injectToPrompt: boolean('inject_to_prompt').notNull().default(true),
    promptPriority: integer('prompt_priority').notNull().default(0),
    sourceConversationId: text('source_conversation_id').notNull().default(''),
    evidence: text('evidence').notNull().default(''),
    submittedBy: text('submitted_by').notNull().default(''),
    reviewedBy: text('reviewed_by').notNull().default(''),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note').notNull().default(''),
    glossaryTermId: uuid('glossary_term_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('glossary_candidates_status_idx').on(table.status, table.createdAt),
    index('glossary_candidates_name_idx').on(table.nameKey),
  ],
);

type CandidateRow = typeof glossaryCandidates.$inferSelect;

function toCandidate(row: CandidateRow): GlossaryCandidate {
  return {
    id: row.id,
    status: row.status as GlossaryCandidateStatus,
    standardName: row.standardName,
    aliases: row.aliases,
    definition: row.definition,
    usageScenarios: row.usageScenarios,
    examples: row.examples,
    misconceptions: row.misconceptions,
    department: row.department,
    timeliness: isGlossaryTimeliness(row.timeliness)
      ? row.timeliness
      : 'long_term',
    sensitivity: isGlossarySensitivity(row.sensitivity)
      ? row.sensitivity
      : 'team',
    docLinks: row.docLinks,
    injectToPrompt: row.injectToPrompt,
    promptPriority: row.promptPriority,
    sourceConversationId: row.sourceConversationId,
    evidence: row.evidence,
    submittedBy: row.submittedBy,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.getTime() : null,
    reviewNote: row.reviewNote,
    glossaryTermId: row.glossaryTermId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** PostgreSQL 持久化实现：候选提交、查询与审批状态流转（不含术语入库） */
export class DrizzleGlossaryCandidateStore implements GlossaryCandidateStore {
  constructor(private readonly db: Database) {}

  public async submit(input: GlossaryCandidateInput): Promise<GlossaryCandidate> {
    const standardName = input.standardName.trim();
    const nameKey = glossaryNameKey(standardName);
    // 同名待审批候选幂等返回，避免技能重复提交刷屏
    const existing = await this.db
      .select()
      .from(glossaryCandidates)
      .where(
        and(
          eq(glossaryCandidates.nameKey, nameKey),
          eq(glossaryCandidates.status, 'pending'),
        ),
      )
      .limit(1);
    if (existing[0]) return toCandidate(existing[0]);

    const rows = await this.db
      .insert(glossaryCandidates)
      .values({
        status: 'pending',
        standardName,
        nameKey,
        aliases: normalizeGlossaryList(input.aliases),
        definition: input.definition.trim(),
        usageScenarios: (input.usageScenarios ?? '').trim(),
        examples: normalizeGlossaryList(input.examples),
        misconceptions: (input.misconceptions ?? '').trim(),
        department: (input.department ?? '').trim(),
        timeliness: input.timeliness ?? 'long_term',
        sensitivity: input.sensitivity ?? 'team',
        docLinks: normalizeGlossaryList(input.docLinks),
        injectToPrompt: input.injectToPrompt ?? true,
        promptPriority: Math.trunc(input.promptPriority ?? 0),
        sourceConversationId: input.sourceConversationId ?? '',
        evidence: input.evidence ?? '',
        submittedBy: input.submittedBy ?? '',
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to insert glossary candidate');
    return toCandidate(row);
  }

  public async list(
    filter: GlossaryCandidateListFilter,
  ): Promise<GlossaryCandidate[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 100)));
    const rows = await this.db
      .select()
      .from(glossaryCandidates)
      .where(
        filter.status
          ? eq(glossaryCandidates.status, filter.status)
          : undefined,
      )
      .orderBy(desc(glossaryCandidates.createdAt))
      .limit(limit);
    return rows.map(toCandidate);
  }

  public async getById(id: string): Promise<GlossaryCandidate | null> {
    const rows = await this.db
      .select()
      .from(glossaryCandidates)
      .where(eq(glossaryCandidates.id, id))
      .limit(1);
    return rows[0] ? toCandidate(rows[0]) : null;
  }

  public async markReviewed(
    id: string,
    review: {
      status: 'approved' | 'rejected';
      reviewedBy: string;
      reviewNote?: string;
      glossaryTermId?: string | null;
    },
  ): Promise<GlossaryCandidate | null> {
    const now = new Date();
    const rows = await this.db
      .update(glossaryCandidates)
      .set({
        status: review.status,
        reviewedBy: review.reviewedBy,
        reviewNote: review.reviewNote ?? '',
        glossaryTermId: review.glossaryTermId ?? null,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(glossaryCandidates.id, id),
          eq(glossaryCandidates.status, 'pending'),
        ),
      )
      .returning();
    return rows[0] ? toCandidate(rows[0]) : null;
  }

  public async countByStatus(): Promise<
    Record<GlossaryCandidateStatus, number>
  > {
    const rows = await this.db
      .select({
        status: glossaryCandidates.status,
        count: sql<number>`count(*)::int`,
      })
      .from(glossaryCandidates)
      .groupBy(glossaryCandidates.status);
    const counts: Record<GlossaryCandidateStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
    };
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'approved' || row.status === 'rejected') {
        counts[row.status] = row.count;
      }
    }
    return counts;
  }
}