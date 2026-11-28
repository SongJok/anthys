import type {
  CompiledTestcaseDocument,
  TestcaseCompileSelection,
  TestcaseDefect,
  TestcaseDraft,
  TestcaseEvidence,
  TestcaseExecution,
  TestcaseOpenQuestion,
  TestcaseOutputPreferences,
  TestcaseRequirement,
  TestcaseRisk,
  TestcaseWorkspace,
  TestcaseWorkspacePatch,
  TestcaseWorkspaceSummary,
  TestcaseWorkspaceSnapshot,
  TestcaseWorkspaceState,
  TestcaseWorkspaceVersion,
} from '../types/testcase-workspace.js';
import {
  compileTestcaseWorkspace,
  expandStepItems,
  normalizeTestcaseMethod,
} from './TestcaseCompiler.js';
import {
  emptyTestcaseWorkspaceState,
  TestcaseRevisionConflictError,
  type CreateTestcaseWorkspaceInput,
  type ListTestcaseWorkspacesInput,
  type SaveTestcaseVersionInput,
  type TestcaseWorkspaceStore,
} from './TestcaseWorkspaceStore.js';

export interface TestcaseActor {
  senderStaffId: string;
  conversationId: string;
  conversationType: '1' | '2';
  isAdmin?: boolean;
}

export interface CreateTestcaseInput {
  title: string;
  projectId?: string;
  state?: Partial<TestcaseWorkspaceState>;
}

export interface CompileTestcaseInput {
  workspaceId: string;
  baseRevision: number;
  label?: string;
  now?: number;
  selection?: TestcaseCompileSelection;
}

export class TestcaseWorkspaceAccessError extends Error {
  constructor(workspaceId: string) {
    super(`无权访问测试用例工作区：${workspaceId}`);
    this.name = 'TestcaseWorkspaceAccessError';
  }
}

