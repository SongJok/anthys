import { describe, expect, it } from 'vitest';
import { LoginAttemptLimiter } from './loginRateLimit.js';

describe('LoginAttemptLimiter', () => {
  it('窗口内失败达到阈值后拒绝，并给出剩余等待时间', () => {
    let clock = 1_000;
    const limiter = new LoginAttemptLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      now: () => clock,
    });
    expect(limiter.check('ip').allowed).toBe(true);
    limiter.recordFailure('ip');
    limiter.recordFailure('ip');
    limiter.recordFailure('ip');
    const state = limiter.check('ip');
    expect(state.allowed).toBe(false);
    expect(state.retryAfterMs).toBe(60_000);
    clock += 30_000;
    expect(limiter.check('ip').retryAfterMs).toBe(30_000);
  });

  it('成功登录清零计数', () => {
    const limiter = new LoginAttemptLimiter({ maxAttempts: 2, now: () => 0 });
    limiter.recordFailure('ip');
    limiter.recordFailure('ip');
    expect(limiter.check('ip').allowed).toBe(false);
    limiter.recordSuccess('ip');
    expect(limiter.check('ip').allowed).toBe(true);
    limiter.recordFailure('ip');
    expect(limiter.check('ip').allowed).toBe(true);
  });

  it('按 IP 隔离计数', () => {
    const limiter = new LoginAttemptLimiter({ maxAttempts: 1, now: () => 0 });
    limiter.recordFailure('a');
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('窗口过期后计数重置', () => {
    let clock = 0;
    const limiter = new LoginAttemptLimiter({
      maxAttempts: 1,
      windowMs: 10_000,
      now: () => clock,
    });
    limiter.recordFailure('ip');
    expect(limiter.check('ip').allowed).toBe(false);
    clock += 10_001;
    expect(limiter.check('ip').allowed).toBe(true);
    limiter.recordFailure('ip');
    expect(limiter.check('ip').allowed).toBe(false);
  });

  it('阈值与窗口下限保护：非法配置被钳制到安全默认', () => {
    const limiter = new LoginAttemptLimiter({
      maxAttempts: 0,
      windowMs: 1,
      now: () => 0,
    });
    limiter.recordFailure('ip');
    expect(limiter.check('ip').allowed).toBe(false);
    expect(limiter.check('ip').retryAfterMs).toBeGreaterThanOrEqual(1_000);
  });
});