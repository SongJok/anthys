import type { DynamicLoopPolicy } from '../types/core.js';

/** 单次测试用例编写运行的 Token 硬上限，任何环境变量都不能突破 */
export const TESTCASE_TOKEN_CEILING = 2_000_000;
/** 单次测试用例编写运行的推理轮次硬上限 */
export const TESTCASE_ITERATION_CEILING = 200;
/** 墙钟硬上限：2 小时 */
export const TESTCASE_WALL_CEILING_MS = 7_200_000;

const DEFAULT_MAX_TOKENS = TESTCASE_TOKEN_CEILING;
const DEFAULT_MAX_ITERATIONS = TESTCASE_ITERATION_CEILING;
const DEFAULT_MAX_WALL_MS = 3_600_000;

export interface TestcaseRunBudget {
  enabled: boolean;
  maxTotalTokens: number;
  maxIterations: number;
  maxWallTimeMs: number;
}

function envInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envEnabled(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/**
 * 测试用例编写是长任务：预算在主循环策略之上放宽，但始终受硬上限约束。
 * 默认 200 万 Token / 200 轮 / 60 分钟。
 */
export function resolveTestcaseRunBudget(
  env: Record<string, string | undefined>,
): TestcaseRunBudget {
  return {
    enabled: envEnabled(env, 'TESTCASE_EXTENDED_BUDGET_ENABLED', true),
    maxTotalTokens: envInt(
      env,
      'TESTCASE_MAX_TOTAL_TOKENS',
      DEFAULT_MAX_TOKENS,
      1_000,
      TESTCASE_TOKEN_CEILING,
    ),
    maxIterations: envInt(
      env,
      'TESTCASE_MAX_ITERATIONS',
      DEFAULT_MAX_ITERATIONS,
      1,
      TESTCASE_ITERATION_CEILING,
    ),
    maxWallTimeMs:
      envInt(
        env,
        'TESTCASE_MAX_WALL_SECONDS',
        DEFAULT_MAX_WALL_MS / 1_000,
        30,
        TESTCASE_WALL_CEILING_MS / 1_000,
      ) * 1_000,
  };
}

const TESTCASE_INTENT =
  /测试用例|测试案例|测试点|测试场景|测试方案|测试计划|测试报告|回归用例|冒烟用例|复现用例|缺陷复现|需求评审|用例评审|用例|test\s*cases?|testcase/iu;

/** 只认明确的测试编写/评审意图，避免普通聊天拿到放宽后的预算 */
export function isTestcaseWritingIntent(text: string): boolean {
  return TESTCASE_INTENT.test(text);
}

/** 放宽后的策略只增不减，且不超过硬上限 */
export function testcaseRunPolicy(
  base: DynamicLoopPolicy,
  budget: TestcaseRunBudget,
): DynamicLoopPolicy {
  return {
    ...base,
    maxWallTimeMs: Math.min(
      TESTCASE_WALL_CEILING_MS,
      Math.max(base.maxWallTimeMs, budget.maxWallTimeMs),
    ),
    maxTotalTokens: Math.min(
      TESTCASE_TOKEN_CEILING,
      Math.max(base.maxTotalTokens, budget.maxTotalTokens),
    ),
    maxIterations: Math.min(
      TESTCASE_ITERATION_CEILING,
      Math.max(base.maxIterations ?? 40, budget.maxIterations),
    ),
  };
}