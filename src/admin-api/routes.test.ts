import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import { DynamicConfigCenter as Center } from '../config/DynamicConfigCenter.js';
import type { IConfigProvider } from '../config/IConfigProvider.js';
import type {
  AdminAuditInput,
  AdminAuditLog,
  ConfigSections,
  ConfigStore,
  GroupPolicyStore,
} from '../db/configSchema.js';
import type {
  GroupDirectory,
  KnownGroup,
  McpServerStatusView,
  McpServerTestResult,
  ReActTracePage,
  ReActTraceQuery,
  ReActTraceRecord,
  ReActTraceStore,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  TraceDailyStats,
} from '../types/admin-and-console.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import type { GroupBystanderPolicy } from '../types/bystander-and-memory.js';
import {
  GlossaryConflictError,
  GlossaryNotFoundError,
  type GlossaryAdminPort,
  type GlossaryListFilter,
  type GlossaryListResult,
  type GlossaryPromptPreview,
  type GlossaryStats,
  type GlossaryTerm,
  type GlossaryTermInput,
  type GlossaryTermPatch,
  type GlossaryValidationReport,
} from '../types/glossary.js';
import { createAdminApp } from './server.js';
import { MCP_SECRET_MASK } from './routes/mcpRoutes.js';
import { MetricsRegistry } from './metrics.js';

const TOKEN = 'test-token';
const NOW = new Date('2026-10-30T10:00:00Z').getTime();

