export type TestcaseScenarioType = 'normal' | 'exception' | 'boundary' | 'other';

export type TestcaseMethod =
  | '需求分析法'
  | '等价类划分法'
  | '边界值分析法'
  | '场景法'
  | '错误猜测法';

export interface TestcaseRequirement {
  id: string;
  title: string;
  description: string;
  module: string;
  sourceRef: string;
  rules: string[];
  constraints: string[];
  status: 'active' | 'superseded' | 'unresolved';
}

export interface TestcaseEvidence {
  id: string;
  type: 'user' | 'document' | 'project' | 'mcp' | 'dws' | 'ui' | 'web';
  sourceRef: string;
  collectedAt: number;
  scope: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  requirementIds: string[];
  conflictsWith: string[];
  datasetRef?: string;
}

export interface TestcaseDraft {
  id: string;
  module: string;
  title: string;
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
  priority: '高' | '中' | '低';
  testMethod: TestcaseMethod;
  scenarioType: TestcaseScenarioType;
  requirementIds: string[];
  evidenceIds: string[];
  assumptions: string[];
  status: 'draft' | 'ready' | 'superseded';
}

export interface TestcaseDecision {
  id: string;
  topic: string;
  value: string;
  sourceMessageId?: string;
  createdAt: number;
}

export interface TestcaseOpenQuestion {
  id: string;
  question: string;
  blocking: boolean;
  requirementIds: string[];
  status: 'open' | 'resolved';
}

export interface TestcaseOutputPreferences {
  screenshotMarkers: boolean;
  includeDataChecklist: boolean;
  includeTraceability: boolean;
  includeAutomationFeasibility: boolean;
}

export interface TestcaseWorkspaceState {
  requirements: TestcaseRequirement[];
  evidence: TestcaseEvidence[];
  cases: TestcaseDraft[];
  decisions: TestcaseDecision[];
  openQuestions: TestcaseOpenQuestion[];
  outputPreferences: TestcaseOutputPreferences;
}

export interface TestcaseWorkspace {
  id: string;
  title: string;
  conversationId: string;
  conversationType: '1' | '2';
  ownerStaffId: string;
  projectId?: string;
  revision: number;
  state: TestcaseWorkspaceState;
  createdAt: number;
  updatedAt: number;
}

export interface TestcaseWorkspaceSnapshot {
  workspaceId: string;
  baseRevision: number;
  workspace: TestcaseWorkspace;
}

export interface TestcaseWorkspacePatch {
  title?: string;
  projectId?: string | null;
  requirements?: {
    upsert?: TestcaseRequirement[];
    removeIds?: string[];
  };
  evidence?: {
    upsert?: TestcaseEvidence[];
    removeIds?: string[];
  };
  cases?: {
    upsert?: TestcaseDraft[];
    removeIds?: string[];
  };
  decisions?: {
    upsert?: TestcaseDecision[];
    removeIds?: string[];
  };
  openQuestions?: {
    upsert?: TestcaseOpenQuestion[];
    removeIds?: string[];
  };
  outputPreferences?: Partial<TestcaseOutputPreferences>;
}

export interface TestcaseWorkspaceSummary {
  id: string;
  title: string;
  projectId?: string;
  revision: number;
  requirementCount: number;
  caseCount: number;
  openQuestionCount: number;
  updatedAt: number;
}

export interface CompiledTestcaseCase extends TestcaseDraft {
  caseNumber: string;
}

export interface TestcaseDataItem {
  module: string;
  placeholder: string;
  caseNumbers: string[];
}

export interface TestcaseCompileIssue {
  code:
    | 'missing_requirement'
    | 'missing_evidence'
    | 'uncovered_requirement'
    | 'duplicate_candidate'
    | 'empty_case'
    | 'unsupported_method'
    | 'unresolved_question';
  message: string;
  requirementId?: string;
  evidenceId?: string;
  caseId?: string;
}

export interface CompiledTestcaseDocument {
  workspaceId: string;
  version: number;
  sourceRevision: number;
  title: string;
  generatedAt: number;
  cases: CompiledTestcaseCase[];
  dataItems: TestcaseDataItem[];
  statistics: {
    total: number;
    byPriority: Record<'高' | '中' | '低', number>;
    byModule: Record<string, number>;
    byMethod: Record<string, number>;
  };
  traceability: Array<{
    requirementId: string;
    title: string;
    caseNumbers: string[];
    covered: boolean;
  }>;
  openQuestions: TestcaseOpenQuestion[];
  issues: TestcaseCompileIssue[];
  markdown: string;
  rows: string[][];
}

export interface TestcaseWorkspaceVersion {
  id: string;
  workspaceId: string;
  version: number;
  sourceRevision: number;
  label?: string;
  document: CompiledTestcaseDocument;
  createdAt: number;
}
