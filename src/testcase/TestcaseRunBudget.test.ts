import { describe, expect, it } from 'vitest';
import type { DynamicLoopPolicy } from '../types/core.js';
import {
  TESTCASE_ITERATION_CEILING,
  TESTCASE_TOKEN_CEILING,
  TESTCASE_WALL_CEILING_MS,
  isTestcaseWritingIntent,
  resolveTestcaseRunBudget,
  testcaseRunPolicy,
} from './TestcaseRunBudget.js';

const base: DynamicLoopPolicy = {
  maxWallTimeMs: 900_000,
  maxTotalTokens: 120_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: true,
  maxIterations: 40,
};

describe('resolveTestcaseRunBudget', () => {
  it('默认给到 200 万 Token / 200 轮 / 60 分钟', () => {
    const budget = resolveTestcaseRunBudget({});
    expect(budget.enabled).toBe(true);
    expect(budget.maxTotalTokens).toBe(2_000_000);
    expect(budget.maxIterations).toBe(200);
    expect(budget.maxWallTimeMs).toBe(3_600_000);
  });

  it('配置超过硬上限时被钳制，不会无限放宽', () => {
    const budget = resolveTestcaseRunBudget({
      TESTCASE_MAX_TOTAL_TOKENS: '99999999',
      TESTCASE_MAX_ITERATIONS: '99999',
      TESTCASE_MAX_WALL_SECONDS: '999999',
    });
    expect(budget.maxTotalTokens).toBe(TESTCASE_TOKEN_CEILING);
    expect(budget.maxIterations).toBe(TESTCASE_ITERATION_CEILING);
    expect(budget.maxWallTimeMs).toBe(TESTCASE_WALL_CEILING_MS);
  });

  it('可以收紧预算，也可以整体关闭', () => {
    const budget = resolveTestcaseRunBudget({
      TESTCASE_MAX_TOTAL_TOKENS: '500000',
      TESTCASE_MAX_ITERATIONS: '60',
      TESTCASE_MAX_WALL_SECONDS: '1200',
    });
    expect(budget.maxTotalTokens).toBe(500_000);
    expect(budget.maxIterations).toBe(60);
    expect(budget.maxWallTimeMs).toBe(1_200_000);
    expect(
      resolveTestcaseRunBudget({ TESTCASE_EXTENDED_BUDGET_ENABLED: 'false' })
        .enabled,
    ).toBe(false);
  });
});

describe('isTestcaseWritingIntent', () => {
  it('识别编写、评审、回归与报告类请求', () => {
    for (const text of [
      '帮我根据这份 PRD 写测试用例',
      '补充一下边界用例',
      '这个需求评审有哪些风险点',
      '给出回归用例范围',
      '汇总本次测试报告',
      'write test cases for login',
    ]) {
      expect(isTestcaseWritingIntent(text)).toBe(true);
    }
  });

  it('普通聊天不命中', () => {
    for (const text of ['现在几点？', '帮我约个会议', '这个报错怎么修']) {
      expect(isTestcaseWritingIntent(text)).toBe(false);
    }
  });
});

describe('testcaseRunPolicy', () => {
  it('只放宽不收紧，且不超过硬上限', () => {
    const policy = testcaseRunPolicy(base, resolveTestcaseRunBudget({}));
    expect(policy.maxTotalTokens).toBe(TESTCASE_TOKEN_CEILING);
    expect(policy.maxIterations).toBe(TESTCASE_ITERATION_CEILING);
    expect(policy.maxWallTimeMs).toBe(3_600_000);
    expect(policy.maxConsecutiveSameTool).toBe(base.maxConsecutiveSameTool);
    expect(policy.convergenceCheck).toBe(base.convergenceCheck);
  });

  it('主策略已经更宽时保持不变', () => {
    const wider: DynamicLoopPolicy = {
      ...base,
      maxTotalTokens: TESTCASE_TOKEN_CEILING,
      maxIterations: TESTCASE_ITERATION_CEILING,
      maxWallTimeMs: TESTCASE_WALL_CEILING_MS,
    };
    const policy = testcaseRunPolicy(
      wider,
      resolveTestcaseRunBudget({ TESTCASE_MAX_TOTAL_TOKENS: '500000' }),
    );
    expect(policy.maxTotalTokens).toBe(TESTCASE_TOKEN_CEILING);
    expect(policy.maxWallTimeMs).toBe(TESTCASE_WALL_CEILING_MS);
  });
});