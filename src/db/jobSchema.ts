import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import type {
  AgentJob,
  AgentJobEvent,
  AgentJobKind,
  AgentJobResult,
  AgentJobStatus,
  AgentJobStore,
  ClaimJobInput,
  EnqueueAgentJobInput,
  ListJobsInput,
} from '../types/jobs.js';

export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: text('conversation_id').notNull(),
    conversationType: varchar('conversation_type', { length: 1 })
      .notNull()
      .default('2'),
    messageId: text('message_id').notNull().default(''),
    senderStaffId: text('sender_staff_id').notNull().default(''),
    senderNick: text('sender_nick').notNull().default(''),
    kind: varchar('kind', { length: 24 }).notNull().default('task'),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    prompt: text('prompt').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    result: jsonb('result').$type<AgentJobResult>(),
    error: text('error'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(2),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_jobs_claim_idx').on(
      table.status,
      table.availableAt,
      table.priority,
      table.createdAt,
    ),
    index('agent_jobs_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const agentJobEvents = pgTable(
  'agent_job_events',
  {
    seq: serial('seq').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('agent_job_events_job_seq_idx').on(table.jobId, table.seq)],
);

function normalizeStatus(value: string): AgentJobStatus {
  switch (value) {
    case 'running':
    case 'paused':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'queued';
  }
}

function normalizeKind(value: string): AgentJobKind {
  return value === 'scheduled' ||
    value === 'worker' ||
    value === 'investigation'
    ? value
    : 'task';
}

function toJob(row: typeof agentJobs.$inferSelect): AgentJob {
  return {
    id: row.id,
    conversationId: row.conversationId,
    conversationType: row.conversationType === '1' ? '1' : '2',
    messageId: row.messageId,
    senderStaffId: row.senderStaffId,
    senderNick: row.senderNick,
    kind: normalizeKind(row.kind),
    status: normalizeStatus(row.status),
    prompt: row.prompt,
    metadata: row.metadata ?? {},
    result: row.result ?? null,
    error: row.error ?? null,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    finishedAt: row.finishedAt?.getTime() ?? null,
  };
}

export class DrizzleAgentJobStore implements AgentJobStore {
  constructor(private readonly db: Database) {}

