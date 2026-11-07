import { and, desc, eq, ne } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  GroupGoalRecord,
  GroupGoalStatus,
  GroupModelRoute,
  GroupModelRouteStore,
  GroupTaskRecord,
  GroupTaskStatus,
  GroupWorkspaceRecord,
  GroupWorkspaceStore,
} from '../types/group-workspace.js';
import type { ThinkingMode } from '../types/core.js';
import type {
  GroupBotEntry,
  GroupDirectoryEntry,
} from '../types/admin-and-console.js';

export const groupWorkspaces = pgTable('group_workspaces', {
  conversationId: text('conversation_id').primaryKey(),
  title: text('title').notNull().default(''),
  purpose: text('purpose').notNull().default(''),
  responsibilities: jsonb('responsibilities')
    .$type<string[]>()
    .notNull()
    .default([]),
  updatedBy: text('updated_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const groupGoals = pgTable(
  'group_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    progress: integer('progress').notNull().default(0),
    ownerPersonKey: text('owner_person_key'),
    ownerName: text('owner_name').notNull().default(''),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('group_goals_conversation_idx').on(
      table.conversationId,
      table.updatedAt,
    ),
  ],
);

export const groupTasks = pgTable(
  'group_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    goalId: text('goal_id'),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    status: varchar('status', { length: 16 }).notNull().default('todo'),
    assigneePersonKey: text('assignee_person_key'),
    assigneeName: text('assignee_name').notNull().default(''),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('group_tasks_conversation_idx').on(
      table.conversationId,
      table.updatedAt,
    ),
    index('group_tasks_status_idx').on(table.conversationId, table.status),
    index('group_tasks_goal_idx').on(table.conversationId, table.goalId),
  ],
);

