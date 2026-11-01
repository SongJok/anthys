import { readFile } from 'node:fs/promises';

export type GoldenCategory =
  | 'architecture'
  | 'symbols'
  | 'config'
  | 'deploy'
  | 'history';

export const GOLDEN_CATEGORY_LABELS: Record<GoldenCategory, string> = {
  architecture: '架构与入口',
  symbols: '符号定位',
  config: '数据与配置',
  deploy: '部署与运维',
  history: '历史与决策',
};

export const GOLDEN_CATEGORIES: GoldenCategory[] = [
  'architecture',
  'symbols',
  'config',
  'deploy',
  'history',
];

export interface GoldenQuestion {
  id: string;
  category: GoldenCategory;
  question: string;
  query: string;
  expectedPaths: string[];
  factKeywords: string[];
}

export interface GoldenSetFile {
  project: string;
  version: number;
  description?: string;
  questions: GoldenQuestion[];
}

export interface GoldenEvidence {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  match: string;
  content: string;
}

export interface GoldenQuestionRun {
  question: GoldenQuestion;
  evidence: GoldenEvidence[];
  latencyMs: number;
  error?: string;
}

export interface GoldenSecurityProbe {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface GoldenQuestionScore {
  id: string;
  category: GoldenCategory;
  question: string;
  citationHit: boolean;
  citationValid: boolean;
  matchedPaths: string[];
  missingKeywords: string[];
  keywordCoverage: number;
  secretLeaks: string[];
  sensitivePaths: string[];
  latencyMs: number;
  error?: string;
}

export interface GoldenCategorySummary {
  total: number;
  citationHitRate: number;
  keywordCoverage: number;
}

export interface GoldenReport {
  project: string;
  total: number;
  byCategory: Record<GoldenCategory, GoldenCategorySummary>;
  citationHitRate: number;
  citationValidity: number;
  keywordCoverage: number;
  securityPassed: boolean;
  securityViolations: string[];
  p95LatencyMs: number;
  questions: GoldenQuestionScore[];
}

export interface GoldenTargets {
  citationHitRate: number;
  keywordCoverage: number;
  p95LatencyMs: number;
}

/** 文档目标：引用命中 ≥95%、事实代理覆盖率 ≥80%、p95 <1.5s；安全必须 100% */
export const DEFAULT_GOLDEN_TARGETS: GoldenTargets = {
  citationHitRate: 0.95,
  keywordCoverage: 0.8,
  p95LatencyMs: 1_500,
};

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/u },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: 'private-key-header', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    name: 'database-url-with-password',
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/u,
  },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];

const PLACEHOLDER =
  /(?:CHANGE_ME|REPLACE_ME|EXAMPLE|YOUR_|placeholder|xxxx|<[^>]+>|\$\{[^}]+\}|%(?:\d+\$)?[sd])/iu;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/gu, ' ').toLowerCase();
}

export function isSensitivePath(filePath: string): boolean {
  const name =
    normalizeRepoPath(filePath).split('/').pop() ?? '';
  if (
    /^\.env(?:$|\.)/u.test(name) &&
    !/^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample|template)$/u.test(name)
  ) {
    return true;
  }
  return (
    /^(?:id_rsa|id_ed25519)/u.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/iu.test(name) ||
    /^credentials/iu.test(name) ||
    name === '.npmrc' ||
    name === '.pypirc'
  );
}

/** 只返回命中类型，不回显密钥本身，避免评测日志二次泄露 */
export function scanSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (PLACEHOLDER.test(match[0])) continue;
    hits.push(name);
  }
  return hits;
}

export function parseGoldenSet(raw: unknown): GoldenSetFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('golden set 必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const project = asString(record['project']);
  if (!project) throw new Error('golden set 缺少 project');
  if (!Array.isArray(record['questions']) || record['questions'].length === 0) {
    throw new Error('golden set 缺少 questions');
  }
  const seen = new Set<string>();
  const questions = record['questions'].map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 题不是对象`);
    }
    const question = item as Record<string, unknown>;
    const id = asString(question['id']);
    if (!id) throw new Error(`第 ${index + 1} 题缺少 id`);
    if (seen.has(id)) throw new Error(`题目 id 重复：${id}`);
    seen.add(id);
    const category = asString(question['category']) as GoldenCategory;
    if (!GOLDEN_CATEGORIES.includes(category)) {
      throw new Error(`题目 ${id} 的 category 非法：${category}`);
    }
    const text = asString(question['question']);
    const query = asString(question['query']);
    if (!text || !query) throw new Error(`题目 ${id} 缺少 question 或 query`);
    const expectedPaths = Array.isArray(question['expectedPaths'])
      ? question['expectedPaths'].map(asString).filter(Boolean)
      : [];
    if (expectedPaths.length === 0) {
      throw new Error(`题目 ${id} 缺少 expectedPaths`);
    }
    const factKeywords = Array.isArray(question['factKeywords'])
      ? question['factKeywords'].map(asString).filter(Boolean)
      : [];
    if (factKeywords.length === 0) {
      throw new Error(`题目 ${id} 缺少 factKeywords`);
    }
    return {
      id,
      category,
      question: text,
      query,
      expectedPaths,
      factKeywords,
    };
  });
  const version = Number(record['version']);
  return {
    project,
    version: Number.isFinite(version) ? version : 1,
    ...(asString(record['description'])
      ? { description: asString(record['description']) }
      : {}),
    questions,
  };
}

export async function loadGoldenSet(filePath: string): Promise<GoldenSetFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `读取 golden set 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseGoldenSet(raw);
}

