import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  testcaseWorkspaces,
  testcaseWorkspaceVersions,
} from './testcaseWorkspaceSchema.js';
import type {
  TestcaseWorkspace,
  TestcaseWorkspaceSummary,
  TestcaseWorkspaceVersion,
} from '../types/testcase-workspace.js';
import {
  emptyTestcaseWorkspaceState,
  TestcaseRevisionConflictError,
  type CreateTestcaseWorkspaceInput,
  type ListTestcaseWorkspacesInput,
  type SaveTestcaseVersionInput,
  type TestcaseWorkspaceMutation,
  type TestcaseWorkspaceStore,
} from '../testcase/TestcaseWorkspaceStore.js';

function toWorkspace(row: typeof testcaseWorkspaces.$inferSelect): TestcaseWorkspace {
  return {
    id: row.id,
    title: row.title,
    conversationId: row.conversationId,
    conversationType: row.conversationType === '1' ? '1' : '2',
    ownerStaffId: row.ownerStaffId,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    revision: row.revision,
    state: row.stateJson,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toSummary(row: typeof testcaseWorkspaces.$inferSelect): TestcaseWorkspaceSummary {
  return {
    id: row.id,
    title: row.title,
    conversationId: row.conversationId,
    conversationType: row.conversationType === '1' ? '1' : '2',
    ownerStaffId: row.ownerStaffId,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    revision: row.revision,
    requirementCount: row.stateJson.requirements.filter(
      (item) => item.status !== 'superseded',
    ).length,
    caseCount: row.stateJson.cases.filter((item) => item.status !== 'superseded')
      .length,
    evidenceCount: row.stateJson.evidence.length,
    decisionCount: row.stateJson.decisions.length,
    openQuestionCount: row.stateJson.openQuestions.filter(
      (item) => item.status === 'open',
    ).length,
    archived: Boolean(row.stateJson.archived),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toVersion(
  row: typeof testcaseWorkspaceVersions.$inferSelect,
): TestcaseWorkspaceVersion {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    version: row.version,
    sourceRevision: row.sourceRevision,
    ...(row.label ? { label: row.label } : {}),
    document: row.documentJson,
    createdAt: row.createdAt.getTime(),
  };
}

export class DrizzleTestcaseWorkspaceStore implements TestcaseWorkspaceStore {
  public constructor(private readonly db: Database) {}

  public async create(
    input: CreateTestcaseWorkspaceInput,
  ): Promise<TestcaseWorkspace> {
    const rows = await this.db
      .insert(testcaseWorkspaces)
      .values({
        title: input.title,
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        ownerStaffId: input.ownerStaffId,
        projectId: input.projectId,
        stateJson: input.state ?? emptyTestcaseWorkspaceState(),
        revision: 1,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('failed to create testcase workspace');
    return toWorkspace(row);
  }

  public async get(workspaceId: string): Promise<TestcaseWorkspace | null> {
    const rows = await this.db
      .select()
      .from(testcaseWorkspaces)
      .where(eq(testcaseWorkspaces.id, workspaceId))
      .limit(1);
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  public async list(
    input: ListTestcaseWorkspacesInput = {},
  ): Promise<TestcaseWorkspaceSummary[]> {
    const conditions = [];
    if (input.conversationId) {
      conditions.push(eq(testcaseWorkspaces.conversationId, input.conversationId));
    }
    if (input.ownerStaffId) {
      conditions.push(eq(testcaseWorkspaces.ownerStaffId, input.ownerStaffId));
    }
    if (input.projectId) {
      conditions.push(eq(testcaseWorkspaces.projectId, input.projectId));
    }
    if (input.includeArchived === false) {
      conditions.push(
        sql`coalesce((${testcaseWorkspaces.stateJson}->>'archived')::boolean, false) = false`,
      );
    }
    const query = input.query?.trim();
    if (query) {
      const pattern = `%${query}%`;
      conditions.push(
        or(
          ilike(testcaseWorkspaces.title, pattern),
          ilike(testcaseWorkspaces.conversationId, pattern),
          ilike(testcaseWorkspaces.ownerStaffId, pattern),
          ilike(sql`coalesce(${testcaseWorkspaces.projectId}, '')`, pattern),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(testcaseWorkspaces)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(testcaseWorkspaces.updatedAt))
      .limit(Math.max(1, Math.min(input.limit ?? 20, 100)));
    return rows.map(toSummary);
  }

  public async delete(workspaceId: string): Promise<boolean> {
    const rows = await this.db
      .delete(testcaseWorkspaces)
      .where(eq(testcaseWorkspaces.id, workspaceId))
      .returning({ id: testcaseWorkspaces.id });
    return rows.length > 0;
  }

  public async update(
    workspaceId: string,
    baseRevision: number,
    mutate: TestcaseWorkspaceMutation,
  ): Promise<TestcaseWorkspace> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(testcaseWorkspaces)
        .where(eq(testcaseWorkspaces.id, workspaceId))
        .limit(1)
        .for('update');
      const current = rows[0];
      if (!current) throw new Error(`测试用例工作区不存在：${workspaceId}`);
      if (current.revision !== baseRevision) {
        throw new TestcaseRevisionConflictError(
          workspaceId,
          baseRevision,
          current.revision,
        );
      }
      const patch = mutate(toWorkspace(current));
      const changed =
        patch.title !== current.title ||
        (patch.projectId ?? undefined) !== (current.projectId ?? undefined) ||
        JSON.stringify(patch.state) !== JSON.stringify(current.stateJson);
      if (!changed) return toWorkspace(current);
      const updated = await tx
        .update(testcaseWorkspaces)
        .set({
          title: patch.title,
          projectId: patch.projectId,
          stateJson: patch.state,
          revision: current.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(testcaseWorkspaces.id, workspaceId),
            eq(testcaseWorkspaces.revision, baseRevision),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        throw new TestcaseRevisionConflictError(
          workspaceId,
          baseRevision,
          current.revision + 1,
        );
      }
      return toWorkspace(row);
    });
  }

  public async saveVersion(
    input: SaveTestcaseVersionInput,
  ): Promise<TestcaseWorkspaceVersion> {
    return this.db.transaction(async (tx) => {
      const workspace = await tx
        .select({ id: testcaseWorkspaces.id })
        .from(testcaseWorkspaces)
        .where(eq(testcaseWorkspaces.id, input.workspaceId))
        .for('update');
      if (!workspace[0]) throw new Error('测试用例工作区不存在');
      const latest = await tx
        .select({ version: testcaseWorkspaceVersions.version })
        .from(testcaseWorkspaceVersions)
        .where(eq(testcaseWorkspaceVersions.workspaceId, input.workspaceId))
        .orderBy(desc(testcaseWorkspaceVersions.version))
        .limit(1);
      const version = (latest[0]?.version ?? 0) + 1;
      const rows = await tx
        .insert(testcaseWorkspaceVersions)
        .values({
          workspaceId: input.workspaceId,
          version,
          sourceRevision: input.sourceRevision,
          label: input.label,
          documentJson: { ...input.document, version },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('failed to save testcase workspace version');
      return toVersion(row);
    });
  }

  public async listVersions(
    workspaceId: string,
    limit = 20,
  ): Promise<TestcaseWorkspaceVersion[]> {
    const rows = await this.db
      .select()
      .from(testcaseWorkspaceVersions)
      .where(eq(testcaseWorkspaceVersions.workspaceId, workspaceId))
      .orderBy(desc(testcaseWorkspaceVersions.version))
      .limit(Math.max(1, Math.min(limit, 100)));
    return rows.map(toVersion);
  }
}
