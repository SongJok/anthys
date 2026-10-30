import { describe, expect, it } from 'vitest';
import { DynamicConfigCenter, maskSecret } from './DynamicConfigCenter.js';
import type { IConfigProvider } from './IConfigProvider.js';
import type {
  AdminAuditInput,
  AdminAuditLog,
  ConfigSections,
  ConfigSectionKey,
  ConfigSectionMap,
  ConfigStore,
  GroupPolicyStore,
} from '../db/configSchema.js';
import type { GroupBystanderPolicy } from '../types/bystander-and-memory.js';

class MemoryConfigStore implements ConfigStore {
  public readonly writes: Array<{ key: ConfigSectionKey; value: unknown }> = [];
  constructor(public sections: ConfigSections = {}) {}
  async loadAll(): Promise<ConfigSections> {
    return structuredClone(this.sections);
  }
  async save<K extends ConfigSectionKey>(
    key: K,
    value: ConfigSectionMap[K],
  ): Promise<void> {
    this.writes.push({ key, value });
    this.sections[key] = structuredClone(value);
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
      createdAt: new Date('2026-10-30T08:00:00Z').toISOString(),
    };
    this.entries.unshift(entry);
    return entry;
  }
  async list(limit: number): Promise<AdminAuditLog[]> {
    return this.entries.slice(0, limit);
  }
}

function fakeDefaults(overrides: Record<string, string> = {}): IConfigProvider {
  const env = {
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: 'https://api.deepseek.com/v1',
    LLM_API_KEY: 'sk-env-secret-key',
    LLM_MODEL: 'deepseek-reasoner',
    LLM_ENABLE_NATIVE_REASONING: 'true',
    LLM_TEMPERATURE: '0.3',
    PERSONA_NAME: '小钉',
    PERSONA_ROLE_PROMPT: '企业助手',
    PERSONA_SPEAKING_STYLE: '专业友好',
    DINGTALK_CLIENT_ID: 'ding-app-key',
    DINGTALK_CLIENT_SECRET: 'ding-app-secret',
    DINGTALK_ROBOT_CODE: 'robot-code',
    DINGTALK_CARD_TEMPLATE_ID: 'card-template',
    BYSTANDER_ENABLED: 'true',
    BYSTANDER_PROACTIVE_REPLY: 'true',
    BYSTANDER_SLIDING_WINDOW_SIZE: '20',
    BYSTANDER_COOLDOWN_SECONDS: '180',
    BYSTANDER_CONFIDENCE_THRESHOLD: '0.82',
    BYSTANDER_TRIGGER_TOPICS: '线上故障,SQL查询',
    ...overrides,
  };
  return {
    getLLMConfig: () => ({
      provider: env.LLM_PROVIDER as 'openai-compatible',
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      enableNativeReasoning: env.LLM_ENABLE_NATIVE_REASONING === 'true',
      temperature: Number(env.LLM_TEMPERATURE),
      persona: {
        name: env.PERSONA_NAME,
        rolePrompt: env.PERSONA_ROLE_PROMPT,
        speakingStyle: env.PERSONA_SPEAKING_STYLE,
      },
    }),
    getLoopPolicy: () => ({
      maxWallTimeMs: 120_000,
      maxTotalTokens: 64_000,
      maxConsecutiveSameTool: 2,
      convergenceCheck: true,
    }),
    getDingTalkConfig: () => ({
      clientId: env.DINGTALK_CLIENT_ID,
      clientSecret: env.DINGTALK_CLIENT_SECRET,
      robotCode: env.DINGTALK_ROBOT_CODE,
      cardTemplateId: env.DINGTALK_CARD_TEMPLATE_ID,
    }),
    getMemoryConfig: () => ({
      windowMessages: 20,
      compressionThresholdTokens: 12_000,
      compressionRatio: 0.6,
      semanticLimit: 6,
    }),
    getBystanderConfig: () => ({
      bystanderEnabled: env.BYSTANDER_ENABLED === 'true',
      proactiveReplyEnabled: env.BYSTANDER_PROACTIVE_REPLY === 'true',
      slidingWindowSize: Number(env.BYSTANDER_SLIDING_WINDOW_SIZE),
      cooldownSeconds: Number(env.BYSTANDER_COOLDOWN_SECONDS),
      confidenceThreshold: Number(env.BYSTANDER_CONFIDENCE_THRESHOLD),
      triggerTopics: env.BYSTANDER_TRIGGER_TOPICS.split(','),
      debounceMs: 8_000,
    }),
    getDatabaseUrl: () => 'postgres://localhost:5432/test',
    assertReady: () => undefined,
  };
}

