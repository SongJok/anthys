import { describe, expect, it, vi } from 'vitest';
import type { AgentEngine, RunResult } from '../types/core.js';
import type { GroupModelRoute } from '../types/group-workspace.js';
import { GroupModelRoutingEngine } from './GroupModelRoutingEngine.js';

const NOW = 1_764_500_000_000;

function result(answer: string): RunResult {
  return {
    answer,
    reasoning: '',
    usage: { totalTokens: 0, steps: 0, durationMs: 0 },
  };
}

function route(overrides: Partial<GroupModelRoute> = {}): GroupModelRoute {
  return {
    conversationId: 'cid-group-1',
    enabled: true,
    provider: '',
    baseUrl: '',
    apiKeyEnv: '',
    model: 'qwen-max',
    temperature: null,
    thinking: '',
    maxTokens: null,
    updatedBy: 'admin',
    updatedAt: NOW,
    ...overrides,
  };
}

function input(
  conversationType: '1' | '2' = '2',
  conversationId = 'cid-group-1',
) {
  return {
    messages: [],
    context: {
      conversationId,
      messageId: 'msg-1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      conversationType,
      deadlineAt: NOW + 60_000,
      now: () => NOW,
    },
    emit: () => {},
  };
}

function makeHarness(options: {
  initialRoute?: GroupModelRoute | null;
  ttlMs?: number;
  now?: () => number;
  unusable?: boolean;
} = {}) {
  let current = options.initialRoute ?? null;
  let fail = false;
  const created: string[] = [];
  const runs: string[] = [];
  const warns: Array<Record<string, unknown> & { message: string }> = [];
  const fallback: AgentEngine = {
    async run() {
      runs.push('fallback');
      return result('fallback');
    },
  };
  const engineForRoute = vi.fn(
    (selected: GroupModelRoute): AgentEngine | null => {
      if (options.unusable) return null;
      created.push(selected.model);
      const label = `route:${selected.model}`;
      return {
        async run() {
          runs.push(label);
          return result(label);
        },
      };
    },
  );
  const routes = {
    get: vi.fn(async (conversationId: string) => {
      if (fail) throw new Error(`lookup failed: ${conversationId}`);
      return current ? { ...current, conversationId } : null;
    }),
  };
  const engine = new GroupModelRoutingEngine({
    fallback,
    routes,
    engineForRoute,
    cacheTtlMs: options.ttlMs ?? 60_000,
    now: options.now ?? (() => NOW),
    logger: {
      warn: (obj, message) => warns.push({ ...obj, message }),
    },
  });
  return {
    engine,
    routes,
    engineForRoute,
    created,
    runs,
    warns,
    setRoute: (next: GroupModelRoute | null) => {
      current = next;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

describe('GroupModelRoutingEngine', () => {
  it('单聊直接使用默认引擎，不查询群路由', async () => {
    const harness = makeHarness({ initialRoute: route() });
    const outcome = await harness.engine.run(input('1'));
    expect(outcome.answer).toBe('fallback');
    expect(harness.routes.get).not.toHaveBeenCalled();
    expect(harness.engineForRoute).not.toHaveBeenCalled();
  });

  it('群聊无路由或路由停用时使用默认引擎', async () => {
    const empty = makeHarness();
    expect((await empty.engine.run(input())).answer).toBe('fallback');
    expect(empty.engineForRoute).not.toHaveBeenCalled();

    const disabled = makeHarness({ initialRoute: route({ enabled: false }) });
    expect((await disabled.engine.run(input())).answer).toBe('fallback');
    expect(disabled.engineForRoute).not.toHaveBeenCalled();
  });

  it('启用路由时使用按群引擎，并复用同一签名缓存', async () => {
    const harness = makeHarness({ initialRoute: route() });
    expect((await harness.engine.run(input())).answer).toBe('route:qwen-max');
    expect((await harness.engine.run(input())).answer).toBe('route:qwen-max');
    expect(harness.engineForRoute).toHaveBeenCalledTimes(1);
    expect(harness.created).toEqual(['qwen-max']);
    expect(harness.runs).toEqual(['route:qwen-max', 'route:qwen-max']);
  });

  it('路由签名变化时重建引擎', async () => {
    const harness = makeHarness({ initialRoute: route() });
    await harness.engine.run(input());
    harness.setRoute(route({ model: 'qwen-plus', temperature: 0.2 }));
    expect((await harness.engine.run(input())).answer).toBe('route:qwen-plus');
    expect(harness.created).toEqual(['qwen-max', 'qwen-plus']);
  });

  it('缓存超过 TTL 后重新读取并重建引擎', async () => {
    let clock = NOW;
    const harness = makeHarness({
      initialRoute: route(),
      ttlMs: 1_000,
      now: () => clock,
    });
    await harness.engine.run(input());
    clock = NOW + 999;
    await harness.engine.run(input());
    expect(harness.engineForRoute).toHaveBeenCalledTimes(1);
    clock = NOW + 1_000;
    await harness.engine.run(input());
    expect(harness.engineForRoute).toHaveBeenCalledTimes(2);
  });

  it('invalidate 只清理指定群或全部缓存', async () => {
    const harness = makeHarness({ initialRoute: route() });
    await harness.engine.run(input('2', 'cid-group-1'));
    await harness.engine.run(input('2', 'cid-group-2'));
    expect(harness.engineForRoute).toHaveBeenCalledTimes(2);

    harness.engine.invalidate('cid-group-1');
    await harness.engine.run(input('2', 'cid-group-1'));
    await harness.engine.run(input('2', 'cid-group-2'));
    expect(harness.engineForRoute).toHaveBeenCalledTimes(3);

    harness.engine.invalidate();
    await harness.engine.run(input('2', 'cid-group-1'));
    await harness.engine.run(input('2', 'cid-group-2'));
    expect(harness.engineForRoute).toHaveBeenCalledTimes(5);
  });

  it('读取路由失败时回退默认引擎并记录告警', async () => {
    const harness = makeHarness();
    harness.setFail(true);
    expect((await harness.engine.run(input())).answer).toBe('fallback');
    expect(harness.warns).toHaveLength(1);
    expect(harness.warns[0]!.message).toContain('group model route lookup failed');
    expect(harness.warns[0]!.conversationId).toBe('cid-group-1');
  });

  it('路由不可用（如密钥环境变量缺失）时回退默认引擎并告警', async () => {
    const harness = makeHarness({
      initialRoute: route({ apiKeyEnv: 'GROUP_MISSING_KEY' }),
      unusable: true,
    });
    expect((await harness.engine.run(input())).answer).toBe('fallback');
    expect(harness.engineForRoute).toHaveBeenCalledTimes(1);
    expect(harness.runs).toEqual(['fallback']);
    expect(harness.warns).toHaveLength(1);
    expect(harness.warns[0]!.message).toContain('group model route unusable');
    expect(harness.warns[0]!.apiKeyEnv).toBe('GROUP_MISSING_KEY');
  });
});
