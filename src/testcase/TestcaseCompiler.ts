import type {
  CompiledTestcaseCase,
  CompiledTestcaseDocument,
  TestcaseCompileIssue,
  TestcaseCompileSelection,
  TestcaseDataItem,
  TestcaseDefectCoverage,
  TestcaseDraft,
  TestcaseExecutionSummary,
  TestcaseMethod,
  TestcaseRegressionScope,
  TestcaseRiskCoverage,
  TestcaseWorkspace,
} from '../types/testcase-workspace.js';

export const CANONICAL_TESTCASE_METHODS: readonly TestcaseMethod[] = [
  '需求分析法',
  '等价类划分法',
  '边界值分析法',
  '场景法',
  '错误猜测法',
];

const TEST_METHODS = new Set<TestcaseMethod>(CANONICAL_TESTCASE_METHODS);

const PRIORITY_ORDER = { 高: 0, 中: 1, 低: 2 } as const;
const SCENARIO_ORDER = { normal: 0, exception: 1, boundary: 2, other: 3 } as const;
const RISK_STATUS_LABELS = {
  open: '待处理',
  mitigated: '已缓解',
  accepted: '已接受',
} as const;
const DEFECT_STATUS_LABELS = {
  open: '待修复',
  fixed: '已修复待验证',
  verified: '已验证',
  rejected: '已拒绝',
} as const;
const EXECUTION_STATUS_LABELS = {
  untested: '未执行',
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
} as const;
const HEADERS = [
  '用例编号',
  '用例标题',
  '前置条件',
  '操作步骤',
  '预期结果',
  '优先级',
  '测试方法',
];

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function stripStepPrefix(value: string): string {
  return value
    .replace(/^\s*(?:\d+\s*[.、)）]|[(（]\d+[)）])\s*/u, '')
    .trim();
}

export function expandStepItems(items: string[]): string[] {
  const expanded: string[] = [];
  for (const item of items) {
    for (const part of item.split(/<br\s*\/?>|\r?\n/giu)) {
      const cleaned = normalize(stripStepPrefix(part));
      if (cleaned) expanded.push(cleaned);
    }
  }
  return expanded;
}

export function parseTestcaseMethods(raw: string): TestcaseMethod[] | null {
  const parts = raw
    .split(/[+＋、/,，]+/u)
    .map((part) => normalize(part))
    .filter(Boolean);
  if (parts.length === 0) return null;
  const result: TestcaseMethod[] = [];
  const seen = new Set<TestcaseMethod>();
  for (const part of parts) {
    if (!TEST_METHODS.has(part as TestcaseMethod)) return null;
    const method = part as TestcaseMethod;
    if (!seen.has(method)) {
      seen.add(method);
      result.push(method);
    }
  }
  return result.length > 3 ? null : result;
}

export function normalizeTestcaseMethod(raw: string): string {
  const parsed = parseTestcaseMethods(raw);
  if (!parsed) {
    throw new Error(`case.testMethod 非法：${String(raw)}`);
  }
  return parsed.join('+');
}

export function toPlainTestcaseRows(document: CompiledTestcaseDocument): string[][] {
  return document.rows.map((row) =>
    row.map((cell) => cell.replace(/<br\s*\/?>/giu, '\n')),
  );
}

export interface TestcaseXlsxSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
}