class MemoryConfigStore implements ConfigStore {
  constructor(public sections: ConfigSections = {}) {}
  async loadAll(): Promise<ConfigSections> {
    return structuredClone(this.sections);
  }
  async save<K extends keyof ConfigSections>(
    key: K,
    value: NonNullable<ConfigSections[K]>,
  ): Promise<void> {
    this.sections[key] = structuredClone(value) as ConfigSections[K];
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

class FakeGlossary implements GlossaryAdminPort {
  public readonly terms: GlossaryTerm[] = [];

  async list(filter: GlossaryListFilter): Promise<GlossaryListResult> {
    const query = filter.query?.trim().toLowerCase() ?? '';
    const filtered = this.terms.filter((term) => {
      if (filter.timeliness && term.timeliness !== filter.timeliness) return false;
      if (filter.sensitivity && term.sensitivity !== filter.sensitivity) return false;
      if (filter.onlyInjected && !term.injectToPrompt) return false;
      if (!query) return true;
      return [term.standardName, ...term.aliases, term.definition].some((field) =>
        field.toLowerCase().includes(query),
      );
    });
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    return { total: filtered.length, terms: filtered.slice(offset, offset + limit) };
  }

  async get(id: string): Promise<GlossaryTerm | null> {
    return this.terms.find((term) => term.id === id) ?? null;
  }

  async create(input: GlossaryTermInput, updatedBy: string): Promise<GlossaryTerm> {
    if (this.terms.some((term) => term.standardName === input.standardName)) {
      throw new GlossaryConflictError('标准名称已存在');
    }
    const term: GlossaryTerm = {
      id: `glossary-${this.terms.length + 1}`,
      standardName: input.standardName,
      aliases: input.aliases ?? [],
      definition: input.definition,
      usageScenarios: input.usageScenarios ?? '',
      examples: input.examples ?? [],
      misconceptions: input.misconceptions ?? '',
      department: input.department ?? '',
      timeliness: input.timeliness ?? 'long_term',
      sensitivity: input.sensitivity ?? 'team',
      docLinks: input.docLinks ?? [],
      injectToPrompt: input.injectToPrompt ?? true,
      promptPriority: input.promptPriority ?? 0,
      hitCount: 0,
      lastUpdatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy,
    };
    this.terms.push(term);
    return term;
  }

  async update(
    id: string,
    patch: GlossaryTermPatch,
    updatedBy: string,
  ): Promise<GlossaryTerm> {
    const index = this.terms.findIndex((term) => term.id === id);
    if (index < 0) throw new GlossaryNotFoundError('未找到术语');
    const next: GlossaryTerm = {
      ...this.terms[index]!,
      ...patch,
      aliases: patch.aliases ?? this.terms[index]!.aliases,
      examples: patch.examples ?? this.terms[index]!.examples,
      docLinks: patch.docLinks ?? this.terms[index]!.docLinks,
      updatedBy,
      updatedAt: NOW,
      lastUpdatedAt: NOW,
    };
    this.terms[index] = next;
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.terms.findIndex((term) => term.id === id);
    if (index < 0) return false;
    this.terms.splice(index, 1);
    return true;
  }

  async validate(): Promise<GlossaryValidationReport> {
    return {
      checked: this.terms.length,
      errors: 0,
      warnings: 0,
      infos: 0,
      issues: [],
    };
  }

  async stats(): Promise<GlossaryStats> {
    return {
      total: this.terms.length,
      injected: this.terms.filter((term) => term.injectToPrompt).length,
      retired: this.terms.filter((term) => term.timeliness === 'retired').length,
      sensitive: this.terms.filter((term) => term.sensitivity === 'sensitive')
        .length,
      missingDefinition: this.terms.filter((term) => !term.definition.trim())
        .length,
      byTimeliness: { long_term: 0, project: 0, retired: 0 },
      bySensitivity: { public: 0, team: 0, sensitive: 0 },
    };
  }

  async previewPrompt(limit?: number): Promise<GlossaryPromptPreview> {
    const terms = this.terms.slice(0, limit ?? 80);
    return { terms, prompt: `## 企业术语知识库（${terms.length}）` };
  }
}

class FakeTraces implements ReActTraceStore {
  public readonly records: ReActTraceRecord[] = [];

  async append(record: ReActTraceRecord): Promise<void> {
    this.records.push(record);
  }

  async query(input: ReActTraceQuery): Promise<ReActTracePage> {
    const filtered = this.records.filter(
      (record) =>
        (!input.conversationId ||
          record.conversationId === input.conversationId) &&
        (input.sinceMs === undefined ||
          Date.parse(record.createdAt) >= input.sinceMs),
    );
    const start = (input.page - 1) * input.pageSize;
    return {
      items: filtered.slice(start, start + input.pageSize),
      total: filtered.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async dailyStats(): Promise<TraceDailyStats> {
    return {
      totalTokens: 5_000,
      totalTurns: 3,
      byGroup: [
        {
          conversationId: 'cid-dev',
          turns: 3,
          proactiveReplies: 2,
          totalTokens: 5_000,
        },
      ],
    };
  }
}

class FakeGroups implements GroupDirectory {
  async listGroups(): Promise<KnownGroup[]> {
    return [
      {
        conversationId: 'cid-dev',
        title: '研发大群',
        conversationType: '2',
        bystanderEnabled: true,
        proactiveReplyEnabled: true,
        lastActiveAt: NOW,
      },
      {
        conversationId: 'cid-quiet',
        title: '安静群',
        conversationType: '2',
        bystanderEnabled: true,
        proactiveReplyEnabled: true,
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
      apiKey: 'sk-env-secret-key',
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
      clientSecret: 'ding-app-secret-123456',
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
    getWebSearchConfig: () => ({
      enabled: true,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-env-secret-key',
      engine: 'search_pro',
      count: 5,
      contentSize: 'medium',
      timeoutMs: 12_000,
      redactOutbound: true,
      cacheTtlSeconds: 300,
      maxCallsPerHour: 30,
      dailyLimit: 500,
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

interface TestContext {
  app: Hono;
  center: DynamicConfigCenter;
  traces: FakeTraces;
  glossary: FakeGlossary;
  applied: EnterpriseMcpServerConfig[][];
  tested: string[];
  metrics: MetricsRegistry;
  ranTasks: string[];
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'x-admin-staff-id': 'admin-001',
  };
}

// Node 类型下 Response.json() 为 unknown，测试中统一收窄为宽松结构
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(response: Response): Promise<any> {
  return await response.json();
}

async function createTestContext(staticDir?: string): Promise<TestContext> {
  const traces = new FakeTraces();
  const glossary = new FakeGlossary();
  traces.records.push(
    {
      id: 'trace-1',
      conversationId: 'cid-dev',
      messageId: 'm-1',
      senderStaffId: 'u-1',
      senderNick: '张三',
      conversationType: '2',
      proactive: true,
      question: '统计错误日志',
      reasoning: '调用日志 MCP',
      steps: [
        {
          index: 0,
          type: 'tool',
          toolName: 'mcp__logs__search_logs',
          arguments: { keyword: 'error' },
          durationMs: 1_200,
        },
      ],
      answer: '共 3 条',
      totalTokens: 2_100,
      stepCount: 2,
      durationMs: 4_000,
      createdAt: new Date(NOW - 60_000).toISOString(),
    },
    {
      id: 'trace-2',
      conversationId: 'cid-ops',
      messageId: 'm-2',
      senderStaffId: 'u-2',
      senderNick: '李四',
      conversationType: '2',
      proactive: false,
      question: '今天天气',
      reasoning: '',
      steps: [],
      answer: '晴',
      totalTokens: 800,
      stepCount: 1,
      durationMs: 900,
      createdAt: new Date(NOW - 120_000).toISOString(),
    },
  );

  const center = new Center({
    defaults: fakeDefaults(),
    store: new MemoryConfigStore(),
    groupPolicies: new MemoryGroupPolicyStore(),
    auditStore: new MemoryAuditStore(),
    initialMcpServers: [LOG_SERVER],
    initialAdminStaffIds: ['admin-001'],
    initialDwsCliEnabled: true,
    initialWebSearchEnabled: true,
    now: () => NOW,
  });
  await center.init();

  const applied: EnterpriseMcpServerConfig[][] = [];
  const tested: string[] = [];
  const metrics = new MetricsRegistry();
  metrics.set('agent_active_runs', 0);
  const tasks: ScheduledTask[] = [];
  const ranTasks: string[] = [];
  const scheduledTasks = {
    list: async () => tasks,
    create: async (input: ScheduledTaskInput): Promise<ScheduledTask> => {
      const task: ScheduledTask = {
        id: `task-${tasks.length + 1}`,
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        title: input.title ?? '',
        prompt: input.prompt,
        intervalSeconds: input.intervalSeconds ?? null,
        cron: input.cron ?? null,
        enabled: input.enabled ?? true,
        lastRunAt: null,
        nextRunAt: new Date(NOW).toISOString(),
        createdBy: input.createdBy ?? '',
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      };
      tasks.push(task);
      return task;
    },
    update: async (
      id: string,
      input: ScheduledTaskUpdate,
    ): Promise<ScheduledTask> => {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw new Error('not found');
      Object.assign(task, input, { updatedAt: new Date(NOW).toISOString() });
      return task;
    },
    remove: async (id: string): Promise<boolean> => {
      const index = tasks.findIndex((item) => item.id === id);
      if (index < 0) return false;
      tasks.splice(index, 1);
      return true;
    },
    runNow: async (id: string): Promise<void> => {
      ranTasks.push(id);
    },
  };
  const status = (): McpServerStatusView[] =>
    center.getMcpServers().map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      connected: server.enabled,
      toolCount: server.enabled ? 1 : 0,
      lastError: null,
    }));

  const app = createAdminApp({
    configCenter: center,
    traces,
    groups: new FakeGroups(),
    listeningGroups: () => ['cid-dev'],
    glossary,
    mcp: {
      status,
      applyServers: async (servers) => {
        applied.push(structuredClone(servers));
      },
      testServer: async (serverId): Promise<McpServerTestResult> => {
        tested.push(serverId);
        return {
          serverId,
          ok: true,
          latencyMs: 42,
          tools: [
            {
              name: 'search_logs',
              description: '检索日志',
              inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } },
            },
          ],
        };
      },
    },
    llmTester: async ({ question, systemPrompt }) => ({
      answer: `收到：${question}`,
      reasoning: systemPrompt ? '已应用临时人设' : '默认人设',
      usage: { totalTokens: 120, durationMs: 300 },
    }),
    dingtalkTester: {
      streamStatus: () => ({ connected: true, detail: 'STREAM_READY' }),
      sendTestCard: async () => ({ ok: true }),
    },
    authToken: TOKEN,
    chatStream: async ({ question }, emit) => {
      emit({ type: 'turn_start', turnId: 'console-1', step: 1 });
      emit({
        type: 'answer_delta',
        turnId: 'console-1',
        content: `收到：${question}`,
        final: true,
      });
      emit({
        type: 'completed',
        usage: { totalTokens: 10, steps: 1, durationMs: 5 },
      });
    },
    metrics,
    readiness: async () => ({ ready: true }),
    feedback: { list: async () => [] },
    scheduledTasks,
    usage: {
      summary: async (days = 1) => ({
        sinceMs: days * 1_000,
        totalTokens: 120,
        totalTurns: 2,
        byUser: [
          { key: 'u-1', label: '张三', tokens: 120, turns: 2 },
        ],
        byConversation: [
          { key: 'cid-dev', label: 'cid-dev', tokens: 120, turns: 2 },
        ],
      }),
    },
    ...(staticDir ? { staticDir } : {}),
    now: () => NOW,
  });

  return { app, center, traces, glossary, applied, tested, metrics, ranTasks };
}

let ctx: TestContext;
let staticDir: string;

beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'admin-console-'));
  await writeFile(
    join(staticDir, 'index.html'),
    '<!doctype html><html><body>web-console</body></html>',
    'utf8',
  );
  ctx = await createTestContext(staticDir);
});

