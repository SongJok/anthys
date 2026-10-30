import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/core.js';
import type { EnterpriseMcpServerConfig } from '../../types/mcp-and-sandbox.js';
import type {
  GroupDirectory,
  KnownGroup,
  McpAdminPort,
  McpServerStatusView,
  ReActTracePage,
  ReActTraceQuery,
  ReActTraceRecord,
  ReActTraceStore,
  TraceDailyStats,
} from '../../types/admin-and-console.js';
import type {
  AdminAuditInput,
  AdminAuditLog,
  ConfigSections,
  ConfigStore,
  GroupPolicyStore,
} from '../../db/configSchema.js';
import type { GroupBystanderPolicy } from '../../types/bystander-and-memory.js';
import type { IConfigProvider } from '../../config/IConfigProvider.js';
import { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import { ToolRegistry } from '../../harness/ToolRegistry.js';
import {
  ADMIN_TOOL_NAMES,
  AdminChatOpsToolProvider,
} from './AdminChatOpsToolProvider.js';

const ADMIN_ID = 'admin-001';
const NOW = new Date('2026-10-30T10:00:00Z').getTime();

class MemoryConfigStore implements ConfigStore {
  constructor(public sections: ConfigSections = {}) {}
  async loadAll(): Promise<ConfigSections> {
    return structuredClone(this.sections);
  }
  async save(): Promise<void> {
    // no-op: assertions read the center's in-memory state
  }
}

class MemoryGroupPolicyStore implements GroupPolicyStore {
  private readonly policies = new Map<string, GroupBystanderPolicy>();
  async getPolicy(conversationId: string): Promise<GroupBystanderPolicy | null> {
    return this.policies.get(conversationId) ?? null;
  }
  async upsertPolicy(policy: GroupBystanderPolicy): Promise<void> {
    this.policies.set(policy.conversationId, structuredClone(policy));
  }
  async listPolicies(): Promise<GroupBystanderPolicy[]> {
    return [...this.policies.values()];
  }
}

class MemoryAuditStore {
  public readonly entries: AdminAuditLog[] = [];
  async append(input: AdminAuditInput): Promise<AdminAuditLog> {
    const entry: AdminAuditLog = {
      id: `audit-${this.entries.length + 1}`,
      ...input,
      createdAt: new Date(NOW).toISOString(),
    };
    this.entries.unshift(entry);
    return entry;
  }
  async list(limit: number): Promise<AdminAuditLog[]> {
    return this.entries.slice(0, limit);
  }
}

class FakeMcpAdminPort implements McpAdminPort {
  public readonly reloaded: string[] = [];
  public readonly applied: EnterpriseMcpServerConfig[][] = [];
  private servers: EnterpriseMcpServerConfig[];

  constructor(servers: EnterpriseMcpServerConfig[]) {
    this.servers = servers;
  }

  status(): McpServerStatusView[] {
    return this.servers.map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      connected: server.enabled,
      toolCount: server.enabled ? 2 : 0,
      lastError: null,
    }));
  }

  async healthCheck() {
    return this.servers.map((server) => ({
      serverId: server.id,
      healthy: server.enabled,
      latencyMs: 12,
    }));
  }

  async reloadServer(serverId: string) {
    this.reloaded.push(serverId);
    return [
      {
        serverId,
        originalName: 'search_logs',
        namespacedName: `mcp__${serverId}__search_logs`,
        description: '检索日志',
      },
    ];
  }

  async applyServers(servers: EnterpriseMcpServerConfig[]) {
    this.servers = structuredClone(servers);
    this.applied.push(structuredClone(servers));
    return servers
      .filter((server) => server.enabled)
      .map((server) => ({
        serverId: server.id,
        originalName: `${server.id}_tool`,
        namespacedName: `mcp__${server.id}__${server.id}_tool`,
        description: '示例工具',
      }));
  }
}