export function buildTestcaseXlsxSheets(
  document: CompiledTestcaseDocument,
  workspace?: TestcaseWorkspace,
): TestcaseXlsxSheet[] {
  const prefs = workspace?.state.outputPreferences;
  const sheets: TestcaseXlsxSheet[] = [
    {
      name: '功能测试用例',
      headers: [...HEADERS],
      rows: toPlainTestcaseRows(document),
    },
  ];
  if ((prefs?.includeDataChecklist ?? true) && document.dataItems.length > 0) {
    sheets.push({
      name: '数据准备清单',
      headers: ['模块', '数据占位符', '关联用例编号'],
      rows: document.dataItems.map((item) => [
        item.module,
        item.placeholder,
        item.caseNumbers.join('、'),
      ]),
    });
  }
  if ((prefs?.includeTraceability ?? true) && document.traceability.length > 0) {
    const reqById = new Map(
      (workspace?.state.requirements ?? []).map((req) => [req.id, req]),
    );
    sheets.push({
      name: '需求覆盖追溯',
      headers: ['需求 ID', '模块', '需求标题', '来源章节', '已覆盖', '覆盖用例编号'],
      rows: document.traceability.map((item) => {
        const req = reqById.get(item.requirementId);
        return [
          item.requirementId,
          req?.module ?? '',
          item.title,
          req?.sourceRef ?? '',
          item.covered ? '是' : '否',
          item.caseNumbers.join('、'),
        ];
      }),
    });
  }
  if ((prefs?.includeTraceability ?? true) && document.riskRegister.length > 0) {
    const riskById = new Map(
      (workspace?.state.risks ?? []).map((risk) => [risk.id, risk]),
    );
    sheets.push({
      name: '需求评审风险',
      headers: [
        '风险 ID',
        '模块',
        '风险标题',
        '等级',
        '状态',
        '已覆盖',
        '覆盖用例编号',
        '风险说明',
        '应对说明',
      ],
      rows: document.riskRegister.map((item) => {
        const risk = riskById.get(item.riskId);
        return [
          item.riskId,
          risk?.module ?? '',
          item.title,
          item.severity,
          RISK_STATUS_LABELS[item.status],
          item.covered ? '是' : '否',
          item.caseNumbers.join('、'),
          risk?.detail ?? '',
          risk?.mitigation ?? '',
        ];
      }),
    });
  }
  if (
    (prefs?.includeTraceability ?? true) &&
    document.defectTraceability.length > 0
  ) {
    const defectById = new Map(
      (workspace?.state.defects ?? []).map((defect) => [defect.id, defect]),
    );
    sheets.push({
      name: '缺陷复现追溯',
      headers: [
        '缺陷 ID',
        '模块',
        '缺陷标题',
        '等级',
        '状态',
        '来源',
        '已覆盖',
        '覆盖用例编号',
        '现象',
      ],
      rows: document.defectTraceability.map((item) => {
        const defect = defectById.get(item.defectId);
        return [
          item.defectId,
          defect?.module ?? '',
          item.title,
          item.severity,
          DEFECT_STATUS_LABELS[item.status],
          defect?.sourceRef ?? '',
          item.covered ? '是' : '否',
          item.caseNumbers.join('、'),
          defect?.symptom ?? '',
        ];
      }),
    });
  }
  const executedCount =
    document.execution.passed +
    document.execution.failed +
    document.execution.blocked;
  if (executedCount > 0) {
    sheets.push({
      name: '执行结果',
      headers: ['用例编号', '用例标题', '执行状态', '执行人', '执行时间', '备注'],
      rows: document.cases.map((item) => [
        item.caseNumber,
        item.title,
        EXECUTION_STATUS_LABELS[item.execution?.status ?? 'untested'],
        item.execution?.executor ?? '',
        item.execution?.executedAt
          ? new Date(item.execution.executedAt).toISOString()
          : '',
        item.execution?.note ?? '',
      ]),
    });
  }
  if (document.regression.reasons.length > 0) {
    sheets.push({
      name: '回归范围建议',
      headers: ['用例编号', '纳入原因'],
      rows: document.regression.reasons.map((item) => [
        item.caseNumber,
        item.reason,
      ]),
    });
  }
  const summaryRows: Array<[string, string]> = [
    ['工作区标题', document.title],
    ['工作区 ID', document.workspaceId],
    ['合稿版本', `v${document.version}（来源 r${document.sourceRevision}）`],
    ['总用例数', String(document.statistics.total)],
    [
      '优先级分布',
      `高 ${document.statistics.byPriority.高} / 中 ${document.statistics.byPriority.中} / 低 ${document.statistics.byPriority.低}`,
    ],
    [
      '模块分布',
      Object.entries(document.statistics.byModule)
        .map(([k, v]) => `${k}: ${v}`)
        .join('；') || '无',
    ],
    [
      '测试方法分布',
      Object.entries(document.statistics.byMethod)
        .map(([k, v]) => `${k}: ${v}`)
        .join('；') || '无',
    ],
    [
      '未关闭风险',
      String(document.riskRegister.filter((item) => item.status === 'open').length),
    ],
    [
      '待验证缺陷',
      String(
        document.defectTraceability.filter(
          (item) => item.status === 'open' || item.status === 'fixed',
        ).length,
      ),
    ],
    ['回归范围建议', document.regression.caseNumbers.join('、') || '无'],
  ];
  if (document.selection) {
    summaryRows.push(['合稿范围', describeTestcaseSelection(document.selection)]);
  }
  if (executedCount > 0) {
    summaryRows.push([
      '执行统计',
      `已执行 ${executedCount}/${document.execution.total}，通过 ${document.execution.passed}、失败 ${document.execution.failed}、阻塞 ${document.execution.blocked}，通过率 ${document.execution.passRate}%`,
    ]);
  }
  for (const decision of workspace?.state.decisions ?? []) {
    summaryRows.push([`已确认口径：${decision.topic}`, decision.value]);
  }
  for (const assumption of unique(document.cases.flatMap((c) => c.assumptions))) {
    summaryRows.push(['编写假设', assumption]);
  }
  for (const question of document.openQuestions) {
    summaryRows.push([
      question.blocking ? '阻塞待确认' : '非阻塞待确认',
      question.question,
    ]);
  }
  for (const issue of document.issues) {
    summaryRows.push([`编译检查：${issue.code}`, issue.message]);
  }
  sheets.push({
    name: '概要统计与检查',
    headers: ['检查项', '内容'],
    rows: summaryRows,
  });
  return sheets;
}

