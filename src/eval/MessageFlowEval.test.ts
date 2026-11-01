import { describe, expect, it } from 'vitest';
import {
  evaluateMessageFlow,
  formatMessageFlowReport,
  parseFlowCases,
} from './MessageFlowEval.js';
import type { ReActTraceRecord } from '../types/admin-and-console.js';

function trace(
  overrides: Partial<ReActTraceRecord> & { id: string },
): ReActTraceRecord {
  return {
    conversationId: 'cid',
    messageId: `msg-${overrides.id}`,
    senderStaffId: 'u-1',
    senderNick: '张三',
    conversationType: '1',
    proactive: false,
    question: '如何发布？',
    reasoning: '',
    steps: [],
    answer: '按发布手册执行。',
    totalTokens: 100,
    stepCount: 1,
    durationMs: 1_000,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('evaluateMessageFlow', () => {
  it('汇总回答率、工具错误、引用与看门狗', () => {
    const report = evaluateMessageFlow(
      [
        trace({
          id: 'a',
          steps: [
            { index: 0, type: 'tool', toolName: 'project_search' },
            { index: 1, type: 'citation', content: '1. 发布手册 https://x' },
          ],
        }),
        trace({
          id: 'b',
          answer: '',
          steps: [
            {
              index: 0,
              type: 'narration',
              content: '执行保护（no-progress）：多次提醒后仍无有效进展',
              isError: true,
            },
            { index: 1, type: 'tool', toolName: 'web_search', isError: true },
          ],
        }),
      ],
      { sinceMs: 1_000 },
    );
    expect(report.totalTurns).toBe(2);
    expect(report.answeredTurns).toBe(1);
    expect(report.toolTurns).toBe(2);
    expect(report.toolErrorTurns).toBe(1);
    expect(report.citationTurns).toBe(1);
    expect(report.watchdogTurns).toBe(1);
    expect(report.p95DurationMs).toBe(1_000);
    expect(report.sinceMs).toBe(1_000);
  });

  it('按问法匹配最新轨迹并校验工具、引用与预算', () => {
    const report = evaluateMessageFlow(
      [
        trace({
          id: 'old',
          question: '如何发布？',
          answer: '旧回答',
          createdAt: '2026-10-01T00:00:00.000Z',
        }),
        trace({
          id: 'new',
          question: ' 如何发布？ ',
          answer: '先跑 pnpm typecheck，再执行发布手册。',
          totalTokens: 900,
          stepCount: 3,
          steps: [
            { index: 0, type: 'tool', toolName: 'project_search' },
            { index: 1, type: 'citation', content: '1. 发布手册' },
          ],
        }),
      ],
      {
        cases: [
          {
            id: 'publish',
            question: '如何发布',
            expectedKeywords: ['pnpm typecheck', '发布手册', 'systemd'],
            expectedTools: ['project_search'],
            requireCitation: true,
            maxSteps: 4,
            maxTokens: 1_000,
          },
          {
            id: 'forbidden',
            question: '如何发布？',
            expectedKeywords: ['发布手册'],
            forbiddenTools: ['project_search'],
          },
        ],
      },
    );
    expect(report.cases[0]?.matchedTraces).toBe(1);
    expect(report.cases[0]?.passed).toBe(false);
    expect(report.cases[0]?.keywordCoverage).toBeCloseTo(2 / 3);
    expect(report.cases[0]?.missingKeywords).toEqual(['systemd']);
    expect(report.cases[0]?.violations[0]).toMatch(/关键词覆盖率/);
    expect(report.cases[1]?.forbiddenToolsUsed).toEqual(['project_search']);
    expect(report.unmatchedCaseIds).toEqual([]);
  });

  it('格式化报告包含关键指标', () => {
    const text = formatMessageFlowReport(
      evaluateMessageFlow([trace({ id: 'a' })]),
    );
    expect(text).toContain('消息流评测：1 轮');
    expect(text).toMatch(/回答率 100\.0%/);
  });
});

describe('parseFlowCases', () => {
  it('校验必填字段并归一化可选字段', () => {
    const parsed = parseFlowCases({
      description: '发布流程',
      cases: [
        {
          id: 'publish',
          question: '如何发布？',
          expectedKeywords: ['发布手册'],
          expectedTools: ['project_search'],
          maxTokens: 800,
          requireCitation: true,
        },
      ],
    });
    expect(parsed.cases[0]).toMatchObject({
      id: 'publish',
      expectedKeywords: ['发布手册'],
      expectedTools: ['project_search'],
      maxTokens: 800,
      requireCitation: true,
    });
    expect(() => parseFlowCases({ cases: [] })).toThrow(/cases/);
    expect(() =>
      parseFlowCases({
        cases: [{ id: 'x', question: 'q', expectedKeywords: [] }],
      }),
    ).toThrow(/expectedKeywords/);
  });
});
