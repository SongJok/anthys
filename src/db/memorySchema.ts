import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
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
  SemanticMemoryAdminFilter,
  SemanticMemoryAdminPort,
  SemanticMemoryPatch,
  SemanticMemoryRecord,
  SemanticMemoryUpsertInput,
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
    /** 用户级记忆是否允许在该用户所在的群聊中召回 */
    shareableInGroup: boolean('shareable_in_group').notNull().default(false),
    sensitivity: varchar('sensitivity', { length: 16 })
      .notNull()
      .default('normal'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    sourceConversationId: text('source_conversation_id'),
    sourceConversationType: varchar('source_conversation_type', { length: 2 }),
    sourceMessageId: text('source_message_id'),
    confidence: real('confidence').notNull().default(0.8),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    index('semantic_memories_embedding_idx').using(
      'hnsw',
      sql`${table.embedding} vector_cosine_ops`,
    ),
  ],
);

/** 群聊旁听策略：数据库可覆盖配置文件默认值 */
export const bystanderPolicies = pgTable('bystander_policies', {
  conversationId: text('conversation_id').primaryKey(),
  bystanderEnabled: boolean('bystander_enabled').notNull().default(true),
  proactiveReplyEnabled: boolean('proactive_reply_enabled')
    .notNull()
    .default(true),
  silentInvestigationEnabled: boolean('silent_investigation_enabled')
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
  upsert(input: SemanticMemoryUpsertInput): Promise<SemanticMemoryRecord>;
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
  shareableInGroup: boolean;
  sensitivity: string;
  status: string;
  sourceConversationId: string | null;
  sourceConversationType: string | null;
  sourceMessageId: string | null;
  confidence: number;
  expiresAt: Date | null;
  createdAt: Date;
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
    shareableInGroup: row.shareableInGroup,
    sensitivity: row.sensitivity as SemanticMemoryRecord['sensitivity'],
    status: row.status as SemanticMemoryRecord['status'],
    sourceConversationId: row.sourceConversationId,
    sourceConversationType:
      row.sourceConversationType === '1' || row.sourceConversationType === '2'
        ? row.sourceConversationType
        : null,
    sourceMessageId: row.sourceMessageId,
    confidence: row.confidence,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** PostgreSQL 持久化实现：情景摘要、语义召回与旁听策略 */
export class DrizzleMemoryStore
  implements
    EpisodicSummaryStore,
    SemanticMemoryStore,
    SemanticMemoryAdminPort,
    BystanderPolicyStore
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

  public async upsert(
    input: SemanticMemoryUpsertInput,
  ): Promise<SemanticMemoryRecord> {
    const shareableInGroup =
      input.shareableInGroup ?? input.scope !== 'user';
    const sensitivity =
      input.sensitivity ?? (input.scope === 'user' ? 'private' : 'normal');
    const rows = await this.db
      .insert(semanticMemories)
      .values({
        scope: input.scope,
        subjectKey: input.subjectKey,
        kind: input.kind,
        content: input.content,
        keywords: input.keywords,
        embedding: input.embedding ?? null,
        shareableInGroup,
        sensitivity,
        status: input.status ?? 'active',
        sourceConversationId: input.sourceConversationId ?? null,
        sourceConversationType: input.sourceConversationType ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        confidence: input.confidence ?? 0.8,
        expiresAt:
          input.expiresAt === null || input.expiresAt === undefined
            ? null
            : new Date(input.expiresAt),
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
          ...(input.shareableInGroup !== undefined
            ? { shareableInGroup }
            : {}),
          ...(input.sensitivity !== undefined ? { sensitivity } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.sourceConversationId !== undefined
            ? { sourceConversationId: input.sourceConversationId }
            : {}),
          ...(input.sourceConversationType !== undefined
            ? { sourceConversationType: input.sourceConversationType }
            : {}),
          ...(input.sourceMessageId !== undefined
            ? { sourceMessageId: input.sourceMessageId }
            : {}),
          ...(input.confidence !== undefined
            ? { confidence: input.confidence }
            : {}),
          ...(input.expiresAt !== undefined
            ? {
                expiresAt:
                  input.expiresAt === null ? null : new Date(input.expiresAt),
              }
            : {}),
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
    const now = new Date(query.now ?? Date.now());

    conditions.push(eq(semanticMemories.status, 'active'));
    conditions.push(
      or(
        isNull(semanticMemories.expiresAt),
        gt(semanticMemories.expiresAt, now),
      ),
    );

    if (query.scope) {
      if (query.subjectKey) {
        const scopedMatch = and(
          eq(semanticMemories.scope, query.scope),
          eq(semanticMemories.subjectKey, query.subjectKey),
          ...(query.shareableOnly
            ? [eq(semanticMemories.shareableInGroup, true)]
            : []),
        );
        conditions.push(
          query.scope === 'group_member'
            ? scopedMatch
            : or(scopedMatch, eq(semanticMemories.scope, 'global')),
        );
      } else {
        conditions.push(eq(semanticMemories.scope, query.scope));
        if (query.shareableOnly) {
          conditions.push(eq(semanticMemories.shareableInGroup, true));
        }
      }
    } else if (query.shareableOnly) {
      conditions.push(eq(semanticMemories.shareableInGroup, true));
    }
    if (query.excludeSensitive) {
      conditions.push(ne(semanticMemories.sensitivity, 'sensitive'));
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

  public async list(
    filter: SemanticMemoryAdminFilter,
  ): Promise<{ total: number; items: SemanticMemoryRecord[] }> {
    const conditions = [];
    if (filter.scope) {
      conditions.push(eq(semanticMemories.scope, filter.scope));
    }
    if (filter.subjectKey) {
      conditions.push(eq(semanticMemories.subjectKey, filter.subjectKey));
    }
    if (filter.kind) {
      conditions.push(eq(semanticMemories.kind, filter.kind));
    }
    if (filter.status) {
      conditions.push(eq(semanticMemories.status, filter.status));
    }
    const query = filter.query?.trim();
    if (query) {
      conditions.push(
        or(
          ilike(semanticMemories.content, `%${query}%`),
          ilike(semanticMemories.subjectKey, `%${query}%`),
          sql`${semanticMemories.keywords} ? ${query}`,
        ),
      );
    }
    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const [totalRows, rows] = await Promise.all([
      this.db.select({ value: count() }).from(semanticMemories).where(where),
      this.db
        .select()
        .from(semanticMemories)
        .where(where)
        .orderBy(desc(semanticMemories.updatedAt))
        .limit(limit)
        .offset(offset),
    ]);
    return {
      total: Number(totalRows[0]?.value ?? 0),
      items: rows.map(toSemanticRecord),
    };
  }

  public async get(id: string): Promise<SemanticMemoryRecord | null> {
    const rows = await this.db
      .select()
      .from(semanticMemories)
      .where(eq(semanticMemories.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toSemanticRecord(row) : null;
  }

  public async update(
    id: string,
    patch: SemanticMemoryPatch,
  ): Promise<SemanticMemoryRecord> {
    const existingRows = await this.db
      .select()
      .from(semanticMemories)
      .where(eq(semanticMemories.id, id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error('未找到语义记忆');
    const rows = await this.db
      .update(semanticMemories)
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
        ...(patch.shareableInGroup !== undefined
          ? { shareableInGroup: patch.shareableInGroup }
          : {}),
        ...(patch.sensitivity !== undefined
          ? { sensitivity: patch.sensitivity }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.confidence !== undefined
          ? { confidence: patch.confidence }
          : {}),
        ...(patch.expiresAt !== undefined
          ? {
              expiresAt:
                patch.expiresAt === null ? null : new Date(patch.expiresAt),
            }
          : {}),
        ...(patch.content !== undefined && patch.content !== existing.content
          ? { embedding: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(semanticMemories.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error('未找到语义记忆');
    return toSemanticRecord(row);
  }

  public async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(semanticMemories)
      .where(eq(semanticMemories.id, id))
      .returning({ id: semanticMemories.id });
    return rows.length > 0;
  }

  /** 身份绑定后把旧 personKey 的用户级记忆与群成员专属记忆并入新身份，并清理重复条目 */
  public async reassignSubjectKey(
    from: string,
    to: string,
  ): Promise<number> {
    if (from === to) return 0;
    await this.db.execute(sql`
      DELETE FROM semantic_memories AS source
      USING semantic_memories AS target
      WHERE source.scope = 'user'
        AND target.scope = 'user'
        AND source.subject_key = ${from}
        AND target.subject_key = ${to}
        AND source.kind = target.kind
        AND source.content = target.content
    `);
    const rows = await this.db
      .update(semanticMemories)
      .set({ subjectKey: to, updatedAt: new Date() })
      .where(
        and(
          eq(semanticMemories.scope, 'user'),
          eq(semanticMemories.subjectKey, from),
        ),
      )
      .returning({ id: semanticMemories.id });

    const fromSuffix = `::${from}`;
    const toSuffix = `::${to}`;
    await this.db.execute(sql`
      DELETE FROM semantic_memories AS source
      USING semantic_memories AS target
      WHERE source.scope = 'group_member'
        AND target.scope = 'group_member'
        AND right(source.subject_key, length(${fromSuffix})) = ${fromSuffix}
        AND target.subject_key = left(source.subject_key, length(source.subject_key) - length(${fromSuffix})) || ${toSuffix}
        AND source.kind = target.kind
        AND source.content = target.content
    `);
    const memberRows = await this.db.execute<{ id: string }>(sql`
      UPDATE semantic_memories
      SET subject_key = left(subject_key, length(subject_key) - length(${fromSuffix})) || ${toSuffix},
          updated_at = NOW()
      WHERE scope = 'group_member'
        AND right(subject_key, length(${fromSuffix})) = ${fromSuffix}
      RETURNING id
    `);
    return rows.length + memberRows.rows.length;
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
      silentInvestigationEnabled: row.silentInvestigationEnabled,
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
        silentInvestigationEnabled: policy.silentInvestigationEnabled,
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
          silentInvestigationEnabled: policy.silentInvestigationEnabled,
          slidingWindowSize: policy.slidingWindowSize,
          cooldownSeconds: policy.cooldownSeconds,
          confidenceThreshold: policy.confidenceThreshold,
          triggerTopics: policy.triggerTopics,
          updatedAt: new Date(),
        },
      });
  }
}