function createCenter(options: {
  store?: MemoryConfigStore;
  groups?: MemoryGroupPolicyStore;
  audit?: MemoryAuditStore;
} = {}): {
  center: DynamicConfigCenter;
  store: MemoryConfigStore;
  groups: MemoryGroupPolicyStore;
  audit: MemoryAuditStore;
} {
  const store = options.store ?? new MemoryConfigStore();
  const groups = options.groups ?? new MemoryGroupPolicyStore();
  const audit = options.audit ?? new MemoryAuditStore();
  const center = new DynamicConfigCenter({
    defaults: fakeDefaults(),
    store,
    groupPolicies: groups,
    auditStore: audit,
    initialAdminStaffIds: ['admin-001'],
    initialDwsCliEnabled: true,
    now: () => 1_000,
  });
  return { center, store, groups, audit };
}

describe('DynamicConfigCenter', () => {
  it('loads persisted sections over env defaults and masks secrets', async () => {
    const store = new MemoryConfigStore({
      llm: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-db-secret-key-123456',
        model: 'deepseek-chat',
        enableNativeReasoning: false,
        temperature: 0.7,
        persona: {
          name: '小钉',
          rolePrompt: '数据库人设',
          speakingStyle: '简洁',
        },
      },
      dingtalk: {
        clientId: 'db-client-id',
        clientSecret: 'db-client-secret-123456',
        robotCode: 'db-robot',
        aiCardTemplateId: 'db-card',
        adminStaffIds: ['admin-001', ' admin-002 ', 'admin-001'],
        dwsCliEnabled: false,
      },
    });
    const { center } = createCenter({ store });
    await center.init();

    const config = center.getSystemConfig();
    expect(config.llm.model).toBe('deepseek-chat');
    expect(config.llm.apiKey).toBe(maskSecret('sk-db-secret-key-123456'));
    expect(config.dingtalk.clientSecretMasked).toBe(
      maskSecret('db-client-secret-123456'),
    );
    expect(config.dingtalk.adminStaffIds).toEqual(['admin-001', 'admin-002']);
    expect(config.dingtalk.dwsCliEnabled).toBe(false);
    expect(center.getDingTalkConfig().clientSecret).toBe(
      'db-client-secret-123456',
    );
    expect(center.isAdmin('admin-002')).toBe(true);
    expect(center.isAdmin('employee-9')).toBe(false);
    expect(center.isAdmin('  ')).toBe(false);
  });

  it('persists LLM changes and broadcasts hot-reload events', async () => {
    const { center, store } = createCenter();
    const events: string[] = [];
    center.on('changed', (event) => events.push(event.scope));
    center.on('llm:changed', (event) => events.push(`llm:${event.at}`));
    await center.init();

    await center.updateLLM(
      { model: 'DeepSeek-R1', temperature: 1.4 },
      'admin-001',
    );

    expect(center.getLLMConfig().model).toBe('DeepSeek-R1');
    expect(center.getLLMConfig().temperature).toBe(1.4);
    expect(store.writes).toEqual([
      {
        key: 'llm',
        value: expect.objectContaining({ model: 'DeepSeek-R1' }),
      },
    ]);
    expect(events).toEqual(['llm', 'llm:1000']);
    expect(center.getSystemConfig().llm.apiKey).toBe(
      maskSecret('sk-env-secret-key'),
    );
  });

  it('refresh 拉取其他实例的配置并只发出变更分区', async () => {
    const { center, store } = createCenter();
    await center.init();
    const scopes: string[] = [];
    center.on('changed', (event) => scopes.push(event.scope));

    await center.refresh();
    expect(scopes).toEqual([]);

    store.sections.llm = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-other-instance',
      model: 'other-instance-model',
      enableNativeReasoning: false,
      temperature: 0.5,
      persona: { name: '小钉', rolePrompt: '其他实例', speakingStyle: '简洁' },
    };
    await center.refresh();

    expect(center.getLLMConfig().model).toBe('other-instance-model');
    expect(scopes).toEqual(['llm']);
  });

  it('updates loop policy, persona and MCP servers with validation', async () => {
    const { center, store } = createCenter();
    await center.init();
    const scopes: string[] = [];
    center.on('changed', (event) => scopes.push(event.scope));

    await center.updateLoopPolicy({ maxTotalTokens: 900, maxWallTimeMs: 1 });
    expect(center.getLoopPolicy().maxTotalTokens).toBe(1_000);
    expect(center.getLoopPolicy().maxWallTimeMs).toBe(1_000);

    await center.updateLLM({
      persona: { rolePrompt: '新的企业助手人设', speakingStyle: '幽默' },
    });
    expect(center.getLLMConfig().persona.rolePrompt).toBe('新的企业助手人设');
    expect(center.getLLMConfig().persona.name).toBe('小钉');

    await center.updateMcpServers([
      {
        id: 'logs',
        name: '日志 MCP',
        domain: 'log',
        transport: 'streamable-http',
        endpointOrCommand: 'https://logs.example.com/mcp',
        timeoutMs: 5_000,
        maxResultChars: 8_000,
        enabled: true,
      },
    ]);
    expect(center.getMcpServers().map((server) => server.id)).toEqual(['logs']);
    expect(store.writes.map((entry) => entry.key)).toEqual([
      'loopPolicy',
      'llm',
      'mcpServers',
    ]);
    expect(scopes).toEqual(['loopPolicy', 'llm', 'mcpServers']);

    await expect(
      center.updateMcpServers([
        {
          id: 'logs',
          name: '日志 MCP',
          domain: 'log',
          transport: 'streamable-http',
          endpointOrCommand: '',
          timeoutMs: 5_000,
          maxResultChars: 8_000,
          enabled: true,
        },
      ]),
    ).rejects.toThrow(/endpointOrCommand/);
  });

  it('merges group policy overrides and broadcasts per-group changes', async () => {
    const { center, groups } = createCenter();
    await center.init();
    const changes: Array<{ scope: string; conversationId?: string }> = [];
    center.on('changed', (event) =>
      changes.push({
        scope: event.scope,
        conversationId: event.conversationId,
      }),
    );

    const initial = await center.getGroupPolicy('cid-dev');
    expect(initial.bystanderEnabled).toBe(true);
    expect(initial.cooldownSeconds).toBe(180);

    const updated = await center.updateGroupPolicy(
      'cid-dev',
      { cooldownSeconds: 600, proactiveReplyEnabled: false },
      'admin-001',
    );
    expect(updated.cooldownSeconds).toBe(600);
    expect(updated.proactiveReplyEnabled).toBe(false);
    expect(await groups.getPolicy('cid-dev')).toEqual(updated);
    expect(changes).toEqual([
      { scope: 'groupPolicy', conversationId: 'cid-dev' },
    ]);

    const muted = await center.emergencyMute(undefined, 'admin-001');
    expect(muted).toEqual(['cid-dev']);
    expect((await center.getGroupPolicy('cid-dev')).bystanderEnabled).toBe(
      false,
    );
    expect(
      center.getSystemConfig().defaultBystanderPolicy.bystanderEnabled,
    ).toBe(false);
  });

  it('records admin audit entries', async () => {
    const { center, audit } = createCenter();
    await center.init();
    const entry = await center.recordAudit({
      adminStaffId: 'admin-001',
      adminNick: '管理员',
      actionType: 'UPDATE_LLM',
      beforeSnapshot: { model: 'deepseek-reasoner' },
      afterSnapshot: { model: 'DeepSeek-R1' },
    });
    expect(entry?.actionType).toBe('UPDATE_LLM');
    expect(await center.listAuditLogs(10)).toHaveLength(1);
    expect(audit.entries[0]?.afterSnapshot).toEqual({
      model: 'DeepSeek-R1',
    });
  });
});
