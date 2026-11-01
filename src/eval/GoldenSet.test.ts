import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOLDEN_TARGETS,
  categoryCounts,
  evaluateTargets,
  formatGoldenReport,
  isSensitivePath,
  loadGoldenSet,
  normalizeRepoPath,
  parseGoldenSet,
  scanSecrets,
  scoreGoldenRun,
} from './GoldenSet.js';
import type {
  GoldenQuestionRun,
  GoldenSetFile,
} from './GoldenSet.js';

const REPO_ROOT = process.cwd();
const GOLDEN_PATH = resolve(REPO_ROOT, 'eval/golden/anthys.json');

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').toLowerCase();
}

describe('golden set 数据文件', () => {
  it('包含 30 题且分类数量符合设计文档', async () => {
    const set = await loadGoldenSet(GOLDEN_PATH);
    expect(set.project).toBe('anthys');
    expect(set.questions).toHaveLength(30);
    expect(categoryCounts(set)).toEqual({
      architecture: 6,
      symbols: 8,
      config: 6,
      deploy: 5,
      history: 5,
    });
    const ids = new Set(set.questions.map((question) => question.id));
    expect(ids.size).toBe(30);
  });

  it('期望路径都真实存在，事实关键词能在期望文件中找到', async () => {
    const set = await loadGoldenSet(GOLDEN_PATH);
    const cache = new Map<string, string>();
    for (const question of set.questions) {
      const contents: string[] = [];
      for (const filePath of question.expectedPaths) {
        let content = cache.get(filePath);
        if (content === undefined) {
          content = await readFile(resolve(REPO_ROOT, filePath), 'utf8');
          cache.set(filePath, content);
        }
        expect(
          content,
          `${question.id} 的期望路径 ${filePath} 不应为空`,
        ).not.toBe('');
        contents.push(content);
      }
      const haystack = normalize(contents.join('\n'));
      for (const keyword of question.factKeywords) {
        expect(
          haystack,
          `${question.id} 的关键词「${keyword}」不在期望文件中`,
        ).toContain(normalize(keyword));
      }
    }
  });
});

describe('golden set 解析与校验', () => {
  it('拒绝重复 id 和缺失字段', () => {
    expect(() =>
      parseGoldenSet({
        project: 'demo',
        questions: [
          {
            id: 'q1',
            category: 'architecture',
            question: '问题',
            query: 'query',
            expectedPaths: ['a.ts'],
            factKeywords: ['a'],
          },
          {
            id: 'q1',
            category: 'symbols',
            question: '问题 2',
            query: 'query 2',
            expectedPaths: ['b.ts'],
            factKeywords: ['b'],
          },
        ],
      }),
    ).toThrow(/重复/u);

    expect(() =>
      parseGoldenSet({
        project: 'demo',
        questions: [
          {
            id: 'q1',
            category: 'unknown',
            question: '问题',
            query: 'query',
            expectedPaths: ['a.ts'],
            factKeywords: ['a'],
          },
        ],
      }),
    ).toThrow(/category/u);

    expect(() =>
      parseGoldenSet({
        project: 'demo',
        questions: [
          {
            id: 'q1',
            category: 'architecture',
            question: '问题',
            query: 'query',
            expectedPaths: [],
            factKeywords: ['a'],
          },
        ],
      }),
    ).toThrow(/expectedPaths/u);
  });
});

function sampleSet(): GoldenSetFile {
  return parseGoldenSet({
    project: 'demo',
    questions: [
      {
        id: 'q1',
        category: 'architecture',
        question: '入口在哪？',
        query: 'alpha',
        expectedPaths: ['src/a.ts'],
        factKeywords: ['alpha', 'beta'],
      },
      {
        id: 'q2',
        category: 'symbols',
        question: '符号在哪？',
        query: 'gamma',
        expectedPaths: ['src/b.ts'],
        factKeywords: ['gamma'],
      },
    ],
  });
}

function runOf(
  set: GoldenSetFile,
  index: number,
  evidence: GoldenQuestionRun['evidence'],
  latencyMs: number,
  error?: string,
): GoldenQuestionRun {
  return {
    question: set.questions[index]!,
    evidence,
    latencyMs,
    ...(error ? { error } : {}),
  };
}

