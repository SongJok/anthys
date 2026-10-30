import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import { conversations } from './schema.js';
import type {
  EpisodicSummaryRecord,
  GroupBystanderPolicy,
  SemanticMemoryRecord,
  SemanticRecallQuery,
} from '../types/bystander-and-memory.js';

/** 情景记忆：超长对话的滚动摘要归档 */
export const conversationSummaries = pgTable(
  'conversation_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    coveredMessageIds: jsonb('covered_message_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('conversation_summaries_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/**
 * 语义与画像记忆：企业黑话/项目缩写映射、员工职责画像。
 * embedding 需要数据库执行 CREATE EXTENSION IF NOT EXISTS vector;
 */
export const semanticMemories = pgTable(
  'semantic_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 16 }).notNull(),
    subjectKey: text('subject_key').notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    content: text('content').notNull(),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
    embedding: vector('embedding', { dimensions: 1536 }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('semantic_memories_identity_idx').on(
      table.scope,
      table.subjectKey,
      table.kind,
      table.content,
    ),
    index('semantic_memories_subject_idx').on(table.scope, table.subjectKey),
  ],
);

/** 群聊旁听策略：数据库可覆盖配置文件默认值 */
export const bystanderPolicies = pgTable('bystander_policies', {
  conversationId: text('conversation_id').primaryKey(),
  bystanderEnabled: boolean('bystander_enabled').notNull().default(true),
  proactiveReplyEnabled: boolean('proactive_reply_enabled')
    .notNull()
    .default(true),
  slidingWindowSize: integer('sliding_window_size').notNull().default(20),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(180),
  confidenceThreshold: real('confidence_threshold').notNull().default(0.82),
  triggerTopics: jsonb('trigger_topics').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export interface EpisodicSummaryStore {
  appendSummary(input: {
    conversationId: string;
    summary: string;
    coveredMessageIds: string[];
    tokenCount: number;
  }): Promise<EpisodicSummaryRecord>;
  listSummaries(
    conversationId: string,
    limit: number,
  ): Promise<EpisodicSummaryRecord[]>;
}

export interface SemanticMemoryStore {
  upsert(input: {
    scope: SemanticMemoryRecord['scope'];
    subjectKey: string;
    kind: SemanticMemoryRecord['kind'];
    content: string;
    keywords: string[];
    embedding?: number[] | null;
  }): Promise<SemanticMemoryRecord>;
  search(query: SemanticRecallQuery): Promise<SemanticMemoryRecord[]>;
}

export interface BystanderPolicyStore {
  getPolicy(conversationId: string): Promise<GroupBystanderPolicy | null>;
  upsertPolicy(policy: GroupBystanderPolicy): Promise<void>;
}

function toSummaryRecord(row: {
  id: string;
  conversationId: string;
  summary: string;
  coveredMessageIds: string[];
  tokenCount: number;
  createdAt: Date;
}): EpisodicSummaryRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    summary: row.summary,
    coveredMessageIds: row.coveredMessageIds,
    tokenCount: row.tokenCount,
    createdAt: row.createdAt.getTime(),
  };
}

function toSemanticRecord(row: {
  id: string;
  scope: string;
  subjectKey: string;
  kind: string;
  content: string;
  keywords: string[];
  embedding: number[] | null;
  updatedAt: Date;
}): SemanticMemoryRecord {
  return {
    id: row.id,
    scope: row.scope as SemanticMemoryRecord['scope'],
    subjectKey: row.subjectKey,
    kind: row.kind as SemanticMemoryRecord['kind'],
    content: row.content,
    keywords: row.keywords,
    embedding: row.embedding,
    updatedAt: row.updatedAt.getTime(),
  };
}

/** PostgreSQL 持久化实现：情景摘要、语义召回与旁听策略 */
export class DrizzleMemoryStore
  implements EpisodicSummaryStore, SemanticMemoryStore, BystanderPolicyStore
{
  constructor(private readonly db: Database) {}

  public async appendSummary(input: {
    conversationId: string;
    summary: string;
    coveredMessageIds: string[];
    tokenCount: number;
  }): Promise<EpisodicSummaryRecord> {
    const rows = await this.db
      .insert(conversationSummaries)
      .values({
        conversationId: input.conversationId,
        summary: input.summary,
        coveredMessageIds: input.coveredMessageIds,
        tokenCount: input.tokenCount,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to append conversation summary');
    return toSummaryRecord(row);
  }

  public async listSummaries(
    conversationId: string,
    limit: number,
  ): Promise<EpisodicSummaryRecord[]> {
    const rows = await this.db
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.createdAt))
      .limit(Math.max(1, limit));
    return rows.reverse().map(toSummaryRecord);
  }

  public async upsert(input: {
    scope: SemanticMemoryRecord['scope'];
    subjectKey: string;
    kind: SemanticMemoryRecord['kind'];
    content: string;
    keywords: string[];
    embedding?: number[] | null;
  }): Promise<SemanticMemoryRecord> {
    const rows = await this.db
      .insert(semanticMemories)
      .values({
        scope: input.scope,
        subjectKey: input.subjectKey,
        kind: input.kind,
        content: input.content,
        keywords: input.keywords,
        embedding: input.embedding ?? null,
      })
      .onConflictDoUpdate({
        target: [
          semanticMemories.scope,
          semanticMemories.subjectKey,
          semanticMemories.kind,
          semanticMemories.content,
        ],
        set: {
          keywords: input.keywords,
          embedding: input.embedding ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to upsert semantic memory');
    return toSemanticRecord(row);
  }

  public async search(
    query: SemanticRecallQuery,
  ): Promise<SemanticMemoryRecord[]> {
    const limit = Math.max(1, query.limit ?? 6);
    const conditions = [];

    if (query.scope) {
      if (query.subjectKey) {
        conditions.push(
          or(
            and(
              eq(semanticMemories.scope, query.scope),
              eq(semanticMemories.subjectKey, query.subjectKey),
            ),
            eq(semanticMemories.scope, 'global'),
          ),
        );
      } else {
        conditions.push(eq(semanticMemories.scope, query.scope));
      }
    }

    const terms = query.query
      .split(/[\s,，。;；、/]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    // 有向量时按余弦距离召回，不再要求关键词命中；否则回退关键词匹配
    if (terms.length > 0 && !(query.embedding && query.embedding.length > 0)) {
      const keywordConditions = terms.map(
        (term) => sql`${semanticMemories.keywords} ? ${term}`,
      );
      const textConditions = terms.map((term) =>
        ilike(semanticMemories.content, `%${term}%`),
      );
      conditions.push(or(...keywordConditions, ...textConditions));
    }

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const distance =
      query.embedding && query.embedding.length > 0
        ? sql`${semanticMemories.embedding} <=> ${JSON.stringify(query.embedding)}::vector`
        : null;

    const rows = await this.db
      .select()
      .from(semanticMemories)
      .where(where)
      .orderBy(distance ?? desc(semanticMemories.updatedAt))
      .limit(limit);

    return rows.map(toSemanticRecord);
  }

  public async getPolicy(
    conversationId: string,
  ): Promise<GroupBystanderPolicy | null> {
    const rows = await this.db
      .select()
      .from(bystanderPolicies)
      .where(eq(bystanderPolicies.conversationId, conversationId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      bystanderEnabled: row.bystanderEnabled,
      proactiveReplyEnabled: row.proactiveReplyEnabled,
      slidingWindowSize: row.slidingWindowSize,
      cooldownSeconds: row.cooldownSeconds,
      confidenceThreshold: row.confidenceThreshold,
      triggerTopics: row.triggerTopics,
    };
  }

  public async upsertPolicy(policy: GroupBystanderPolicy): Promise<void> {
    await this.db
      .insert(bystanderPolicies)
      .values({
        conversationId: policy.conversationId,
        bystanderEnabled: policy.bystanderEnabled,
        proactiveReplyEnabled: policy.proactiveReplyEnabled,
        slidingWindowSize: policy.slidingWindowSize,
        cooldownSeconds: policy.cooldownSeconds,
        confidenceThreshold: policy.confidenceThreshold,
        triggerTopics: policy.triggerTopics,
      })
      .onConflictDoUpdate({
        target: bystanderPolicies.conversationId,
        set: {
          bystanderEnabled: policy.bystanderEnabled,
          proactiveReplyEnabled: policy.proactiveReplyEnabled,
          slidingWindowSize: policy.slidingWindowSize,
          cooldownSeconds: policy.cooldownSeconds,
          confidenceThreshold: policy.confidenceThreshold,
          triggerTopics: policy.triggerTopics,
          updatedAt: new Date(),
        },
      });
  }
}