afterAll(async () => {
  await rm(staticDir, { recursive: true, force: true });
});

describe('管理后台鉴权', () => {
  it('未携带 Bearer Token 时返回 401，健康检查开放', async () => {
    const unauth = await ctx.app.request('/api/v1/admin/config/llm');
    expect(unauth.status).toBe(401);
    expect((await body(unauth)).ok).toBe(false);

    const health = await ctx.app.request('/health');
    expect(health.status).toBe(200);
    expect((await body(health)).ok).toBe(true);
  });

  it('静态资源托管 web-console 构建产物并回退到 index.html', async () => {
    const root = await ctx.app.request('/', { headers: headers() });
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('web-console');

    const fallback = await ctx.app.request('/mcp', { headers: headers() });
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('web-console');

    const api404 = await ctx.app.request('/api/v1/admin/unknown', {
      headers: headers(),
    });
    expect(api404.status).toBe(404);
  });
});

describe('钉钉与 LLM 配置接口', () => {
  it('GET 返回脱敏配置与 Stream 状态，PUT 热更新生效', async () => {
    const get = await ctx.app.request('/api/v1/admin/config/dingtalk', {
      headers: headers(),
    });
    const getBody = await body(get);
    expect(getBody.config.clientSecretMasked).toBe('ding****3456');
    expect(getBody.stream.connected).toBe(true);

    const put = await ctx.app.request('/api/v1/admin/config/dingtalk', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        robotCode: 'robot-code-v2',
        adminStaffIds: ['admin-001', 'admin-002'],
        dwsCliEnabled: false,
        webSearchEnabled: false,
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await body(put);
    expect(putBody.config.robotCode).toBe('robot-code-v2');
    expect(putBody.config.adminStaffIds).toEqual(['admin-001', 'admin-002']);
    expect(ctx.center.getSystemConfig().dingtalk.dwsCliEnabled).toBe(false);
    expect(ctx.center.getSystemConfig().dingtalk.webSearchEnabled).toBe(false);
    expect(ctx.center.getWebSearchConfig()?.enabled).toBe(false);
    expect(ctx.center.getDingTalkConfig().clientSecret).toBe(
      'ding-app-secret-123456',
    );
    const audit = await ctx.center.listAuditLogs(20);
    const entry = audit.find((item) => item.actionType === 'UPDATE_DINGTALK');
    expect(entry?.afterSnapshot.robotCode).toBe('robot-code-v2');
    expect(JSON.stringify(entry)).not.toContain('ding-app-secret-123456');
  });

  it('回传掩码时保持 AppSecret 与模型 API Key 不变', async () => {
    const dingtalk = await ctx.app.request('/api/v1/admin/config/dingtalk', {
      headers: headers(),
    });
    const clientSecretMasked = (await body(dingtalk)).config.clientSecretMasked;
    const maskedPut = await ctx.app.request('/api/v1/admin/config/dingtalk', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ clientSecret: clientSecretMasked }),
    });
    expect(maskedPut.status).toBe(200);
    expect(ctx.center.getDingTalkConfig().clientSecret).toBe(
      'ding-app-secret-123456',
    );

    const llm = await ctx.app.request('/api/v1/admin/config/llm', {
      headers: headers(),
    });
    const apiKeyMasked = (await body(llm)).llm.apiKey;
    expect(apiKeyMasked).not.toBe('sk-env-secret-key');
    const maskedLlmPut = await ctx.app.request('/api/v1/admin/config/llm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ apiKey: apiKeyMasked }),
    });
    expect(maskedLlmPut.status).toBe(200);
    expect(ctx.center.getLLMConfig().apiKey).toBe('sk-env-secret-key');
  });

  it('PUT 更新 LLM 与循环预算，POST 发起沙盒对话测试', async () => {
    const put = await ctx.app.request('/api/v1/admin/config/llm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        model: 'DeepSeek-R1',
        temperature: 1.1,
        enableNativeReasoning: false,
        persona: { speakingStyle: '幽默' },
        loop: { maxTotalTokens: 20_000 },
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await body(put);
    expect(putBody.llm.model).toBe('DeepSeek-R1');
    expect(putBody.llm.persona.speakingStyle).toBe('幽默');
    expect(putBody.loopPolicy.maxTotalTokens).toBe(20_000);
    expect(ctx.center.getLLMConfig().enableNativeReasoning).toBe(false);

    const test = await ctx.app.request('/api/v1/admin/config/llm/test', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ question: '介绍一下你自己' }),
    });
    expect(test.status).toBe(200);
    const testBody = await body(test);
    expect(testBody.result.answer).toBe('收到：介绍一下你自己');

    const invalid = await ctx.app.request('/api/v1/admin/config/llm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ provider: 'unknown-vendor' }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('企业 MCP 管理接口', () => {
  it('完成 MCP 节点增删改查、连通性测试与工具 Schema 浏览', async () => {
    const list = await ctx.app.request('/api/v1/admin/mcp-servers', {
      headers: headers(),
    });
    expect((await body(list)).servers).toHaveLength(1);

    const created = await ctx.app.request('/api/v1/admin/mcp-servers', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'apidocs',
        name: '接口文档 MCP',
        domain: 'apidoc',
        transport: 'sse',
        endpointOrCommand: 'https://apidocs.example.com/sse',
      }),
    });
    expect(created.status).toBe(200);
    expect(ctx.center.getMcpServers().map((server) => server.id)).toEqual([
      'logs',
      'apidocs',
    ]);
    expect(ctx.applied.at(-1)).toHaveLength(2);

    const duplicate = await ctx.app.request('/api/v1/admin/mcp-servers', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'apidocs',
        domain: 'apidoc',
        transport: 'sse',
        endpointOrCommand: 'https://apidocs.example.com/sse',
      }),
    });
    expect(duplicate.status).toBe(409);

    const updated = await ctx.app.request('/api/v1/admin/mcp-servers/apidocs', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ enabled: false, timeoutMs: 9_000 }),
    });
    expect(updated.status).toBe(200);
    const updatedServer = ctx.center
      .getMcpServers()
      .find((server) => server.id === 'apidocs');
    expect(updatedServer?.enabled).toBe(false);
    expect(updatedServer?.timeoutMs).toBe(9_000);
    expect(updatedServer?.endpointOrCommand).toBe(
      'https://apidocs.example.com/sse',
    );

    const tested = await ctx.app.request(
      '/api/v1/admin/mcp-servers/apidocs/test',
      { method: 'POST', headers: headers() },
    );
    expect(tested.status).toBe(200);
    const testedBody = await body(tested);
    expect(testedBody.result.ok).toBe(true);
    expect(testedBody.result.tools[0].inputSchema).toMatchObject({
      type: 'object',
    });
    expect(ctx.tested).toEqual(['apidocs']);

    const deleted = await ctx.app.request(
      '/api/v1/admin/mcp-servers/apidocs',
      { method: 'DELETE', headers: headers() },
    );
    expect(deleted.status).toBe(200);
    expect(ctx.center.getMcpServers().map((server) => server.id)).toEqual([
      'logs',
    ]);

    const missing = await ctx.app.request('/api/v1/admin/mcp-servers/none/test', {
      method: 'POST',
      headers: headers(),
    });
    expect(missing.status).toBe(404);
  });

  it('读取 MCP 节点时掩码密钥，更新时回传占位符保留原值', async () => {
    const created = await ctx.app.request('/api/v1/admin/mcp-servers', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'secret-node',
        name: '密钥节点',
        domain: 'general',
        transport: 'sse',
        endpointOrCommand: 'https://secret.example.com/sse',
        envOrHeaders: { authorization: 'Bearer super-secret' },
      }),
    });
    expect(created.status).toBe(200);
    expect((await body(created)).server.envOrHeaders.authorization).toBe(
      MCP_SECRET_MASK,
    );

    const listed = await body(
      await ctx.app.request('/api/v1/admin/mcp-servers', {
        headers: headers(),
      }),
    );
    const listedNode = listed.servers.find(
      (item: { id: string }) => item.id === 'secret-node',
    );
    expect(listedNode.envOrHeaders.authorization).toBe(MCP_SECRET_MASK);

    const maskedCreate = await ctx.app.request('/api/v1/admin/mcp-servers', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'masked-node',
        domain: 'general',
        transport: 'sse',
        endpointOrCommand: 'https://masked.example.com/sse',
        envOrHeaders: { authorization: MCP_SECRET_MASK },
      }),
    });
    expect(maskedCreate.status).toBe(400);

    const updated = await ctx.app.request(
      '/api/v1/admin/mcp-servers/secret-node',
      {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ envOrHeaders: { authorization: MCP_SECRET_MASK } }),
      },
    );
    expect(updated.status).toBe(200);
    const stored = ctx.center
      .getMcpServers()
      .find((server) => server.id === 'secret-node');
    expect(stored?.envOrHeaders?.authorization).toBe('Bearer super-secret');

    const deleted = await ctx.app.request(
      '/api/v1/admin/mcp-servers/secret-node',
      { method: 'DELETE', headers: headers() },
    );
    expect(deleted.status).toBe(200);
  });

  it('维护按群/角色的 MCP 工具访问策略', async () => {
    const put = await ctx.app.request('/api/v1/admin/mcp-access-policies', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        policies: [
          {
            id: 'dev-group',
            conversationId: 'cid-dev',
            allowedServerIds: ['logs'],
            allowedTools: [],
            enabled: true,
          },
        ],
      }),
    });
    expect(put.status).toBe(200);
    const policyBody = await body(put);
    expect(policyBody.policies[0].id).toBe('dev-group');
    expect(ctx.center.getMcpAccessPolicies()).toHaveLength(1);
    const audit = await ctx.center.listAuditLogs(20);
    expect(audit.some((item) => item.actionType === 'UPDATE_MCP_POLICY')).toBe(
      true,
    );
  });
});