function semanticKey(item: TestcaseDraft): string {
  return JSON.stringify([
    normalize(item.module),
    normalize(item.title),
    expandStepItems(item.preconditions),
    expandStepItems(item.steps),
    expandStepItems(item.expectedResults),
  ]);
}

function moduleCode(module: string): string {
  const cleaned = module
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toUpperCase();
  return cleaned || 'GENERAL';
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
}

function numbered(items: string[]): string {
  return items
    .map((item) => normalize(stripStepPrefix(item)))
    .filter(Boolean)
    .map((item, index) => `${index + 1}. ${item}`)
    .join('<br>');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function mergeDuplicate(
  target: TestcaseDraft,
  source: TestcaseDraft,
): TestcaseDraft {
  const riskIds = unique([...(target.riskIds ?? []), ...(source.riskIds ?? [])]);
  const defectIds = unique([
    ...(target.defectIds ?? []),
    ...(source.defectIds ?? []),
  ]);
  const execution = target.execution ?? source.execution;
  return {
    ...target,
    requirementIds: unique([...target.requirementIds, ...source.requirementIds]),
    evidenceIds: unique([...target.evidenceIds, ...source.evidenceIds]),
    assumptions: unique([...target.assumptions, ...source.assumptions]),
    ...(riskIds.length > 0 ? { riskIds } : {}),
    ...(defectIds.length > 0 ? { defectIds } : {}),
    ...(execution ? { execution } : {}),
  };
}

export interface CompileTestcaseOptions {
  version?: number;
  now?: number;
  /** 只合稿命中筛选条件的用例，用于回归子集或单模块导出 */
  selection?: TestcaseCompileSelection;
}

function matchesSelection(
  item: TestcaseDraft,
  selection: TestcaseCompileSelection,
): boolean {
  if (selection.modules?.length && !selection.modules.includes(item.module)) {
    return false;
  }
  if (selection.caseIds?.length && !selection.caseIds.includes(item.id)) {
    return false;
  }
  if (
    selection.priorities?.length &&
    !selection.priorities.includes(item.priority)
  ) {
    return false;
  }
  if (
    selection.requirementIds?.length &&
    !item.requirementIds.some((id) => selection.requirementIds?.includes(id))
  ) {
    return false;
  }
  if (
    selection.executionStatuses?.length &&
    !selection.executionStatuses.includes(item.execution?.status ?? 'untested')
  ) {
    return false;
  }
  return true;
}

export function describeTestcaseSelection(
  selection: TestcaseCompileSelection,
): string {
  const parts: string[] = [];
  if (selection.modules?.length) parts.push(`模块 ${selection.modules.join('、')}`);
  if (selection.requirementIds?.length) {
    parts.push(`需求 ${selection.requirementIds.join('、')}`);
  }
  if (selection.caseIds?.length) parts.push(`草稿 ${selection.caseIds.join('、')}`);
  if (selection.priorities?.length) {
    parts.push(`优先级 ${selection.priorities.join('、')}`);
  }
  if (selection.executionStatuses?.length) {
    parts.push(`执行状态 ${selection.executionStatuses.join('、')}`);
  }
  return parts.join('；') || '全部用例';
}

function buildRiskRegister(
  workspace: TestcaseWorkspace,
  cases: CompiledTestcaseCase[],
  issues: TestcaseCompileIssue[],
): TestcaseRiskCoverage[] {
  const register = workspace.state.risks.map((risk) => {
    const matched = cases.filter((item) => item.riskIds?.includes(risk.id));
    return {
      riskId: risk.id,
      title: risk.title,
      severity: risk.severity,
      status: risk.status,
      caseNumbers: matched.map((item) => item.caseNumber),
      covered: matched.length > 0,
    };
  });
  for (const item of register) {
    if (item.status === 'open' && !item.covered) {
      issues.push({
        code: 'uncovered_risk',
        message: `风险 ${item.riskId} ${item.title} 仍待处理且没有用例覆盖`,
        riskId: item.riskId,
      });
    }
  }
  return register;
}

function buildDefectTraceability(
  workspace: TestcaseWorkspace,
  cases: CompiledTestcaseCase[],
  issues: TestcaseCompileIssue[],
): TestcaseDefectCoverage[] {
  const traceability = workspace.state.defects.map((defect) => {
    const matched = cases.filter((item) => item.defectIds?.includes(defect.id));
    return {
      defectId: defect.id,
      title: defect.title,
      severity: defect.severity,
      status: defect.status,
      caseNumbers: matched.map((item) => item.caseNumber),
      covered: matched.length > 0,
    };
  });
  for (const item of traceability) {
    if (
      (item.status === 'open' || item.status === 'fixed') &&
      !item.covered
    ) {
      issues.push({
        code: 'uncovered_defect',
        message: `缺陷 ${item.defectId} ${item.title} 缺少复现或回归验证用例`,
        defectId: item.defectId,
      });
    }
  }
  return traceability;
}

function buildExecutionSummary(
  cases: CompiledTestcaseCase[],
): TestcaseExecutionSummary {
  const summary: TestcaseExecutionSummary = {
    total: cases.length,
    passed: 0,
    failed: 0,
    blocked: 0,
    untested: 0,
    passRate: 0,
    failedCaseNumbers: [],
    blockedCaseNumbers: [],
  };
  for (const item of cases) {
    const status = item.execution?.status ?? 'untested';
    if (status === 'passed') summary.passed += 1;
    else if (status === 'failed') {
      summary.failed += 1;
      summary.failedCaseNumbers.push(item.caseNumber);
    } else if (status === 'blocked') {
      summary.blocked += 1;
      summary.blockedCaseNumbers.push(item.caseNumber);
    } else summary.untested += 1;
  }
  const executed = summary.passed + summary.failed + summary.blocked;
  summary.passRate =
    executed > 0 ? Math.round((summary.passed / executed) * 1000) / 10 : 0;
  return summary;
}

function buildRegressionScope(
  workspace: TestcaseWorkspace,
  cases: CompiledTestcaseCase[],
): TestcaseRegressionScope {
  const openRiskIds = new Set(
    workspace.state.risks
      .filter((item) => item.status === 'open')
      .map((item) => item.id),
  );
  const pendingDefectIds = new Set(
    workspace.state.defects
      .filter((item) => item.status === 'open' || item.status === 'fixed')
      .map((item) => item.id),
  );
  const reasons: TestcaseRegressionScope['reasons'] = [];
  for (const item of cases) {
    const why: string[] = [];
    if (item.execution?.status === 'failed') why.push('上轮执行失败');
    if (item.execution?.status === 'blocked') why.push('上轮执行阻塞');
    const riskHits = (item.riskIds ?? []).filter((id) => openRiskIds.has(id));
    if (riskHits.length > 0) why.push(`关联未关闭风险 ${riskHits.join('、')}`);
    const defectHits = (item.defectIds ?? []).filter((id) =>
      pendingDefectIds.has(id),
    );
    if (defectHits.length > 0) {
      why.push(`关联待验证缺陷 ${defectHits.join('、')}`);
    }
    if (item.priority === '高') why.push('高优先级核心用例');
    if (why.length > 0) {
      reasons.push({ caseNumber: item.caseNumber, reason: why.join('；') });
    }
  }
  return { caseNumbers: reasons.map((item) => item.caseNumber), reasons };
}

export function compileTestcaseWorkspace(
  workspace: TestcaseWorkspace,
  options: CompileTestcaseOptions = {},
): CompiledTestcaseDocument {
  const issues: TestcaseCompileIssue[] = [];
  const activeRequirements = workspace.state.requirements.filter(
    (item) => item.status !== 'superseded',
  );
  const requirementIds = new Set(activeRequirements.map((item) => item.id));
  const evidenceIds = new Set(workspace.state.evidence.map((item) => item.id));
  const riskIds = new Set(workspace.state.risks.map((item) => item.id));
  const defectIds = new Set(workspace.state.defects.map((item) => item.id));
  const selection = options.selection;
  const candidates = workspace.state.cases.filter(
    (item) =>
      item.status !== 'superseded' &&
      (!selection || matchesSelection(item, selection)),
  );
  const deduped: TestcaseDraft[] = [];
  const bySemanticKey = new Map<string, TestcaseDraft>();

  for (const candidate of candidates) {
    const key = semanticKey(candidate);
    const existing = bySemanticKey.get(key);
    if (existing) {
      const merged = mergeDuplicate(existing, candidate);
      const index = deduped.findIndex((item) => item.id === existing.id);
      deduped[index] = merged;
      bySemanticKey.set(key, merged);
      continue;
    }
    const copy = structuredClone(candidate);
    deduped.push(copy);
    bySemanticKey.set(key, copy);
  }

  const byTitle = new Map<string, TestcaseDraft[]>();
  for (const item of deduped) {
    const key = `${normalize(item.module)}|${normalize(item.title)}`;
    byTitle.set(key, [...(byTitle.get(key) ?? []), item]);
  }
  for (const items of byTitle.values()) {
    if (items.length < 2) continue;
    issues.push({
      code: 'duplicate_candidate',
      message: `同模块同标题存在内容不同的用例：${items.map((item) => item.id).join('、')}`,
      caseId: items[0]?.id,
    });
  }

  for (const item of deduped) {
    const preconditions = expandStepItems(item.preconditions);
    const steps = expandStepItems(item.steps);
    const expectedResults = expandStepItems(item.expectedResults);
    if (
      !normalize(item.title) ||
      preconditions.length === 0 ||
      steps.length === 0 ||
      expectedResults.length === 0
    ) {
      issues.push({
        code: 'empty_case',
        message: `用例 ${item.id} 缺少标题、前置条件、步骤或预期结果`,
        caseId: item.id,
      });
    }
    const parsedMethods = parseTestcaseMethods(item.testMethod);
    if (!parsedMethods) {
      issues.push({
        code: 'unsupported_method',
        message: `用例 ${item.id} 使用了不支持的测试方法：${item.testMethod}`,
        caseId: item.id,
      });
    } else {
      item.testMethod = parsedMethods.join('+');
    }
    item.preconditions = preconditions;
    item.steps = steps;
    item.expectedResults = expectedResults;
    if (item.requirementIds.length === 0) {
      issues.push({
        code: 'missing_requirement',
        message: `用例 ${item.id} 尚未关联需求`,
        caseId: item.id,
      });
    }
    for (const requirementId of item.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        issues.push({
          code: 'missing_requirement',
          message: `用例 ${item.id} 引用了不存在或已替代的需求 ${requirementId}`,
          caseId: item.id,
          requirementId,
        });
      }
    }
    for (const evidenceId of item.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push({
          code: 'missing_evidence',
          message: `用例 ${item.id} 引用了不存在的证据 ${evidenceId}`,
          caseId: item.id,
          evidenceId,
        });
      }
    }
    for (const riskId of item.riskIds ?? []) {
      if (!riskIds.has(riskId)) {
        issues.push({
          code: 'missing_risk',
          message: `用例 ${item.id} 引用了不存在的风险 ${riskId}`,
          caseId: item.id,
          riskId,
        });
      }
    }
    for (const defectId of item.defectIds ?? []) {
      if (!defectIds.has(defectId)) {
        issues.push({
          code: 'missing_defect',
          message: `用例 ${item.id} 引用了不存在的缺陷 ${defectId}`,
          caseId: item.id,
          defectId,
        });
      }
    }
  }

  const moduleRank = new Map<string, number>();
  for (const requirement of activeRequirements) {
    if (!moduleRank.has(requirement.module)) {
      moduleRank.set(requirement.module, moduleRank.size);
    }
  }
  for (const item of deduped) {
    if (!moduleRank.has(item.module)) {
      moduleRank.set(item.module, moduleRank.size);
    }
  }

  const sorted = [...deduped].sort((left, right) => {
    const moduleDiff =
      (moduleRank.get(left.module) ?? Number.MAX_SAFE_INTEGER) -
      (moduleRank.get(right.module) ?? Number.MAX_SAFE_INTEGER);
    if (moduleDiff !== 0) return moduleDiff;
    const priorityDiff =
      PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const scenarioDiff =
      SCENARIO_ORDER[left.scenarioType] - SCENARIO_ORDER[right.scenarioType];
    if (scenarioDiff !== 0) return scenarioDiff;
    return left.title.localeCompare(right.title, 'zh-CN');
  });

  const moduleCodes = new Map<string, string>();
  const usedModuleCodes = new Set<string>();
  for (const module of new Set(sorted.map((item) => item.module))) {
    const baseCode = moduleCode(module);
    let code = baseCode;
    let suffix = 2;
    while (usedModuleCodes.has(code)) {
      code = `${baseCode}_${suffix}`;
      suffix += 1;
    }
    moduleCodes.set(module, code);
    usedModuleCodes.add(code);
  }

  const moduleCounters = new Map<string, number>();
  const cases: CompiledTestcaseCase[] = sorted.map((item) => {
    const code = moduleCodes.get(item.module) ?? moduleCode(item.module);
    const next = (moduleCounters.get(code) ?? 0) + 1;
    moduleCounters.set(code, next);
    return {
      ...item,
      caseNumber: `TC_${code}_${String(next).padStart(3, '0')}`,
    };
  });

  const dataItems: TestcaseDataItem[] = [];
  const dataMap = new Map<string, TestcaseDataItem>();
  for (const item of cases) {
    const text = [...item.preconditions, ...item.steps, ...item.expectedResults].join(
      '\n',
    );
    for (const match of text.matchAll(/\{\{DATA:\s*([^}]+)\}\}/gu)) {
      const placeholder = `{{DATA: ${normalize(match[1] ?? '')}}}`;
      const key = `${item.module}|${placeholder}`;
      const existing = dataMap.get(key);
      if (existing) {
        existing.caseNumbers.push(item.caseNumber);
      } else {
        const dataItem = {
          module: item.module,
          placeholder,
          caseNumbers: [item.caseNumber],
        };
        dataMap.set(key, dataItem);
        dataItems.push(dataItem);
      }
    }
  }

  const moduleCounts = new Map<string, number>();
  const statistics = {
    total: cases.length,
    byPriority: { 高: 0, 中: 0, 低: 0 },
    byModule: {} as Record<string, number>,
    byMethod: {} as Record<string, number>,
  };
  for (const item of cases) {
    statistics.byPriority[item.priority] += 1;
    moduleCounts.set(item.module, (moduleCounts.get(item.module) ?? 0) + 1);
    statistics.byMethod[item.testMethod] =
      (statistics.byMethod[item.testMethod] ?? 0) + 1;
  }
  statistics.byModule = Object.fromEntries(moduleCounts);

  // 筛选合稿时只追溯范围内的需求，避免把范围外需求报成未覆盖
  const tracedRequirements = selection
    ? activeRequirements.filter(
        (requirement) =>
          selection.requirementIds?.includes(requirement.id) ||
          cases.some((item) => item.requirementIds.includes(requirement.id)),
      )
    : activeRequirements;
  const traceability = tracedRequirements.map((requirement) => {
    const matched = cases.filter((item) =>
      item.requirementIds.includes(requirement.id),
    );
    return {
      requirementId: requirement.id,
      title: requirement.title,
      caseNumbers: matched.map((item) => item.caseNumber),
      covered: matched.length > 0,
    };
  });
  for (const item of traceability) {
    if (!item.covered) {
      issues.push({
        code: 'uncovered_requirement',
        message: `需求 ${item.requirementId} ${item.title} 尚未被用例覆盖`,
        requirementId: item.requirementId,
      });
    }
  }

  const seenConflicts = new Set<string>();
  for (const evidence of workspace.state.evidence) {
    for (const conflictId of evidence.conflictsWith) {
      const pairKey =
        evidence.id < conflictId
          ? `${evidence.id}|${conflictId}`
          : `${conflictId}|${evidence.id}`;
      if (seenConflicts.has(pairKey)) continue;
      seenConflicts.add(pairKey);
      issues.push({
        code: 'evidence_conflict',
        message: `证据 ${evidence.id} 与 ${conflictId} 存在冲突，请核实可见行为与文档差异`,
        evidenceId: evidence.id,
      });
    }
  }

  const openQuestions = workspace.state.openQuestions.filter(
    (item) => item.status === 'open',
  );
  for (const question of openQuestions) {
    issues.push({
      code: 'unresolved_question',
      message: question.question,
      requirementId: question.requirementIds[0],
    });
  }

  const riskRegister = buildRiskRegister(workspace, cases, issues);
  const defectTraceability = buildDefectTraceability(workspace, cases, issues);
  const execution = buildExecutionSummary(cases);
  const regression = buildRegressionScope(workspace, cases);

  const rows = cases.map((item) => {
    const steps = item.steps.map(stepWithScreenshot(item, workspace));
    return [
      item.caseNumber,
      item.title,
      numbered(item.preconditions),
      numbered(steps),
      numbered(item.expectedResults),
      item.priority,
      item.testMethod,
    ];
  });

  const markdown = renderMarkdown({
    workspace,
    cases,
    dataItems,
    statistics,
    traceability,
    riskRegister,
    defectTraceability,
    execution,
    regression,
    ...(selection ? { selection } : {}),
    openQuestions,
    issues,
  });

  return {
    workspaceId: workspace.id,
    version: options.version ?? 1,
    sourceRevision: workspace.revision,
    title: workspace.title,
    generatedAt: options.now ?? Date.now(),
    cases,
    dataItems,
    statistics,
    traceability,
    riskRegister,
    defectTraceability,
    execution,
    regression,
    ...(selection ? { selection } : {}),
    openQuestions,
    issues,
    markdown,
    rows,
  };
}