export function categoryCounts(
  set: GoldenSetFile,
): Record<GoldenCategory, number> {
  const counts = Object.fromEntries(
    GOLDEN_CATEGORIES.map((category) => [category, 0]),
  ) as Record<GoldenCategory, number>;
  for (const question of set.questions) {
    counts[question.category] += 1;
  }
  return counts;
}

function scoreQuestion(
  question: GoldenQuestion,
  run: GoldenQuestionRun | undefined,
  documentLines: ReadonlyMap<string, number>,
): GoldenQuestionScore {
  const base = {
    id: question.id,
    category: question.category,
    question: question.question,
    latencyMs: run?.latencyMs ?? 0,
  };
  if (!run) {
    return {
      ...base,
      citationHit: false,
      citationValid: false,
      matchedPaths: [],
      missingKeywords: [...question.factKeywords],
      keywordCoverage: 0,
      secretLeaks: [],
      sensitivePaths: [],
      error: '缺少运行结果',
    };
  }
  const evidence = run.evidence.map((item) => ({
    ...item,
    path: normalizeRepoPath(item.path),
  }));
  const expected = new Set(question.expectedPaths.map(normalizeRepoPath));
  const matchedPaths = Array.from(
    new Set(evidence.filter((item) => expected.has(item.path)).map((item) => item.path)),
  );
  let validRows = 0;
  const secretLeaks = new Set<string>();
  const sensitivePaths = new Set<string>();
  for (const item of evidence) {
    const lineCount = documentLines.get(item.path);
    if (
      lineCount !== undefined &&
      item.startLine >= 1 &&
      item.endLine >= item.startLine &&
      item.endLine <= lineCount
    ) {
      validRows += 1;
    }
    for (const leak of scanSecrets(item.content)) secretLeaks.add(leak);
    if (isSensitivePath(item.path)) sensitivePaths.add(item.path);
  }
  const citationHit = evidence.some((item) => {
    const lineCount = documentLines.get(item.path);
    return (
      expected.has(item.path) &&
      lineCount !== undefined &&
      item.startLine >= 1 &&
      item.endLine >= item.startLine &&
      item.endLine <= lineCount
    );
  });
  const citationValid =
    evidence.length > 0 && validRows === evidence.length;
  const haystack = normalizeForMatch(
    evidence.map((item) => item.content).join('\n'),
  );
  const missingKeywords = question.factKeywords.filter(
    (keyword) => !haystack.includes(normalizeForMatch(keyword)),
  );
  const keywordCoverage =
    question.factKeywords.length === 0
      ? 1
      : (question.factKeywords.length - missingKeywords.length) /
        question.factKeywords.length;
  return {
    ...base,
    citationHit,
    citationValid,
    matchedPaths,
    missingKeywords,
    keywordCoverage,
    secretLeaks: Array.from(secretLeaks),
    sensitivePaths: Array.from(sensitivePaths),
    ...(run.error ? { error: run.error } : {}),
  };
}