describe('群策略、轨迹与审计大盘', () => {
  it('群列表返回生效策略，PUT 调整冷却时间并支持紧急静音', async () => {
    const groups = await ctx.app.request('/api/v1/admin/groups', {
      headers: headers(),
    });
    const groupsBody = await body(groups);
    expect(groupsBody.groups[0].policy.cooldownSeconds).toBe(180);
    expect(groupsBody.groups[0].listening).toBe(true);
    expect(groupsBody.groups[0].policyOverridden).toBe(false);
    // 全局默认旁听开启不代表在监听：未订阅的群必须显式标记
    expect(groupsBody.groups[1].policy.bystanderEnabled).toBe(true);
    expect(groupsBody.groups[1].listening).toBe(false);

    const put = await ctx.app.request(
      '/api/v1/admin/groups/cid-dev/policy',
      {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ cooldownSeconds: 600 }),
      },
    );
    expect(put.status).toBe(200);
    expect((await body(put)).policy.cooldownSeconds).toBe(600);

    const mute = await ctx.app.request('/api/v1/admin/groups/emergency-mute', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ conversationId: 'cid-dev' }),
    });
    expect(mute.status).toBe(200);
    expect((await body(mute)).muted).toEqual(['cid-dev']);
    expect(
      (await ctx.center.getGroupPolicy('cid-dev')).proactiveReplyEnabled,
    ).toBe(false);
  });

  it('分页查询 ReAct 轨迹并返回大盘聚合数据', async () => {
    const traces = await ctx.app.request(
      '/api/v1/admin/traces?page=1&pageSize=1',
      { headers: headers() },
    );
    const tracesBody = await body(traces);
    expect(tracesBody.total).toBe(2);
    expect(tracesBody.items).toHaveLength(1);
    expect(tracesBody.items[0].steps[0].toolName).toBe('mcp__logs__search_logs');

    const scoped = await ctx.app.request(
      '/api/v1/admin/traces?conversationId=cid-ops',
      { headers: headers() },
    );
    expect((await body(scoped)).total).toBe(1);

    const dashboard = await ctx.app.request('/api/v1/admin/dashboard', {
      headers: headers(),
    });
    const dashBody = await body(dashboard);
    expect(dashBody.today.totalTokens).toBe(5_000);
    expect(dashBody.mcpServers).toHaveLength(1);
    expect(dashBody.system.llm.apiKey).not.toContain('sk-env-secret-key');
  });
});

