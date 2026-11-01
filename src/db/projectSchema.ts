import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  HandbookContent,
  HandbookSource,
  ProjectSource,
  ProjectSyncStats,
} from '../types/skills-plugins-projects.js';

/** 项目登记：一个项目可有多个不可变快照 */
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  description: text('description').notNull().default(''),
  sourceType: varchar('source_type', { length: 16 }).notNull(),
  sourceConfig: jsonb('source_config')
    .$type<ProjectSource>()
    .notNull()
    .default({ type: 'manual' }),
  defaultBranch: text('default_branch').notNull().default('main'),
  ownerStaffIds: jsonb('owner_staff_ids').$type<string[]>().notNull().default([]),
  visibility: varchar('visibility', { length: 16 }).notNull().default('team'),
  sensitivity: varchar('sensitivity', { length: 16 }).notNull().default('team'),
  isDefault: boolean('is_default').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  autoSyncMinutes: integer('auto_sync_minutes').notNull().default(0),
  activeSnapshotId: uuid('active_snapshot_id'),
  lastCommit: text('last_commit').notNull().default(''),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  handbookVersion: integer('handbook_version').notNull().default(0),
  lastError: text('last_error').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projectSnapshots = pgTable(
  'project_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    commitSha: text('commit_sha').notNull(),
    branch: text('branch').notNull().default(''),
    status: varchar('status', { length: 16 }).notNull().default('building'),
    fileCount: integer('file_count').notNull().default(0),
    totalBytes: integer('total_bytes').notNull().default(0),
    symbolCount: integer('symbol_count').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_snapshots_commit_idx').on(
      table.projectId,
      table.commitSha,
    ),
    index('project_snapshots_status_idx').on(table.projectId, table.status),
  ],
);

export const projectDocuments = pgTable(
  'project_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    path: text('path').notNull(),
    language: varchar('language', { length: 32 }).notNull().default('other'),
    kind: varchar('kind', { length: 16 }).notNull().default('code'),
    contentHash: text('content_hash').notNull().default(''),
    sizeBytes: integer('size_bytes').notNull().default(0),
    lineCount: integer('line_count').notNull().default(0),
    text: text('text').notNull().default(''),
  },
  (table) => [
    uniqueIndex('project_documents_path_idx').on(table.snapshotId, table.path),
    index('project_documents_language_idx').on(table.snapshotId, table.language),
  ],
);

/**
 * 检索代码块。embedding 由 pgvector 提供，tsv 与 HNSW 索引由
 * src/db/sql/project-index.sql 在 db:push 之后补齐。
 */
export const projectChunks = pgTable(
  'project_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    path: text('path').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    symbol: text('symbol').notNull().default(''),
    kind: varchar('kind', { length: 16 }).notNull().default('code'),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull().default(''),
    tokenCount: integer('token_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (table) => [
    index('project_chunks_snapshot_path_idx').on(table.snapshotId, table.path),
    index('project_chunks_symbol_idx').on(table.snapshotId, table.symbol),
  ],
);

export const projectSymbols = pgTable(
  'project_symbols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    kind: varchar('kind', { length: 32 }).notNull().default('unknown'),
    startLine: integer('start_line').notNull().default(0),
    endLine: integer('end_line').notNull().default(0),
    signature: text('signature').notNull().default(''),
    parent: text('parent').notNull().default(''),
    exported: boolean('exported').notNull().default(false),
  },
  (table) => [
    index('project_symbols_name_idx').on(table.snapshotId, table.name),
    index('project_symbols_path_idx').on(table.snapshotId, table.path),
  ],
);

export const projectHandbooks = pgTable(
  'project_handbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    version: integer('version').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    commitSha: text('commit_sha').notNull().default(''),
    content: jsonb('content').$type<HandbookContent>().notNull(),
    sources: jsonb('sources').$type<HandbookSource[]>().notNull().default([]),
    generatedBy: varchar('generated_by', { length: 16 }).notNull().default('manual'),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_handbooks_version_idx').on(
      table.projectId,
      table.version,
    ),
    index('project_handbooks_status_idx').on(table.projectId, table.status),
  ],
);

export const projectManualEntries = pgTable(
  'project_manual_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    section: varchar('section', { length: 32 }).notNull(),
    title: text('title').notNull(),
    markdown: text('markdown').notNull().default(''),
    visibility: varchar('visibility', { length: 16 }).notNull().default('team'),
    sensitivity: varchar('sensitivity', { length: 16 }).notNull().default('team'),
    injectToBrief: boolean('inject_to_brief').notNull().default(false),
    priority: integer('priority').notNull().default(0),
    updatedBy: text('updated_by').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('project_manual_project_section_idx').on(
      table.projectId,
      table.section,
    ),
  ],
);

export const projectSyncJobs = pgTable(
  'project_sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: text('project_id').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    trigger: varchar('trigger', { length: 16 }).notNull().default('manual'),
    snapshotId: uuid('snapshot_id'),
    stats: jsonb('stats').$type<ProjectSyncStats>(),
    error: text('error').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('project_sync_jobs_project_created_idx').on(
      table.projectId,
      table.createdAt,
    ),
    index('project_sync_jobs_status_idx').on(table.status),
  ],
);
