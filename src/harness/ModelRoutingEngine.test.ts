import { describe, expect, it } from 'vitest';
import { ModelRoutingEngine } from './ModelRoutingEngine.js';
import type { AgentEngine, ExecutionContext, ModelRole } from '../types/core.js';

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
      engineForRole: (role) => engineNamed(role),
    });
    expect(await answerFor(engine, context())).toBe('fallback');
  });

  it('主动回复优先切到 proactive 角色', async () => {
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForRole: (role) => engineNamed(role),
      isAdmin: () => true,
    });
    expect(await answerFor(engine, context({ proactive: true }))).toBe(
      'proactive',
    );
    expect(await answerFor(engine, context())).toBe('admin');
  });

  it('答疑模式主动回复对齐正常路由，不走 proactive 角色', async () => {
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForRole: (role) => engineNamed(role),
      isAdmin: (staffId) => staffId === 'admin-1',
    });
    // 答疑态普通成员走默认模型，管理员走 admin，均与正常@回复一致
    expect(
      await answerFor(
        engine,
        context({ proactive: true, qaMode: true, senderStaffId: 'staff-9' }),
      ),
    ).toBe('fallback');
    expect(
      await answerFor(
        engine,
        context({ proactive: true, qaMode: true, senderStaffId: 'admin-1' }),
      ),
    ).toBe('admin');
    // 非答疑主动回复仍走便宜旁听模型
    expect(
      await answerFor(engine, context({ proactive: true, qaMode: false })),
    ).toBe('proactive');
  });

  it('管理员单聊切到 admin 角色，普通员工不切', async () => {
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForRole: (role) => engineNamed(role),
      isAdmin: (staffId) => staffId === 'admin-1',
    });
    expect(
      await answerFor(engine, context({ senderStaffId: 'admin-1' })),
    ).toBe('admin');
    expect(
      await answerFor(engine, context({ senderStaffId: 'staff-9' })),
    ).toBe('fallback');
  });

  it('按角色缓存引擎实例', async () => {
    const created: ModelRole[] = [];
    const engine = new ModelRoutingEngine({
      fallback: engineNamed('fallback'),
      engineForRole: (role) => {
        created.push(role);
        return engineNamed(role);
      },
      isAdmin: () => true,
    });
    expect(await answerFor(engine, context())).toBe('admin');
    expect(await answerFor(engine, context())).toBe('admin');
    expect(created).toEqual(['admin']);
  });
});