export class TestcaseWorkspaceService {
  public constructor(
    private readonly store: TestcaseWorkspaceStore,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  public async create(
    actor: TestcaseActor,
    input: CreateTestcaseInput,
  ): Promise<TestcaseWorkspace> {
    const ownerStaffId = requiredText(actor.senderStaffId, 'senderStaffId', 200);
    const baseState = emptyTestcaseWorkspaceState();
    const state = input.state
      ? {
          ...baseState,
          ...input.state,
          outputPreferences: {
            ...baseState.outputPreferences,
            ...input.state.outputPreferences,
          },
        }
      : baseState;
    return this.store.create({
      title: requiredText(input.title, 'title', 300),
      conversationId: requiredText(actor.conversationId, 'conversationId', 300),
      conversationType: actor.conversationType,
      ownerStaffId,
      ...(input.projectId ? { projectId: cleanText(input.projectId, 'projectId', 300) } : {}),
      state: sanitizeState(state),
    } satisfies CreateTestcaseWorkspaceInput);
  }

  public async list(
    actor: TestcaseActor,
    conversationId?: string,
    limit?: number,
  ): Promise<TestcaseWorkspaceSummary[]> {
    return this.store.list({
      ...(conversationId ? { conversationId } : { conversationId: actor.conversationId }),
      ...(actor.isAdmin ? {} : { ownerStaffId: actor.senderStaffId }),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  public async query(
    actor: TestcaseActor,
    filter: ListTestcaseWorkspacesInput = {},
  ): Promise<TestcaseWorkspaceSummary[]> {
    return this.store.list({
      ...filter,
      ...(actor.isAdmin ? {} : { ownerStaffId: actor.senderStaffId }),
    });
  }

  public async delete(
    actor: TestcaseActor,
    workspaceId: string,
  ): Promise<boolean> {
    const id = cleanId(workspaceId, 'workspaceId');
    await this.get(actor, id);
    return this.store.delete(id);
  }

  public async get(
    actor: TestcaseActor,
    workspaceId: string,
  ): Promise<TestcaseWorkspace> {
    const workspace = await this.store.get(cleanId(workspaceId, 'workspaceId'));
    if (!workspace) throw new Error(`测试用例工作区不存在：${workspaceId}`);
    this.assertAccess(actor, workspace);
    return workspace;
  }

  public async latest(
    actor: TestcaseActor,
    preferredId?: string,
  ): Promise<TestcaseWorkspace | null> {
    if (preferredId) {
      try {
        return await this.get(actor, preferredId);
      } catch (error) {
        if (!(error instanceof TestcaseWorkspaceAccessError)) throw error;
      }
    }
    const items = await this.store.list({
      conversationId: actor.conversationId,
      ...(actor.isAdmin ? {} : { ownerStaffId: actor.senderStaffId }),
      includeArchived: false,
      limit: 1,
    });
    const latest = items[0];
    return latest ? this.get(actor, latest.id) : null;
  }

  public async snapshot(
    actor: TestcaseActor,
    preferredId?: string,
  ): Promise<TestcaseWorkspaceSnapshot | null> {
    const workspace = await this.latest(actor, preferredId);
    return workspace
      ? {
          workspaceId: workspace.id,
          baseRevision: workspace.revision,
          workspace,
        }
      : null;
  }

  public async restoreSnapshot(
    actor: TestcaseActor,
    workspaceId: string,
    baseRevision: number,
  ): Promise<TestcaseWorkspaceSnapshot> {
    const workspace = await this.get(actor, workspaceId);
    if (workspace.revision !== baseRevision) {
      throw new TestcaseRevisionConflictError(
        workspace.id,
        baseRevision,
        workspace.revision,
      );
    }
    return { workspaceId: workspace.id, baseRevision, workspace };
  }

  public async update(
    actor: TestcaseActor,
    workspaceId: string,
    baseRevision: number,
    patch: TestcaseWorkspacePatch,
  ): Promise<TestcaseWorkspace> {
    const id = cleanId(workspaceId, 'workspaceId');
    const current = await this.get(actor, id);
    if (current.revision !== baseRevision) {
      throw new TestcaseRevisionConflictError(id, baseRevision, current.revision);
    }
    const sanitized = sanitizePatch(patch, this.now());
    return this.store.update(id, baseRevision, (workspace) => {
      const next = applyPatch(workspace, sanitized);
      if (JSON.stringify(next) === JSON.stringify(workspace)) {
        return {
          title: workspace.title,
          ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
          state: workspace.state,
        };
      }
      return next;
    });
  }

  public async compile(
    actor: TestcaseActor,
    input: CompileTestcaseInput,
  ): Promise<CompiledTestcaseDocument> {
    const workspace = await this.get(actor, input.workspaceId);
    if (workspace.revision !== input.baseRevision) {
      throw new TestcaseRevisionConflictError(
        workspace.id,
        input.baseRevision,
        workspace.revision,
      );
    }
    const document = compileTestcaseWorkspace(workspace, {
      now: input.now ?? this.now(),
      ...(input.selection ? { selection: input.selection } : {}),
    });
    const saved = await this.store.saveVersion({
      workspaceId: workspace.id,
      sourceRevision: workspace.revision,
      ...(input.label ? { label: cleanText(input.label, 'label', 200) } : {}),
      document,
    });
    return saved.document;
  }

  public async versions(
    actor: TestcaseActor,
    workspaceId: string,
    limit?: number,
  ): Promise<TestcaseWorkspaceVersion[]> {
    await this.get(actor, workspaceId);
    return this.store.listVersions(workspaceId, limit);
  }

  public buildPromptSummary(workspace: TestcaseWorkspace): string {
    const activeRequirements = workspace.state.requirements.filter(
      (item) => item.status !== 'superseded',
    );
    const activeCases = workspace.state.cases.filter(
      (item) => item.status !== 'superseded',
    );
    const coveredRequirementIds = new Set(
      activeCases.flatMap((item) => item.requirementIds),
    );
    const uncoveredRequirements = activeRequirements.filter(
      (item) => !coveredRequirementIds.has(item.id),
    );
    const requirements = activeRequirements
      .slice(0, 12)
      .map((item) => `${item.id} ${item.title}`)
      .join('；');
    const cases = activeCases
      .slice(0, 12)
      .map((item) => `${item.id} ${item.title}`)
      .join('；');
    const uncoveredSummary = uncoveredRequirements
      .slice(0, 8)
      .map((item) => `${item.id} ${item.title}`)
      .join('；');
    const decisions = workspace.state.decisions
      .slice(-6)
      .map((item) => `${item.topic}=${item.value}`)
      .join('；');
    const questions = workspace.state.openQuestions
      .filter((item) => item.status === 'open')
      .slice(0, 5)
      .map((item) => `[${item.blocking ? '阻塞' : '非阻塞'}]${item.question}`)
      .join('；');
    const openRisks = workspace.state.risks.filter(
      (item) => item.status === 'open',
    );
    const pendingDefects = workspace.state.defects.filter(
      (item) => item.status === 'open' || item.status === 'fixed',
    );
    const riskSummary = openRisks
      .slice(0, 6)
      .map((item) => `[${item.severity}]${item.id} ${item.title}`)
      .join('；');
    const defectSummary = pendingDefects
      .slice(0, 6)
      .map((item) => `[${item.severity}]${item.id} ${item.title}`)
      .join('；');
    const executedCases = activeCases.filter(
      (item) => item.execution && item.execution.status !== 'untested',
    );
    const failedCases = activeCases.filter(
      (item) => item.execution?.status === 'failed',
    );
    return [
      '## 当前测试用例工作区',
      `- workspaceId：${workspace.id}`,
      `- 标题：${workspace.title}${workspace.state.archived ? '（已归档）' : ''}`,
      `- revision：${workspace.revision}`,
      `- 有效需求：${activeRequirements.length}；有效草稿：${activeCases.length}；证据：${workspace.state.evidence.length}`,
      requirements ? `- 需求摘要：${requirements}` : '',
      cases ? `- 草稿摘要：${cases}` : '',
      uncoveredSummary
        ? `- 未覆盖需求（${uncoveredRequirements.length}）：${uncoveredSummary}`
        : '',
      openRisks.length > 0 || pendingDefects.length > 0
        ? `- 待处理风险：${openRisks.length}；待验证缺陷：${pendingDefects.length}`
        : '',
      riskSummary ? `- 风险摘要：${riskSummary}` : '',
      defectSummary ? `- 缺陷摘要：${defectSummary}` : '',
      executedCases.length > 0
        ? `- 执行回填：已执行 ${executedCases.length}/${activeCases.length}，失败 ${failedCases.length}`
        : '',
      decisions ? `- 已确认口径：${decisions}` : '',
      questions ? `- 待确认：${questions}` : '',
      '- 这是可继续修改的工作成果，不是固定流程状态。是否取证、继续编写或导出由你根据当前信息自主决定。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private assertAccess(actor: TestcaseActor, workspace: TestcaseWorkspace): void {
    if (actor.isAdmin) return;
    if (
      workspace.ownerStaffId === actor.senderStaffId &&
      workspace.conversationId === actor.conversationId &&
      workspace.conversationType === actor.conversationType
    ) {
      return;
    }
    throw new TestcaseWorkspaceAccessError(workspace.id);
  }
}

function applyPatch(
  workspace: TestcaseWorkspace,
  patch: TestcaseWorkspacePatch,
): Pick<TestcaseWorkspace, 'title' | 'projectId' | 'state'> {
  const state = structuredClone(workspace.state);
  if (patch.requirements) {
    state.requirements = upsertItems(
      state.requirements,
      patch.requirements.upsert ?? [],
      patch.requirements.removeIds ?? [],
    );
  }
  if (patch.evidence) {
    state.evidence = upsertItems(
      state.evidence,
      patch.evidence.upsert ?? [],
      patch.evidence.removeIds ?? [],
    );
  }
  if (patch.cases) {
    state.cases = upsertItems(
      state.cases,
      patch.cases.upsert ?? [],
      patch.cases.removeIds ?? [],
    );
  }
  if (patch.decisions) {
    state.decisions = upsertItems(
      state.decisions,
      patch.decisions.upsert ?? [],
      patch.decisions.removeIds ?? [],
    );
  }
  if (patch.openQuestions) {
    state.openQuestions = upsertItems(
      state.openQuestions,
      patch.openQuestions.upsert ?? [],
      patch.openQuestions.removeIds ?? [],
    );
  }
  if (patch.risks) {
    state.risks = upsertItems(
      state.risks,
      patch.risks.upsert ?? [],
      patch.risks.removeIds ?? [],
    );
  }
  if (patch.defects) {
    state.defects = upsertItems(
      state.defects,
      patch.defects.upsert ?? [],
      patch.defects.removeIds ?? [],
    );
  }
  if (patch.outputPreferences) {
    state.outputPreferences = {
      ...state.outputPreferences,
      ...patch.outputPreferences,
    };
  }
  if (patch.archived !== undefined) {
    if (patch.archived) state.archived = true;
    else delete state.archived;
  }
  return {
    title: patch.title ?? workspace.title,
    ...(patch.projectId === null
      ? {}
      : { projectId: patch.projectId ?? workspace.projectId }),
    state,
  };
}

function upsertItems<T extends { id: string }>(
  current: T[],
  upsert: T[],
  removeIds: string[],
): T[] {
  const removed = new Set(removeIds);
  const map = new Map(current.filter((item) => !removed.has(item.id)).map((item) => [item.id, item]));
  for (const item of upsert) map.set(item.id, item);
  return [...map.values()];
}

function sanitizeState(state: TestcaseWorkspaceState): TestcaseWorkspaceState {
  return {
    requirements: sanitizeArray(state.requirements, sanitizeRequirement, 'requirements'),
    evidence: sanitizeArray(state.evidence, sanitizeEvidence, 'evidence'),
    cases: sanitizeArray(state.cases, sanitizeCase, 'cases'),
    decisions: sanitizeArray(state.decisions, sanitizeDecision, 'decisions'),
    openQuestions: sanitizeArray(state.openQuestions, sanitizeQuestion, 'openQuestions'),
    risks: sanitizeArray(state.risks ?? [], sanitizeRisk, 'risks'),
    defects: sanitizeArray(state.defects ?? [], sanitizeDefect, 'defects'),
    outputPreferences: sanitizePreferences(state.outputPreferences),
    ...(state.archived ? { archived: true } : {}),
  };
}

function sanitizePatch(
  patch: TestcaseWorkspacePatch,
  now: number,
): TestcaseWorkspacePatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch 必须是对象');
  }
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') {
    throw new Error('archived 必须是布尔值');
  }
  return {
    ...(patch.title !== undefined
      ? { title: requiredText(patch.title, 'title', 300) }
      : {}),
    ...(patch.projectId !== undefined
      ? patch.projectId === null || patch.projectId === ''
        ? { projectId: null }
        : { projectId: cleanText(patch.projectId, 'projectId', 300) }
      : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.requirements
      ? {
          requirements: {
            ...(patch.requirements.upsert
              ? {
                  upsert: sanitizeArray(
                    patch.requirements.upsert,
                    sanitizeRequirement,
                    'requirements.upsert',
                  ),
                }
              : {}),
            ...(patch.requirements.removeIds
              ? { removeIds: sanitizeIds(patch.requirements.removeIds, 'requirements.removeIds') }
              : {}),
          },
        }
      : {}),
    ...(patch.evidence
      ? {
          evidence: {
            ...(patch.evidence.upsert
              ? {
                  upsert: sanitizeArray(
                    patch.evidence.upsert,
                    (item) => sanitizeEvidence(item, now),
                    'evidence.upsert',
                  ),
                }
              : {}),
            ...(patch.evidence.removeIds
              ? { removeIds: sanitizeIds(patch.evidence.removeIds, 'evidence.removeIds') }
              : {}),
          },
        }
      : {}),
    ...(patch.cases
      ? {
          cases: {
            ...(patch.cases.upsert
              ? {
                  upsert: sanitizeArray(
                    patch.cases.upsert,
                    sanitizeCase,
                    'cases.upsert',
                  ),
                }
              : {}),
            ...(patch.cases.removeIds
              ? { removeIds: sanitizeIds(patch.cases.removeIds, 'cases.removeIds') }
              : {}),
          },
        }
      : {}),
    ...(patch.decisions
      ? {
          decisions: {
            ...(patch.decisions.upsert
              ? {
                  upsert: sanitizeArray(
                    patch.decisions.upsert,
                    (item) => sanitizeDecision(item, now),
                    'decisions.upsert',
                  ),
                }
              : {}),
            ...(patch.decisions.removeIds
              ? { removeIds: sanitizeIds(patch.decisions.removeIds, 'decisions.removeIds') }
              : {}),
          },
        }
      : {}),
    ...(patch.openQuestions
      ? {
          openQuestions: {
            ...(patch.openQuestions.upsert
              ? {
                  upsert: sanitizeArray(
                    patch.openQuestions.upsert,
                    sanitizeQuestion,
                    'openQuestions.upsert',
                  ),
                }
              : {}),
            ...(patch.openQuestions.removeIds
              ? {
                  removeIds: sanitizeIds(
                    patch.openQuestions.removeIds,
                    'openQuestions.removeIds',
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(patch.risks
      ? {
          risks: {
            ...(patch.risks.upsert
              ? {
                  upsert: sanitizeArray(patch.risks.upsert, sanitizeRisk, 'risks.upsert'),
                }
              : {}),
            ...(patch.risks.removeIds
              ? { removeIds: sanitizeIds(patch.risks.removeIds, 'risks.removeIds') }
              : {}),
          },
        }
      : {}),
    ...(patch.defects
      ? {
          defects: {
            ...(patch.defects.upsert
              ? {
                  upsert: sanitizeArray(
                    patch.defects.upsert,
                    sanitizeDefect,
                    'defects.upsert',
                  ),
                }
              : {}),
            ...(patch.defects.removeIds
              ? { removeIds: sanitizeIds(patch.defects.removeIds, 'defects.removeIds') }
              : {}),
          },
        }
      : {}),
    ...(patch.outputPreferences
      ? { outputPreferences: sanitizePreferences(patch.outputPreferences, true) }
      : {}),
  };
}

function sanitizeRequirement(item: TestcaseRequirement): TestcaseRequirement {
  return {
    id: cleanId(item.id, 'requirement.id'),
    title: requiredText(item.title, 'requirement.title', 500),
    description: cleanText(item.description ?? '', 'requirement.description', 8000),
    module: requiredText(item.module, 'requirement.module', 200),
    sourceRef: requiredText(item.sourceRef, 'requirement.sourceRef', 2000),
    rules: cleanList(item.rules ?? [], 'requirement.rules'),
    constraints: cleanList(item.constraints ?? [], 'requirement.constraints'),
    status: oneOf(
      item.status ?? 'active',
      ['active', 'superseded', 'unresolved'] as const,
      'requirement.status',
    ),
  };
}

function sanitizeEvidence(item: TestcaseEvidence, now = Date.now()): TestcaseEvidence {
  return {
    id: cleanId(item.id, 'evidence.id'),
    type: oneOf(
      item.type,
      ['user', 'document', 'project', 'mcp', 'dws', 'ui', 'web'] as const,
      'evidence.type',
    ),
    sourceRef: requiredText(item.sourceRef, 'evidence.sourceRef', 2000),
    collectedAt: finiteNumber(item.collectedAt ?? now, 'evidence.collectedAt'),
    scope: cleanText(item.scope ?? '', 'evidence.scope', 2000),
    summary: requiredText(item.summary, 'evidence.summary', 8000),
    confidence: oneOf(
      item.confidence ?? 'medium',
      ['high', 'medium', 'low'] as const,
      'evidence.confidence',
    ),
    requirementIds: sanitizeIds(item.requirementIds ?? [], 'evidence.requirementIds'),
    conflictsWith: sanitizeIds(item.conflictsWith ?? [], 'evidence.conflictsWith'),
    ...(item.datasetRef ? { datasetRef: cleanText(item.datasetRef, 'evidence.datasetRef', 2000) } : {}),
  };
}

function sanitizeCase(item: TestcaseDraft): TestcaseDraft {
  return {
    id: cleanId(item.id, 'case.id'),
    module: requiredText(item.module, 'case.module', 200),
    title: requiredText(item.title, 'case.title', 500),
    preconditions: expandStepItems(cleanList(item.preconditions ?? [], 'case.preconditions')),
    steps: expandStepItems(cleanList(item.steps ?? [], 'case.steps')),
    expectedResults: expandStepItems(cleanList(item.expectedResults ?? [], 'case.expectedResults')),
    priority: oneOf(item.priority ?? '中', ['高', '中', '低'] as const, 'case.priority'),
    testMethod: normalizeTestcaseMethod(item.testMethod ?? '需求分析法'),
    scenarioType: oneOf(
      item.scenarioType ?? 'normal',
      ['normal', 'exception', 'boundary', 'other'] as const,
      'case.scenarioType',
    ),
    requirementIds: sanitizeIds(item.requirementIds ?? [], 'case.requirementIds'),
    evidenceIds: sanitizeIds(item.evidenceIds ?? [], 'case.evidenceIds'),
    assumptions: cleanList(item.assumptions ?? [], 'case.assumptions'),
    status: oneOf(
      item.status ?? 'ready',
      ['draft', 'ready', 'superseded'] as const,
      'case.status',
    ),
    ...(item.riskIds?.length
      ? { riskIds: sanitizeIds(item.riskIds, 'case.riskIds') }
      : {}),
    ...(item.defectIds?.length
      ? { defectIds: sanitizeIds(item.defectIds, 'case.defectIds') }
      : {}),
    ...(item.execution ? { execution: sanitizeExecution(item.execution) } : {}),
  };
}

function sanitizeExecution(item: TestcaseExecution): TestcaseExecution {
  return {
    status: oneOf(
      item.status ?? 'untested',
      ['untested', 'passed', 'failed', 'blocked'] as const,
      'case.execution.status',
    ),
    ...(item.executedAt !== undefined
      ? { executedAt: finiteNumber(item.executedAt, 'case.execution.executedAt') }
      : {}),
    ...(item.executor
      ? { executor: cleanText(item.executor, 'case.execution.executor', 200) }
      : {}),
    ...(item.note
      ? { note: cleanText(item.note, 'case.execution.note', 4000) }
      : {}),
  };
}

function sanitizeRisk(item: TestcaseRisk): TestcaseRisk {
  return {
    id: cleanId(item.id, 'risk.id'),
    module: requiredText(item.module, 'risk.module', 200),
    title: requiredText(item.title, 'risk.title', 500),
    detail: cleanText(item.detail ?? '', 'risk.detail', 8000),
    severity: oneOf(item.severity ?? '中', ['高', '中', '低'] as const, 'risk.severity'),
    requirementIds: sanitizeIds(item.requirementIds ?? [], 'risk.requirementIds'),
    evidenceIds: sanitizeIds(item.evidenceIds ?? [], 'risk.evidenceIds'),
    mitigation: cleanText(item.mitigation ?? '', 'risk.mitigation', 4000),
    status: oneOf(
      item.status ?? 'open',
      ['open', 'mitigated', 'accepted'] as const,
      'risk.status',
    ),
  };
}

function sanitizeDefect(item: TestcaseDefect): TestcaseDefect {
  return {
    id: cleanId(item.id, 'defect.id'),
    module: requiredText(item.module, 'defect.module', 200),
    title: requiredText(item.title, 'defect.title', 500),
    sourceRef: requiredText(item.sourceRef, 'defect.sourceRef', 2000),
    severity: oneOf(
      item.severity ?? '中',
      ['高', '中', '低'] as const,
      'defect.severity',
    ),
    symptom: cleanText(item.symptom ?? '', 'defect.symptom', 8000),
    status: oneOf(
      item.status ?? 'open',
      ['open', 'fixed', 'verified', 'rejected'] as const,
      'defect.status',
    ),
  };
}

function sanitizeDecision(
  item: TestcaseWorkspaceState['decisions'][number],
  now = Date.now(),
): TestcaseWorkspaceState['decisions'][number] {
  return {
    id: cleanId(item.id, 'decision.id'),
    topic: requiredText(item.topic, 'decision.topic', 300),
    value: requiredText(item.value, 'decision.value', 4000),
    ...(item.sourceMessageId
      ? { sourceMessageId: cleanText(item.sourceMessageId, 'decision.sourceMessageId', 300) }
      : {}),
    createdAt: finiteNumber(item.createdAt ?? now, 'decision.createdAt'),
  };
}

function sanitizeQuestion(item: TestcaseOpenQuestion): TestcaseOpenQuestion {
  return {
    id: cleanId(item.id, 'question.id'),
    question: requiredText(item.question, 'question.question', 2000),
    blocking: Boolean(item.blocking ?? false),
    requirementIds: sanitizeIds(item.requirementIds ?? [], 'question.requirementIds'),
    status: oneOf(
      item.status ?? 'open',
      ['open', 'resolved'] as const,
      'question.status',
    ),
  };
}

function sanitizePreferences(
  value: Partial<TestcaseOutputPreferences>,
): TestcaseOutputPreferences;
function sanitizePreferences(
  value: Partial<TestcaseOutputPreferences>,
  partial: true,
): Partial<TestcaseOutputPreferences>;
function sanitizePreferences(
  value: Partial<TestcaseOutputPreferences>,
  partial = false,
): Partial<TestcaseOutputPreferences> | TestcaseOutputPreferences {
  const result: Partial<TestcaseOutputPreferences> = {};
  for (const key of [
    'screenshotMarkers',
    'includeDataChecklist',
    'includeTraceability',
    'includeAutomationFeasibility',
  ] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      result[key] = value[key];
    }
  }
  if (partial) return result;
  return {
    screenshotMarkers: result.screenshotMarkers ?? true,
    includeDataChecklist: result.includeDataChecklist ?? true,
    includeTraceability: result.includeTraceability ?? true,
    includeAutomationFeasibility: result.includeAutomationFeasibility ?? true,
  };
}

function sanitizeArray<T extends { id: string }>(
  value: T[],
  sanitize: (item: T) => T,
  field: string,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (value.length > 500) throw new Error(`${field} 最多 500 项`);
  const ids = new Set<string>();
  return value.map((item) => {
    const result = sanitize(item);
    if (ids.has(result.id)) throw new Error(`${field} 存在重复 id：${result.id}`);
    ids.add(result.id);
    return result;
  });
}

function sanitizeIds(value: string[], field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (value.length > 500) throw new Error(`${field} 最多 500 项`);
  return [...new Set(value.map((item) => cleanId(item, field)))];
}

function cleanList(value: string[], field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (value.length > 200) throw new Error(`${field} 最多 200 项`);
  return value.map((item) => cleanText(item, field, 8000));
}

function cleanId(value: string, field: string): string {
  const text = requiredText(value, field, 160);
  if (!/^[\p{L}\p{N}_.:-]+$/u.test(text)) {
    throw new Error(`${field} 只能包含字母、数字、下划线、点、冒号或连字符`);
  }
  return text;
}

function cleanText(value: string, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} 超过 ${max} 字符`);
  return text;
}

function requiredText(value: string, field: string, max: number): string {
  const text = cleanText(value, field, max);
  if (!text) throw new Error(`${field} 不能为空`);
  return text;
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`);
  return value;
}

function oneOf<T extends string>(
  value: T,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value)) {
    throw new Error(`${field} 非法：${String(value)}`);
  }
  return value;
}
