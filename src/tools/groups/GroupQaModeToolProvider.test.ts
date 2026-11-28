import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import {
  createDefaultBystanderPolicy,
  type GroupBystanderPolicy,
} from '../../types/bystander-and-memory.js';
import {
  GroupQaModeToolProvider,
  type GroupQaModePolicyPort,
} from './GroupQaModeToolProvider.js';

const NOW = 1_764_500_000_000;

class MemoryPolicyPort implements GroupQaModePolicyPort {
  public policy: GroupBystanderPolicy = createDefaultBystanderPolicy('cid-g');
  public updates: Array<{ qaModeEnabled?: boolean; qaModeExpiresAt?: number }> =
    [];

  public async getGroupPolicy(): Promise<GroupBystanderPolicy> {
    return this.policy;
  }

  public async updateGroupPolicy(
    _conversationId: string,
    input: { qaModeEnabled?: boolean; qaModeExpiresAt?: number },
  ): Promise<GroupBystanderPolicy> {
    this.updates.push(input);
    this.policy = { ...this.policy, ...input };
    return this.policy;
  }
}

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-g',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '2',
    deadlineAt: NOW + 60_000,
    now: () => NOW,
    ...overrides,
  };
}

function setup(policy?: Partial<GroupBystanderPolicy>) {
  const port = new MemoryPolicyPort();
  if (policy) port.policy = { ...port.policy, ...policy };
  const provider = new GroupQaModeToolProvider({
    policies: port,
    now: () => NOW,
  });
  return { port, provider };
}

async function toolsOf(
  provider: GroupQaModeToolProvider,
  ctx: ExecutionContext,
): Promise<Map<string, ToolDefinition>> {
  return new Map(
    (await provider.getTools(ctx)).map((tool) => [tool.name, tool]),
  );
}

describe('GroupQaModeToolProvider', () => {
  it('只在群聊暴露答疑模式工具', async () => {
    const { provider } = setup();
    expect(
      await provider.getTools(context({ conversationType: '1' })),
    ).toEqual([]);
    const tools = await toolsOf(provider, context());
    expect(tools.has('group_qa_mode')).toBe(true);
    expect(tools.has('group_qa_mode_status')).toBe(true);
  });

  it('开启默认 2 小时答疑模式并写入到期时间', async () => {
    const { port, provider } = setup();
    const tool = (await toolsOf(provider, context())).get('group_qa_mode')!;
    const result = await tool.execute({ enabled: true }, context());
    expect(port.policy.qaModeEnabled).toBe(true);
    expect(port.policy.qaModeExpiresAt).toBe(NOW + 7_200_000);
    expect(result).toContain('答疑模式');
    expect(result).toContain('120 分钟');
  });

  it('自定义时长并钳制到 1–1440 分钟', async () => {
    const { port, provider } = setup();
    const tool = (await toolsOf(provider, context())).get('group_qa_mode')!;
    await tool.execute({ enabled: true, durationMinutes: 30 }, context());
    expect(port.policy.qaModeExpiresAt).toBe(NOW + 30 * 60_000);
    await tool.execute({ enabled: true, durationMinutes: 9999 }, context());
    expect(port.policy.qaModeExpiresAt).toBe(NOW + 1440 * 60_000);
    await tool.execute({ enabled: true, durationMinutes: 0 }, context());
    expect(port.policy.qaModeExpiresAt).toBe(0);
  });

  it('旁听被管理员暂停时拒绝开启且不写策略', async () => {
    const { port, provider } = setup({ bystanderEnabled: false });
    const tool = (await toolsOf(provider, context())).get('group_qa_mode')!;
    const result = await tool.execute({ enabled: true }, context());
    expect(result).toContain('暂停');
    expect(port.updates).toHaveLength(0);
    expect(port.policy.qaModeEnabled).toBeFalsy();
  });

  it('关闭答疑模式清空开关与到期时间', async () => {
    const { port, provider } = setup({
      qaModeEnabled: true,
      qaModeExpiresAt: NOW + 7_200_000,
    });
    const tool = (await toolsOf(provider, context())).get('group_qa_mode')!;
    await tool.execute({ enabled: false }, context());
    expect(port.policy.qaModeEnabled).toBe(false);
    expect(port.policy.qaModeExpiresAt).toBe(0);
  });

  it('状态查询区分生效、到期、未开启与暂停', async () => {
    const active = setup({
      qaModeEnabled: true,
      qaModeExpiresAt: NOW + 60_000,
    });
    const activeTool = (await toolsOf(active.provider, context())).get(
      'group_qa_mode_status',
    )!;
    expect(await activeTool.execute({}, context())).toContain('生效中');

    const expired = setup({
      qaModeEnabled: true,
      qaModeExpiresAt: NOW - 1,
    });
    const expiredTool = (await toolsOf(expired.provider, context())).get(
      'group_qa_mode_status',
    )!;
    expect(await expiredTool.execute({}, context())).toContain('已到期');

    const off = setup();
    const offTool = (await toolsOf(off.provider, context())).get(
      'group_qa_mode_status',
    )!;
    expect(await offTool.execute({}, context())).toContain('未开启');

    const muted = setup({
      qaModeEnabled: true,
      qaModeExpiresAt: NOW + 60_000,
      bystanderEnabled: false,
    });
    const mutedTool = (await toolsOf(muted.provider, context())).get(
      'group_qa_mode_status',
    )!;
    expect(await mutedTool.execute({}, context())).toContain('暂停');
  });
});