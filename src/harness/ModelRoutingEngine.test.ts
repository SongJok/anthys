import { describe, expect, it } from 'vitest';
import { ModelRoutingEngine } from './ModelRoutingEngine.js';
import type { ModelRoutingPolicy } from '../types/admin-and-console.js';
import type { AgentEngine, ExecutionContext } from '../types/core.js';

function engineNamed(name: string): AgentEngine {
  return {
    async run() {
      return {
        answer: name,
        reasoning: '',
        usage: { totalTokens: 1, steps: 1, durationMs: 1 },
      };
    },
  };
}

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid',
    messageId: 'm-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: 1_000,
    now: () => 0,
    ...overrides,
  };
}

async function answerFor(
  engine: ModelRoutingEngine,
  ctx: ExecutionContext,
): Promise<string> {
  const result = await engine.run({
    messages: [],
    context: ctx,
    emit: () => undefined,
  });
  return result.answer;
}

describe('ModelRoutingEngine', () => {
  it('默认走 fallback 引擎', async () => {
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForModel: engineNamed,
      routing: () => ({}),
    });
    expect(await answerFor(engine, context())).toBe('fallback');
  });

  it('主动回复切到 proactiveModel', async () => {
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForModel: engineNamed,
      routing: () => ({ proactiveModel: 'cheap-model' }),
    });
    expect(await answerFor(engine, context({ proactive: true }))).toBe(
      'cheap-model',
    );
    expect(await answerFor(engine, context())).toBe('fallback');
  });

  it('管理员单聊切到 adminModel，普通员工不切', async () => {
    const routing: ModelRoutingPolicy = { adminModel: 'strong-model' };
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForModel: engineNamed,
      routing: () => routing,
      isAdmin: (staffId) => staffId === 'admin-1',
    });
    expect(
      await answerFor(engine, context({ senderStaffId: 'admin-1' })),
    ).toBe('strong-model');
    expect(
      await answerFor(engine, context({ senderStaffId: 'staff-9' })),
    ).toBe('fallback');
  });

  it('defaultModel 覆盖全局默认模型并按模型名缓存引擎', async () => {
    const created: string[] = [];
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForModel: (model) => {
        created.push(model);
        return engineNamed(model);
      },
      routing: () => ({ defaultModel: 'shared-model' }),
    });
    expect(await answerFor(engine, context())).toBe('shared-model');
    expect(await answerFor(engine, context())).toBe('shared-model');
    expect(created).toEqual(['shared-model']);
  });
});
