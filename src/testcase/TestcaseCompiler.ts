import type {
  CompiledTestcaseCase,
  CompiledTestcaseDocument,
  TestcaseCompileIssue,
  TestcaseDataItem,
  TestcaseDraft,
  TestcaseMethod,
  TestcaseWorkspace,
} from '../types/testcase-workspace.js';

const TEST_METHODS = new Set<TestcaseMethod>([
  '需求分析法',
  '等价类划分法',
  '边界值分析法',
  '场景法',
  '错误猜测法',
]);

const PRIORITY_ORDER = { 高: 0, 中: 1, 低: 2 } as const;
const SCENARIO_ORDER = { normal: 0, exception: 1, boundary: 2, other: 3 } as const;
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

function semanticKey(item: TestcaseDraft): string {
  return JSON.stringify([
    normalize(item.module),
    normalize(item.title),
    item.preconditions.map(normalize),
    item.steps.map(normalize),
    item.expectedResults.map(normalize),
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
  return items.map((item, index) => `${index + 1}. ${item}`).join('<br>');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function mergeDuplicate(
  target: TestcaseDraft,
  source: TestcaseDraft,
): TestcaseDraft {
  return {
    ...target,
    requirementIds: unique([...target.requirementIds, ...source.requirementIds]),
    evidenceIds: unique([...target.evidenceIds, ...source.evidenceIds]),
    assumptions: unique([...target.assumptions, ...source.assumptions]),
  };
}

export interface CompileTestcaseOptions {
  version?: number;
  now?: number;
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
  const candidates = workspace.state.cases.filter(
    (item) => item.status !== 'superseded',
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
    if (
      !normalize(item.title) ||
      !item.preconditions.some((value) => normalize(value)) ||
      !item.steps.some((value) => normalize(value)) ||
      !item.expectedResults.some((value) => normalize(value))
    ) {
      issues.push({
        code: 'empty_case',
        message: `用例 ${item.id} 缺少标题、前置条件、步骤或预期结果`,
        caseId: item.id,
      });
    }
    if (!TEST_METHODS.has(item.testMethod)) {
      issues.push({
        code: 'unsupported_method',
        message: `用例 ${item.id} 使用了不支持的测试方法：${item.testMethod}`,
        caseId: item.id,
      });
    }
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

  const traceability = activeRequirements.map((requirement) => {
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

  const rows = cases.map((item) => [
    item.caseNumber,
    item.title,
    numbered(item.preconditions),
    numbered(item.steps.map(stepWithScreenshot(item, workspace))),
    numbered(item.expectedResults),
    item.priority,
    item.testMethod,
  ]);

  const markdown = renderMarkdown({
    workspace,
    cases,
    dataItems,
    statistics,
    traceability,
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
    '',
    '## 需求缺失、假设与待确认',
    '',
  ];

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
        .flatMap((item) => [...item.steps, ...item.expectedResults])
        .join(' ');
      const partial = /人工|硬件|支付|审批|短信|邮件|通知/u.test(text);
      lines.push(
        '',
        partial
          ? '自动化可行性：部分可自动化。存在人工判断、外部通知或不可逆依赖，需要结合测试平台与真实数据评估。'
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
  return (step, index) => {
    if (!workspace.state.outputPreferences.screenshotMarkers) return step;
    if (index === Math.max(0, item.steps.length - 1) && !step.includes('📷')) {
      return `${step} 📷`;
    }
    return step;
  };
}