class FakeTraceStore implements ReActTraceStore {
  public readonly records: ReActTraceRecord[] = [];
  async append(record: ReActTraceRecord): Promise<void> {
    this.records.push(record);
  }
  async query(input: ReActTraceQuery): Promise<ReActTracePage> {
    const filtered = this.records.filter(
      (record) =>
        input.sinceMs === undefined ||
        Date.parse(record.createdAt) >= input.sinceMs,
    );
    return {
      items: filtered.slice(0, input.pageSize),
      total: filtered.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }
  async dailyStats(): Promise<TraceDailyStats> {
    return {
      totalTokens: 18_000,
      totalTurns: 9,
      byGroup: [
        {
          conversationId: 'cid-dev',
          turns: 6,
          proactiveReplies: 4,
          totalTokens: 12_000,
        },
        {
          conversationId: 'cid-ops',
          turns: 3,
          proactiveReplies: 1,
          totalTokens: 6_000,
        },
      ],
    };
  }
}

class FakeGroupDirectory implements GroupDirectory {
  async listGroups(): Promise<KnownGroup[]> {
    return [
      {
        conversationId: 'cid-dev',
        title: '研发大群',
        conversationType: '2',
        bystanderEnabled: null,
        proactiveReplyEnabled: null,
        lastActiveAt: NOW,
      },
    ];
  }
}

function fakeDefaults(): IConfigProvider {
  return {
    getLLMConfig: () => ({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-env-secret',
      model: 'deepseek-reasoner',
      enableNativeReasoning: true,
      temperature: 0.3,
      persona: { name: '小钉', rolePrompt: '企业助手', speakingStyle: '专业' },
    }),
    getLoopPolicy: () => ({
      maxWallTimeMs: 120_000,
      maxTotalTokens: 64_000,
      maxConsecutiveSameTool: 2,
      convergenceCheck: true,
    }),
    getDingTalkConfig: () => ({
      clientId: 'ding-app-key',
      clientSecret: 'ding-app-secret',
      robotCode: 'robot-code',
      cardTemplateId: 'card-template',
    }),
    getMemoryConfig: () => ({
      windowMessages: 20,
      compressionThresholdTokens: 12_000,
      compressionRatio: 0.6,
      semanticLimit: 6,
    }),
    getBystanderConfig: () => ({
      bystanderEnabled: true,
      proactiveReplyEnabled: true,
      slidingWindowSize: 20,
      cooldownSeconds: 180,
      confidenceThreshold: 0.82,
      triggerTopics: ['线上故障'],
      debounceMs: 8_000,
    }),
    getDatabaseUrl: () => 'postgres://localhost:5432/test',
    assertReady: () => undefined,
  };
}

const LOG_SERVER: EnterpriseMcpServerConfig = {
  id: 'logs',
  name: '日志 MCP',
  domain: 'log',
  transport: 'streamable-http',
  endpointOrCommand: 'https://logs.example.com/mcp',
  timeoutMs: 5_000,
  maxResultChars: 8_000,
  enabled: true,
};

function ctx(
  conversationType: '1' | '2',
  senderStaffId: string,
): ExecutionContext {
  return {
    conversationId: conversationType === '1' ? `single-${senderStaffId}` : 'cid-dev',
    messageId: 'msg-1',
    senderStaffId,
    senderNick: senderStaffId === ADMIN_ID ? '管理员' : '普通员工',
    conversationType,
    deadlineAt: NOW + 120_000,
    now: () => NOW,
  };
}

interface Harness {
  center: DynamicConfigCenter;
  audit: MemoryAuditStore;
  mcp: FakeMcpAdminPort;
  traces: FakeTraceStore;
  provider: AdminChatOpsToolProvider;
  registry: ToolRegistry;
}

async function createHarness(workspaceRoot: string): Promise<Harness> {
  const audit = new MemoryAuditStore();
  const mcp = new FakeMcpAdminPort([LOG_SERVER]);
  const traces = new FakeTraceStore();
  traces.records.push(
    {
      id: 'trace-fast',
      conversationId: 'cid-dev',
      messageId: 'm-1',
      senderStaffId: 'u-1',
      senderNick: '张三',
      conversationType: '2',
      proactive: false,
      question: '今天几号',
      reasoning: '',
      steps: [],
      answer: '10 月 30 日',
      totalTokens: 1_200,
      stepCount: 1,
      durationMs: 900,
      createdAt: new Date(NOW - 60_000).toISOString(),
    },
    {
      id: 'trace-slow',
      conversationId: 'cid-ops',
      messageId: 'm-2',
      senderStaffId: 'u-2',
      senderNick: '李四',
      conversationType: '2',
      proactive: true,
      question: '统计最近一周的错误日志',
      reasoning: '需要调用日志 MCP',
      steps: [
        {
          index: 0,
          type: 'tool',
          toolName: 'mcp__logs__search_logs',
          durationMs: 12_000,
          isError: false,
        },
      ],
      answer: '共 42 条错误',
      totalTokens: 9_000,
      stepCount: 3,
      durationMs: 15_000,
      createdAt: new Date(NOW - 120_000).toISOString(),
    },
  );

  const center = new DynamicConfigCenter({
    defaults: fakeDefaults(),
    store: new MemoryConfigStore(),
    groupPolicies: new MemoryGroupPolicyStore(),
    auditStore: audit,
    initialMcpServers: [LOG_SERVER],
    initialAdminStaffIds: [ADMIN_ID],
    initialDwsCliEnabled: true,
    now: () => NOW,
  });
  await center.init();

  const provider = new AdminChatOpsToolProvider({
    configCenter: center,
    mcp,
    traces,
    groups: new FakeGroupDirectory(),
    now: () => NOW,
  });
  const registry = await ToolRegistry.create({
    adminProvider: provider,
    enableBuiltin: false,
    enableDws: false,
    enableSandbox: false,
    workspace: { hostDir: workspaceRoot, sandboxDir: '/workspace' },
  });

  return { center, audit, mcp, traces, provider, registry };
}

let workspaceRoot: string;
let h: Harness;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'admin-chatops-'));
  h = await createHarness(workspaceRoot);
});

