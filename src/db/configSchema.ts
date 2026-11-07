import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
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
import { conversations } from './schema.js';
import { bystanderPolicies } from './memorySchema.js';
import {
  dingtalkGroupDirectory,
  toGroupDirectoryEntry,
} from './groupSchema.js';
import type {
  AdminAuditInput,
  AdminAuditLog,
  ConfigScope,
  EnterpriseBotSystemConfig,
  FeedbackStore,
  GroupBotEntry,
  GroupBystanderPolicy,
  GroupDirectory,
  GroupDirectoryEntry,
  GroupDirectorySyncResult,
  GroupTraceStat,
  KnownGroup,
  UserFeedbackInput,
  UserFeedbackRecord,
  McpToolAccessPolicy,
  ReActTracePage,
  ReActTraceQuery,
  ReActTraceRecord,
  ReActTraceStore,
  TraceDailyStats,
} from '../types/admin-and-console.js';
import type { DynamicLoopPolicy, LLMAndPersonaConfig } from '../types/core.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import type { ExtensionsConfig } from '../types/skills-plugins-projects.js';

export type { ExtensionsConfig } from '../types/skills-plugins-projects.js';

export type { AdminAuditInput, AdminAuditLog } from '../types/admin-and-console.js';

/** 全局动态配置：每个 scope 一行，value 为该 scope 的完整 JSON 快照 */
export const sysConfigs = pgTable('sys_configs', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 管理员单聊/后台高危操作审计 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminStaffId: text('admin_staff_id').notNull(),
    adminNick: text('admin_nick').notNull().default(''),
    actionType: varchar('action_type', { length: 32 }).notNull(),
    beforeSnapshot: jsonb('before_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    afterSnapshot: jsonb('after_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('admin_audit_logs_created_idx').on(table.createdAt)],
);

