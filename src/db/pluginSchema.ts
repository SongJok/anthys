import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import type { PluginManifest } from '../types/skills-plugins-projects.js';

/** 已安装插件的当前状态（运行时以 active_version 为准） */
export const plugins = pgTable('plugins', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  activeVersion: text('active_version').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('installed'),
  manifest: jsonb('manifest').$type<PluginManifest>().notNull(),
  installedBy: text('installed_by').notNull().default(''),
  lastError: text('last_error').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 插件版本目录，保留用于回滚 */
export const pluginVersions = pgTable(
  'plugin_versions',
  {
    pluginId: text('plugin_id').notNull(),
    version: text('version').notNull(),
    manifest: jsonb('manifest').$type<PluginManifest>().notNull(),
    dir: text('dir').notNull(),
    checksum: text('checksum').notNull().default(''),
    status: varchar('status', { length: 16 }).notNull().default('installed'),
    installedAt: timestamp('installed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('plugin_versions_pk_idx').on(table.pluginId, table.version),
    index('plugin_versions_status_idx').on(table.status),
  ],
);
