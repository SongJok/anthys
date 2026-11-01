import type { ReActTraceRecord, ReActTraceStep } from '../types/admin-and-console.js';

export interface FlowEvalCase {
  id: string;
  /** 与轨迹 question 完全一致的文本；比较时忽略空白与大小写 */
  question: string;
  expectedKeywords: string[];
  /** 期望至少调用一次的工具名 */
  expectedTools?: string[];
  /** 不允许出现的工具名 */
  forbiddenTools?: string[];
  requireCitation?: boolean;
  maxSteps?: number;
  maxTokens?: number;
  /** 期望关键词覆盖率下限，默认 0.8 */
  minKeywordCoverage?: number;
}

export interface FlowCaseResult {
  id: string;
  question: string;
  matchedTraces: number;
  passed: boolean;
  keywordCoverage: number;
  missingKeywords: string[];
  missingTools: string[];
  forbiddenToolsUsed: string[];
  citationOk: boolean;
  stepsOk: boolean;
  tokensOk: boolean;
  violations: string[];
}

export interface MessageFlowReport {
  sinceMs: number;
  totalTurns: number;
  answeredTurns: number;
  answeredRate: number;
  toolTurns: number;
  toolErrorTurns: number;
  toolErrorRate: number;
  citationTurns: number;
  citationRate: number;
  watchdogTurns: number;
  watchdogRate: number;
  avgTokens: number;
  p95Tokens: number;
  avgDurationMs: number;
  p95DurationMs: number;
  cases: FlowCaseResult[];
  casePassRate: number;
  unmatchedCaseIds: string[];
}

