import { desc, eq } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  GroupMemorySharing,
  PersonMemoryConsent,
  PersonMemoryConsentStore,
  PersonPreferences,
  PersonPreferencesStore,
  PreferenceLanguage,
  ReplyLength,
} from '../types/personal-settings.js';

export const personPreferences = pgTable('person_preferences', {
  personKey: text('person_key').primaryKey(),
  replyLength: varchar('reply_length', { length: 16 })
    .notNull()
    .default('balanced'),
  language: varchar('language', { length: 8 }).notNull().default('auto'),
  addressAs: text('address_as').notNull().default(''),
  extraInstructions: text('extra_instructions').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  updatedBy: text('updated_by').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const personMemoryConsents = pgTable('person_memory_consents', {
  personKey: text('person_key').primaryKey(),
  groupSharing: varchar('group_sharing', { length: 16 })
    .notNull()
    .default('shareable'),
  allowedConversationIds: jsonb('allowed_conversation_ids')
    .$type<string[]>()
    .notNull()
    .default([]),
  updatedBy: text('updated_by').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

type PreferenceRow = typeof personPreferences.$inferSelect;
type ConsentRow = typeof personMemoryConsents.$inferSelect;

function toPreferences(row: PreferenceRow): PersonPreferences {
  return {
    personKey: row.personKey,
    replyLength: row.replyLength as ReplyLength,
    language: row.language as PreferenceLanguage,
    addressAs: row.addressAs,
    extraInstructions: row.extraInstructions,
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.getTime(),
  };
}

function toConsent(row: ConsentRow): PersonMemoryConsent {
  return {
    personKey: row.personKey,
    groupSharing: row.groupSharing as GroupMemorySharing,
    allowedConversationIds: row.allowedConversationIds,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.getTime(),
  };
}

export class DrizzlePersonPreferencesStore implements PersonPreferencesStore {
  constructor(private readonly db: Database) {}

  public async get(personKey: string): Promise<PersonPreferences | null> {
    const rows = await this.db
      .select()
      .from(personPreferences)
      .where(eq(personPreferences.personKey, personKey))
      .limit(1);
    return rows[0] ? toPreferences(rows[0]) : null;
  }

  public async list(): Promise<PersonPreferences[]> {
    const rows = await this.db
      .select()
      .from(personPreferences)
      .orderBy(desc(personPreferences.updatedAt));
    return rows.map(toPreferences);
  }

  public async upsert(
    preferences: PersonPreferences,
  ): Promise<PersonPreferences> {
    const rows = await this.db
      .insert(personPreferences)
      .values({
        personKey: preferences.personKey,
        replyLength: preferences.replyLength,
        language: preferences.language,
        addressAs: preferences.addressAs,
        extraInstructions: preferences.extraInstructions,
        enabled: preferences.enabled,
        updatedBy: preferences.updatedBy,
      })
      .onConflictDoUpdate({
        target: personPreferences.personKey,
        set: {
          replyLength: preferences.replyLength,
          language: preferences.language,
          addressAs: preferences.addressAs,
          extraInstructions: preferences.extraInstructions,
          enabled: preferences.enabled,
          updatedBy: preferences.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to upsert person preferences');
    return toPreferences(row);
  }

  public async remove(personKey: string): Promise<void> {
    await this.db
      .delete(personPreferences)
      .where(eq(personPreferences.personKey, personKey));
  }
}

export class DrizzlePersonMemoryConsentStore
  implements PersonMemoryConsentStore
{
  constructor(private readonly db: Database) {}

  public async get(personKey: string): Promise<PersonMemoryConsent | null> {
    const rows = await this.db
      .select()
      .from(personMemoryConsents)
      .where(eq(personMemoryConsents.personKey, personKey))
      .limit(1);
    return rows[0] ? toConsent(rows[0]) : null;
  }

  public async list(): Promise<PersonMemoryConsent[]> {
    const rows = await this.db
      .select()
      .from(personMemoryConsents)
      .orderBy(desc(personMemoryConsents.updatedAt));
    return rows.map(toConsent);
  }

  public async upsert(consent: PersonMemoryConsent): Promise<PersonMemoryConsent> {
    const rows = await this.db
      .insert(personMemoryConsents)
      .values({
        personKey: consent.personKey,
        groupSharing: consent.groupSharing,
        allowedConversationIds: consent.allowedConversationIds,
        updatedBy: consent.updatedBy,
      })
      .onConflictDoUpdate({
        target: personMemoryConsents.personKey,
        set: {
          groupSharing: consent.groupSharing,
          allowedConversationIds: consent.allowedConversationIds,
          updatedBy: consent.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to upsert person memory consent');
    return toConsent(row);
  }

  public async remove(personKey: string): Promise<void> {
    await this.db
      .delete(personMemoryConsents)
      .where(eq(personMemoryConsents.personKey, personKey));
  }
}
