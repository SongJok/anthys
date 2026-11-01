import { describe, expect, it } from 'vitest';
import type { DynamicLoopPolicy } from '../types/core.js';
import { createWorkerRegistry } from './WorkerRegistry.js';

const basePolicy: DynamicLoopPolicy = {
  maxWallTimeMs: 900_000,
  maxTotalTokens: 120_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: true,
  maxIterations: 40,
  maxParallelTools: 4,
};

describe('WorkerRegistry', () => {
  it('内置三类 Worker 的默认范围与预算', () => {
    const registry = createWorkerRegistry({ basePolicy });
    const research = registry.get('research');
    expect(research.scope.readOnly).toBe(true);
    expect(research.policy).toMatchObject({
      maxWallTimeMs: 600_000,
      maxTotalTokens: 100_000,
      maxIterations: 20,
      maxConsecutiveSameTool: 2,
      convergenceCheck: true,
      maxParallelTools: 4,
    });

    const ops = registry.get('ops');
    expect(ops.scope.readOnly).toBe(false);
    expect(ops.policy).toMatchObject({
      maxWallTimeMs: 900_000,
      maxTotalTokens: 160_000,
      maxIterations: 30,
    });

    const report = registry.get('report');
    expect(report.scope.readOnly).toBe(true);
    expect(report.policy.maxTotalTokens).toBe(120_000);
  });

  it('环境变量可覆盖预算、只读开关与工具名单', () => {
    const registry = createWorkerRegistry({
      basePolicy,
      env: {
        WORKER_RESEARCH_MAX_WALL_SECONDS: '120',
        WORKER_RESEARCH_MAX_TOKENS: '5000',
        WORKER_RESEARCH_MAX_ITERATIONS: '7',
        WORKER_RESEARCH_READ_ONLY: 'false',
        WORKER_OPS_READ_ONLY: 'true',
        WORKER_OPS_TOOL_ALLOWLIST: 'mcp__code__*, search_docs',
        WORKER_OPS_TOOL_DENYLIST: 'mcp__code__delete_*',
      },
    });
    const research = registry.get('research');
    expect(research.policy).toMatchObject({
      maxWallTimeMs: 120_000,
      maxTotalTokens: 5_000,
      maxIterations: 7,
    });
    // 研究 Worker 不允许通过配置关闭只读
    expect(research.scope.readOnly).toBe(true);
    expect(registry.get('ops').scope).toMatchObject({
      readOnly: true,
      allow: ['mcp__code__*', 'search_docs'],
      deny: ['mcp__code__delete_*'],
    });
  });

  it('非法数值回退默认，未知 Worker 返回 undefined', () => {
    const registry = createWorkerRegistry({
      basePolicy,
      env: {
        WORKER_REPORT_MAX_TOKENS: 'not-a-number',
        WORKER_REPORT_MAX_ITERATIONS: '0',
        WORKER_REPORT_MAX_WALL_SECONDS: '99999',
      },
    });
    const report = registry.get('report');
    expect(report.policy.maxTotalTokens).toBe(120_000);
    expect(report.policy.maxIterations).toBe(1);
    expect(report.policy.maxWallTimeMs).toBe(3_600_000);
    expect(registry.resolve('research')?.name).toBe('research');
    expect(registry.resolve('unknown')).toBeUndefined();
    expect(registry.resolve(undefined)).toBeUndefined();
  });
});
