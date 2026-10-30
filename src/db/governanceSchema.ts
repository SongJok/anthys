import { eq } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type {
  RetentionCutoffs,
  RetentionKind,
  RetentionPolicy,
  RetentionStore,
} from '../governance/DataRetention.js';
import { normalizeRetentionPolicy } from '../governance/DataRetention.js';

/** 数据治理设置：保留期等管理端可调项的持久化覆盖 */
export const governanceSettings = pgTable('governance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export interface SqlExecutor {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

const RETENTION_KEY = 'retention';

const PURGE_TABLE: Record<
  Exclude<RetentionKind, 'attachments'>,
  string
> = {
  messages: 'messages',
  summaries: 'conversation_summaries',
  traces: 'react_traces',
  audit: 'admin_audit_logs',
  usage: 'usage_ledger',
};

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function scalar(sql: SqlExecutor, text: string, values: unknown[]): Promise<number> {
  const result = await sql.query<{ count: string }>(text, values);
  return toNumber(result.rows[0]?.count);
}

function rowCount(result: { rowCount: number | null; rows: unknown[] }): number {
  return result.rowCount ?? result.rows.length;
}

/** 基于 PostgreSQL 的保留期清理与级联删除实现 */
export class PgRetentionStore implements RetentionStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly settings?: {
      load(): Promise<Record<string, unknown> | null>;
      save(value: Record<string, unknown>): Promise<void>;
    },
  ) {}

  public async counts(cutoffs: RetentionCutoffs): Promise<{
    totals: Record<RetentionKind, number>;
    expired: Record<RetentionKind, number>;
  }> {
    const values = [new Date(cutoffs.messages), new Date(cutoffs.traces), new Date(cutoffs.audit), new Date(cutoffs.usage)];
    const result = await this.sql.query<{
      messages_total: string;
      messages_expired: string;
      summaries_total: string;
      summaries_expired: string;
      traces_total: string;
      traces_expired: string;
      audit_total: string;
      audit_expired: string;
      usage_total: string;
      usage_expired: string;
    }>(
      `SELECT
         (SELECT count(*) FROM messages) AS messages_total,
         (SELECT count(*) FROM messages WHERE created_at < $1) AS messages_expired,
         (SELECT count(*) FROM conversation_summaries) AS summaries_total,
         (SELECT count(*) FROM conversation_summaries WHERE created_at < $1) AS summaries_expired,
         (SELECT count(*) FROM react_traces) AS traces_total,
         (SELECT count(*) FROM react_traces WHERE created_at < $2) AS traces_expired,
         (SELECT count(*) FROM admin_audit_logs) AS audit_total,
         (SELECT count(*) FROM admin_audit_logs WHERE created_at < $3) AS audit_expired,
         (SELECT count(*) FROM usage_ledger) AS usage_total,
         (SELECT count(*) FROM usage_ledger WHERE created_at < $4) AS usage_expired`,
      values,
    );
    const row = result.rows[0];
    const totals: Record<RetentionKind, number> = {
      messages: toNumber(row?.messages_total),
      summaries: toNumber(row?.summaries_total),
      traces: toNumber(row?.traces_total),
      audit: toNumber(row?.audit_total),
      usage: toNumber(row?.usage_total),
      attachments: 0,
    };
    const expired: Record<RetentionKind, number> = {
      messages: toNumber(row?.messages_expired),
      summaries: toNumber(row?.summaries_expired),
      traces: toNumber(row?.traces_expired),
      audit: toNumber(row?.audit_expired),
      usage: toNumber(row?.usage_expired),
      attachments: 0,
    };
    return { totals, expired };
  }

  public async purge(
    kind: Exclude<RetentionKind, 'attachments'>,
    cutoffMs: number,
    limit: number,
  ): Promise<number> {
    const table = PURGE_TABLE[kind];
    const result = await this.sql.query(
      `DELETE FROM ${table}
        WHERE id IN (
          SELECT id FROM ${table} WHERE created_at < $1 ORDER BY created_at LIMIT $2
        )`,
      [new Date(cutoffMs), limit],
    );
    return rowCount(result);
  }

  public async deleteConversation(
    conversationId: string,
  ): Promise<{ deleted: Record<string, number>; messageIds: string[] }> {
    const conversationFilter = `(conversation_key = $2 OR metadata->>'conversationId' = $1)`;
    const messageIds = (
      await this.sql.query<{ message_id: string }>(
        `SELECT DISTINCT message_id FROM react_traces WHERE conversation_id = $1
         UNION
         SELECT DISTINCT metadata->>'messageId' AS message_id
           FROM messages
          WHERE conversation_id IN (SELECT id FROM conversations WHERE ${conversationFilter})
            AND metadata ? 'messageId'`,
        [conversationId, `group:${conversationId}`],
      )
    ).rows
      .map((row) => row.message_id)
      .filter((id): id is string => Boolean(id));

    const deleted: Record<string, number> = {};
    deleted.messages = await scalar(
      this.sql,
      `SELECT count(*) FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE ${conversationFilter})`,
      [conversationId, `group:${conversationId}`],
    );
    deleted.summaries = await scalar(
      this.sql,
      `SELECT count(*) FROM conversation_summaries WHERE conversation_id IN (SELECT id FROM conversations WHERE ${conversationFilter})`,
      [conversationId, `group:${conversationId}`],
    );
    await this.sql.query(
      `DELETE FROM conversations WHERE ${conversationFilter}`,
      [conversationId, `group:${conversationId}`],
    );

    const cascades: Array<[string, string, unknown[]]> = [
      ['traces', 'DELETE FROM react_traces WHERE conversation_id = $1', [conversationId]],
      ['usage', 'DELETE FROM usage_ledger WHERE conversation_id = $1', [conversationId]],
      ['feedback', 'DELETE FROM user_feedback WHERE conversation_id = $1', [conversationId]],
      ['groupPolicies', 'DELETE FROM bystander_policies WHERE conversation_id = $1', [conversationId]],
      ['scheduledTasks', 'DELETE FROM scheduled_tasks WHERE conversation_id = $1', [conversationId]],
      ['semanticMemories', 'DELETE FROM semantic_memories WHERE subject_key = $1', [conversationId]],
      [
        'sharedState',
        'DELETE FROM cluster_shared_state WHERE key = $1',
        [`bystander:state:${conversationId}`],
      ],
    ];
    for (const [label, statement, params] of cascades) {
      deleted[label] =
        label === 'sharedState'
          ? await this.optionalDelete(statement, params)
          : rowCount(await this.sql.query(statement, params));
    }
    return { deleted, messageIds };
  }

  public async deleteUser(
    staffId: string,
  ): Promise<{ deleted: Record<string, number>; messageIds: string[] }> {
    const messageIds = (
      await this.sql.query<{ message_id: string }>(
        `SELECT DISTINCT message_id FROM react_traces WHERE sender_staff_id = $1
         UNION
         SELECT DISTINCT metadata->>'messageId' AS message_id
           FROM messages
          WHERE metadata->>'senderStaffId' = $1
            AND metadata ? 'messageId'`,
        [staffId],
      )
    ).rows
      .map((row) => row.message_id)
      .filter((id): id is string => Boolean(id));

    const deleted: Record<string, number> = {};
    deleted.messages = await scalar(
      this.sql,
      `SELECT count(*) FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE conversation_key = $1)`,
      [`single:${staffId}`],
    );
    deleted.summaries = await scalar(
      this.sql,
      `SELECT count(*) FROM conversation_summaries WHERE conversation_id IN (SELECT id FROM conversations WHERE conversation_key = $1)`,
      [`single:${staffId}`],
    );
    await this.sql.query(
      `DELETE FROM conversations WHERE conversation_key = $1`,
      [`single:${staffId}`],
    );

    // 群聊中由该员工发出的消息同样属于个人数据
    const groupMessages = await scalar(
      this.sql,
      `SELECT count(*) FROM messages WHERE metadata->>'senderStaffId' = $1`,
      [staffId],
    );
    if (groupMessages > 0) {
      await this.sql.query(
        `DELETE FROM messages WHERE metadata->>'senderStaffId' = $1`,
        [staffId],
      );
      deleted.groupMessages = groupMessages;
      deleted.messages += groupMessages;
    }

    const cascades: Array<[string, string]> = [
      ['traces', 'DELETE FROM react_traces WHERE sender_staff_id = $1'],
      ['usage', 'DELETE FROM usage_ledger WHERE sender_staff_id = $1'],
      ['feedback', 'DELETE FROM user_feedback WHERE sender_staff_id = $1'],
      ['scheduledTasks', 'DELETE FROM scheduled_tasks WHERE created_by = $1'],
      [
        'semanticMemories',
        "DELETE FROM semantic_memories WHERE scope = 'user' AND subject_key = $1",
      ],
    ];
    for (const [label, statement] of cascades) {
      const result = await this.sql.query(statement, [staffId]);
      deleted[label] = rowCount(result);
    }
    return { deleted, messageIds };
  }

  public async loadPolicy(): Promise<Partial<RetentionPolicy> | null> {
    if (!this.settings) return null;
    const value = await this.settings.load();
    if (!value) return null;
    return normalizeRetentionPolicy(
      value as Partial<RetentionPolicy>,
      normalizeRetentionPolicy({}),
    );
  }

  public async savePolicy(policy: RetentionPolicy): Promise<void> {
    if (!this.settings) return;
    await this.settings.save({ ...policy });
  }

  /** 集群表可能尚未 push，缺表时跳过而不是让级联删除整体失败 */
  private async optionalDelete(
    statement: string,
    params: unknown[],
  ): Promise<number> {
    try {
      return rowCount(await this.sql.query(statement, params));
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return 0;
      throw error;
    }
  }
}

export async function loadGovernanceSetting(
  db: import('./client.js').Database,
  key = RETENTION_KEY,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(governanceSettings)
    .where(eq(governanceSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function saveGovernanceSetting(
  db: import('./client.js').Database,
  value: Record<string, unknown>,
  key = RETENTION_KEY,
): Promise<void> {
  await db
    .insert(governanceSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: governanceSettings.key,
      set: { value, updatedAt: new Date() },
    });
}
