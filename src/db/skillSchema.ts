import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { SkillFrontmatter } from '../types/skills-plugins-projects.js';

/** 技能元数据：正文仍保存在技能目录，数据库只记录状态与索引信息 */
export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    version: text('version').notNull().default('0.0.0'),
    source: varchar('source', { length: 16 }).notNull(),
    pluginId: text('plugin_id'),
    path: text('path').notNull(),
    frontmatter: jsonb('frontmatter')
      .$type<SkillFrontmatter>()
      .notNull()
      .default({ name: '', description: '' }),
    bodyHash: text('body_hash').notNull().default(''),
    /** 模块只用于分组与路由，不参与技能身份，所以改名不会丢 enabled */
    module: varchar('module', { length: 32 }).notNull().default('other'),
    enabled: boolean('enabled').notNull().default(true),
    visibility: varchar('visibility', { length: 16 }).notNull().default('public'),
    loadError: text('load_error').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('skills_name_source_idx').on(table.source, table.name),
    index('skills_enabled_idx').on(table.enabled, table.visibility),
    index('skills_module_idx').on(table.module, table.enabled),
  ],
);

export const skillUsage = pgTable(
  'skill_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: text('skill_id').notNull(),
    conversationId: text('conversation_id').notNull().default(''),
    senderStaffId: text('sender_staff_id').notNull().default(''),
    action: varchar('action', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('skill_usage_skill_created_idx').on(table.skillId, table.createdAt),
  ],
);
