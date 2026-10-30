import { EventEmitter } from 'node:events';
import type {
  BystanderConfig,
  DingTalkConfig,
  IConfigProvider,
  MemoryConfig,
} from './IConfigProvider.js';
import type {
  AdminAuditInput,
  AdminAuditLog,
  ConfigChangeEvent,
  ConfigScope,
  EnterpriseBotSystemConfig,
  GroupBystanderPolicy,
  McpToolAccessPolicy,
  ModelRoutingPolicy,
  UsagePolicy,
} from '../types/admin-and-console.js';
import type {
  DynamicLoopPolicy,
  LLMAndPersonaConfig,
} from '../types/core.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_SLIDING_WINDOW_SIZE,
} from '../types/bystander-and-memory.js';
import type {
  AdminAuditStore,
  ConfigSectionKey,
  ConfigSections,
  ConfigStore,
  GroupPolicyStore,
  StoredDingTalkConfig,
} from '../db/configSchema.js';

export interface DynamicConfigCenterLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DynamicConfigCenterOptions {
  defaults: IConfigProvider;
  store?: ConfigStore;
  groupPolicies?: GroupPolicyStore;
  auditStore?: AdminAuditStore;
  /** 启动时从 config/mcp-servers.json 等来源载入的初始 MCP 列表 */
  initialMcpServers?: EnterpriseMcpServerConfig[];
  initialAdminStaffIds?: string[];
  initialDwsCliEnabled?: boolean;
  logger?: DynamicConfigCenterLogger;
  now?: () => number;
}

export interface DingTalkUpdateInput {
  clientId?: string;
  clientSecret?: string;
  robotCode?: string;
  aiCardTemplateId?: string;
  adminStaffIds?: string[];
  dwsCliEnabled?: boolean;
}

export interface LLMUpdateInput
  extends Partial<Omit<LLMAndPersonaConfig, 'persona'>> {
  persona?: Partial<LLMAndPersonaConfig['persona']>;
}

export interface BystanderPolicyUpdateInput
  extends Partial<Omit<GroupBystanderPolicy, 'conversationId'>> {}

interface CenterState {
  dingtalk: StoredDingTalkConfig;
  llm: LLMAndPersonaConfig;
  loopPolicy: DynamicLoopPolicy;
  mcpServers: EnterpriseMcpServerConfig[];
  defaultBystanderPolicy: Omit<GroupBystanderPolicy, 'conversationId'>;
  mcpAccessPolicies: McpToolAccessPolicy[];
}

export type DynamicConfigCenterEvent = 'changed' | `${ConfigScope}:changed`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '******';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sanitizeStaffIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 阶段四动态配置中心：PostgreSQL 持久化 + 内存缓存 + EventEmitter 广播。
 * 所有写入先落库再更新缓存，成功后按 scope 广播，供 StreamGateway、
 * McpClientPool 与 ReActRunner 做局部热重载。
 */