export interface FlowEvalOptions {
  sinceMs?: number;
  minAnswerChars?: number;
  cases?: FlowEvalCase[];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** 问法匹配忽略空白、大小写与句末标点 */
function normalizeQuestion(text: string): string {
  return normalizeText(text).replace(/[?？!！。.,，;；:：]+$/u, '');
}

function isToolStep(step: ReActTraceStep): boolean {
  return step.type === 'tool' || step.type === 'sandbox';
}

function hasCitation(trace: ReActTraceRecord): boolean {
  return trace.steps.some(
    (step) => step.type === 'citation' && Boolean(step.content?.trim()),
  );
}

function hasWatchdog(trace: ReActTraceRecord): boolean {
  return trace.steps.some(
    (step) =>
      step.type === 'narration' && Boolean(step.content?.startsWith('执行保护')),
  );
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function latestTraceFor(
  traces: ReActTraceRecord[],
  question: string,
): ReActTraceRecord[] {
  const target = normalizeQuestion(question);
  return traces
    .filter((trace) => normalizeQuestion(trace.question) === target)
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )
    .slice(0, 1);
}

function evaluateCase(
  testCase: FlowEvalCase,
  traces: ReActTraceRecord[],
): FlowCaseResult {
  const matched = latestTraceFor(traces, testCase.question);
  const trace = matched[0];
  const violations: string[] = [];
  if (!trace) {
    return {
      id: testCase.id,
      question: testCase.question,
      matchedTraces: 0,
      passed: false,
      keywordCoverage: 0,
      missingKeywords: [...testCase.expectedKeywords],
      missingTools: [...(testCase.expectedTools ?? [])],
      forbiddenToolsUsed: [],
      citationOk: testCase.requireCitation !== true,
      stepsOk: true,
      tokensOk: true,
      violations: ['未找到匹配问法的轨迹'],
    };
  }

  const haystack = normalizeText(`${trace.answer}\n${trace.steps
    .map((step) => step.output ?? step.content ?? '')
    .join('\n')}`);
  const missingKeywords = testCase.expectedKeywords.filter(
    (keyword) => !haystack.includes(normalizeText(keyword)),
  );
  const keywordCoverage =
    testCase.expectedKeywords.length === 0
      ? 1
      : (testCase.expectedKeywords.length - missingKeywords.length) /
        testCase.expectedKeywords.length;
  const usedTools = new Set(
    trace.steps.filter(isToolStep).map((step) => step.toolName ?? ''),
  );
  const missingTools = (testCase.expectedTools ?? []).filter(
    (tool) => !usedTools.has(tool),
  );
  const forbiddenToolsUsed = (testCase.forbiddenTools ?? []).filter((tool) =>
    usedTools.has(tool),
  );
  const citationOk = testCase.requireCitation !== true || hasCitation(trace);
  const stepsOk = testCase.maxSteps === undefined || trace.stepCount <= testCase.maxSteps;
  const tokensOk = testCase.maxTokens === undefined || trace.totalTokens <= testCase.maxTokens;

  if (keywordCoverage < (testCase.minKeywordCoverage ?? 0.8)) {
    violations.push(
      `关键词覆盖率 ${(keywordCoverage * 100).toFixed(1)}% 低于 ${((testCase.minKeywordCoverage ?? 0.8) * 100).toFixed(0)}%`,
    );
  }
  if (missingTools.length > 0) {
    violations.push(`未调用期望工具：${missingTools.join('、')}`);
  }
  if (forbiddenToolsUsed.length > 0) {
    violations.push(`调用了禁止工具：${forbiddenToolsUsed.join('、')}`);
  }
  if (!citationOk) violations.push('缺少引用');
  if (!stepsOk) {
    violations.push(`步数 ${trace.stepCount} 超过 ${testCase.maxSteps}`);
  }
  if (!tokensOk) {
    violations.push(`Token ${trace.totalTokens} 超过 ${testCase.maxTokens}`);
  }

  return {
    id: testCase.id,
    question: testCase.question,
    matchedTraces: matched.length,
    passed: violations.length === 0,
    keywordCoverage,
    missingKeywords,
    missingTools,
    forbiddenToolsUsed,
    citationOk,
    stepsOk,
    tokensOk,
    violations,
  };
}

/**
 * 对真实消息轨迹做确定性质量评测：
 * 只看已落库的输入/工具/输出，不调用模型，因此可重复、可进 CI。
 */
export function evaluateMessageFlow(
  traces: ReActTraceRecord[],
  options: FlowEvalOptions = {},
): MessageFlowReport {
  const minAnswerChars = Math.max(1, options.minAnswerChars ?? 1);
  const answered = traces.filter(
    (trace) => trace.answer.trim().length >= minAnswerChars,
  ).length;
  const withTools = traces.filter((trace) =>
    trace.steps.some(isToolStep),
  );
  const toolErrors = withTools.filter((trace) =>
    trace.steps.some((step) => isToolStep(step) && step.isError),
  ).length;
  const citations = withTools.filter(hasCitation).length;
  const watchdogs = traces.filter(hasWatchdog).length;
  const tokenValues = traces.map((trace) => trace.totalTokens);
  const durationValues = traces.map((trace) => trace.durationMs);
  const cases = (options.cases ?? []).map((testCase) =>
    evaluateCase(testCase, traces),
  );
  const passedCases = cases.filter((item) => item.passed).length;

  return {
    sinceMs: options.sinceMs ?? 0,
    totalTurns: traces.length,
    answeredTurns: answered,
    answeredRate: traces.length === 0 ? 0 : answered / traces.length,
    toolTurns: withTools.length,
    toolErrorTurns: toolErrors,
    toolErrorRate: withTools.length === 0 ? 0 : toolErrors / withTools.length,
    citationTurns: citations,
    citationRate: withTools.length === 0 ? 0 : citations / withTools.length,
    watchdogTurns: watchdogs,
    watchdogRate: traces.length === 0 ? 0 : watchdogs / traces.length,
    avgTokens: average(tokenValues),
    p95Tokens: p95(tokenValues),
    avgDurationMs: average(durationValues),
    p95DurationMs: p95(durationValues),
    cases,
    casePassRate: cases.length === 0 ? 0 : passedCases / cases.length,
    unmatchedCaseIds: cases.filter((item) => item.matchedTraces === 0).map((item) => item.id),
  };
}

export interface FlowCaseFile {
  description?: string;
  cases: FlowEvalCase[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseFlowCases(raw: unknown): FlowCaseFile {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('flow cases 必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw new Error('flow cases 缺少非空 cases 数组');
  }
  const seen = new Set<string>();
  const cases = record.cases.map((item, index) => {
    if (item === null || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 个用例不是对象`);
    }
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const question = typeof entry.question === 'string' ? entry.question.trim() : '';
    if (!id || !question) {
      throw new Error(`第 ${index + 1} 个用例缺少 id 或 question`);
    }
    if (seen.has(id)) throw new Error(`用例 id 重复：${id}`);
    seen.add(id);
    const expectedKeywords = stringList(entry.expectedKeywords);
    if (expectedKeywords.length === 0) {
      throw new Error(`用例 ${id} 缺少 expectedKeywords`);
    }
    const expectedTools = stringList(entry.expectedTools);
    const forbiddenTools = stringList(entry.forbiddenTools);
    const maxSteps = positiveNumber(entry.maxSteps);
    const maxTokens = positiveNumber(entry.maxTokens);
    const minCoverage = Number(entry.minKeywordCoverage);
    return {
      id,
      question,
      expectedKeywords,
      ...(expectedTools.length > 0 ? { expectedTools } : {}),
      ...(forbiddenTools.length > 0 ? { forbiddenTools } : {}),
      ...(entry.requireCitation === true ? { requireCitation: true } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(Number.isFinite(minCoverage) && minCoverage >= 0 && minCoverage <= 1
        ? { minKeywordCoverage: minCoverage }
        : {}),
    };
  });
  return {
    ...(typeof record.description === 'string' && record.description.trim()
      ? { description: record.description.trim() }
      : {}),
    cases,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMessageFlowReport(report: MessageFlowReport): string {
  const lines = [
    `消息流评测：${report.totalTurns} 轮（自 ${report.sinceMs > 0 ? new Date(report.sinceMs).toISOString() : '不限时间'}）`,
    `回答率 ${percent(report.answeredRate)}（${report.answeredTurns}/${report.totalTurns}）`,
    `工具错误率 ${percent(report.toolErrorRate)}（${report.toolErrorTurns}/${report.toolTurns} 轮含工具调用）`,
    `引用覆盖率 ${percent(report.citationRate)}（${report.citationTurns}/${report.toolTurns}）`,
    `看门狗触发率 ${percent(report.watchdogRate)}（${report.watchdogTurns}/${report.totalTurns}）`,
    `Token 均值 ${report.avgTokens.toFixed(0)}，p95 ${report.p95Tokens.toFixed(0)}；耗时均值 ${report.avgDurationMs.toFixed(0)}ms，p95 ${report.p95DurationMs.toFixed(0)}ms`,
  ];
  if (report.cases.length > 0) {
    lines.push(`期望用例通过率 ${percent(report.casePassRate)}（${report.cases.filter((item) => item.passed).length}/${report.cases.length}）`);
    for (const item of report.cases) {
      lines.push(
        `  - ${item.id}：${item.passed ? '通过' : '未通过'}，匹配 ${item.matchedTraces} 条${item.violations.length > 0 ? `，${item.violations.join('；')}` : ''}`,
      );
    }
    if (report.unmatchedCaseIds.length > 0) {
      lines.push(`未匹配到轨迹：${report.unmatchedCaseIds.join('、')}`);
    }
  }
  return lines.join('\n');
}