/** 按群模型路由；api_key_env 只存环境变量名，密钥仍留在部署环境 */
export const groupModelRoutes = pgTable('group_model_routes', {
  conversationId: text('conversation_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  provider: varchar('provider', { length: 24 }).notNull().default(''),
  baseUrl: text('base_url').notNull().default(''),
  apiKeyEnv: text('api_key_env').notNull().default(''),
  model: text('model').notNull(),
  temperature: real('temperature'),
  thinking: varchar('thinking', { length: 8 }).notNull().default(''),
  maxTokens: integer('max_tokens'),
  updatedBy: text('updated_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

type WorkspaceRow = typeof groupWorkspaces.$inferSelect;
type GoalRow = typeof groupGoals.$inferSelect;
type TaskRow = typeof groupTasks.$inferSelect;
type ModelRouteRow = typeof groupModelRoutes.$inferSelect;

function toWorkspace(row: WorkspaceRow): GroupWorkspaceRecord {
  return {
    conversationId: row.conversationId,
    title: row.title,
    purpose: row.purpose,
    responsibilities: row.responsibilities,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toGoal(row: GoalRow): GroupGoalRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    title: row.title,
    detail: row.detail,
    status: row.status as GroupGoalStatus,
    progress: row.progress,
    ownerPersonKey: row.ownerPersonKey,
    ownerName: row.ownerName,
    dueAt: row.dueAt ? row.dueAt.getTime() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toTask(row: TaskRow): GroupTaskRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    goalId: row.goalId,
    title: row.title,
    detail: row.detail,
    status: row.status as GroupTaskStatus,
    assigneePersonKey: row.assigneePersonKey,
    assigneeName: row.assigneeName,
    dueAt: row.dueAt ? row.dueAt.getTime() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    completedAt: row.completedAt ? row.completedAt.getTime() : null,
  };
}

function toModelRoute(row: ModelRouteRow): GroupModelRoute {
  return {
    conversationId: row.conversationId,
    enabled: row.enabled,
    provider:
      row.provider === 'openai-compatible' || row.provider === 'anthropic'
        ? row.provider
        : '',
    baseUrl: row.baseUrl,
    apiKeyEnv: row.apiKeyEnv,
    model: row.model,
    temperature: row.temperature,
    thinking: row.thinking as ThinkingMode | '',
    maxTokens: row.maxTokens,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.getTime(),
  };
}

export class DrizzleGroupWorkspaceStore implements GroupWorkspaceStore {
  constructor(private readonly db: Database) {}

  public async getWorkspace(
    conversationId: string,
  ): Promise<GroupWorkspaceRecord | null> {
    const rows = await this.db
      .select()
      .from(groupWorkspaces)
      .where(eq(groupWorkspaces.conversationId, conversationId))
      .limit(1);
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  public async upsertWorkspace(
    workspace: GroupWorkspaceRecord,
  ): Promise<GroupWorkspaceRecord> {
    const rows = await this.db
      .insert(groupWorkspaces)
      .values({
        conversationId: workspace.conversationId,
        title: workspace.title,
        purpose: workspace.purpose,
        responsibilities: workspace.responsibilities,
        updatedBy: workspace.updatedBy,
      })
      .onConflictDoUpdate({
        target: groupWorkspaces.conversationId,
        set: {
          title: workspace.title,
          purpose: workspace.purpose,
          responsibilities: workspace.responsibilities,
          updatedBy: workspace.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to upsert group workspace');
    return toWorkspace(row);
  }

  public async listGoals(
    conversationId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<GroupGoalRecord[]> {
    const conditions = [eq(groupGoals.conversationId, conversationId)];
    if (!options.includeArchived) {
      conditions.push(ne(groupGoals.status, 'archived'));
    }
    const rows = await this.db
      .select()
      .from(groupGoals)
      .where(and(...conditions))
      .orderBy(desc(groupGoals.updatedAt));
    return rows.map(toGoal);
  }

  public async getGoal(id: string): Promise<GroupGoalRecord | null> {
    const rows = await this.db
      .select()
      .from(groupGoals)
      .where(eq(groupGoals.id, id))
      .limit(1);
    return rows[0] ? toGoal(rows[0]) : null;
  }

  public async createGoal(
    goal: Omit<GroupGoalRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GroupGoalRecord> {
    const rows = await this.db
      .insert(groupGoals)
      .values({
        conversationId: goal.conversationId,
        title: goal.title,
        detail: goal.detail,
        status: goal.status,
        progress: goal.progress,
        ownerPersonKey: goal.ownerPersonKey,
        ownerName: goal.ownerName,
        dueAt: goal.dueAt === null ? null : new Date(goal.dueAt),
        createdBy: goal.createdBy,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to create group goal');
    return toGoal(row);
  }

  public async updateGoal(
    id: string,
    patch: Partial<
      Pick<
        GroupGoalRecord,
        | 'title'
        | 'detail'
        | 'status'
        | 'progress'
        | 'ownerPersonKey'
        | 'ownerName'
        | 'dueAt'
      >
    >,
  ): Promise<GroupGoalRecord | null> {
    const rows = await this.db
      .update(groupGoals)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
        ...(patch.ownerPersonKey !== undefined
          ? { ownerPersonKey: patch.ownerPersonKey }
          : {}),
        ...(patch.ownerName !== undefined ? { ownerName: patch.ownerName } : {}),
        ...(patch.dueAt !== undefined
          ? { dueAt: patch.dueAt === null ? null : new Date(patch.dueAt) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(groupGoals.id, id))
      .returning();
    return rows[0] ? toGoal(rows[0]) : null;
  }

  public async removeGoal(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(groupGoals)
      .where(eq(groupGoals.id, id))
      .returning({ id: groupGoals.id });
    return rows.length > 0;
  }

  public async listTasks(
    conversationId: string,
    options: { includeDone?: boolean } = {},
  ): Promise<GroupTaskRecord[]> {
    const conditions = [eq(groupTasks.conversationId, conversationId)];
    if (!options.includeDone) {
      conditions.push(ne(groupTasks.status, 'done'));
      conditions.push(ne(groupTasks.status, 'cancelled'));
    }
    const rows = await this.db
      .select()
      .from(groupTasks)
      .where(and(...conditions))
      .orderBy(desc(groupTasks.updatedAt));
    return rows.map(toTask);
  }

  public async getTask(id: string): Promise<GroupTaskRecord | null> {
    const rows = await this.db
      .select()
      .from(groupTasks)
      .where(eq(groupTasks.id, id))
      .limit(1);
    return rows[0] ? toTask(rows[0]) : null;
  }

  public async createTask(
    task: Omit<GroupTaskRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GroupTaskRecord> {
    const rows = await this.db
      .insert(groupTasks)
      .values({
        conversationId: task.conversationId,
        goalId: task.goalId,
        title: task.title,
        detail: task.detail,
        status: task.status,
        assigneePersonKey: task.assigneePersonKey,
        assigneeName: task.assigneeName,
        dueAt: task.dueAt === null ? null : new Date(task.dueAt),
        createdBy: task.createdBy,
        completedAt:
          task.completedAt === null ? null : new Date(task.completedAt),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to create group task');
    return toTask(row);
  }

  public async updateTask(
    id: string,
    patch: Partial<
      Pick<
        GroupTaskRecord,
        | 'title'
        | 'detail'
        | 'status'
        | 'goalId'
        | 'assigneePersonKey'
        | 'assigneeName'
        | 'dueAt'
        | 'completedAt'
      >
    >,
  ): Promise<GroupTaskRecord | null> {
    const rows = await this.db
      .update(groupTasks)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.goalId !== undefined ? { goalId: patch.goalId } : {}),
        ...(patch.assigneePersonKey !== undefined
          ? { assigneePersonKey: patch.assigneePersonKey }
          : {}),
        ...(patch.assigneeName !== undefined
          ? { assigneeName: patch.assigneeName }
          : {}),
        ...(patch.dueAt !== undefined
          ? { dueAt: patch.dueAt === null ? null : new Date(patch.dueAt) }
          : {}),
        ...(patch.completedAt !== undefined
          ? {
              completedAt:
                patch.completedAt === null
                  ? null
                  : new Date(patch.completedAt),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(groupTasks.id, id))
      .returning();
    return rows[0] ? toTask(rows[0]) : null;
  }

  public async removeTask(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(groupTasks)
      .where(eq(groupTasks.id, id))
      .returning({ id: groupTasks.id });
    return rows.length > 0;
  }
}

export class DrizzleGroupModelRouteStore implements GroupModelRouteStore {
  constructor(private readonly db: Database) {}

  public async get(conversationId: string): Promise<GroupModelRoute | null> {
    const rows = await this.db
      .select()
      .from(groupModelRoutes)
      .where(eq(groupModelRoutes.conversationId, conversationId))
      .limit(1);
    return rows[0] ? toModelRoute(rows[0]) : null;
  }

  public async list(): Promise<GroupModelRoute[]> {
    const rows = await this.db
      .select()
      .from(groupModelRoutes)
      .orderBy(desc(groupModelRoutes.updatedAt));
    return rows.map(toModelRoute);
  }

  public async upsert(route: GroupModelRoute): Promise<GroupModelRoute> {
    const rows = await this.db
      .insert(groupModelRoutes)
      .values({
        conversationId: route.conversationId,
        enabled: route.enabled,
        provider: route.provider,
        baseUrl: route.baseUrl,
        apiKeyEnv: route.apiKeyEnv,
        model: route.model,
        temperature: route.temperature,
        thinking: route.thinking,
        maxTokens: route.maxTokens,
        updatedBy: route.updatedBy,
      })
      .onConflictDoUpdate({
        target: groupModelRoutes.conversationId,
        set: {
          enabled: route.enabled,
          provider: route.provider,
          baseUrl: route.baseUrl,
          apiKeyEnv: route.apiKeyEnv,
          model: route.model,
          temperature: route.temperature,
          thinking: route.thinking,
          maxTokens: route.maxTokens,
          updatedBy: route.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to upsert group model route');
    return toModelRoute(row);
  }

  public async remove(conversationId: string): Promise<boolean> {
    const rows = await this.db
      .delete(groupModelRoutes)
      .where(eq(groupModelRoutes.conversationId, conversationId))
      .returning({ conversationId: groupModelRoutes.conversationId });
    return rows.length > 0;
  }
}

/**
 * 组织钉钉群与群内机器人目录表：
 * 将原本散落在本地 JSON 的真实群名称、openConversationId 与群机器人持久化到数据库。
 */
export const dingtalkGroupDirectory = pgTable(
  'dingtalk_group_directory',
  {
    conversationId: text('conversation_id').primaryKey(),
    name: text('name').notNull().default(''),
    bots: jsonb('bots').$type<GroupBotEntry[]>().notNull().default([]),
    botCount: integer('bot_count').notNull().default(0),
    source: varchar('source', { length: 16 }).notNull().default('dws'),
    syncedAt: timestamp('synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('dingtalk_group_directory_name_idx').on(table.name),
    index('dingtalk_group_directory_bot_count_idx').on(table.botCount),
  ],
);

export function toGroupDirectoryEntry(
  row: typeof dingtalkGroupDirectory.$inferSelect,
): GroupDirectoryEntry {
  const bots = Array.isArray(row.bots) ? row.bots : [];
  const source =
    row.source === 'stream' || row.source === 'manual' ? row.source : 'dws';
  return {
    conversationId: row.conversationId,
    name: row.name,
    bots,
    botCount: typeof row.botCount === 'number' ? row.botCount : bots.length,
    source,
    syncedAt: row.syncedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