  public async enqueue(input: EnqueueAgentJobInput): Promise<AgentJob> {
    const rows = await this.db
      .insert(agentJobs)
      .values({
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        messageId: input.messageId,
        senderStaffId: input.senderStaffId,
        senderNick: input.senderNick,
        kind: input.kind,
        status: 'queued',
        prompt: input.prompt,
        metadata: input.metadata ?? {},
        priority: input.priority ?? 0,
        maxAttempts: Math.max(1, input.maxAttempts ?? 2),
        availableAt: new Date(),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to enqueue agent job');
    return toJob(row);
  }

  public async claimNext(input: ClaimJobInput): Promise<AgentJob | null> {
    const now = new Date(input.nowMs);
    const row = await this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(agentJobs)
        .where(
          or(
            and(
              inArray(agentJobs.status, ['queued', 'paused']),
              lte(agentJobs.availableAt, now),
              or(
                isNull(agentJobs.leaseExpiresAt),
                lt(agentJobs.leaseExpiresAt, now),
              ),
            ),
            // 进程崩溃后未释放的 running 任务在租约到期后可被重新领取
            and(
              eq(agentJobs.status, 'running'),
              lt(agentJobs.leaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(desc(agentJobs.priority), asc(agentJobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      const candidate = candidates[0];
      if (!candidate) return null;
      const updated = await tx
        .update(agentJobs)
        .set({
          status: 'running',
          leaseOwner: input.owner,
          leaseExpiresAt: new Date(input.nowMs + input.leaseMs),
          attempts: sql`${agentJobs.attempts} + 1`,
          startedAt: candidate.startedAt ?? now,
          updatedAt: now,
        })
        .where(eq(agentJobs.id, candidate.id))
        .returning();
      return updated[0] ?? null;
    });
    return row ? toJob(row) : null;
  }

  public async heartbeat(
    jobId: string,
    owner: string,
    nowMs: number,
    leaseMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(agentJobs)
      .set({
        leaseExpiresAt: new Date(nowMs + leaseMs),
        updatedAt: new Date(nowMs),
      })
      .where(
        and(
          eq(agentJobs.id, jobId),
          eq(agentJobs.leaseOwner, owner),
          eq(agentJobs.status, 'running'),
        ),
      )
      .returning({ id: agentJobs.id });
    return rows.length > 0;
  }

  public async complete(
    jobId: string,
    owner: string,
    result: AgentJobResult,
  ): Promise<AgentJob | null> {
    const now = new Date();
    const rows = await this.db
      .update(agentJobs)
      .set({
        status: 'succeeded',
        result,
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentJobs.id, jobId),
          eq(agentJobs.leaseOwner, owner),
          eq(agentJobs.status, 'running'),
        ),
      )
      .returning();
    return rows[0] ? toJob(rows[0]) : null;
  }

  public async fail(
    jobId: string,
    owner: string,
    error: string,
    retryable = true,
  ): Promise<AgentJob | null> {
    const row = await this.db.transaction(async (tx) => {
      const currentRows = await tx
        .select()
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId))
        .for('update');
      const current = currentRows[0];
      if (
        !current ||
        current.leaseOwner !== owner ||
        current.status !== 'running'
      ) {
        return null;
      }
      const canRetry = retryable && current.attempts < current.maxAttempts;
      const now = new Date();
      const updated = await tx
        .update(agentJobs)
        .set({
          status: canRetry ? 'queued' : 'failed',
          error,
          leaseOwner: null,
          leaseExpiresAt: null,
          availableAt: canRetry
            ? new Date(now.getTime() + Math.min(60_000, current.attempts * 5_000))
            : current.availableAt,
          finishedAt: canRetry ? null : now,
          updatedAt: now,
        })
        .where(eq(agentJobs.id, jobId))
        .returning();
      return updated[0] ?? null;
    });
    return row ? toJob(row) : null;
  }

  public async cancel(jobId: string): Promise<AgentJob | null> {
    const now = new Date();
    const rows = await this.db
      .update(agentJobs)
      .set({
        status: 'cancelled',
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentJobs.id, jobId),
          inArray(agentJobs.status, ['queued', 'running', 'paused']),
        ),
      )
      .returning();
    return rows[0] ? toJob(rows[0]) : null;
  }

  public async get(jobId: string): Promise<AgentJob | null> {
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  public async list(input: ListJobsInput = {}): Promise<AgentJob[]> {
    const filters = [
      ...(input.conversationId
        ? [eq(agentJobs.conversationId, input.conversationId)]
        : []),
      ...(input.status && input.status.length > 0
        ? [inArray(agentJobs.status, input.status)]
        : []),
    ];
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(agentJobs.createdAt))
      .limit(Math.max(1, Math.min(input.limit ?? 20, 100)));
    return rows.map(toJob);
  }

  public async appendEvent(input: {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(agentJobEvents).values({
      jobId: input.jobId,
      type: input.type,
      payload: input.payload,
    });
  }

  public async listEvents(
    jobId: string,
    limit = 50,
  ): Promise<AgentJobEvent[]> {
    const rows = await this.db
      .select()
      .from(agentJobEvents)
      .where(eq(agentJobEvents.jobId, jobId))
      .orderBy(desc(agentJobEvents.seq))
      .limit(Math.max(1, Math.min(limit, 500)));
    return rows
      .reverse()
      .map((row) => ({
        jobId: row.jobId,
        seq: row.seq,
        type: row.type,
        payload: row.payload ?? {},
        createdAt: row.createdAt.getTime(),
      }));
  }
}
