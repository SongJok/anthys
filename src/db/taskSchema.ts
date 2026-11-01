import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  AddAgentTaskLinkInput,
  AgentTask,
  AgentTaskLink,
  AgentTaskLinkKind,
  AgentTaskStatus,
  AgentTaskStore,
  AgentTaskSubscription,
  CreateAgentTaskInput,
  ListAgentTasksInput,
  UpdateAgentTaskInput,
} from '../types/tasks.js';

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    conversationType: varchar('conversation_type', { length: 1 })
      .notNull()
      .default('1'),
    ownerStaffId: text('owner_staff_id').notNull().default(''),
    ownerNick: text('owner_nick').notNull().default(''),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    summary: text('summary'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_tasks_conversation_updated_idx').on(
      table.conversationId,
      table.updatedAt,
    ),
    index('agent_tasks_owner_updated_idx').on(
      table.ownerStaffId,
      table.updatedAt,
    ),
  ],
);

export const agentTaskLinks = pgTable(
  'agent_task_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull().default('other'),
    ref: text('ref').notNull(),
    label: text('label'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_task_links_unique_idx').on(
      table.taskId,
      table.kind,
      table.ref,
    ),
    index('agent_task_links_task_idx').on(table.taskId),
  ],
);

export const agentTaskSubscriptions = pgTable(
  'agent_task_subscriptions',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    staffId: text('staff_id').notNull(),
    nick: text('nick').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.staffId] }),
    index('agent_task_subscriptions_staff_idx').on(table.staffId),
  ],
);

function normalizeStatus(value: string): AgentTaskStatus {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'closed':
      return value;
    default:
      return 'active';
  }
}

function normalizeLinkKind(value: string): AgentTaskLinkKind {
  switch (value) {
    case 'message':
    case 'conversation':
    case 'job':
    case 'url':
    case 'doc':
    case 'issue':
    case 'card':
      return value;
    default:
      return 'other';
  }
}

function toTask(row: typeof agentTasks.$inferSelect): AgentTask {
  return {
    id: row.id,
    conversationId: row.conversationId,
    conversationType: row.conversationType === '2' ? '2' : '1',
    ownerStaffId: row.ownerStaffId,
    ownerNick: row.ownerNick,
    title: row.title,
    prompt: row.prompt,
    status: normalizeStatus(row.status),
    summary: row.summary ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    closedAt: row.closedAt?.getTime() ?? null,
  };
}

function toLink(row: typeof agentTaskLinks.$inferSelect): AgentTaskLink {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: normalizeLinkKind(row.kind),
    ref: row.ref,
    label: row.label ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.getTime(),
  };
}

export class DrizzleAgentTaskStore implements AgentTaskStore {
  constructor(private readonly db: Database) {}

  public async create(input: CreateAgentTaskInput): Promise<AgentTask> {
    const rows = await this.db
      .insert(agentTasks)
      .values({
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        ownerStaffId: input.ownerStaffId,
        ownerNick: input.ownerNick,
        title: input.title,
        prompt: input.prompt,
        status: 'active',
        metadata: input.metadata ?? {},
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to create agent task');
    return toTask(row);
  }

  public async get(id: string): Promise<AgentTask | null> {
    const rows = await this.db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.id, id))
      .limit(1);
    return rows[0] ? toTask(rows[0]) : null;
  }

  public async list(input: ListAgentTasksInput = {}): Promise<AgentTask[]> {
    const filters = [
      ...(input.conversationId
        ? [eq(agentTasks.conversationId, input.conversationId)]
        : []),
      ...(input.ownerStaffId
        ? [eq(agentTasks.ownerStaffId, input.ownerStaffId)]
        : []),
      ...(input.status && input.status.length > 0
        ? [inArray(agentTasks.status, input.status)]
        : []),
    ];
    const rows = await this.db
      .select()
      .from(agentTasks)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(agentTasks.updatedAt))
      .limit(Math.min(100, Math.max(1, input.limit ?? 20)));
    return rows.map(toTask);
  }

  public async update(
    id: string,
    patch: UpdateAgentTaskInput,
  ): Promise<AgentTask | null> {
    const values: Partial<typeof agentTasks.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.summary !== undefined) values.summary = patch.summary;
    if (patch.metadata !== undefined) values.metadata = patch.metadata;
    if (patch.closedAt !== undefined) {
      values.closedAt =
        patch.closedAt === null ? null : new Date(patch.closedAt);
    }
    const rows = await this.db
      .update(agentTasks)
      .set(values)
      .where(eq(agentTasks.id, id))
      .returning();
    return rows[0] ? toTask(rows[0]) : null;
  }

  public async addLink(input: AddAgentTaskLinkInput): Promise<AgentTaskLink> {
    const rows = await this.db
      .insert(agentTaskLinks)
      .values({
        taskId: input.taskId,
        kind: input.kind,
        ref: input.ref,
        label: input.label ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing({
        target: [agentTaskLinks.taskId, agentTaskLinks.kind, agentTaskLinks.ref],
      })
      .returning();
    if (rows[0]) return toLink(rows[0]);
    const existing = await this.db
      .select()
      .from(agentTaskLinks)
      .where(
        and(
          eq(agentTaskLinks.taskId, input.taskId),
          eq(agentTaskLinks.kind, input.kind),
          eq(agentTaskLinks.ref, input.ref),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error('failed to add agent task link');
    return toLink(row);
  }

  public async listLinks(taskId: string): Promise<AgentTaskLink[]> {
    const rows = await this.db
      .select()
      .from(agentTaskLinks)
      .where(eq(agentTaskLinks.taskId, taskId))
      .orderBy(asc(agentTaskLinks.createdAt));
    return rows.map(toLink);
  }

  public async subscribe(input: {
    taskId: string;
    staffId: string;
    nick: string;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(agentTaskSubscriptions)
      .values({
        taskId: input.taskId,
        staffId: input.staffId,
        nick: input.nick,
      })
      .onConflictDoNothing({
        target: [
          agentTaskSubscriptions.taskId,
          agentTaskSubscriptions.staffId,
        ],
      })
      .returning();
    return rows.length > 0;
  }

  public async unsubscribe(taskId: string, staffId: string): Promise<boolean> {
    const rows = await this.db
      .delete(agentTaskSubscriptions)
      .where(
        and(
          eq(agentTaskSubscriptions.taskId, taskId),
          eq(agentTaskSubscriptions.staffId, staffId),
        ),
      )
      .returning();
    return rows.length > 0;
  }

  public async listSubscribers(
    taskId: string,
  ): Promise<AgentTaskSubscription[]> {
    const rows = await this.db
      .select()
      .from(agentTaskSubscriptions)
      .where(eq(agentTaskSubscriptions.taskId, taskId))
      .orderBy(asc(agentTaskSubscriptions.createdAt));
    return rows.map((row) => ({
      taskId: row.taskId,
      staffId: row.staffId,
      nick: row.nick,
      createdAt: row.createdAt.getTime(),
    }));
  }
}