function renderMarkdown(input: {
  workspace: TestcaseWorkspace;
  cases: CompiledTestcaseCase[];
  dataItems: TestcaseDataItem[];
  statistics: CompiledTestcaseDocument['statistics'];
  traceability: CompiledTestcaseDocument['traceability'];
  riskRegister: TestcaseRiskCoverage[];
  defectTraceability: TestcaseDefectCoverage[];
  execution: TestcaseExecutionSummary;
  regression: TestcaseRegressionScope;
  selection?: TestcaseCompileSelection;
  openQuestions: CompiledTestcaseDocument['openQuestions'];
  issues: TestcaseCompileIssue[];
}): string {
  const { workspace, cases, dataItems, statistics, traceability } = input;
  const lines: string[] = [
    `# ${workspace.title}`,
    '',
    `- 工作区：${workspace.id}`,
    `- 来源版本：r${workspace.revision}`,
    `- 用例总数：${statistics.total}`,
    `- 优先级：高 ${statistics.byPriority.高} / 中 ${statistics.byPriority.中} / 低 ${statistics.byPriority.低}`,
  ];
  if (input.selection) {
    lines.push(`- 合稿范围：${describeTestcaseSelection(input.selection)}`);
  }
  lines.push('', '## 需求缺失、假设与待确认', '');

  const assumptions = unique(cases.flatMap((item) => item.assumptions));
  if (assumptions.length === 0 && input.openQuestions.length === 0) {
    lines.push('- 无记录项。');
  } else {
    for (const assumption of assumptions) lines.push(`- 假设：${assumption}`);
    for (const question of input.openQuestions) {
      lines.push(
        `- ${question.blocking ? '阻塞待确认' : '非阻塞待确认'}：${question.question}`,
      );
    }
  }

  if (workspace.state.decisions.length > 0) {
    lines.push('', '## 已确认口径与决策', '');
    for (const decision of workspace.state.decisions) {
      lines.push(`- ${decision.topic}：${decision.value}`);
    }
  }

  const sources = unique([
    ...workspace.state.requirements.map((item) => item.sourceRef),
    ...workspace.state.evidence.map((item) => item.sourceRef),
  ]);
  if (sources.length > 0) {
    lines.push('', '## 来源', '');
    for (const source of sources) lines.push(`- ${source}`);
  }

  const modules = [...new Set(cases.map((item) => item.module))];
  for (const module of modules) {
    const moduleCases = cases.filter((item) => item.module === module);
    lines.push('', `## ${module}`, '');
    if (workspace.state.outputPreferences.includeDataChecklist) {
      const items = dataItems.filter((item) => item.module === module);
      if (items.length > 0) {
        lines.push('> ⚠️ 数据准备清单（执行前必读）', '');
        items.forEach((item, index) => {
          lines.push(
            `> ${index + 1}. ${item.placeholder} — 用于 ${item.caseNumbers.join('、')}`,
          );
        });
        lines.push('');
      }
    }
    lines.push(`| ${HEADERS.join(' | ')} |`);
    lines.push(`| ${HEADERS.map(() => '---').join(' | ')} |`);
    for (const item of moduleCases) {
      lines.push(
        `| ${[
          item.caseNumber,
          escapeCell(item.title),
          numbered(item.preconditions),
          numbered(item.steps.map(stepWithScreenshot(item, workspace))),
          numbered(item.expectedResults),
          item.priority,
          item.testMethod,
        ]
          .map(escapeCell)
          .join(' | ')} |`,
      );
    }
    if (workspace.state.outputPreferences.includeTraceability) {
      const requirementIds = new Set(
        moduleCases.flatMap((item) => item.requirementIds),
      );
      const related = workspace.state.requirements.filter((item) =>
        requirementIds.has(item.id),
      );
      lines.push('', '对应需求文档章节：');
      for (const requirement of related) {
        lines.push(`- ${requirement.sourceRef} / ${requirement.title}`);
      }
    }
    if (workspace.state.outputPreferences.includeAutomationFeasibility) {
      const text = moduleCases
        .flatMap((item) => [...item.preconditions, ...item.steps, ...item.expectedResults])
        .join(' ');
      const notAutomatable =
        /真实支付|扣款|打款|硬件|外设|指纹|人脸识别|扫码枪|蓝牙|USB|生产专属|不可逆/u.test(
          text,
        );
      const partial =
        /验证码|滑块|人机校验|扫码|人工|审批|短信|邮件|企微|钉钉通知|消息推送|第三方回调/u.test(
          text,
        );
      lines.push(
        '',
        notAutomatable
          ? '自动化可行性：暂不可自动化。存在真实资金交易、硬件外设、生产专属数据或不可逆操作依赖，建议人工或专项环境验证。'
          : partial
            ? '自动化可行性：部分可自动化。存在人机校验、人工审批或外部通知依赖，需要结合测试平台与桩服务评估。'
            : '自动化可行性：可自动化（仍需测试平台实现、真实数据准备和环境配置）。',
      );
    }
  }

  if (workspace.state.outputPreferences.includeTraceability) {
    lines.push('', '## 需求覆盖追溯', '');
    for (const item of traceability) {
      lines.push(
        `- ${item.requirementId} ${item.title}：${item.covered ? item.caseNumbers.join('、') : '未覆盖，需补充用例或说明原因'}`,
      );
    }
  }

  if (input.riskRegister.length > 0) {
    lines.push('', '## 需求评审风险', '');
    for (const item of input.riskRegister) {
      lines.push(
        `- [${item.severity}] ${item.riskId} ${item.title}（${RISK_STATUS_LABELS[item.status]}）：${item.covered ? item.caseNumbers.join('、') : '无用例覆盖'}`,
      );
    }
  }

  if (input.defectTraceability.length > 0) {
    lines.push('', '## 缺陷复现追溯', '');
    for (const item of input.defectTraceability) {
      lines.push(
        `- [${item.severity}] ${item.defectId} ${item.title}（${DEFECT_STATUS_LABELS[item.status]}）：${item.covered ? item.caseNumbers.join('、') : '缺少复现或回归用例'}`,
      );
    }
  }

  const execution = input.execution;
  const executed = execution.passed + execution.failed + execution.blocked;
  if (executed > 0) {
    const byNumber = new Map(cases.map((item) => [item.caseNumber, item]));
    lines.push(
      '',
      '## 执行结果与测试报告',
      '',
      `- 已执行 ${executed} / ${execution.total}：通过 ${execution.passed}、失败 ${execution.failed}、阻塞 ${execution.blocked}；未执行 ${execution.untested}`,
      `- 已执行用例通过率：${execution.passRate}%`,
    );
    for (const caseNumber of execution.failedCaseNumbers) {
      const item = byNumber.get(caseNumber);
      lines.push(
        `- 失败 ${caseNumber} ${item?.title ?? ''}：${item?.execution?.note || '未填写失败说明'}`,
      );
    }
    for (const caseNumber of execution.blockedCaseNumbers) {
      const item = byNumber.get(caseNumber);
      lines.push(
        `- 阻塞 ${caseNumber} ${item?.title ?? ''}：${item?.execution?.note || '未填写阻塞原因'}`,
      );
    }
  }

  if (input.regression.caseNumbers.length > 0) {
    lines.push(
      '',
      '## 回归范围建议',
      '',
      `共 ${input.regression.caseNumbers.length} 条，按失败、阻塞、未关闭风险、待验证缺陷与高优先级筛出：`,
    );
    for (const item of input.regression.reasons) {
      lines.push(`- ${item.caseNumber}：${item.reason}`);
    }
  }

  if (input.issues.length > 0) {
    lines.push('', '## 编译检查提醒', '');
    for (const issue of input.issues) lines.push(`- ${issue.message}`);
  }

  lines.push(
    '',
    '> 本文档为功能测试用例设计稿，不包含自动执行器；执行由人或外部测试平台完成。',
    '',
  );
  return lines.join('\n');
}

function stepWithScreenshot(
  item: CompiledTestcaseCase,
  workspace: TestcaseWorkspace,
): (step: string, index: number) => string {
  const hasExistingMarker = item.steps.some((step) => step.includes('📷'));
  return (step, index) => {
    const clean = stripStepPrefix(step);
    if (!workspace.state.outputPreferences.screenshotMarkers) {
      return clean.replace(/\s*📷\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
    }
    if (!hasExistingMarker && index === Math.max(0, item.steps.length - 1)) {
      return `${clean} 📷`;
    }
    return clean;
  };
}