afterAll(async () => {
  await h.registry.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('AdminChatOpsToolProvider 权限隔离', () => {
  it('群聊与非管理员单聊下 admin_* 工具物理不可见', async () => {
    expect(await h.provider.getTools(ctx('2', ADMIN_ID))).toEqual([]);
    expect(await h.provider.getTools(ctx('1', 'employee-9'))).toEqual([]);
    expect(await h.registry.assembleTools(ctx('2', ADMIN_ID))).toEqual([]);
    expect(await h.registry.assembleTools(ctx('1', 'employee-9'))).toEqual([]);
  });

  it('管理员单聊挂载全部 admin_* 管控工具', async () => {
    const adminCtx = ctx('1', ADMIN_ID);
    const tools = await h.provider.getTools(adminCtx);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...ADMIN_TOOL_NAMES].sort(),
    );
    const assembled = await h.registry.assembleTools(adminCtx);
    expect(assembled.map((tool) => tool.name).sort()).toEqual(
      [...ADMIN_TOOL_NAMES].sort(),
    );
  });

  it('工具对象在群聊上下文中执行会被二次校验拦截', async () => {
    const tools = await h.provider.getTools(ctx('1', ADMIN_ID));
    const statusTool = tools.find(
      (tool) => tool.name === 'admin_inspect_system_status',
    );
    expect(statusTool).toBeDefined();
    await expect(statusTool!.execute({}, ctx('2', ADMIN_ID))).rejects.toThrow(
      /权限不足/,
    );
  });
});

