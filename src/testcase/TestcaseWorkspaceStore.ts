import type {
  TestcaseWorkspace,
  TestcaseWorkspaceSummary,
  TestcaseWorkspaceVersion,
} from '../types/testcase-workspace.js';

export class TestcaseRevisionConflictError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `测试用例工作区 ${workspaceId} 版本冲突：预期 r${expectedRevision}，实际 r${actualRevision}`,
    );
    this.name = 'TestcaseRevisionConflictError';
  }
}

export interface CreateTestcaseWorkspaceInput {
  title: string;
  conversationId: string;
  conversationType: '1' | '2';
  ownerStaffId: string;
  projectId?: string;
  state?: TestcaseWorkspace['state'];
}

export interface ListTestcaseWorkspacesInput {
  conversationId?: string;
  ownerStaffId?: string;
  limit?: number;
}

export type TestcaseWorkspaceMutation = (
  current: TestcaseWorkspace,
) => Pick<TestcaseWorkspace, 'title' | 'projectId' | 'state'>;

export interface SaveTestcaseVersionInput {
  workspaceId: string;
  sourceRevision: number;
  label?: string;
  document: TestcaseWorkspaceVersion['document'];
}

export interface TestcaseWorkspaceStore {
  create(input: CreateTestcaseWorkspaceInput): Promise<TestcaseWorkspace>;
  get(workspaceId: string): Promise<TestcaseWorkspace | null>;
  list(input?: ListTestcaseWorkspacesInput): Promise<TestcaseWorkspaceSummary[]>;
  update(
    workspaceId: string,
    baseRevision: number,
    mutate: TestcaseWorkspaceMutation,
  ): Promise<TestcaseWorkspace>;
  saveVersion(input: SaveTestcaseVersionInput): Promise<TestcaseWorkspaceVersion>;
  listVersions(
    workspaceId: string,
    limit?: number,
  ): Promise<TestcaseWorkspaceVersion[]>;
}

function cloneWorkspace(workspace: TestcaseWorkspace): TestcaseWorkspace {
  return structuredClone(workspace);
}

export class InMemoryTestcaseWorkspaceStore implements TestcaseWorkspaceStore {
  private readonly workspaces = new Map<string, TestcaseWorkspace>();
  private readonly versions = new Map<string, TestcaseWorkspaceVersion[]>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  public async create(
    input: CreateTestcaseWorkspaceInput,
  ): Promise<TestcaseWorkspace> {
    const id = this.createId();
    const timestamp = this.now();
    const workspace: TestcaseWorkspace = {
      id,
      title: input.title,
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      ownerStaffId: input.ownerStaffId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      revision: 1,
      state: structuredClone(input.state ?? emptyState()),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.workspaces.set(id, workspace);
    return cloneWorkspace(workspace);
  }

  public async get(workspaceId: string): Promise<TestcaseWorkspace | null> {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? cloneWorkspace(workspace) : null;
  }

  public async list(
    input: ListTestcaseWorkspacesInput = {},
  ): Promise<TestcaseWorkspaceSummary[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    return [...this.workspaces.values()]
      .filter(
        (workspace) =>
          (!input.conversationId ||
            workspace.conversationId === input.conversationId) &&
          (!input.ownerStaffId ||
            workspace.ownerStaffId === input.ownerStaffId),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(toSummary);
  }

  public async update(
    workspaceId: string,
    baseRevision: number,
    mutate: TestcaseWorkspaceMutation,
  ): Promise<TestcaseWorkspace> {
    const current = this.workspaces.get(workspaceId);
    if (!current) throw new Error(`测试用例工作区不存在：${workspaceId}`);
    if (current.revision !== baseRevision) {
      throw new TestcaseRevisionConflictError(
        workspaceId,
        baseRevision,
        current.revision,
      );
    }
    const patch = mutate(cloneWorkspace(current));
    const changed =
      patch.title !== current.title ||
      (patch.projectId ?? undefined) !== (current.projectId ?? undefined) ||
      JSON.stringify(patch.state) !== JSON.stringify(current.state);
    if (!changed) return cloneWorkspace(current);
    const next: TestcaseWorkspace = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    this.workspaces.set(workspaceId, next);
    return cloneWorkspace(next);
  }

  public async saveVersion(
    input: SaveTestcaseVersionInput,
  ): Promise<TestcaseWorkspaceVersion> {
    const list = this.versions.get(input.workspaceId) ?? [];
    const nextVersion = list.reduce((max, item) => Math.max(max, item.version), 0) + 1;
    const version: TestcaseWorkspaceVersion = {
      id: this.createId(),
      workspaceId: input.workspaceId,
      version: nextVersion,
      sourceRevision: input.sourceRevision,
      ...(input.label ? { label: input.label } : {}),
      document: structuredClone({ ...input.document, version: nextVersion }),
      createdAt: this.now(),
    };
    list.push(version);
    this.versions.set(input.workspaceId, list);
    return structuredClone(version);
  }

  public async listVersions(
    workspaceId: string,
    limit = 20,
  ): Promise<TestcaseWorkspaceVersion[]> {
    return structuredClone(
      [...(this.versions.get(workspaceId) ?? [])]
        .sort((left, right) => right.version - left.version)
        .slice(0, Math.max(1, Math.min(limit, 100))),
    );
  }
}

export function emptyTestcaseWorkspaceState(): TestcaseWorkspace['state'] {
  return emptyState();
}

function emptyState(): TestcaseWorkspace['state'] {
  return {
    requirements: [],
    evidence: [],
    cases: [],
    decisions: [],
    openQuestions: [],
    outputPreferences: {
      screenshotMarkers: true,
      includeDataChecklist: true,
      includeTraceability: true,
      includeAutomationFeasibility: true,
    },
  };
}

export function toTestcaseWorkspaceSummary(
  workspace: TestcaseWorkspace,
): TestcaseWorkspaceSummary {
  return toSummary(workspace);
}

function toSummary(workspace: TestcaseWorkspace): TestcaseWorkspaceSummary {
  return {
    id: workspace.id,
    title: workspace.title,
    ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
    revision: workspace.revision,
    requirementCount: workspace.state.requirements.filter(
      (item) => item.status !== 'superseded',
    ).length,
    caseCount: workspace.state.cases.filter((item) => item.status !== 'superseded')
      .length,
    openQuestionCount: workspace.state.openQuestions.filter(
      (item) => item.status === 'open',
    ).length,
    updatedAt: workspace.updatedAt,
  };
}