function nearestRankP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function scoreGoldenRun(
  set: GoldenSetFile,
  runs: GoldenQuestionRun[],
  documentLines: ReadonlyMap<string, number>,
  securityProbes: GoldenSecurityProbe[] = [],
): GoldenReport {
  const runById = new Map(runs.map((run) => [run.question.id, run]));
  const questions = set.questions.map((question) =>
    scoreQuestion(question, runById.get(question.id), documentLines),
  );
  const byCategory = Object.fromEntries(
    GOLDEN_CATEGORIES.map((category) => [category, { total: 0, citationHitRate: 0, keywordCoverage: 0 }]),
  ) as Record<GoldenCategory, GoldenCategorySummary>;
  for (const score of questions) {
    const bucket = byCategory[score.category];
    bucket.total += 1;
    bucket.citationHitRate += score.citationHit ? 1 : 0;
    bucket.keywordCoverage += score.keywordCoverage;
  }
  for (const bucket of Object.values(byCategory)) {
    if (bucket.total === 0) continue;
    bucket.citationHitRate /= bucket.total;
    bucket.keywordCoverage /= bucket.total;
  }
  const total = questions.length;
  const citationHitRate =
    total === 0 ? 0 : questions.filter((item) => item.citationHit).length / total;
  const keywordCoverage =
    total === 0
      ? 0
      : questions.reduce((sum, item) => sum + item.keywordCoverage, 0) / total;
  const citationValidity =
    total === 0
      ? 0
      : questions.reduce((sum, item) => sum + (item.citationValid ? 1 : 0), 0) /
        total;

  const violations: string[] = [];
  for (const score of questions) {
    if (score.error) violations.push(`运行失败 ${score.id}：${score.error}`);
    for (const leak of score.secretLeaks) {
      violations.push(`疑似密钥泄露 ${score.id}：${leak}`);
    }
    for (const path of score.sensitivePaths) {
      violations.push(`检索到敏感文件 ${score.id}：${path}`);
    }
  }
  for (const probe of securityProbes) {
    if (!probe.ok) {
      violations.push(
        `安全探针失败 ${probe.name}${probe.detail ? `：${probe.detail}` : ''}`,
      );
    }
  }
  return {
    project: set.project,
    total,
    byCategory,
    citationHitRate,
    citationValidity,
    keywordCoverage,
    securityPassed: violations.length === 0,
    securityViolations: violations,
    p95LatencyMs: nearestRankP95(questions.map((item) => item.latencyMs)),
    questions,
  };
}

export function evaluateTargets(
  report: GoldenReport,
  targets: GoldenTargets = DEFAULT_GOLDEN_TARGETS,
): string[] {
  const failures: string[] = [];
  if (report.citationHitRate < targets.citationHitRate) {
    failures.push(
      `引用命中率 ${(report.citationHitRate * 100).toFixed(1)}% < ${(targets.citationHitRate * 100).toFixed(0)}%`,
    );
  }
  if (report.keywordCoverage < targets.keywordCoverage) {
    failures.push(
      `事实代理覆盖率 ${(report.keywordCoverage * 100).toFixed(1)}% < ${(targets.keywordCoverage * 100).toFixed(0)}%`,
    );
  }
  if (report.p95LatencyMs >= targets.p95LatencyMs) {
    failures.push(
      `检索 p95 ${report.p95LatencyMs.toFixed(0)}ms ≥ ${targets.p95LatencyMs}ms`,
    );
  }
  if (!report.securityPassed) failures.push('安全检查未通过');
  return failures;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatGoldenReport(report: GoldenReport): string {
  const lines: string[] = [];
  lines.push(
    `golden set：${report.project}，共 ${report.total} 题`,
  );
  for (const category of GOLDEN_CATEGORIES) {
    const bucket = report.byCategory[category];
    if (bucket.total === 0) continue;
    lines.push(
      `  ${GOLDEN_CATEGORY_LABELS[category]}：${bucket.total} 题，引用命中 ${percent(bucket.citationHitRate)}，事实代理覆盖 ${percent(bucket.keywordCoverage)}`,
    );
  }
  lines.push(
    `总体：引用命中率 ${percent(report.citationHitRate)}，引用完整率 ${percent(report.citationValidity)}，事实代理覆盖率 ${percent(report.keywordCoverage)}，检索 p95 ${report.p95LatencyMs.toFixed(0)}ms`,
  );
  lines.push(
    `安全：${report.securityPassed ? '通过' : '未通过'}（检查密钥泄露、敏感文件、敏感读取探针；不覆盖模型是否服从仓库内提示注入）`,
  );
  for (const violation of report.securityViolations) {
    lines.push(`  - ${violation}`);
  }
  lines.push('未命中题目：');
  let missed = 0;
  for (const score of report.questions) {
    if (score.citationHit && score.keywordCoverage >= 0.8 && !score.error) continue;
    missed += 1;
    lines.push(
      `  - ${score.id} ${score.question}：命中=${score.citationHit ? '是' : '否'}，覆盖=${percent(score.keywordCoverage)}${score.missingKeywords.length > 0 ? `，缺少关键词 ${score.missingKeywords.join('、')}` : ''}${score.error ? `，错误 ${score.error}` : ''}`,
    );
  }
  if (missed === 0) lines.push('  （无）');
  return lines.join('\n');
}
