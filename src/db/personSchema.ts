import { and, desc, eq } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  PersonIdentityAliasRecord,
  PersonIdentityAliasSource,
  PersonIdentityRecord,
  PersonIdentityStore,
  PersonaProfileRecord,
  PersonaProfileStore,
  PersonaScope,
} from '../types/persona-and-identity.js';

type DbExecutor = Pick<Database, 'insert' | 'update' | 'select'>;

/**
 * 员工身份主表：personKey 是记忆与人设的稳定归属键。
 * 一个员工可能有 staffId、openDingTalkId、外部加密 ID 等多个别名。
 */
export const personIdentities = pgTable('person_identities', {
  personKey: text('person_key').primaryKey(),
  displayName: text('display_name').notNull().default(''),
  /** 管理员把旧身份并入新身份后指向新 personKey */
  mergedInto: text('merged_into'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const personIdentityAliases = pgTable(
  'person_identity_aliases',
  {
    /** 形如 staff:<id> / open:<id> / external:<id> */
    alias: text('alias').primaryKey(),
    personKey: text('person_key')
      .notNull()
      .references(() => personIdentities.personKey, { onDelete: 'cascade' }),
    source: varchar('source', { length: 16 }).notNull(),
    displayName: text('display_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('person_identity_aliases_person_idx').on(table.personKey),
  ],
);

/** 群 / 个人人设覆盖；未配置的字段回退管理员全局人设 */
export const personaProfiles = pgTable(
  'persona_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 16 }).notNull(),
    subjectKey: text('subject_key').notNull(),
    name: text('name').notNull().default(''),
    rolePrompt: text('role_prompt').notNull().default(''),
    speakingStyle: text('speaking_style').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: text('updated_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('persona_profiles_scope_subject_idx').on(
      table.scope,
      table.subjectKey,
    ),
    index('persona_profiles_scope_idx').on(table.scope),
  ],
);

type PersonaRow = typeof personaProfiles.$inferSelect;
type PersonRow = typeof personIdentities.$inferSelect;
type AliasRow = typeof personIdentityAliases.$inferSelect;

function toPersonaRecord(row: PersonaRow): PersonaProfileRecord {
  return {
    scope: row.scope as PersonaScope,
    subjectKey: row.subjectKey,
    name: row.name,
    rolePrompt: row.rolePrompt,
    speakingStyle: row.speakingStyle,
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toAliasRecord(row: AliasRow): PersonIdentityAliasRecord {
  return {
    alias: row.alias,
    personKey: row.personKey,
    source: row.source as PersonIdentityAliasSource,
    displayName: row.displayName,
    updatedAt: row.updatedAt.getTime(),
  };
}

export class DrizzlePersonaProfileStore implements PersonaProfileStore {
  constructor(private readonly db: Database) {}

  public async list(scope?: PersonaScope): Promise<PersonaProfileRecord[]> {
    const rows = scope
      ? await this.db
          .select()
          .from(personaProfiles)
          .where(eq(personaProfiles.scope, scope))
          .orderBy(desc(personaProfiles.updatedAt))
      : await this.db
          .select()
          .from(personaProfiles)
          .orderBy(desc(personaProfiles.updatedAt));
    return rows.map(toPersonaRecord);
  }

  public async get(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<PersonaProfileRecord | null> {
    const rows = await this.db
      .select()
      .from(personaProfiles)
      .where(
        and(
          eq(personaProfiles.scope, scope),
          eq(personaProfiles.subjectKey, subjectKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toPersonaRecord(row) : null;
  }

  public async upsert(
    profile: PersonaProfileRecord,
  ): Promise<PersonaProfileRecord> {
    const rows = await this.db
      .insert(personaProfiles)
      .values({
        scope: profile.scope,
        subjectKey: profile.subjectKey,
        name: profile.name,
        rolePrompt: profile.rolePrompt,
        speakingStyle: profile.speakingStyle,
        enabled: profile.enabled,
        updatedBy: profile.updatedBy,
      })
      .onConflictDoUpdate({
        target: [personaProfiles.scope, personaProfiles.subjectKey],
        set: {
          name: profile.name,
          rolePrompt: profile.rolePrompt,
          speakingStyle: profile.speakingStyle,
          enabled: profile.enabled,
          updatedBy: profile.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to upsert persona profile');
    return toPersonaRecord(row);
  }

  public async remove(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<boolean> {
    const rows = await this.db
      .delete(personaProfiles)
      .where(
        and(
          eq(personaProfiles.scope, scope),
          eq(personaProfiles.subjectKey, subjectKey),
        ),
      )
      .returning({ id: personaProfiles.id });
    return rows.length > 0;
  }

  public async reassignSubjectKey(
    scope: PersonaScope,
    from: string,
    to: string,
  ): Promise<number> {
    if (from === to) return 0;
    const target = await this.get(scope, to);
    if (target) {
      const removed = await this.db
        .delete(personaProfiles)
        .where(
          and(
            eq(personaProfiles.scope, scope),
            eq(personaProfiles.subjectKey, from),
          ),
        )
        .returning({ id: personaProfiles.id });
      return removed.length;
    }
    const rows = await this.db
      .update(personaProfiles)
      .set({ subjectKey: to, updatedAt: new Date() })
      .where(
        and(
          eq(personaProfiles.scope, scope),
          eq(personaProfiles.subjectKey, from),
        ),
      )
      .returning({ id: personaProfiles.id });
    return rows.length;
  }
}

export class DrizzlePersonIdentityStore implements PersonIdentityStore {
  constructor(private readonly db: Database) {}

  public async findPersonByAlias(alias: string): Promise<{
    personKey: string;
    displayName: string;
    mergedInto: string | null;
  } | null> {
    const rows = await this.db
      .select({
        personKey: personIdentities.personKey,
        displayName: personIdentities.displayName,
        mergedInto: personIdentities.mergedInto,
      })
      .from(personIdentityAliases)
      .innerJoin(
        personIdentities,
        eq(personIdentityAliases.personKey, personIdentities.personKey),
      )
      .where(eq(personIdentityAliases.alias, alias))
      .limit(1);
    return rows[0] ?? null;
  }

  public async ensurePerson(input: {
    personKey: string;
    displayName?: string;
  }): Promise<void> {
    await this.ensurePersonOn(this.db, input);
  }

  private async ensurePersonOn(
    db: DbExecutor,
    input: { personKey: string; displayName?: string },
  ): Promise<void> {
    await db
      .insert(personIdentities)
      .values({
        personKey: input.personKey,
        displayName: input.displayName?.trim() ?? '',
      })
      .onConflictDoNothing();
    const displayName = input.displayName?.trim();
    if (!displayName) return;
    await db
      .update(personIdentities)
      .set({ displayName, updatedAt: new Date() })
      .where(
        and(
          eq(personIdentities.personKey, input.personKey),
          eq(personIdentities.displayName, ''),
        ),
      );
  }

  public async upsertAlias(input: {
    alias: string;
    personKey: string;
    source: PersonIdentityAliasSource;
    displayName?: string;
  }): Promise<void> {
    await this.ensurePerson({
      personKey: input.personKey,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    await this.db
      .insert(personIdentityAliases)
      .values({
        alias: input.alias,
        personKey: input.personKey,
        source: input.source,
        displayName: input.displayName?.trim() ?? '',
      })
      .onConflictDoNothing();
    if (input.displayName?.trim()) {
      await this.db
        .update(personIdentityAliases)
        .set({ displayName: input.displayName.trim(), updatedAt: new Date() })
        .where(
          and(
            eq(personIdentityAliases.alias, input.alias),
            eq(personIdentityAliases.personKey, input.personKey),
          ),
        );
    }
  }

  public async getPerson(
    personKey: string,
  ): Promise<PersonIdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(personIdentities)
      .where(eq(personIdentities.personKey, personKey))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const aliases = await this.db
      .select()
      .from(personIdentityAliases)
      .where(eq(personIdentityAliases.personKey, personKey))
      .orderBy(desc(personIdentityAliases.updatedAt));
    return {
      personKey: row.personKey,
      displayName: row.displayName,
      mergedInto: row.mergedInto,
      aliases: aliases.map(toAliasRecord),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }

  public async listPeopleMergedInto(personKey: string): Promise<string[]> {
    const rows = await this.db
      .select({ personKey: personIdentities.personKey })
      .from(personIdentities)
      .where(eq(personIdentities.mergedInto, personKey));
    return rows.map((row) => row.personKey);
  }

  public async listPeople(input: {
    query?: string;
    limit?: number;
  } = {}): Promise<PersonIdentityRecord[]> {
    const [people, aliases] = await Promise.all([
      this.db.select().from(personIdentities).orderBy(desc(personIdentities.updatedAt)),
      this.db
        .select()
        .from(personIdentityAliases)
        .orderBy(desc(personIdentityAliases.updatedAt)),
    ]);
    const aliasesByPerson = new Map<string, AliasRow[]>();
    for (const alias of aliases) {
      const list = aliasesByPerson.get(alias.personKey) ?? [];
      list.push(alias);
      aliasesByPerson.set(alias.personKey, list);
    }
    const query = input.query?.trim().toLowerCase() ?? '';
    const records: PersonIdentityRecord[] = people.map((row) => ({
      personKey: row.personKey,
      displayName: row.displayName,
      mergedInto: row.mergedInto,
      aliases: (aliasesByPerson.get(row.personKey) ?? []).map(toAliasRecord),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    }));
    const filtered = query
      ? records.filter((record) =>
          [
            record.personKey,
            record.displayName,
            ...record.aliases.map((alias) => alias.alias),
            ...record.aliases.map((alias) => alias.displayName),
          ].some((value) => value.toLowerCase().includes(query)),
        )
      : records;
    return filtered.slice(0, Math.max(1, input.limit ?? 200));
  }

  public async bindAlias(input: {
    alias: string;
    personKey: string;
    displayName?: string;
  }): Promise<{ previousPersonKey: string | null }> {
    return await this.db.transaction(async (tx) => {
      await this.ensurePersonOn(tx, {
        personKey: input.personKey,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      });
      const existingRows = await tx
        .select()
        .from(personIdentityAliases)
        .where(eq(personIdentityAliases.alias, input.alias))
        .limit(1);
      const existing = existingRows[0];
      const previousPersonKey =
        existing && existing.personKey !== input.personKey
          ? existing.personKey
          : null;

      if (existing) {
        await tx
          .update(personIdentityAliases)
          .set({
            personKey: input.personKey,
            source: 'manual',
            ...(input.displayName?.trim()
              ? { displayName: input.displayName.trim() }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(personIdentityAliases.alias, input.alias));
      } else {
        await tx.insert(personIdentityAliases).values({
          alias: input.alias,
          personKey: input.personKey,
          source: 'manual',
          displayName: input.displayName?.trim() ?? '',
        });
      }

      if (previousPersonKey) {
        await tx
          .update(personIdentities)
          .set({ mergedInto: input.personKey, updatedAt: new Date() })
          .where(eq(personIdentities.personKey, previousPersonKey));
      }
      return { previousPersonKey };
    });
  }
}