describe('在线对话与可观测性接口', () => {
  it('换取一次性 SSE 票据后流式返回回答，票据不可复用', async () => {
    const unauth = await ctx.app.request('/api/v1/admin/chat/tickets', {
      method: 'POST',
    });
    expect(unauth.status).toBe(401);

    const issued = await ctx.app.request('/api/v1/admin/chat/tickets', {
      method: 'POST',
      headers: headers(),
    });
    expect(issued.status).toBe(200);
    const ticketBody = await body(issued);
    expect(typeof ticketBody.ticket).toBe('string');
    expect(ticketBody.expiresAt).toBeGreaterThan(NOW);

    const stream = await ctx.app.request(
      `/api/v1/chat/stream?ticket=${ticketBody.ticket}&question=${encodeURIComponent('你好')}`,
    );
    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain('turn_start');
    expect(text).toContain('收到：你好');
    expect(text).toContain('event: done');
    expect(ctx.metrics.get('console_chat_total')).toBe(1);

    const replay = await ctx.app.request(
      `/api/v1/chat/stream?ticket=${ticketBody.ticket}&question=again`,
    );
    expect(replay.status).toBe(401);
  });

  it('缺少票据或问题参数时拒绝订阅', async () => {
    const noTicket = await ctx.app.request('/api/v1/chat/stream?question=hi');
    expect(noTicket.status).toBe(401);

    const issued = await body(
      await ctx.app.request('/api/v1/admin/chat/tickets', {
        method: 'POST',
        headers: headers(),
      }),
    );
    const noQuestion = await ctx.app.request(
      `/api/v1/chat/stream?ticket=${issued.ticket}`,
    );
    expect(noQuestion.status).toBe(400);
  });

  it('指标接口鉴权后输出 Prometheus 文本，就绪探针返回 ready', async () => {
    const denied = await ctx.app.request('/metrics');
    expect(denied.status).toBe(401);

    const metrics = await ctx.app.request('/metrics', { headers: headers() });
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain('dingtalk_agent_metrics');
    expect(text).toContain('agent_active_runs 0');

    const ready = await ctx.app.request('/readyz');
    expect(ready.status).toBe(200);
    expect((await body(ready)).ready).toBe(true);
  });

  it('定时任务支持创建、列表、更新、立即执行与删除', async () => {
    const denied = await ctx.app.request('/api/v1/admin/scheduled-tasks', {
      method: 'POST',
    });
    expect(denied.status).toBe(401);

    const invalid = await ctx.app.request('/api/v1/admin/scheduled-tasks', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ conversationId: 'cid-dev', prompt: '' }),
    });
    expect(invalid.status).toBe(400);

    const created = await ctx.app.request('/api/v1/admin/scheduled-tasks', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        conversationId: 'cid-dev',
        conversationType: '2',
        title: '每日巡检',
        prompt: '汇总昨日错误日志',
        intervalSeconds: 3600,
        createdBy: 'admin-001',
      }),
    });
    expect(created.status).toBe(200);
    const task = (await body(created)).task as ScheduledTask;
    expect(task.title).toBe('每日巡检');

    const listed = await ctx.app.request('/api/v1/admin/scheduled-tasks', {
      headers: headers(),
    });
    expect((await body(listed)).tasks).toHaveLength(1);

    const updated = await ctx.app.request(
      `/api/v1/admin/scheduled-tasks/${task.id}`,
      {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect((await body(updated)).task.enabled).toBe(false);

    const ran = await ctx.app.request(
      `/api/v1/admin/scheduled-tasks/${task.id}/run`,
      { method: 'POST', headers: headers() },
    );
    expect(ran.status).toBe(200);
    expect(ctx.ranTasks).toEqual([task.id]);

    const removed = await ctx.app.request(
      `/api/v1/admin/scheduled-tasks/${task.id}`,
      { method: 'DELETE', headers: headers() },
    );
    expect((await body(removed)).removed).toBe(true);
  });

  it('用量汇总接口返回按员工与按群聚合', async () => {
    const denied = await ctx.app.request('/api/v1/admin/usage');
    expect(denied.status).toBe(401);

    const response = await ctx.app.request('/api/v1/admin/usage?days=7', {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.summary.totalTokens).toBe(120);
    expect(payload.summary.sinceMs).toBe(7_000);
    expect(payload.summary.byUser[0].label).toBe('张三');
  });

  it('用户反馈接口在未接入存储时返回空列表', async () => {
    const response = await ctx.app.request('/api/v1/admin/feedback', {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    expect((await body(response)).items).toEqual([]);
  });
});

describe('术语知识库管理接口', () => {
  it('未带 Token 时拒绝访问术语库', async () => {
    const response = await ctx.app.request('/api/v1/admin/glossary');
    expect(response.status).toBe(401);
  });

  it('完成术语的增删改查、校验与提示词预览', async () => {
    const created = await ctx.app.request('/api/v1/admin/glossary', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        standardName: 'CQ',
        aliases: ['变更请求'],
        definition: '变更请求单，用于线上变更审批',
        usageScenarios: '上线前提交',
        examples: ['这个改动先提个 CQ'],
        misconceptions: '不是客服工单',
        department: '研发效能',
        timeliness: 'long_term',
        sensitivity: 'team',
        docLinks: ['https://docs.example.com/cq'],
        promptPriority: 90,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = await body(created);
    expect(createdBody.term.standardName).toBe('CQ');
    expect(createdBody.term.aliases).toEqual(['变更请求']);

    const listed = await ctx.app.request(
      '/api/v1/admin/glossary?query=CQ&sort=priority',
      { headers: headers() },
    );
    const listedBody = await body(listed);
    expect(listedBody.total).toBe(1);
    expect(listedBody.terms[0].id).toBe(createdBody.term.id);

    const stats = await body(
      await ctx.app.request('/api/v1/admin/glossary/stats', {
        headers: headers(),
      }),
    );
    expect(stats.stats.total).toBe(1);

    const validation = await body(
      await ctx.app.request('/api/v1/admin/glossary/validate', {
        headers: headers(),
      }),
    );
    expect(validation.report.checked).toBe(1);

    const preview = await body(
      await ctx.app.request('/api/v1/admin/glossary/prompt-preview?limit=5', {
        headers: headers(),
      }),
    );
    expect(preview.prompt).toContain('企业术语知识库');
    expect(preview.terms).toHaveLength(1);

    const updated = await ctx.app.request(
      `/api/v1/admin/glossary/${createdBody.term.id}`,
      {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ sensitivity: 'sensitive', promptPriority: 10 }),
      },
    );
    expect(updated.status).toBe(200);
    expect((await body(updated)).term.sensitivity).toBe('sensitive');

    const audit = await ctx.center.listAuditLogs(50);
    const entries = audit.filter((item) => item.actionType === 'UPDATE_GLOSSARY');
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(entries)).not.toContain('变更请求单，用于线上变更审批');
    expect(entries[0]?.afterSnapshot).toMatchObject({ action: 'update' });

    const removed = await ctx.app.request(
      `/api/v1/admin/glossary/${createdBody.term.id}`,
      { method: 'DELETE', headers: headers() },
    );
    expect(removed.status).toBe(200);
    expect((await body(removed)).removed).toBe(true);

    const missing = await ctx.app.request(
      `/api/v1/admin/glossary/${createdBody.term.id}`,
      { headers: headers() },
    );
    expect(missing.status).toBe(404);
  });

  it('重复名称返回 409，非法枚举返回 400', async () => {
    const payload = {
      standardName: 'PB 系统',
      definition: '价格配置后台',
    };
    const first = await ctx.app.request('/api/v1/admin/glossary', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);

    const duplicate = await ctx.app.request('/api/v1/admin/glossary', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    expect(duplicate.status).toBe(409);

    const invalid = await ctx.app.request('/api/v1/admin/glossary', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        standardName: '非法时效',
        definition: '测试',
        timeliness: 'forever',
      }),
    });
    expect(invalid.status).toBe(400);
  });
});
