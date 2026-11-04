import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  DirectoryUser,
  WhitelistEntry,
  WhitelistQuery,
  WhitelistSource,
  WhitelistStats,
  WhitelistStatus,
  WhitelistStore,
} from '../types/whitelist.js';

/** 员工白名单：目录同步写入待授权，管理员审批后放行 */
export const userWhitelist = pgTable(
  'user_whitelist',
  {
    staffId: text('staff_id').primaryKey(),
    name: text('name').notNull().default(''),
    deptPath: text('dept_path').notNull().default(''),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    source: varchar('source', { length: 24 }).notNull().default('directory'),
    openDingTalkId: text('open_ding_talk_id'),
    note: text('note').notNull().default(''),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('user_whitelist_status_idx').on(table.status),
    index('user_whitelist_open_id_idx').on(table.openDingTalkId),
    index('user_whitelist_name_idx').on(table.name),
  ],
);

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toEntry(row: typeof userWhitelist.$inferSelect): WhitelistEntry {
  return {
    staffId: row.staffId,
    name: row.name,
    deptPath: row.deptPath,
    status: row.status as WhitelistStatus,
    source: row.source as WhitelistSource,
    openDingTalkId: row.openDingTalkId,
    note: row.note,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export class DrizzleWhitelistStore implements WhitelistStore {
  constructor(private readonly db: Database) {}

  public async get(staffId: string): Promise<WhitelistEntry | null> {
    const rows = await this.db
      .select()
      .from(userWhitelist)
      .where(eq(userWhitelist.staffId, staffId))
      .limit(1);
    return rows[0] ? toEntry(rows[0]) : null;
  }

  public async findByOpenId(openId: string): Promise<WhitelistEntry | null> {
    if (!openId) return null;
    const rows = await this.db
      .select()
      .from(userWhitelist)
      .where(eq(userWhitelist.openDingTalkId, openId))
      .limit(1);
    return rows[0] ? toEntry(rows[0]) : null;
  }

  public async list(
    query: WhitelistQuery,
  ): Promise<{ items: WhitelistEntry[]; total: number }> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));
    const keyword = query.query?.trim();
    const where = and(
      query.status ? eq(userWhitelist.status, query.status) : undefined,
      keyword
        ? or(
            ilike(userWhitelist.name, `%${escapeLike(keyword)}%`),
            ilike(userWhitelist.staffId, `%${escapeLike(keyword)}%`),
            ilike(userWhitelist.deptPath, `%${escapeLike(keyword)}%`),
          )
        : undefined,
    );
    const rows = await this.db
      .select()
      .from(userWhitelist)
      .where(where)
      .orderBy(desc(userWhitelist.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totals = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(userWhitelist)
      .where(where);
    return {
      items: rows.map(toEntry),
      total: Number(totals[0]?.count ?? 0),
    };
  }

  public async stats(): Promise<WhitelistStats> {
    const rows = await this.db
      .select({
        status: userWhitelist.status,
        count: sql<number>`count(*)::int`,
      })
      .from(userWhitelist)
      .groupBy(userWhitelist.status);
    const latest = await this.db
      .select({ at: sql<Date | null>`max(${userWhitelist.lastSeenAt})` })
      .from(userWhitelist);
    const byStatus = new Map(
      rows.map((row) => [row.status, Number(row.count)]),
    );
    const pending = byStatus.get('pending') ?? 0;
    const approved = byStatus.get('approved') ?? 0;
    const rejected = byStatus.get('rejected') ?? 0;
    const syncedAt = latest[0]?.at;
    return {
      total: pending + approved + rejected,
      pending,
      approved,
      rejected,
      syncedAt:
        syncedAt instanceof Date
          ? syncedAt.toISOString()
          : syncedAt
            ? new Date(syncedAt).toISOString()
            : null,
    };
  }

  public async upsertDirectory(
    users: DirectoryUser[],
    source: WhitelistSource,
  ): Promise<{ created: number; updated: number; unchanged: number }> {
    const deduped = new Map<string, DirectoryUser>();
    for (const user of users) {
      const staffId = user.staffId.trim();
      if (!staffId) continue;
      const existing = deduped.get(staffId);
      if (!existing) {
        deduped.set(staffId, { ...user, staffId });
        continue;
      }
      if (!existing.name && user.name) existing.name = user.name;
      if (!existing.deptPath && user.deptPath) existing.deptPath = user.deptPath;
    }
    if (deduped.size === 0) {
      return { created: 0, updated: 0, unchanged: 0 };
    }

    const existingRows = await this.db
      .select({
        staffId: userWhitelist.staffId,
        name: userWhitelist.name,
        deptPath: userWhitelist.deptPath,
      })
      .from(userWhitelist);
    const existing = new Map(
      existingRows.map((row) => [row.staffId, row]),
    );

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const values = [...deduped.values()].map((user) => {
      const before = existing.get(user.staffId);
      if (!before) created += 1;
      else if (
        (user.name && user.name !== before.name) ||
        (user.deptPath && user.deptPath !== before.deptPath)
      )
        updated += 1;
      else unchanged += 1;
      return {
        staffId: user.staffId,
        name: user.name,
        deptPath: user.deptPath,
        status: 'pending',
        source,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      };
    });

    const chunkSize = 500;
    for (let index = 0; index < values.length; index += chunkSize) {
      await this.db
        .insert(userWhitelist)
        .values(values.slice(index, index + chunkSize))
        .onConflictDoUpdate({
          target: userWhitelist.staffId,
          set: {
            name: sql`case when excluded.name <> '' then excluded.name else ${userWhitelist.name} end`,
            deptPath: sql`case when excluded.dept_path <> '' then excluded.dept_path else ${userWhitelist.deptPath} end`,
            source: sql`case when ${userWhitelist.source} = 'manual' then ${userWhitelist.source} else excluded.source end`,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }
    return { created, updated, unchanged };
  }

  public async registerPending(staffId: string, name: string): Promise<void> {
    const id = staffId.trim();
    if (!id) return;
    await this.db
      .insert(userWhitelist)
      .values({
        staffId: id,
        name: name.trim(),
        status: 'pending',
        source: 'auto',
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userWhitelist.staffId,
        set: {
          name: sql`case when ${userWhitelist.name} = '' then excluded.name else ${userWhitelist.name} end`,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  public async setStatus(
    staffId: string,
    status: WhitelistStatus,
    actor: string,
    note?: string,
  ): Promise<WhitelistEntry | null> {
    const decided = status !== 'pending';
    const rows = await this.db
      .update(userWhitelist)
      .set({
        status,
        approvedBy: decided ? actor : null,
        approvedAt: decided ? new Date() : null,
        ...(note !== undefined ? { note } : {}),
        updatedAt: new Date(),
      })
      .where(eq(userWhitelist.staffId, staffId))
      .returning();
    return rows[0] ? toEntry(rows[0]) : null;
  }

  public async setStatusBatch(
    staffIds: string[],
    status: WhitelistStatus,
    actor: string,
  ): Promise<number> {
    const ids = [...new Set(staffIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return 0;
    const decided = status !== 'pending';
    const rows = await this.db
      .update(userWhitelist)
      .set({
        status,
        approvedBy: decided ? actor : null,
        approvedAt: decided ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(inArray(userWhitelist.staffId, ids))
      .returning({ staffId: userWhitelist.staffId });
    return rows.length;
  }

  public async bindOpenId(
    staffId: string,
    openDingTalkId: string,
  ): Promise<void> {
    if (!staffId.trim() || !openDingTalkId.trim()) return;
    await this.db
      .update(userWhitelist)
      .set({ openDingTalkId, updatedAt: new Date() })
      .where(eq(userWhitelist.staffId, staffId));
  }
}