export class DynamicConfigCenter
  extends EventEmitter
  implements IConfigProvider
{
  private state: CenterState;
  private readonly defaults: IConfigProvider;
  private readonly store?: ConfigStore;
  private readonly groupPolicies?: GroupPolicyStore;
  private readonly auditStore?: AdminAuditStore;
  private readonly logger?: DynamicConfigCenterLogger;
  private readonly now: () => number;
  private initialized = false;

  constructor(private readonly options: DynamicConfigCenterOptions) {
    super();
    this.defaults = options.defaults;
    this.store = options.store;
    this.groupPolicies = options.groupPolicies;
    this.auditStore = options.auditStore;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.state = this.buildDefaults();
  }

  /** 从数据库加载覆盖项；数据库不可用时回退 env 默认值但不阻塞启动 */
  public async init(): Promise<this> {
    if (this.initialized) return this;
    this.initialized = true;
    if (!this.store) return this;
    try {
      const sections = await this.store.loadAll();
      this.state = this.mergeSections(this.buildDefaults(), sections);
    } catch (error) {
      this.logger?.warn(
        { error: errorMessage(error) },
        'failed to load dynamic config, using env defaults',
      );
    }
    return this;
  }

  /** 多实例部署时可主动拉取最新配置（不做广播，避免回路） */
  public async refresh(): Promise<void> {
    if (!this.store) return;
    const sections = await this.store.loadAll();
    this.state = this.mergeSections(this.buildDefaults(), sections);
  }

  public isAdmin(staffId: string): boolean {
    const id = staffId.trim();
    return id.length > 0 && this.state.dingtalk.adminStaffIds.includes(id);
  }

  public getSystemConfig(): EnterpriseBotSystemConfig {
    return {
      dingtalk: {
        clientId: this.state.dingtalk.clientId,
        clientSecretMasked: maskSecret(this.state.dingtalk.clientSecret),
        robotCode: this.state.dingtalk.robotCode,
        aiCardTemplateId: this.state.dingtalk.aiCardTemplateId,
        adminStaffIds: [...this.state.dingtalk.adminStaffIds],
        dwsCliEnabled: this.state.dingtalk.dwsCliEnabled,
      },
      llm: {
        ...clone(this.state.llm),
        apiKey: maskSecret(this.state.llm.apiKey),
      },
      loopPolicy: clone(this.state.loopPolicy),
      mcpServers: clone(this.state.mcpServers),
      defaultBystanderPolicy: clone(this.state.defaultBystanderPolicy),
      mcpAccessPolicies: clone(this.state.mcpAccessPolicies),
    };
  }

  public getMcpServers(): EnterpriseMcpServerConfig[] {
    return clone(this.state.mcpServers);
  }

  public getMcpAccessPolicies(): McpToolAccessPolicy[] {
    return clone(this.state.mcpAccessPolicies);
  }

  public getLLMConfig(): LLMAndPersonaConfig {
    return clone(this.state.llm);
  }

  public getLoopPolicy(): DynamicLoopPolicy {
    return clone(this.state.loopPolicy);
  }

  public getDingTalkConfig(): DingTalkConfig {
    return {
      clientId: this.state.dingtalk.clientId,
      clientSecret: this.state.dingtalk.clientSecret,
      robotCode: this.state.dingtalk.robotCode,
      cardTemplateId: this.state.dingtalk.aiCardTemplateId,
    };
  }

  public getMemoryConfig(): MemoryConfig {
    return this.defaults.getMemoryConfig();
  }

  public getUsagePolicy(): UsagePolicy {
    return (
      this.defaults.getUsagePolicy?.() ?? {
        enabled: false,
        dailyTokensPerUser: 0,
        dailyTokensPerConversation: 0,
      }
    );
  }

  public getModelRouting(): ModelRoutingPolicy {
    return this.defaults.getModelRouting?.() ?? {};
  }

  public getEmbeddingConfig() {
    return this.defaults.getEmbeddingConfig?.();
  }

  public getBystanderConfig(): BystanderConfig {
    const defaults = this.defaults.getBystanderConfig();
    return {
      ...defaults,
      bystanderEnabled: this.state.defaultBystanderPolicy.bystanderEnabled,
      proactiveReplyEnabled:
        this.state.defaultBystanderPolicy.proactiveReplyEnabled,
      slidingWindowSize: this.state.defaultBystanderPolicy.slidingWindowSize,
      cooldownSeconds: this.state.defaultBystanderPolicy.cooldownSeconds,
      confidenceThreshold:
        this.state.defaultBystanderPolicy.confidenceThreshold,
      triggerTopics: [...this.state.defaultBystanderPolicy.triggerTopics],
    };
  }

  public getDatabaseUrl(): string {
    return this.defaults.getDatabaseUrl();
  }

  public assertReady(): void {
    const ding = this.getDingTalkConfig();
    const llm = this.getLLMConfig();
    const missing: string[] = [];
    if (!ding.clientId) missing.push('dingtalk.clientId');
    if (!ding.clientSecret) missing.push('dingtalk.clientSecret');
    if (!ding.robotCode) missing.push('dingtalk.robotCode');
    if (!ding.cardTemplateId) missing.push('dingtalk.aiCardTemplateId');
    if (!llm.baseUrl) missing.push('llm.baseUrl');
    if (!llm.apiKey) missing.push('llm.apiKey');
    if (missing.length > 0) {
      throw new Error(`缺少必需配置: ${missing.join(', ')}`);
    }
  }

  public async updateDingTalk(
    input: DingTalkUpdateInput,
    actorStaffId?: string,
  ): Promise<void> {
    const before = clone(this.state.dingtalk);
    const next: StoredDingTalkConfig = {
      ...before,
      ...(input.clientId !== undefined
        ? { clientId: input.clientId.trim() }
        : {}),
      ...(input.robotCode !== undefined
        ? { robotCode: input.robotCode.trim() }
        : {}),
      ...(input.aiCardTemplateId !== undefined
        ? { aiCardTemplateId: input.aiCardTemplateId.trim() }
        : {}),
      ...(input.adminStaffIds !== undefined
        ? { adminStaffIds: sanitizeStaffIds(input.adminStaffIds) }
        : {}),
      ...(input.dwsCliEnabled !== undefined
        ? { dwsCliEnabled: input.dwsCliEnabled }
        : {}),
      ...(input.clientSecret
        ? { clientSecret: input.clientSecret.trim() }
        : {}),
    };
    await this.persist('dingtalk', next);
    this.state = { ...this.state, dingtalk: next };
    this.emitChange('dingtalk', before, next, actorStaffId);
  }

  public async updateLLM(
    input: LLMUpdateInput,
    actorStaffId?: string,
  ): Promise<void> {
    const before = clone(this.state.llm);
    if (
      input.provider !== undefined &&
      input.provider !== 'openai-compatible' &&
      input.provider !== 'anthropic'
    ) {
      throw new Error(`非法的大模型 provider: ${String(input.provider)}`);
    }
    const next: LLMAndPersonaConfig = {
      ...before,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.model ? { model: input.model.trim() } : {}),
      ...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.enableNativeReasoning !== undefined
        ? { enableNativeReasoning: input.enableNativeReasoning }
        : {}),
      ...(input.temperature !== undefined
        ? { temperature: clamp(input.temperature, 0, 2) }
        : {}),
      persona: {
        ...before.persona,
        ...(input.persona?.name ? { name: input.persona.name.trim() } : {}),
        ...(input.persona?.rolePrompt
          ? { rolePrompt: input.persona.rolePrompt }
          : {}),
        ...(input.persona?.speakingStyle
          ? { speakingStyle: input.persona.speakingStyle }
          : {}),
      },
    };
    await this.persist('llm', next);
    this.state = { ...this.state, llm: next };
    this.emitChange('llm', before, next, actorStaffId);
  }

  public async updateLoopPolicy(
    input: Partial<DynamicLoopPolicy>,
    actorStaffId?: string,
  ): Promise<void> {
    const before = clone(this.state.loopPolicy);
    const next: DynamicLoopPolicy = {
      ...before,
      ...(input.maxWallTimeMs !== undefined
        ? { maxWallTimeMs: Math.max(1_000, input.maxWallTimeMs) }
        : {}),
      ...(input.maxTotalTokens !== undefined
        ? { maxTotalTokens: Math.max(1_000, input.maxTotalTokens) }
        : {}),
      ...(input.maxConsecutiveSameTool !== undefined
        ? { maxConsecutiveSameTool: Math.max(1, input.maxConsecutiveSameTool) }
        : {}),
      ...(input.convergenceCheck !== undefined
        ? { convergenceCheck: input.convergenceCheck }
        : {}),
    };
    await this.persist('loopPolicy', next);
    this.state = { ...this.state, loopPolicy: next };
    this.emitChange('loopPolicy', before, next, actorStaffId);
  }

  public async updateMcpServers(
    servers: EnterpriseMcpServerConfig[],
    actorStaffId?: string,
  ): Promise<void> {
    const before = clone(this.state.mcpServers);
    const next = this.validateServers(servers);
    await this.persist('mcpServers', next);
    this.state = { ...this.state, mcpServers: next };
    this.emitChange('mcpServers', before, next, actorStaffId);
  }

  public async upsertMcpServer(
    server: EnterpriseMcpServerConfig,
    actorStaffId?: string,
  ): Promise<EnterpriseMcpServerConfig[]> {
    const servers = clone(this.state.mcpServers);
    const index = servers.findIndex((item) => item.id === server.id);
    if (index >= 0) servers[index] = server;
    else servers.push(server);
    await this.updateMcpServers(servers, actorStaffId);
    return clone(this.state.mcpServers);
  }

  public async deleteMcpServer(
    serverId: string,
    actorStaffId?: string,
  ): Promise<EnterpriseMcpServerConfig[]> {
    const servers = this.state.mcpServers.filter(
      (item) => item.id !== serverId,
    );
    if (servers.length === this.state.mcpServers.length) {
      throw new Error(`未知 MCP Server: ${serverId}`);
    }
    await this.updateMcpServers(servers, actorStaffId);
    return clone(this.state.mcpServers);
  }

  public async updateMcpAccessPolicies(
    policies: McpToolAccessPolicy[],
    actorStaffId?: string,
  ): Promise<void> {
    const before = clone(this.state.mcpAccessPolicies);
    const next = policies.map((policy) => ({
      ...policy,
      id: policy.id.trim(),
      allowedServerIds: sanitizeStaffIds(policy.allowedServerIds),
      allowedTools: sanitizeStaffIds(policy.allowedTools),
    }));
    const ids = new Set(next.map((policy) => policy.id));
    if (ids.size !== next.length || ids.has('')) {
      throw new Error('MCP 工具访问策略 id 不能为空且不能重复');
    }
    await this.persist('mcpAccessPolicies', next);
    this.state = { ...this.state, mcpAccessPolicies: next };
    this.emitChange('mcpAccessPolicies', before, next, actorStaffId);
  }

  public async updateDefaultBystanderPolicy(
    input: BystanderPolicyUpdateInput,
    actorStaffId?: string,
  ): Promise<void> {
    const before = clone(this.state.defaultBystanderPolicy);
    const next = {
      ...before,
      ...(input.bystanderEnabled !== undefined
        ? { bystanderEnabled: input.bystanderEnabled }
        : {}),
      ...(input.proactiveReplyEnabled !== undefined
        ? { proactiveReplyEnabled: input.proactiveReplyEnabled }
        : {}),
      ...(input.slidingWindowSize !== undefined
        ? {
            slidingWindowSize: Math.max(
              1,
              Math.floor(input.slidingWindowSize),
            ),
          }
        : {}),
      ...(input.cooldownSeconds !== undefined
        ? { cooldownSeconds: Math.max(0, Math.floor(input.cooldownSeconds)) }
        : {}),
      ...(input.confidenceThreshold !== undefined
        ? { confidenceThreshold: clamp(input.confidenceThreshold, 0, 1) }
        : {}),
      ...(input.triggerTopics !== undefined
        ? {
            triggerTopics: input.triggerTopics
              .map((topic) => topic.trim())
              .filter(Boolean),
          }
        : {}),
    };
    await this.persist('defaultBystanderPolicy', next);
    this.state = { ...this.state, defaultBystanderPolicy: next };
    this.emitChange('defaultBystanderPolicy', before, next, actorStaffId);
  }

  public async getGroupPolicy(
    conversationId: string,
  ): Promise<GroupBystanderPolicy> {
    const base: GroupBystanderPolicy = {
      conversationId,
      ...clone(this.state.defaultBystanderPolicy),
    };
    if (!this.groupPolicies) return base;
    try {
      const override = await this.groupPolicies.getPolicy(conversationId);
      return override ? { ...base, ...override, conversationId } : base;
    } catch (error) {
      this.logger?.warn(
        { conversationId, error: errorMessage(error) },
        'failed to load group policy, using defaults',
      );
      return base;
    }
  }

  public async listGroupPolicies(): Promise<GroupBystanderPolicy[]> {
    if (!this.groupPolicies) return [];
    return this.groupPolicies.listPolicies();
  }

  public async updateGroupPolicy(
    conversationId: string,
    input: BystanderPolicyUpdateInput,
    actorStaffId?: string,
  ): Promise<GroupBystanderPolicy> {
    const before = await this.getGroupPolicy(conversationId);
    const next: GroupBystanderPolicy = {
      ...before,
      conversationId,
      ...(input.bystanderEnabled !== undefined
        ? { bystanderEnabled: input.bystanderEnabled }
        : {}),
      ...(input.proactiveReplyEnabled !== undefined
        ? { proactiveReplyEnabled: input.proactiveReplyEnabled }
        : {}),
      ...(input.slidingWindowSize !== undefined
        ? {
            slidingWindowSize: Math.max(
              1,
              Math.floor(input.slidingWindowSize),
            ),
          }
        : {}),
      ...(input.cooldownSeconds !== undefined
        ? { cooldownSeconds: Math.max(0, Math.floor(input.cooldownSeconds)) }
        : {}),
      ...(input.confidenceThreshold !== undefined
        ? { confidenceThreshold: clamp(input.confidenceThreshold, 0, 1) }
        : {}),
      ...(input.triggerTopics !== undefined
        ? {
            triggerTopics: input.triggerTopics
              .map((topic) => topic.trim())
              .filter(Boolean),
          }
        : {}),
    };
    if (!this.groupPolicies) {
      throw new Error('未配置群策略存储，无法持久化群级策略');
    }
    await this.groupPolicies.upsertPolicy(next);
    this.emitChange(
      'groupPolicy',
      before,
      next,
      actorStaffId,
      conversationId,
    );
    return next;
  }

  /** 一键紧急静音：指定群或全部已接入群 */
  public async emergencyMute(
    conversationId: string | undefined,
    actorStaffId?: string,
  ): Promise<string[]> {
    if (conversationId) {
      await this.updateGroupPolicy(
        conversationId,
        { bystanderEnabled: false, proactiveReplyEnabled: false },
        actorStaffId,
      );
      return [conversationId];
    }
    await this.updateDefaultBystanderPolicy(
      { bystanderEnabled: false, proactiveReplyEnabled: false },
      actorStaffId,
    );
    if (!this.groupPolicies) return [];
    const policies = await this.groupPolicies.listPolicies();
    const muted: string[] = [];
    for (const policy of policies) {
      await this.updateGroupPolicy(
        policy.conversationId,
        { bystanderEnabled: false, proactiveReplyEnabled: false },
        actorStaffId,
      );
      muted.push(policy.conversationId);
    }
    return muted;
  }

  public async recordAudit(
    input: AdminAuditInput,
  ): Promise<AdminAuditLog | null> {
    if (!this.auditStore) return null;
    return this.auditStore.append(input);
  }

  public async listAuditLogs(limit = 50): Promise<AdminAuditLog[]> {
    if (!this.auditStore) return [];
    return this.auditStore.list(limit);
  }

  private buildDefaults(): CenterState {
    const ding = this.defaults.getDingTalkConfig();
    const bystander = this.defaults.getBystanderConfig();
    return {
      dingtalk: {
        clientId: ding.clientId,
        clientSecret: ding.clientSecret,
        robotCode: ding.robotCode,
        aiCardTemplateId: ding.cardTemplateId,
        adminStaffIds: sanitizeStaffIds(
          this.options.initialAdminStaffIds ?? [],
        ),
        dwsCliEnabled: this.options.initialDwsCliEnabled ?? this.dwsEnabledFromEnv(),
      },
      llm: this.defaults.getLLMConfig(),
      loopPolicy: this.defaults.getLoopPolicy(),
      mcpServers: clone(this.options.initialMcpServers ?? []),
      defaultBystanderPolicy: {
        bystanderEnabled: bystander.bystanderEnabled,
        proactiveReplyEnabled: bystander.proactiveReplyEnabled,
        slidingWindowSize: Math.max(
          1,
          bystander.slidingWindowSize || DEFAULT_SLIDING_WINDOW_SIZE,
        ),
        cooldownSeconds: Math.max(
          0,
          bystander.cooldownSeconds || DEFAULT_COOLDOWN_SECONDS,
        ),
        confidenceThreshold: clamp(bystander.confidenceThreshold, 0, 1),
        triggerTopics: [...bystander.triggerTopics],
      },
      mcpAccessPolicies: [],
    };
  }

  private dwsEnabledFromEnv(): boolean {
    const raw = process.env.DWS_CLI_ENABLED;
    if (raw === undefined || raw.trim() === '') return true;
    return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
  }

  private mergeSections(
    base: CenterState,
    sections: ConfigSections,
  ): CenterState {
    return {
      dingtalk: {
        ...base.dingtalk,
        ...(sections.dingtalk ?? {}),
        adminStaffIds: sanitizeStaffIds(
          sections.dingtalk?.adminStaffIds ?? base.dingtalk.adminStaffIds,
        ),
      },
      llm: {
        ...base.llm,
        ...(sections.llm ?? {}),
        persona: {
          ...base.llm.persona,
          ...(sections.llm?.persona ?? {}),
        },
        apiKey: sections.llm?.apiKey || base.llm.apiKey,
      },
      loopPolicy: {
        ...base.loopPolicy,
        ...(sections.loopPolicy ?? {}),
      },
      mcpServers:
        sections.mcpServers !== undefined
          ? clone(sections.mcpServers)
          : base.mcpServers,
      defaultBystanderPolicy: {
        ...base.defaultBystanderPolicy,
        ...(sections.defaultBystanderPolicy ?? {}),
      },
      mcpAccessPolicies:
        sections.mcpAccessPolicies !== undefined
          ? clone(sections.mcpAccessPolicies)
          : base.mcpAccessPolicies,
    };
  }

  private validateServers(
    servers: EnterpriseMcpServerConfig[],
  ): EnterpriseMcpServerConfig[] {
    const ids = new Set<string>();
    return servers.map((server) => {
      const id = server.id.trim();
      if (!id) throw new Error('MCP Server id 不能为空');
      if (ids.has(id)) throw new Error(`MCP Server id 重复: ${id}`);
      ids.add(id);
      if (!server.endpointOrCommand.trim()) {
        throw new Error(`MCP Server "${id}" 缺少 endpointOrCommand`);
      }
      if (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0) {
        throw new Error(`MCP Server "${id}" 的 timeoutMs 必须为正数`);
      }
      if (!Number.isFinite(server.maxResultChars) || server.maxResultChars < 200) {
        throw new Error(`MCP Server "${id}" 的 maxResultChars 必须 >= 200`);
      }
      return clone({ ...server, id });
    });
  }

  private async persist<K extends ConfigSectionKey>(
    key: K,
    value: CenterState[K],
  ): Promise<void> {
    if (!this.store) return;
    await this.store.save(key, clone(value));
  }

  private emitChange(
    scope: ConfigScope,
    before: unknown,
    after: unknown,
    actorStaffId?: string,
    conversationId?: string,
  ): void {
    const event: ConfigChangeEvent = {
      scope,
      before: clone(before),
      after: clone(after),
      at: this.now(),
      ...(actorStaffId ? { actorStaffId } : {}),
      ...(conversationId ? { conversationId } : {}),
    };
    this.emit('changed', event);
    this.emit(`${scope}:changed`, event);
  }
}
