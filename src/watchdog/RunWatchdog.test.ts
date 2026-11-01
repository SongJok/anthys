import { describe, expect, it } from 'vitest';
import {
  RunWatchdog,
  contentHash,
  createWatchdogPolicy,
  toolSignature,
} from './RunWatchdog.js';
import type { WatchdogToolObservation } from '../types/watchdog.js';

const BUDGET = { maxWallTimeMs: 1_000_000, maxTotalTokens: 1_000_000 };

function tool(
  name: string,
  content: string,
  options: { isError?: boolean; citations?: string[] } = {},
): WatchdogToolObservation {
  return {
    name,
    signature: toolSignature(name, '{}'),
    contentHash: contentHash(content),
    isError: options.isError ?? false,
    citationKeys: options.citations ?? [],
  };
}

function step(
  tools: WatchdogToolObservation[],
  elapsedMs = 100,
  tokens = 100,
) {
  return { tools, elapsedMs, tokens };
}

describe('RunWatchdog', () => {
  it('持续获得新信息时不干预', () => {
    const watchdog = new RunWatchdog({ mode: 'interactive', budget: BUDGET });
    for (let index = 0; index < 5; index += 1) {
      const decision = watchdog.observeToolStep(
        step([tool('search', `结果 ${index}`)]),
      );
      expect(decision).toBeNull();
    }
    expect(watchdog.getOutcome()).toBeNull();
  });

  it('引用也算新信息，避免只按输出文本误判', () => {
    const watchdog = new RunWatchdog({ mode: 'interactive', budget: BUDGET });
    for (let index = 0; index < 4; index += 1) {
      const decision = watchdog.observeToolStep(
        step([
          {
            ...tool('search', '相同正文', {
              citations: [`https://a/${index}`],
            }),
            signature: toolSignature('search', JSON.stringify({ page: index })),
          },
        ]),
      );
      expect(decision).toBeNull();
    }
  });

  it('连续重复调用先注入约束，注入用尽后降级停用工具', () => {
    const watchdog = new RunWatchdog({
      mode: 'interactive',
      budget: BUDGET,
      policy: { noProgressSteps: 2, maxInjections: 2 },
    });
    const repeated = tool('search', '相同结果');
    expect(watchdog.observeToolStep(step([repeated]))).toBeNull();
    expect(watchdog.observeToolStep(step([repeated]))).toBeNull();
    const first = watchdog.observeToolStep(step([repeated]));
    expect(first?.action).toBe('inject');
    expect(first?.code).toBe('repeat');
    const second = watchdog.observeToolStep(step([repeated]));
    expect(second?.action).toBe('inject');
    const third = watchdog.observeToolStep(step([repeated]));
    expect(third?.action).toBe('degrade');
    expect(third?.escalate).toBe(false);
    expect(watchdog.isDegraded()).toBe(true);
    expect(watchdog.observeToolStep(step([repeated]))).toBeNull();
  });

  it('连续工具失败触发检查参数与权限的约束', () => {
    const watchdog = new RunWatchdog({
      mode: 'interactive',
      budget: BUDGET,
      policy: { toolErrorSteps: 2, maxInjections: 1 },
    });
    expect(
      watchdog.observeToolStep(step([tool('doc_read', '失败', { isError: true })])),
    ).toBeNull();
    const injected = watchdog.observeToolStep(
      step([tool('doc_read', '失败', { isError: true })]),
    );
    expect(injected?.action).toBe('inject');
    expect(injected?.code).toBe('tool-errors');
    const degraded = watchdog.observeToolStep(
      step([tool('doc_read', '失败', { isError: true })]),
    );
    expect(degraded?.action).toBe('degrade');
  });

  it('预算告警注入收敛约束，达到硬阈值后台任务暂停、交互运行取消', () => {
    const jobWatchdog = new RunWatchdog({
      mode: 'job',
      budget: { maxWallTimeMs: 1_000, maxTotalTokens: 1_000 },
    });
    expect(jobWatchdog.observeBudget(500, 500)).toBeNull();
    const warning = jobWatchdog.observeBudget(850, 500);
    expect(warning?.action).toBe('inject');
    expect(warning?.code).toBe('wall-time');
    expect(jobWatchdog.observeBudget(900, 900)).toBeNull();
    const paused = jobWatchdog.observeBudget(960, 900);
    expect(paused?.action).toBe('pause');
    expect(paused?.escalate).toBe(true);
    expect(jobWatchdog.isTerminal()).toBe(true);
    expect(jobWatchdog.getOutcome()?.action).toBe('pause');

    const interactive = new RunWatchdog({
      mode: 'interactive',
      budget: { maxWallTimeMs: 1_000, maxTotalTokens: 1_000 },
    });
    const cancelled = interactive.observeBudget(10, 990);
    expect(cancelled?.action).toBe('cancel');
    expect(cancelled?.code).toBe('budget');
  });

  it('关闭时不做任何干预', () => {
    const watchdog = new RunWatchdog({
      mode: 'interactive',
      budget: BUDGET,
      policy: { enabled: false },
    });
    const repeated = tool('search', '相同结果');
    for (let index = 0; index < 10; index += 1) {
      expect(watchdog.observeToolStep(step([repeated]))).toBeNull();
    }
    expect(watchdog.observeBudget(999_999, 999_999)).toBeNull();
  });
});

describe('createWatchdogPolicy', () => {
  it('读取环境变量并纠正倒置的阈值', () => {
    const policy = createWatchdogPolicy({
      WATCHDOG_ENABLED: 'false',
      WATCHDOG_NO_PROGRESS_STEPS: '5',
      WATCHDOG_MAX_INJECTIONS: '0',
      WATCHDOG_WARN_RATIO: '0.98',
      WATCHDOG_HARD_RATIO: '0.9',
      WATCHDOG_TOOL_ERROR_STEPS: '4',
    } as NodeJS.ProcessEnv);
    expect(policy.enabled).toBe(false);
    expect(policy.noProgressSteps).toBe(5);
    expect(policy.maxInjections).toBe(0);
    expect(policy.warnRatio).toBe(0.9);
    expect(policy.hardRatio).toBe(0.98);
    expect(policy.toolErrorSteps).toBe(4);
  });

  it('缺省值开启看门狗', () => {
    const policy = createWatchdogPolicy({});
    expect(policy.enabled).toBe(true);
    expect(policy.noProgressSteps).toBe(3);
    expect(policy.maxInjections).toBe(2);
  });
});
