import { eq } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  DwsBindingInput,
  DwsConsentInput,
  DwsIdentityRecord,
  DwsIdentityStore,
} from '../types/dws-identity.js';

/**
 * 个人 DWS 身份：同意记录 + 每个员工独立的 DWS profile 绑定。
 * 令牌本身保存在独立的 DWS home（file-DEK 加密），这里只存绑定与授权范围。
 */
export const dwsIdentities = pgTable('dws_identities', {
  staffId: text('staff_id').primaryKey(),
  consentVersion: integer('consent_version').notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  writeEnabled: boolean('write_enabled').notNull().default(false),
  homeDir: text('home_dir').notNull(),
  corpId: text('corp_id'),
  dwsUserId: text('dws_user_id'),
  profile: text('profile'),
  userName: text('user_name'),
  corpName: text('corp_name'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

type Row = typeof dwsIdentities.$inferSelect;

function toRecord(row: Row): DwsIdentityRecord {
  return {
    staffId: row.staffId,
    consentVersion: row.consentVersion,
    consentedAt: row.consentedAt.toISOString(),
    scopes: row.scopes,
    writeEnabled: row.writeEnabled,
    homeDir: row.homeDir,
    corpId: row.corpId,
    dwsUserId: row.dwsUserId,
    profile: row.profile,
    userName: row.userName,
    corpName: row.corpName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleDwsIdentityStore implements DwsIdentityStore {
  constructor(private readonly db: Database) {}

  public async get(staffId: string): Promise<DwsIdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(dwsIdentities)
      .where(eq(dwsIdentities.staffId, staffId))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  public async list(): Promise<DwsIdentityRecord[]> {
    const rows = await this.db.select().from(dwsIdentities);
    return rows.map(toRecord);
  }

  public async upsertConsent(
    input: DwsConsentInput,
  ): Promise<DwsIdentityRecord> {
    const rows = await this.db
      .insert(dwsIdentities)
      .values({
        staffId: input.staffId,
        consentVersion: input.consentVersion,
        consentedAt: new Date(input.consentedAt),
        scopes: input.scopes,
        homeDir: input.homeDir,
      })
      .onConflictDoUpdate({
        target: dwsIdentities.staffId,
        set: {
          consentVersion: input.consentVersion,
          consentedAt: new Date(input.consentedAt),
          scopes: input.scopes,
          homeDir: input.homeDir,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to save DWS consent');
    return toRecord(row);
  }

  public async setWriteEnabled(
    staffId: string,
    enabled: boolean,
  ): Promise<DwsIdentityRecord> {
    const rows = await this.db
      .update(dwsIdentities)
      .set({ writeEnabled: enabled, updatedAt: new Date() })
      .where(eq(dwsIdentities.staffId, staffId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error('请先完成 DWS 授权同意');
    return toRecord(row);
  }

  public async bind(input: DwsBindingInput): Promise<DwsIdentityRecord> {
    const rows = await this.db
      .update(dwsIdentities)
      .set({
        corpId: input.corpId,
        dwsUserId: input.dwsUserId,
        profile: input.profile,
        userName: input.userName ?? null,
        corpName: input.corpName ?? null,
        updatedAt: new Date(),
      })
      .where(eq(dwsIdentities.staffId, input.staffId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error('请先完成 DWS 授权同意');
    return toRecord(row);
  }

  public async unbind(staffId: string): Promise<void> {
    await this.db
      .update(dwsIdentities)
      .set({
        corpId: null,
        dwsUserId: null,
        profile: null,
        userName: null,
        corpName: null,
        updatedAt: new Date(),
      })
      .where(eq(dwsIdentities.staffId, staffId));
  }

  public async remove(staffId: string): Promise<boolean> {
    const rows = await this.db
      .delete(dwsIdentities)
      .where(eq(dwsIdentities.staffId, staffId))
      .returning({ staffId: dwsIdentities.staffId });
    return rows.length > 0;
  }
}