describe('AdminChatOps 热改配置', () => {
  it('admin_update_llm_or_persona 修改模型并广播热更新事件', async () => {
    const events: string[] = [];
    h.center.on('changed', (event) => events.push(event.scope));
    const tools = await h.provider.getTools(ctx('1', ADMIN_ID));
    const tool = tools.find(
      (item) => item.name === 'admin_update_llm_or_persona',
    )!;

    const output = JSON.parse(
      await tool.execute(
        {
          model: 'DeepSeek-R1',
          temperature: 0.9,
          enableNativeReasoning: false,
          loop: { maxTotalTokens: 30_000 },
        },
        ctx('1', ADMIN_ID),
      ),
    );

    expect(h.center.getLLMConfig().model).toBe('DeepSeek-R1');
    expect(h.center.getLLMConfig().temperature).toBe(0.9);
    expect(h.center.getSystemConfig().llm.enableNativeReasoning).toBe(false);
    expect(h.center.getLoopPolicy().maxTotalTokens).toBe(30_000);
    expect(output.hotReloaded).toBe(true);
    expect(events).toEqual(['llm', 'loopPolicy']);
    expect(h.audit.entries[0]?.actionType).toBe('UPDATE_LLM');
  });

  it('admin_manage_mcp_server 支持重连与启停并回传工具清单', async () => {
    const tools = await h.provider.getTools(ctx('1', ADMIN_ID));
    const tool = tools.find((item) => item.name === 'admin_manage_mcp_server')!;

    const reloaded = JSON.parse(
      await tool.execute({ serverId: 'logs', action: 'reload' }, ctx('1', ADMIN_ID)),
    );
    expect(h.mcp.reloaded).toEqual(['logs']);
    expect(reloaded.tools[0].namespacedName).toBe('mcp__logs__search_logs');

    const disabled = JSON.parse(
      await tool.execute(
        { serverId: 'logs', action: 'disable' },
        ctx('1', ADMIN_ID),
      ),
    );
    expect(h.center.getMcpServers()[0]?.enabled).toBe(false);
    expect(h.mcp.applied).toHaveLength(1);
    expect(disabled.toolCount).toBe(0);
    expect(h.audit.entries[0]?.actionType).toBe('RELOAD_MCP');

    await expect(
      tool.execute({ serverId: 'missing', action: 'reload' }, ctx('1', ADMIN_ID)),
    ).rejects.toThrow(/未知 MCP Server/);
  });

  it('admin_configure_group_bystander 调整冷却时间并可一键静音', async () => {
    const tools = await h.provider.getTools(ctx('1', ADMIN_ID));
    const tool = tools.find(
      (item) => item.name === 'admin_configure_group_bystander',
    )!;

    const listed = JSON.parse(
      await tool.execute({ action: 'list' }, ctx('1', ADMIN_ID)),
    );
    expect(listed.groups).toHaveLength(1);
    expect(listed.groups[0].effectivePolicy.cooldownSeconds).toBe(180);

    const updated = JSON.parse(
      await tool.execute(
        { action: 'update', conversationId: 'cid-dev', cooldownSeconds: 600 },
        ctx('1', ADMIN_ID),
      ),
    );
    expect(updated.policy.cooldownSeconds).toBe(600);
    expect((await h.center.getGroupPolicy('cid-dev')).cooldownSeconds).toBe(600);

    const muted = JSON.parse(
      await tool.execute(
        { action: 'emergency_mute', conversationId: 'cid-dev' },
        ctx('1', ADMIN_ID),
      ),
    );
    expect(muted.mutedGroups).toEqual(['cid-dev']);
    expect((await h.center.getGroupPolicy('cid-dev')).bystanderEnabled).toBe(
      false,
    );
    expect(h.audit.entries[0]?.actionType).toBe('EMERGENCY_MUTE');
  });

  it('admin_query_traces 返回今天调用最慢的查询', async () => {
    const tools = await h.provider.getTools(ctx('1', ADMIN_ID));
    const tool = tools.find((item) => item.name === 'admin_query_traces')!;

    const result = JSON.parse(
      await tool.execute({ metric: 'slowest', limit: 1 }, ctx('1', ADMIN_ID)),
    );
    expect(result.totalToday).toBe(2);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0].id).toBe('trace-slow');
    expect(result.traces[0].durationMs).toBe(15_000);
    expect(h.audit.entries[0]?.actionType).toBe('QUERY_STATS');
  });
});