/** ReAct 全链路轨迹：原生思维链、工具入参/耗时、沙盒输出与最终回答 */
export const reactTraces = pgTable(
  'react_traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id').notNull(),
    senderStaffId: text('sender_staff_id').notNull().default(''),
    senderNick: text('sender_nick').notNull().default(''),
    conversationType: varchar('conversation_type', { length: 1 }).notNull(),
    proactive: boolean('proactive').notNull().default(false),
    question: text('question').notNull().default(''),
    reasoning: text('reasoning').notNull().default(''),
    steps: jsonb('steps').$type<ReActTraceRecord['steps']>().notNull().default([]),
    answer: text('answer').notNull().default(''),
    totalTokens: integer('total_tokens').notNull().default(0),
    stepCount: integer('step_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('react_traces_created_idx').on(table.createdAt),
    index('react_traces_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/** 持久化的钉钉配置，AppSecret 明文只落库，不出现在管理 API 响应中 */
export type StoredDingTalkConfig = {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  aiCardTemplateId: string;
  adminStaffIds: string[];
  dwsCliEnabled: boolean;
  webSearchEnabled: boolean;
};

/** sys_configs 中各 scope 的 JSON 形状 */
export interface ConfigSectionMap {
  dingtalk: StoredDingTalkConfig;
  llm: LLMAndPersonaConfig;
  loopPolicy: DynamicLoopPolicy;
  mcpServers: EnterpriseMcpServerConfig[];
  defaultBystanderPolicy: Omit<GroupBystanderPolicy, 'conversationId'>;
  mcpAccessPolicies: McpToolAccessPolicy[];
  extensions: ExtensionsConfig;
}

export type ConfigSectionKey = keyof ConfigSectionMap;
export type ConfigSections = Partial<ConfigSectionMap>;

export interface ConfigStore {
  loadAll(): Promise<ConfigSections>;
  save<K extends ConfigSectionKey>(
    key: K,
    value: ConfigSectionMap[K],
  ): Promise<void>;
}

export interface AdminAuditStore {
  append(input: AdminAuditInput): Promise<AdminAuditLog>;
  list(limit: number): Promise<AdminAuditLog[]>;
}

export class DrizzleConfigStore implements ConfigStore {
  constructor(private readonly db: Database) {}

  public async loadAll(): Promise<ConfigSections> {
    const rows = await this.db.select().from(sysConfigs);
    const result: ConfigSections = {};
    for (const row of rows) {
      if (isConfigSectionKey(row.key)) {
        (result as Record<string, unknown>)[row.key] = row.value;
      }
    }
    return result;
  }

  public async save<K extends ConfigSectionKey>(
    key: K,
    value: ConfigSectionMap[K],
  ): Promise<void> {
    await this.db
      .insert(sysConfigs)
      .values({ key, value })
      .onConflictDoUpdate({
        target: sysConfigs.key,
        set: { value, updatedAt: new Date() },
      });
  }
}

export function isConfigSectionKey(value: string): value is ConfigSectionKey {
  return (
    value === 'dingtalk' ||
    value === 'llm' ||
    value === 'loopPolicy' ||
    value === 'mcpServers' ||
    value === 'defaultBystanderPolicy' ||
    value === 'mcpAccessPolicies' ||
    value === 'extensions'
  );
}

function toAuditLog(row: typeof adminAuditLogs.$inferSelect): AdminAuditLog {
  return {
    id: row.id,
    adminStaffId: row.adminStaffId,
    adminNick: row.adminNick,
    actionType: row.actionType as AdminAuditLog['actionType'],
    beforeSnapshot: row.beforeSnapshot,
    afterSnapshot: row.afterSnapshot,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleAdminAuditStore implements AdminAuditStore {
  constructor(private readonly db: Database) {}

  public async append(input: AdminAuditInput): Promise<AdminAuditLog> {
    const rows = await this.db
      .insert(adminAuditLogs)
      .values({
        adminStaffId: input.adminStaffId,
        adminNick: input.adminNick,
        actionType: input.actionType,
        beforeSnapshot: input.beforeSnapshot,
        afterSnapshot: input.afterSnapshot,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to append admin audit log');
    return toAuditLog(row);
  }

  public async list(limit: number): Promise<AdminAuditLog[]> {
    const rows = await this.db
      .select()
      .from(adminAuditLogs)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(Math.max(1, limit));
    return rows.map(toAuditLog);
  }
}

function toTraceRecord(
  row: typeof reactTraces.$inferSelect,
): ReActTraceRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    senderStaffId: row.senderStaffId,
    senderNick: row.senderNick,
    conversationType: row.conversationType as '1' | '2',
    proactive: row.proactive,
    question: row.question,
    reasoning: row.reasoning,
    steps: row.steps,
    answer: row.answer,
    totalTokens: row.totalTokens,
    stepCount: row.stepCount,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleReActTraceStore implements ReActTraceStore {
  constructor(private readonly db: Database) {}

  public async append(record: ReActTraceRecord): Promise<void> {
    await this.db.insert(reactTraces).values({
      id: record.id,
      conversationId: record.conversationId,
      messageId: record.messageId,
      senderStaffId: record.senderStaffId,
      senderNick: record.senderNick,
      conversationType: record.conversationType,
      proactive: record.proactive,
      question: record.question,
      reasoning: record.reasoning,
      steps: record.steps,
      answer: record.answer,
      totalTokens: record.totalTokens,
      stepCount: record.stepCount,
      durationMs: record.durationMs,
      createdAt: new Date(record.createdAt),
    });
  }

  public async query(input: ReActTraceQuery): Promise<ReActTracePage> {
    const page = Math.max(1, input.page);
    const pageSize = Math.min(100, Math.max(1, input.pageSize));
    const where = and(
      input.conversationId
        ? eq(reactTraces.conversationId, input.conversationId)
        : undefined,
      input.sinceMs !== undefined
        ? gte(reactTraces.createdAt, new Date(input.sinceMs))
        : undefined,
    );
    const rows = await this.db
      .select()
      .from(reactTraces)
      .where(where)
      .orderBy(desc(reactTraces.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reactTraces)
      .where(where);
    return {
      items: rows.map(toTraceRecord),
      total: Number(totalRows[0]?.count ?? 0),
      page,
      pageSize,
    };
  }

  public async dailyStats(
    dayStartMs: number,
    dayEndMs: number,
  ): Promise<TraceDailyStats> {
    const range = and(
      gte(reactTraces.createdAt, new Date(dayStartMs)),
      lt(reactTraces.createdAt, new Date(dayEndMs)),
    );
    const rows = await this.db
      .select({
        conversationId: reactTraces.conversationId,
        turns: sql<number>`count(*)::int`,
        proactiveReplies: sql<number>`count(*) filter (where ${reactTraces.proactive})::int`,
        totalTokens: sql<number>`coalesce(sum(${reactTraces.totalTokens}), 0)::int`,
      })
      .from(reactTraces)
      .where(range)
      .groupBy(reactTraces.conversationId);
    const byGroup: GroupTraceStat[] = rows.map((row) => ({
      conversationId: row.conversationId,
      turns: Number(row.turns),
      proactiveReplies: Number(row.proactiveReplies),
      totalTokens: Number(row.totalTokens),
    }));
    return {
      totalTokens: byGroup.reduce((sum, item) => sum + item.totalTokens, 0),
      totalTurns: byGroup.reduce((sum, item) => sum + item.turns, 0),
      byGroup,
    };
  }
}

export interface GroupPolicyStore {
  getPolicy(conversationId: string): Promise<GroupBystanderPolicy | null>;
  upsertPolicy(policy: GroupBystanderPolicy): Promise<void>;
  listPolicies(): Promise<GroupBystanderPolicy[]>;
}

function toGroupPolicy(
  row: typeof bystanderPolicies.$inferSelect,
): GroupBystanderPolicy {
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

export class DrizzleGroupPolicyStore implements GroupPolicyStore {
  constructor(private readonly db: Database) {}

  public async getPolicy(
    conversationId: string,
  ): Promise<GroupBystanderPolicy | null> {
    const rows = await this.db
      .select()
      .from(bystanderPolicies)
      .where(eq(bystanderPolicies.conversationId, conversationId))
      .limit(1);
    return rows[0] ? toGroupPolicy(rows[0]) : null;
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

  public async listPolicies(): Promise<GroupBystanderPolicy[]> {
    const rows = await this.db.select().from(bystanderPolicies);
    return rows.map(toGroupPolicy);
  }
}

export interface GroupDirectorySourcePort {
  fetchGroups(options?: { includeBots?: boolean }): Promise<
    Array<{
      conversationId: string;
      name: string;
      bots: GroupBotEntry[];
    }>
  >;
}

/** 已接入群列表：conversations 提供群标识，bystander_policies 提供覆盖策略，dingtalk_group_directory 补齐群名与机器人 */
export class DrizzleGroupDirectory implements GroupDirectory {
  constructor(
    private readonly db: Database,
    private readonly options: {
      botName?: () => string;
      dwsSource?: GroupDirectorySourcePort;
    } = {},
  ) {}

  public async listGroups(): Promise<KnownGroup[]> {
    const [rows, policies, directoryRows] = await Promise.all([
      this.db
        .select({
          title: conversations.title,
          metadata: conversations.metadata,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .where(eq(conversations.conversationType, '2'))
        .orderBy(desc(conversations.updatedAt)),
      this.db.select().from(bystanderPolicies),
      this.db
        .select()
        .from(dingtalkGroupDirectory)
        .catch(() => [] as Array<typeof dingtalkGroupDirectory.$inferSelect>),
    ]);
    return mergeKnownGroups(
      rows.flatMap((row) => {
        const metadata = row.metadata as { conversationId?: unknown };
        return typeof metadata.conversationId === 'string'
          ? [
              {
                conversationId: metadata.conversationId,
                title: row.title,
                lastActiveAt: row.updatedAt.getTime(),
              },
            ]
          : [];
      }),
      policies.map(toGroupPolicy),
      directoryRows.map(toGroupDirectoryEntry),
      this.options.botName?.(),
    );
  }

  public async listDirectory(
    options: {
      query?: string;
      onlyWithBots?: boolean;
      botName?: string;
      limit?: number;
    } = {},
  ): Promise<GroupDirectoryEntry[]> {
    const rows = await this.db
      .select()
      .from(dingtalkGroupDirectory)
      .orderBy(
        desc(dingtalkGroupDirectory.botCount),
        desc(dingtalkGroupDirectory.updatedAt),
      );
    const query = options.query?.trim().toLowerCase() ?? '';
    const botName = options.botName?.trim().toLowerCase() ?? '';
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 500));
    const filtered: GroupDirectoryEntry[] = [];
    for (const row of rows) {
      const entry = toGroupDirectoryEntry(row);
      if (options.onlyWithBots && entry.bots.length === 0) continue;
      if (
        botName &&
        !entry.bots.some((bot) => bot.name.toLowerCase().includes(botName))
      ) {
        continue;
      }
      if (query) {
        const hitName = entry.name.toLowerCase().includes(query);
        const hitId = entry.conversationId.toLowerCase().includes(query);
        const hitBot = entry.bots.some((bot) =>
          bot.name.toLowerCase().includes(query),
        );
        if (!hitName && !hitId && !hitBot) continue;
      }
      filtered.push(entry);
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  public async getGroup(
    conversationId: string,
  ): Promise<GroupDirectoryEntry | null> {
    const id = conversationId.trim();
    if (!id) return null;
    const rows = await this.db
      .select()
      .from(dingtalkGroupDirectory)
      .where(eq(dingtalkGroupDirectory.conversationId, id))
      .limit(1);
    return rows[0] ? toGroupDirectoryEntry(rows[0]) : null;
  }

  public async upsertGroupTitle(
    conversationId: string,
    title: string,
    source: 'dws' | 'stream' | 'manual' = 'stream',
  ): Promise<void> {
    const id = conversationId.trim();
    const name = title.trim();
    if (!id || !name) return;
    await this.db
      .insert(dingtalkGroupDirectory)
      .values({
        conversationId: id,
        name,
        bots: [],
        botCount: 0,
        source,
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: dingtalkGroupDirectory.conversationId,
        set: {
          name: sql`case when excluded.name <> '' then excluded.name else ${dingtalkGroupDirectory.name} end`,
          updatedAt: new Date(),
        },
      });
    await this.db
      .update(conversations)
      .set({ title: name, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.conversationKey, `group:${id}`),
          sql`(${conversations.title} is null or ${conversations.title} = '')`,
        ),
      );
  }

  public async upsertDirectoryEntries(
    items: Array<{
      conversationId: string;
      name: string;
      bots?: GroupBotEntry[];
    }>,
    source: 'dws' | 'stream' | 'manual' = 'dws',
  ): Promise<GroupDirectorySyncResult> {
    const deduped = new Map<
      string,
      { conversationId: string; name: string; bots?: GroupBotEntry[] }
    >();
    for (const item of items) {
      const id = item.conversationId.trim();
      if (!id) continue;
      const name = item.name.trim();
      const existing = deduped.get(id);
      if (!existing) {
        deduped.set(id, {
          conversationId: id,
          name,
          ...(item.bots !== undefined ? { bots: item.bots } : {}),
        });
        continue;
      }
      if (!existing.name && name) existing.name = name;
      if (item.bots && item.bots.length > 0) existing.bots = item.bots;
    }

    const syncedAt = new Date();
    if (deduped.size === 0) {
      return {
        total: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        withBots: 0,
        syncedAt: syncedAt.toISOString(),
      };
    }

    const existingRows = await this.db.select().from(dingtalkGroupDirectory);
    const existingMap = new Map(
      existingRows.map((row) => [row.conversationId, row]),
    );

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let withBots = 0;

    const values = [...deduped.values()].map((item) => {
      const before = existingMap.get(item.conversationId);
      const nextName = item.name || before?.name || '';
      const nextBots =
        item.bots !== undefined
          ? item.bots
          : Array.isArray(before?.bots)
            ? before.bots
            : [];
      if (nextBots.length > 0) withBots += 1;

      if (!before) {
        created += 1;
      } else {
        const sameName = nextName === before.name;
        const sameBots =
          JSON.stringify(nextBots) === JSON.stringify(before.bots ?? []);
        if (sameName && sameBots) unchanged += 1;
        else updated += 1;
      }

      return {
        conversationId: item.conversationId,
        name: nextName,
        bots: nextBots,
        botCount: nextBots.length,
        source,
        syncedAt,
        updatedAt: syncedAt,
      };
    });

    const chunkSize = 200;
    for (let index = 0; index < values.length; index += chunkSize) {
      await this.db
        .insert(dingtalkGroupDirectory)
        .values(values.slice(index, index + chunkSize))
        .onConflictDoUpdate({
          target: dingtalkGroupDirectory.conversationId,
          set: {
            name: sql`case when excluded.name <> '' then excluded.name else ${dingtalkGroupDirectory.name} end`,
            bots: sql`excluded.bots`,
            botCount: sql`excluded.bot_count`,
            source: sql`excluded.source`,
            syncedAt,
            updatedAt: syncedAt,
          },
        });
    }

    // 同步回填会话表中尚无标题的群聊（如仅收到过 DWS 旁听事件的群）
    for (const row of values) {
      if (!row.name) continue;
      await this.db
        .update(conversations)
        .set({ title: row.name, updatedAt: syncedAt })
        .where(
          and(
            eq(conversations.conversationKey, `group:${row.conversationId}`),
            sql`(${conversations.title} is null or ${conversations.title} = '')`,
          ),
        );
    }

    return {
      total: values.length,
      created,
      updated,
      unchanged,
      withBots,
      syncedAt: syncedAt.toISOString(),
    };
  }

  public async listDistinctBotNames(): Promise<string[]> {
    const rows = await this.db
      .select({ bots: dingtalkGroupDirectory.bots })
      .from(dingtalkGroupDirectory)
      .where(sql`${dingtalkGroupDirectory.botCount} > 0`)
      .catch(() => [] as Array<{ bots: GroupBotEntry[] }>);
    const names = new Set<string>();
    for (const row of rows) {
      for (const bot of Array.isArray(row.bots) ? row.bots : []) {
        const name = bot?.name?.trim();
        if (name) names.add(name);
      }
    }
    return [...names].sort();
  }

  public async syncFromDws(
    options: { includeBots?: boolean } = {},
  ): Promise<GroupDirectorySyncResult> {
    if (!this.options.dwsSource) {
      throw new Error('未配置 DWS 群目录同步源');
    }
    const items = await this.options.dwsSource.fetchGroups(options);
    return this.upsertDirectoryEntries(
      items.map((item) => ({
        conversationId: item.conversationId,
        name: item.name,
        ...(options.includeBots ? { bots: item.bots } : {}),
      })),
      'dws',
    );
  }
}

/**
 * 合并「见过的群」「配过策略的群」与「群目录中已安装本机器人的群」：
 * 只配了策略还没收到过消息的群也要能出现在控制台里，且用群目录补齐缺失群名与机器人列表。
 */
export function mergeKnownGroups(
  conversationsSeen: Array<{
    conversationId: string;
    title: string | null;
    lastActiveAt: number | null;
  }>,
  policies: GroupBystanderPolicy[],
  directoryEntries?: Array<{
    conversationId: string;
    name: string;
    bots: GroupBotEntry[];
    botCount: number;
  }>,
  botName?: string,
): KnownGroup[] {
  const policyByGroup = new Map(
    policies.map((policy) => [policy.conversationId, policy]),
  );
  const directoryByGroup = new Map(
    (directoryEntries ?? []).map((entry) => [entry.conversationId, entry]),
  );
  const seen = new Set<string>();
  const groups: KnownGroup[] = [];
  for (const row of conversationsSeen) {
    if (seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);
    const policy = policyByGroup.get(row.conversationId);
    const dir = directoryByGroup.get(row.conversationId);
    const title = row.title?.trim() || dir?.name?.trim() || null;
    groups.push({
      conversationId: row.conversationId,
      title,
      conversationType: '2',
      bystanderEnabled: policy?.bystanderEnabled ?? null,
      proactiveReplyEnabled: policy?.proactiveReplyEnabled ?? null,
      lastActiveAt: row.lastActiveAt,
      ...(dir ? { bots: dir.bots, botCount: dir.botCount } : {}),
    });
  }
  for (const policy of policies) {
    if (seen.has(policy.conversationId)) continue;
    seen.add(policy.conversationId);
    const dir = directoryByGroup.get(policy.conversationId);
    groups.push({
      conversationId: policy.conversationId,
      title: dir?.name?.trim() || null,
      conversationType: '2',
      bystanderEnabled: policy.bystanderEnabled,
      proactiveReplyEnabled: policy.proactiveReplyEnabled,
      lastActiveAt: null,
      ...(dir ? { bots: dir.bots, botCount: dir.botCount } : {}),
    });
  }
  const normalizedBotName = botName?.trim();
  if (normalizedBotName && directoryEntries) {
    for (const dir of directoryEntries) {
      if (seen.has(dir.conversationId)) continue;
      const hasOurBot = dir.bots.some((bot) => bot.name === normalizedBotName);
      if (!hasOurBot) continue;
      seen.add(dir.conversationId);
      groups.push({
        conversationId: dir.conversationId,
        title: dir.name?.trim() || null,
        conversationType: '2',
        bystanderEnabled: null,
        proactiveReplyEnabled: null,
        lastActiveAt: null,
        bots: dir.bots,
        botCount: dir.botCount,
      });
    }
  }
  return groups;
}

/** 用户反馈：/feedback 指令落库，供运营复盘与评测集沉淀 */
export const userFeedback = pgTable(
  'user_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id').notNull().default(''),
    senderStaffId: text('sender_staff_id').notNull().default(''),
    senderNick: text('sender_nick').notNull().default(''),
    content: text('content').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('user_feedback_created_idx').on(table.createdAt)],
);

export class DrizzleFeedbackStore implements FeedbackStore {
  constructor(private readonly db: Database) {}

  public async append(input: UserFeedbackInput): Promise<UserFeedbackRecord> {
    const rows = await this.db
      .insert(userFeedback)
      .values({
        conversationId: input.conversationId,
        messageId: input.messageId,
        senderStaffId: input.senderStaffId,
        senderNick: input.senderNick,
        content: input.content,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to persist feedback');
    return {
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      senderStaffId: row.senderStaffId,
      senderNick: row.senderNick,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }

  public async list(limit = 100): Promise<UserFeedbackRecord[]> {
    const rows = await this.db
      .select()
      .from(userFeedback)
      .orderBy(desc(userFeedback.createdAt))
      .limit(Math.min(500, Math.max(1, limit)));
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      senderStaffId: row.senderStaffId,
      senderNick: row.senderNick,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
