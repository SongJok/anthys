export type TestcaseScenarioType = 'normal' | 'exception' | 'boundary' | 'other';

export type TestcaseMethod =
  | '需求分析法'
  | '等价类划分法'
  | '边界值分析法'
  | '场景法'
  | '错误猜测法';

export type TestcaseMethodExpression = string;

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
  testMethod: TestcaseMethodExpression;
  scenarioType: TestcaseScenarioType;
  requirementIds: string[];
  evidenceIds: string[];
  assumptions: string[];
  status: 'draft' | 'ready' | 'superseded';
  /** 需求评审识别出的风险点，用例作为风险的验证手段 */
  riskIds?: string[];
  /** 缺陷复现或回归验证的目标缺陷 */
  defectIds?: string[];
  execution?: TestcaseExecution;
}

export type TestcaseSeverity = '高' | '中' | '低';

export type TestcaseExecutionStatus =
  | 'untested'
  | 'passed'
  | 'failed'
  | 'blocked';

export interface TestcaseExecution {
  status: TestcaseExecutionStatus;
  executedAt?: number;
  executor?: string;
  note?: string;
}

/** 需求评审阶段识别的风险点，需要用例覆盖或显式接受 */
export interface TestcaseRisk {
  id: string;
  module: string;
  title: string;
  detail: string;
  severity: TestcaseSeverity;
  requirementIds: string[];
  evidenceIds: string[];
  mitigation: string;
  status: 'open' | 'mitigated' | 'accepted';
}

/** 缺陷记录，用于生成复现用例与回归验证 */
export interface TestcaseDefect {
  id: string;
  module: string;
  title: string;
  sourceRef: string;
  severity: TestcaseSeverity;
  symptom: string;
  status: 'open' | 'fixed' | 'verified' | 'rejected';
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
  risks: TestcaseRisk[];
  defects: TestcaseDefect[];
  outputPreferences: TestcaseOutputPreferences;
  archived?: boolean;
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
  archived?: boolean;
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
  risks?: {
    upsert?: TestcaseRisk[];
    removeIds?: string[];
  };
  defects?: {
    upsert?: TestcaseDefect[];
    removeIds?: string[];
  };
  outputPreferences?: Partial<TestcaseOutputPreferences>;
}

export interface TestcaseWorkspaceSummary {
  id: string;
  title: string;
  conversationId?: string;
  conversationType?: '1' | '2';
  ownerStaffId?: string;
  projectId?: string;
  revision: number;
  requirementCount: number;
  caseCount: number;
  evidenceCount?: number;
  decisionCount?: number;
  openQuestionCount: number;
  riskCount?: number;
  defectCount?: number;
  archived?: boolean;
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
    | 'evidence_conflict'
    | 'uncovered_requirement'
    | 'duplicate_candidate'
    | 'empty_case'
    | 'unsupported_method'
    | 'unresolved_question'
    | 'missing_risk'
    | 'uncovered_risk'
    | 'missing_defect'
    | 'uncovered_defect';
  message: string;
  requirementId?: string;
  evidenceId?: string;
  caseId?: string;
  riskId?: string;
  defectId?: string;
}

/** 合稿范围筛选：用于只导出回归子集或某个模块的用例 */
export interface TestcaseCompileSelection {
  modules?: string[];
  requirementIds?: string[];
  caseIds?: string[];
  priorities?: Array<'高' | '中' | '低'>;
  executionStatuses?: TestcaseExecutionStatus[];
}

export interface TestcaseRiskCoverage {
  riskId: string;
  title: string;
  severity: TestcaseSeverity;
  status: TestcaseRisk['status'];
  caseNumbers: string[];
  covered: boolean;
}

export interface TestcaseDefectCoverage {
  defectId: string;
  title: string;
  severity: TestcaseSeverity;
  status: TestcaseDefect['status'];
  caseNumbers: string[];
  covered: boolean;
}

export interface TestcaseExecutionSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  untested: number;
  /** 已执行用例的通过率；无执行记录时为 0 */
  passRate: number;
  failedCaseNumbers: string[];
  blockedCaseNumbers: string[];
}

export interface TestcaseRegressionScope {
  caseNumbers: string[];
  reasons: Array<{ caseNumber: string; reason: string }>;
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
  riskRegister: TestcaseRiskCoverage[];
  defectTraceability: TestcaseDefectCoverage[];
  execution: TestcaseExecutionSummary;
  regression: TestcaseRegressionScope;
  /** 本次合稿使用的范围筛选；未筛选时缺省 */
  selection?: TestcaseCompileSelection;
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
