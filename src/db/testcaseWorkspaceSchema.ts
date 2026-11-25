import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  CompiledTestcaseDocument,
  TestcaseWorkspaceState,
} from '../types/testcase-workspace.js';

export const testcaseWorkspaces = pgTable(
  'testcase_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 300 }).notNull(),
    conversationId: text('conversation_id').notNull(),
    conversationType: varchar('conversation_type', { length: 1 }).notNull(),
    ownerStaffId: text('owner_staff_id').notNull(),
    projectId: text('project_id'),
    revision: integer('revision').notNull().default(1),
    stateJson: jsonb('state_json')
      .$type<TestcaseWorkspaceState>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('testcase_workspaces_conversation_updated_idx').on(
      table.conversationId,
      table.updatedAt,
    ),
    index('testcase_workspaces_owner_updated_idx').on(
      table.ownerStaffId,
      table.updatedAt,
    ),
  ],
);

export const testcaseWorkspaceVersions = pgTable(
  'testcase_workspace_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => testcaseWorkspaces.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    label: varchar('label', { length: 200 }),
    documentJson: jsonb('document_json')
      .$type<CompiledTestcaseDocument>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('testcase_workspace_versions_unique_idx').on(
      table.workspaceId,
      table.version,
    ),
    index('testcase_workspace_versions_workspace_idx').on(
      table.workspaceId,
      table.version,
    ),
  ],
);
