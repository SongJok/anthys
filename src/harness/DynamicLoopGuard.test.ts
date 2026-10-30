import { describe, expect, it } from 'vitest';
import { DynamicLoopGuard } from './DynamicLoopGuard.js';
import type { DynamicLoopPolicy } from '../types/core.js';

const basePolicy: DynamicLoopPolicy = {
  maxWallTimeMs: 120_000,
  maxTotalTokens: 64_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: true,
};

describe('DynamicLoopGuard', () => {
  it('允许在预算内持续推进', () => {
    const guard = new DynamicLoopGuard(basePolicy, { now: () => 0 });
    const result = guard.recordStep(1_000, 'current_time', {});
    expect(result).toEqual({ allowContinue: true });
    expect(guard.getConsumedTokens()).toBe(1_000);
  });

  it('超过最大思考时间预算时终止', () => {
    let now = 1_000;
    const guard = new DynamicLoopGuard(
      { ...basePolicy, maxWallTimeMs: 5_000 },
      { now: () => now },
    );
    now = 5_999;
    expect(guard.recordStep(10).allowContinue).toBe(true);
    now = 6_000;
    const result = guard.recordStep(10);
    expect(result.allowContinue).toBe(false);
    expect(result.haltCode).toBe('wall-time');
    expect(result.haltReason).toContain('最大思考时间预算');
  });

  it('超过 Token 预算时终止', () => {
    const guard = new DynamicLoopGuard(
      { ...basePolicy, maxTotalTokens: 1_000 },
      { now: () => 0 },
    );
    expect(guard.recordStep(999).allowContinue).toBe(true);
    const result = guard.recordStep(1);
    expect(result.allowContinue).toBe(false);
    expect(result.haltCode).toBe('tokens');
    expect(result.haltReason).toContain('Token 预算');
  });

  it('相同工具与相同参数连续调用时注入警告', () => {
    const guard = new DynamicLoopGuard(basePolicy, { now: () => 0 });
    expect(guard.recordStep(10, 'calculator', { expression: '1+2' }).injectWarning)
      .toBeUndefined();
    const result = guard.recordStep(10, 'calculator', { expression: '1+2' });
    expect(result.allowContinue).toBe(true);
    expect(result.injectWarning).toContain('calculator');
    expect(result.injectWarning).toContain('连续 2 次');
  });

  it('参数变化或工具切换时不触发重复调用警告', () => {
    const guard = new DynamicLoopGuard(basePolicy, { now: () => 0 });
    expect(
      guard.recordStep(10, 'calculator', { expression: '1+2' }).injectWarning,
    ).toBeUndefined();
    expect(
      guard.recordStep(10, 'calculator', { expression: '2+2' }).injectWarning,
    ).toBeUndefined();
    expect(
      guard.recordStep(10, 'current_time', { expression: '2+2' }).injectWarning,
    ).toBeUndefined();
  });

  it('重复调用警告只在达到阈值时出现，并随参数变化重置', () => {
    const guard = new DynamicLoopGuard(basePolicy, { now: () => 0 });
    guard.recordStep(10, 'system_status', {});
    guard.recordStep(10, 'system_status', {});
    const warned = guard.recordStep(10, 'system_status', {});
    expect(warned.injectWarning).toBeDefined();
    const changed = guard.recordStep(10, 'system_status', { detail: true });
    expect(changed.injectWarning).toBeUndefined();
  });

  it('阈值配置为 1 时单次调用即视为重复', () => {
    const guard = new DynamicLoopGuard(
      { ...basePolicy, maxConsecutiveSameTool: 1 },
      { now: () => 0 },
    );
    const result = guard.recordStep(5, 'current_time', {});
    expect(result.allowContinue).toBe(true);
    expect(result.injectWarning).toContain('连续 1 次');
  });

  it('参数键顺序不同但语义相同视为同一签名', () => {
    const guard = new DynamicLoopGuard(basePolicy, { now: () => 0 });
    guard.recordStep(1, 'calculator', { a: 1, b: 2 });
    const result = guard.recordStep(1, 'calculator', { a: 1, b: 2 });
    expect(result.injectWarning).toBeDefined();
  });

  it('记录累计耗时与消耗 Token', () => {
    let now = 100;
    const guard = new DynamicLoopGuard(basePolicy, { now: () => now });
    guard.recordStep(120);
    now = 350;
    guard.recordStep(80);
    expect(guard.getConsumedTokens()).toBe(200);
    expect(guard.getElapsedMs()).toBe(250);
    expect(guard.getPolicy()).toBe(basePolicy);
  });
});