describe('golden set 评分', () => {
  const documentLines = new Map([
    [normalizeRepoPath('src/a.ts'), 10],
    [normalizeRepoPath('src/b.ts'), 20],
  ]);

  it('计算引用命中、事实覆盖、引用有效性与 p95', () => {
    const set = sampleSet();
    const report = scoreGoldenRun(
      set,
      [
        runOf(
          set,
          0,
          [
            {
              path: 'src/a.ts',
              startLine: 1,
              endLine: 2,
              symbol: 'alpha',
              match: 'fts',
              content: 'alpha only',
            },
          ],
          100,
        ),
        runOf(
          set,
          1,
          [
            {
              path: 'src/missing.ts',
              startLine: 1,
              endLine: 2,
              symbol: 'gamma',
              match: 'fts',
              content: 'gamma',
            },
          ],
          300,
        ),
      ],
      documentLines,
    );

    expect(report.total).toBe(2);
    expect(report.citationHitRate).toBe(0.5);
    expect(report.citationValidity).toBe(0.5);
    expect(report.keywordCoverage).toBe(0.75);
    expect(report.p95LatencyMs).toBe(300);
    expect(report.securityPassed).toBe(true);
    expect(report.byCategory.architecture.citationHitRate).toBe(1);
    expect(report.byCategory.symbols.citationHitRate).toBe(0);

    const failures = evaluateTargets(report, {
      ...DEFAULT_GOLDEN_TARGETS,
      citationHitRate: 0.5,
      keywordCoverage: 0.75,
      p95LatencyMs: 500,
    });
    expect(failures).toEqual([]);
  });

  it('行号越界、密钥和敏感文件都会让安全检查失败', () => {
    const set = sampleSet();
    const token = ['sk', 'A'.repeat(24)].join('-');
    const report = scoreGoldenRun(
      set,
      [
        runOf(
          set,
          0,
          [
            {
              path: 'src/a.ts',
              startLine: 1,
              endLine: 99,
              symbol: 'alpha',
              match: 'fts',
              content: `alpha ${token}`,
            },
          ],
          50,
        ),
        runOf(
          set,
          1,
          [
            {
              path: '.env',
              startLine: 1,
              endLine: 1,
              symbol: '',
              match: 'path',
              content: 'gamma',
            },
          ],
          60,
        ),
      ],
      documentLines,
    );
    expect(report.citationHitRate).toBe(0);
    expect(report.citationValidity).toBe(0);
    expect(report.securityPassed).toBe(false);
    expect(report.securityViolations.join('\n')).toContain('openai-style-key');
    expect(report.securityViolations.join('\n')).toContain('.env');
  });

  it('缺少运行结果和失败探针会被记录', () => {
    const set = sampleSet();
    const report = scoreGoldenRun(
      set,
      [runOf(set, 0, [], 10, '超时')],
      documentLines,
      [{ name: 'read:.env', ok: false, detail: '敏感文件被读取' }],
    );
    expect(report.questions[0]?.error).toBe('超时');
    expect(report.questions[1]?.error).toBe('缺少运行结果');
    expect(report.securityPassed).toBe(false);
    expect(report.citationValidity).toBe(0);
  });

  it('报告输出包含各类别与未命中题目', () => {
    const set = sampleSet();
    const report = scoreGoldenRun(set, [], documentLines);
    const text = formatGoldenReport(report);
    expect(text).toContain('架构与入口');
    expect(text).toContain('符号定位');
    expect(text).toContain('q1');
    expect(text).toContain('安全：未通过');
  });
});

describe('安全模式识别', () => {
  it('区分真实 .env 与示例文件', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.production')).toBe(true);
    expect(isSensitivePath('deploy/.env')).toBe(true);
    expect(isSensitivePath('.env.example')).toBe(false);
    expect(isSensitivePath('deploy/.env.production.example')).toBe(false);
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('keys/id_rsa')).toBe(true);
    expect(isSensitivePath('keys/id_rsa.pub')).toBe(true);
    expect(isSensitivePath('certs/server.pem')).toBe(true);
    expect(isSensitivePath('src/credentials.ts')).toBe(true);
    expect(isSensitivePath('src/app.ts')).toBe(false);
  });

  it('识别常见密钥形态并忽略占位符', () => {
    expect(scanSecrets(['sk', 'B'.repeat(24)].join('-'))).toContain(
      'openai-style-key',
    );
    expect(scanSecrets(['ghp', 'C'.repeat(24)].join('_'))).toContain(
      'github-token',
    );
    expect(
      scanSecrets(['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')),
    ).toContain('private-key-header');
    expect(
      scanSecrets('postgres://anthys:CHANGE_ME@127.0.0.1:5432/db'),
    ).toEqual([]);
    expect(
      scanSecrets(
        ['postgres://', 'anthys:', 'secret', '@127.0.0.1:5432/db'].join(''),
      ),
    ).toContain('database-url-with-password');
    expect(
      scanSecrets('postgres://%s:%s@127.0.0.1:5432/%s'),
    ).toEqual([]);
    expect(scanSecrets('EMBEDDING_ENABLED=false')).toEqual([]);
  });
});
