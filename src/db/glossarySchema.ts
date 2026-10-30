import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import {
  glossaryNameKey,
  type GlossarySimilarMatch,
  type GlossaryStore,
  type GlossaryTerm,
  type GlossaryTermWrite,
} from '../types/glossary.js';

/**
 * 术语知识库：每条黑话一行，字段固定对应管理页模板。
 * 需要数据库启用 pgvector（与 semantic_memories 一致），embedding 可为空。
 */
export const glossaryTerms = pgTable(
  'glossary_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    standardName: text('standard_name').notNull(),
    /** 标准名称去重键（小写、压缩空白） */
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
    hitCount: integer('hit_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text('updated_by').notNull().default(''),
  },
  (table) => [
    uniqueIndex('glossary_terms_name_key_idx').on(table.nameKey),
    index('glossary_terms_status_idx').on(
      table.timeliness,
      table.sensitivity,
    ),
    index('glossary_terms_prompt_idx').on(
      table.injectToPrompt,
      table.promptPriority,
    ),
  ],
);

type GlossaryRow = typeof glossaryTerms.$inferSelect;

function toGlossaryTerm(row: GlossaryRow): GlossaryTerm {
  return {
    id: row.id,
    standardName: row.standardName,
    aliases: row.aliases,
    definition: row.definition,
    usageScenarios: row.usageScenarios,
    examples: row.examples,
    misconceptions: row.misconceptions,
    department: row.department,
    timeliness: row.timeliness as GlossaryTerm['timeliness'],
    sensitivity: row.sensitivity as GlossaryTerm['sensitivity'],
    docLinks: row.docLinks,
    injectToPrompt: row.injectToPrompt,
    promptPriority: row.promptPriority,
    hitCount: row.hitCount,
    lastUpdatedAt: row.lastUpdatedAt.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    updatedBy: row.updatedBy,
  };
}

/** PostgreSQL 持久化实现：术语 CRUD、命中计数与可选的向量召回 */
export class DrizzleGlossaryStore implements GlossaryStore {
  constructor(private readonly db: Database) {}

  public async listAll(): Promise<GlossaryTerm[]> {
    const rows = await this.db
      .select()
      .from(glossaryTerms)
      .orderBy(glossaryTerms.standardName);
    return rows.map(toGlossaryTerm);
  }

  public async getById(id: string): Promise<GlossaryTerm | null> {
    const rows = await this.db
      .select()
      .from(glossaryTerms)
      .where(eq(glossaryTerms.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toGlossaryTerm(row) : null;
  }

  public async insert(input: GlossaryTermWrite): Promise<GlossaryTerm> {
    const rows = await this.db
      .insert(glossaryTerms)
      .values({
        standardName: input.standardName,
        nameKey: glossaryNameKey(input.standardName),
        aliases: input.aliases,
        definition: input.definition,
        usageScenarios: input.usageScenarios,
        examples: input.examples,
        misconceptions: input.misconceptions,
        department: input.department,
        timeliness: input.timeliness,
        sensitivity: input.sensitivity,
        docLinks: input.docLinks,
        injectToPrompt: input.injectToPrompt,
        promptPriority: input.promptPriority,
        updatedBy: input.updatedBy,
        ...(input.embedding !== undefined ? { embedding: input.embedding } : {}),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to insert glossary term');
    return toGlossaryTerm(row);
  }

  public async update(
    id: string,
    input: GlossaryTermWrite,
  ): Promise<GlossaryTerm | null> {
    const now = new Date();
    const rows = await this.db
      .update(glossaryTerms)
      .set({
        standardName: input.standardName,
        nameKey: glossaryNameKey(input.standardName),
        aliases: input.aliases,
        definition: input.definition,
        usageScenarios: input.usageScenarios,
        examples: input.examples,
        misconceptions: input.misconceptions,
        department: input.department,
        timeliness: input.timeliness,
        sensitivity: input.sensitivity,
        docLinks: input.docLinks,
        injectToPrompt: input.injectToPrompt,
        promptPriority: input.promptPriority,
        updatedBy: input.updatedBy,
        updatedAt: now,
        lastUpdatedAt: now,
        ...(input.embedding !== undefined ? { embedding: input.embedding } : {}),
      })
      .where(eq(glossaryTerms.id, id))
      .returning();
    const row = rows[0];
    return row ? toGlossaryTerm(row) : null;
  }

  public async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(glossaryTerms)
      .where(eq(glossaryTerms.id, id))
      .returning({ id: glossaryTerms.id });
    return rows.length > 0;
  }

  public async incrementHits(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(glossaryTerms)
      .set({ hitCount: sql`${glossaryTerms.hitCount} + 1` })
      .where(inArray(glossaryTerms.id, ids));
  }

  public async searchSimilar(
    embedding: number[],
    options: {
      limit: number;
      excludeSensitive: boolean;
      includeRetired: boolean;
      maxDistance: number;
    },
  ): Promise<GlossarySimilarMatch[]> {
    const conditions = [isNotNull(glossaryTerms.embedding)];
    if (options.excludeSensitive) {
      conditions.push(ne(glossaryTerms.sensitivity, 'sensitive'));
    }
    if (!options.includeRetired) {
      conditions.push(ne(glossaryTerms.timeliness, 'retired'));
    }
    const distance = sql<number>`${glossaryTerms.embedding} <=> ${JSON.stringify(embedding)}::vector`;
    const rows = await this.db
      .select({ term: glossaryTerms, distance })
      .from(glossaryTerms)
      .where(and(...conditions))
      .orderBy(distance)
      .limit(Math.max(1, options.limit * 3));
    return rows
      .map((row) => ({
        term: toGlossaryTerm(row.term),
        distance: Number(row.distance),
      }))
      .filter(
        (match) =>
          Number.isFinite(match.distance) &&
          match.distance <= options.maxDistance,
      )
      .slice(0, Math.max(1, options.limit));
  }

  public async listMissingEmbeddings(limit: number): Promise<GlossaryTerm[]> {
    const rows = await this.db
      .select()
      .from(glossaryTerms)
      .where(isNull(glossaryTerms.embedding))
      .orderBy(desc(glossaryTerms.updatedAt))
      .limit(Math.max(1, limit));
    return rows.map(toGlossaryTerm);
  }

  public async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.db
      .update(glossaryTerms)
      .set({ embedding })
      .where(eq(glossaryTerms.id, id));
  }
}
