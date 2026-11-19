import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_RETRY_POLICY,
  createModelRetryPolicy,
  isTransientModelError,
  modelRetryDelayMs,
  sleepWithSignal,
} from './modelRetry.js';

function httpError(status: number, message = 'upstream error'): Error {
  return Object.assign(new Error(message), { status });
}

describe('isTransientModelError', () => {
  it('把限流与 5xx 判为瞬态', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(isTransientModelError(httpError(status))).toBe(true);
    }
    expect(
      isTransientModelError(Object.assign(new Error('x'), { statusCode: 503 })),
    ).toBe(true);
  });

  it('鉴权与参数错误不重试', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientModelError(httpError(status))).toBe(false);
    }
  });

  it('状态码优先于消息文本，避免误重试', () => {
    expect(isTransientModelError(httpError(400, 'network glitch'))).toBe(false);
    expect(isTransientModelError(httpError(401, 'rate limit'))).toBe(false);
  });

  it('主动取消不重试，即使带 5xx 状态', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      status: 503,
    });
    expect(isTransientModelError(aborted)).toBe(false);
  });

  it('识别 Anthropic 适配器消息前缀里的状态码', () => {
    expect(
      isTransientModelError(new Error('Anthropic API 529: {"type":"overloaded"}')),
    ).toBe(true);
    expect(
      isTransientModelError(new Error('Anthropic API 401: invalid x-api-key')),
    ).toBe(false);
  });

  it('识别 socket 错误码与传输层消息', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']) {
      expect(isTransientModelError(Object.assign(new Error('x'), { code }))).toBe(
        true,
      );
    }
    for (const message of [
      'fetch failed',
      'socket hang up',
      'other side closed',
      'terminated',
      'Request timed out',
    ]) {
      expect(isTransientModelError(new Error(message))).toBe(true);
    }
  });

  it('业务错误与非对象输入不重试', () => {
    expect(isTransientModelError(new Error('上游模型不可用'))).toBe(false);
    expect(isTransientModelError(new Error('工具参数缺失'))).toBe(false);
    expect(isTransientModelError('ECONNRESET')).toBe(false);
    expect(isTransientModelError(null)).toBe(false);
    expect(isTransientModelError(undefined)).toBe(false);
  });
});

describe('modelRetryDelayMs', () => {
  const policy = { maxAttempts: 4, baseDelayMs: 600, maxDelayMs: 5_000 };

  it('指数增长并受 maxDelayMs 封顶', () => {
    expect(modelRetryDelayMs(1, policy, () => 1)).toBe(600);
    expect(modelRetryDelayMs(2, policy, () => 1)).toBe(1_200);
    expect(modelRetryDelayMs(3, policy, () => 1)).toBe(2_400);
    expect(modelRetryDelayMs(4, policy, () => 1)).toBe(4_800);
    expect(modelRetryDelayMs(5, policy, () => 1)).toBe(5_000);
    expect(modelRetryDelayMs(50, policy, () => 1)).toBe(5_000);
  });

  it('抖动落在天花板的一半到全额之间', () => {
    expect(modelRetryDelayMs(2, policy, () => 0)).toBe(600);
    expect(modelRetryDelayMs(2, policy, () => 0.5)).toBe(900);
    for (let i = 0; i < 50; i += 1) {
      const delay = modelRetryDelayMs(3, policy);
      expect(delay).toBeGreaterThanOrEqual(1_200);
      expect(delay).toBeLessThanOrEqual(2_400);
    }
  });

  it('baseDelayMs 为 0 时不等待', () => {
    expect(
      modelRetryDelayMs(3, { ...policy, baseDelayMs: 0, maxDelayMs: 0 }, () => 1),
    ).toBe(0);
  });
});

describe('sleepWithSignal', () => {
  it('等待指定时长后 resolve', async () => {
    const startedAt = Date.now();
    await sleepWithSignal(30);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it('取消时立即结束等待，不抛异常', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = sleepWithSignal(10_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('已取消或零时长直接返回', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    await sleepWithSignal(10_000, controller.signal);
    await sleepWithSignal(0);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

describe('createModelRetryPolicy', () => {
  it('缺省使用默认策略', () => {
    expect(createModelRetryPolicy({})).toEqual(DEFAULT_MODEL_RETRY_POLICY);
  });

  it('读取环境变量覆盖', () => {
    expect(
      createModelRetryPolicy({
        LLM_RETRY_MAX_ATTEMPTS: '5',
        LLM_RETRY_BASE_DELAY_MS: '200',
        LLM_RETRY_MAX_DELAY_MS: '2000',
      }),
    ).toEqual({ maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 2_000 });
  });

  it('关闭重试时至少保留一次尝试', () => {
    expect(createModelRetryPolicy({ LLM_RETRY_MAX_ATTEMPTS: '1' }).maxAttempts).toBe(
      1,
    );
    expect(createModelRetryPolicy({ LLM_RETRY_MAX_ATTEMPTS: '0' }).maxAttempts).toBe(
      1,
    );
    expect(
      createModelRetryPolicy({ LLM_RETRY_MAX_ATTEMPTS: '-3' }).maxAttempts,
    ).toBe(1);
  });

  it('非法值回退默认，maxDelay 不低于 baseDelay', () => {
    expect(createModelRetryPolicy({ LLM_RETRY_MAX_ATTEMPTS: 'abc' })).toEqual(
      DEFAULT_MODEL_RETRY_POLICY,
    );
    expect(createModelRetryPolicy({ LLM_RETRY_BASE_DELAY_MS: '  ' })).toEqual(
      DEFAULT_MODEL_RETRY_POLICY,
    );
    expect(
      createModelRetryPolicy({
        LLM_RETRY_BASE_DELAY_MS: '-100',
        LLM_RETRY_MAX_DELAY_MS: '50',
      }),
    ).toEqual({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 50 });
    expect(
      createModelRetryPolicy({
        LLM_RETRY_BASE_DELAY_MS: '800',
        LLM_RETRY_MAX_DELAY_MS: '100',
      }),
    ).toEqual({ maxAttempts: 3, baseDelayMs: 800, maxDelayMs: 800 });
  });
});