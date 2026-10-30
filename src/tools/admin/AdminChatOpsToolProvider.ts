import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  GroupDirectory,
  McpAdminPort,
  ReActTraceRecord,
  ReActTraceStore,
} from '../../types/admin-and-console.js';
import type { GroupBystanderPolicy } from '../../types/bystander-and-memory.js';

export interface AdminChatOpsDeps {
  configCenter: DynamicConfigCenter;
  mcp: McpAdminPort;
  traces: ReActTraceStore;
  groups: GroupDirectory;
  now?: () => number;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

const ADMIN_TOOL_NAMES = [
  'admin_inspect_system_status',
  'admin_manage_mcp_server',
  'admin_update_llm_or_persona',
  'admin_configure_group_bystander',
  'admin_query_traces',
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  return value.trim() === '' ? undefined : value.trim();
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`参数 ${key} 必须是数字`);
  return parsed;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`参数 ${key} 必须是布尔值`);
}

function startOfDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 阶段四：管理员单聊管控工具集。
 *
 * 物理隔离：只有 conversationType === '1' 且 senderStaffId 命中管理员白名单时，
 * getTools 才会返回 admin_* 工具；execute 内再次校验，避免工具对象被复用到群聊。
 */
export class AdminChatOpsToolProvider implements IToolProvider {
  public readonly providerName = 'admin-chatops';
  private readonly now: () => number;

  constructor(private readonly deps: AdminChatOpsDeps) {
    this.now = deps.now ?? Date.now;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (!this.isAdminContext(ctx)) return [];
    return [
      this.inspectStatusTool(),
      this.manageMcpTool(),
      this.updateLlmTool(),
      this.configureGroupTool(),
      this.queryTracesTool(),
    ];
  }

  public isAdminContext(ctx: ExecutionContext): boolean {
    return (
      ctx.conversationType === '1' &&
      this.deps.configCenter.isAdmin(ctx.senderStaffId)
    );
  }

  private assertAuthorized(ctx: ExecutionContext): void {
    if (!this.isAdminContext(ctx)) {
      throw new Error('权限不足：仅管理员单聊可执行管控操作');
    }
  }

  private inspectStatusTool(): ToolDefinition {
    return {
      name: 'admin_inspect_system_status',
      description:
        '查看系统运行状态：在线 MCP Server 健康状态、今日 Token 消耗/轮次、各群旁听与主动回复统计。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          includeHealth: {
            type: 'boolean',
            description: '是否对 MCP Server 做一次协议层 ping（默认 false）',
          },
        },
      },
      execute: async (args, ctx) => {
        this.assertAuthorized(ctx);
        const includeHealth = optionalBoolean(args, 'includeHealth') ?? false;
        const today = await this.deps.traces.dailyStats(
          startOfDay(this.now()),
          startOfDay(this.now()) + 24 * 60 * 60 * 1_000,
        );
        const groups = await this.deps.groups.listGroups();
        const config = this.deps.configCenter.getSystemConfig();
        const health = includeHealth
          ? await this.deps.mcp.healthCheck()
          : undefined;
        return JSON.stringify({
          ok: true,
          model: config.llm.model,
          nativeReasoning: config.llm.enableNativeReasoning,
          loopPolicy: config.loopPolicy,
          adminCount: config.dingtalk.adminStaffIds.length,
          mcpServers: this.deps.mcp.status(),
          ...(health ? { mcpHealth: health } : {}),
          today,
          groups: {
            total: groups.length,
            top: today.byGroup
              .slice()
              .sort(
                (a, b) =>
                  b.proactiveReplies - a.proactiveReplies || b.turns - a.turns,
              )
              .slice(0, 5),
          },
        });
      },
    };
  }

  private manageMcpTool(): ToolDefinition {
    return {
      name: 'admin_manage_mcp_server',
      description:
        '启用/禁用指定企业 MCP 节点，或热重载连接；返回该节点最新发现的工具清单。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: 'MCP Server id' },
          action: {
            type: 'string',
            enum: ['reload', 'enable', 'disable'],
            description: 'reload=只重连；enable/disable=切换启用状态并热应用',
          },
        },
        required: ['serverId', 'action'],
      },
      execute: async (args, ctx) => {
        this.assertAuthorized(ctx);
        const serverId = requireString(args, 'serverId');
        const action = requireString(args, 'action');
        if (!['reload', 'enable', 'disable'].includes(action)) {
          throw new Error('action 必须是 reload / enable / disable');
        }
        const servers = this.deps.configCenter.getMcpServers();
        const target = servers.find((server) => server.id === serverId);
        if (!target) throw new Error(`未知 MCP Server: ${serverId}`);
        const before = {
          id: target.id,
          enabled: target.enabled,
          endpointOrCommand: target.endpointOrCommand,
        };

        let tools: Array<{
          serverId: string;
          originalName: string;
          namespacedName: string;
          description: string;
        }>;
        if (action === 'reload') {
          tools = await this.deps.mcp.reloadServer(serverId);
        } else {
          const enabled = action === 'enable';
          const updated = servers.map((server) =>
            server.id === serverId ? { ...server, enabled } : server,
          );
          await this.deps.configCenter.updateMcpServers(
            updated,
            ctx.senderStaffId,
          );
          const applied = await this.deps.mcp.applyServers(updated);
          tools = applied.filter((tool) => tool.serverId === serverId);
        }

        await this.recordAudit(ctx, 'RELOAD_MCP', before, {
          id: target.id,
          action,
          enabled: action === 'reload' ? target.enabled : action === 'enable',
          tools: tools.map((tool) => tool.originalName),
        });
        return JSON.stringify({
          ok: true,
          serverId,
          action,
          tools: tools.map((tool) => ({
            name: tool.originalName,
            namespacedName: tool.namespacedName,
            description: tool.description,
          })),
          toolCount: tools.length,
        });
      },
    };
  }

  private updateLlmTool(): ToolDefinition {
    return {
      name: 'admin_update_llm_or_persona',
      description:
        '热切换主模型、调整温度/原生思维链、修改机器人人设 Prompt 与 ReAct 循环预算，无需重启。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: '例如 DeepSeek-R1' },
          baseUrl: { type: 'string' },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          enableNativeReasoning: { type: 'boolean' },
          personaName: { type: 'string' },
          rolePrompt: { type: 'string' },
          speakingStyle: { type: 'string' },
          loop: {
            type: 'object',
            properties: {
              maxWallTimeMs: { type: 'number' },
              maxTotalTokens: { type: 'number' },
              maxConsecutiveSameTool: { type: 'number' },
              convergenceCheck: { type: 'boolean' },
            },
          },
        },
      },
      execute: async (args, ctx) => {
        this.assertAuthorized(ctx);
        const before = this.deps.configCenter.getSystemConfig();
        const personaName = optionalString(args, 'personaName');
        const rolePrompt = optionalString(args, 'rolePrompt');
        const speakingStyle = optionalString(args, 'speakingStyle');
        const loop =
          args.loop && typeof args.loop === 'object' && !Array.isArray(args.loop)
            ? (args.loop as Record<string, unknown>)
            : undefined;

        await this.deps.configCenter.updateLLM(
          {
            ...(optionalString(args, 'model')
              ? { model: optionalString(args, 'model') }
              : {}),
            ...(optionalString(args, 'baseUrl')
              ? { baseUrl: optionalString(args, 'baseUrl') }
              : {}),
            ...(optionalNumber(args, 'temperature') !== undefined
              ? { temperature: optionalNumber(args, 'temperature') }
              : {}),
            ...(optionalBoolean(args, 'enableNativeReasoning') !== undefined
              ? {
                  enableNativeReasoning: optionalBoolean(
                    args,
                    'enableNativeReasoning',
                  ),
                }
              : {}),
            ...(personaName || rolePrompt || speakingStyle
              ? {
                  persona: {
                    ...(personaName ? { name: personaName } : {}),
                    ...(rolePrompt ? { rolePrompt } : {}),
                    ...(speakingStyle ? { speakingStyle } : {}),
                  },
                }
              : {}),
          },
          ctx.senderStaffId,
        );

        if (loop) {
          await this.deps.configCenter.updateLoopPolicy(
            {
              ...(optionalNumber(loop, 'maxWallTimeMs') !== undefined
                ? { maxWallTimeMs: optionalNumber(loop, 'maxWallTimeMs') }
                : {}),
              ...(optionalNumber(loop, 'maxTotalTokens') !== undefined
                ? { maxTotalTokens: optionalNumber(loop, 'maxTotalTokens') }
                : {}),
              ...(optionalNumber(loop, 'maxConsecutiveSameTool') !== undefined
                ? {
                    maxConsecutiveSameTool: optionalNumber(
                      loop,
                      'maxConsecutiveSameTool',
                    ),
                  }
                : {}),
              ...(optionalBoolean(loop, 'convergenceCheck') !== undefined
                ? {
                    convergenceCheck: optionalBoolean(
                      loop,
                      'convergenceCheck',
                    ),
                  }
                : {}),
            },
            ctx.senderStaffId,
          );
        }

        const after = this.deps.configCenter.getSystemConfig();
        await this.recordAudit(
          ctx,
          'UPDATE_LLM',
          {
            model: before.llm.model,
            temperature: before.llm.temperature,
            persona: before.llm.persona,
            loopPolicy: before.loopPolicy,
          },
          {
            model: after.llm.model,
            temperature: after.llm.temperature,
            persona: after.llm.persona,
            loopPolicy: after.loopPolicy,
          },
        );
        return JSON.stringify({
          ok: true,
          hotReloaded: true,
          llm: {
            model: after.llm.model,
            temperature: after.llm.temperature,
            enableNativeReasoning: after.llm.enableNativeReasoning,
            persona: after.llm.persona,
          },
          loopPolicy: after.loopPolicy,
        });
      },
    };
  }

  private configureGroupTool(): ToolDefinition {
    return {
      name: 'admin_configure_group_bystander',
      description:
        '查询已接入群列表，开关指定群的旁听/非@自主回复，调整冷却时间等策略，或一键紧急静音。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'update', 'emergency_mute'],
          },
          conversationId: {
            type: 'string',
            description: '钉钉群 conversationId；emergency_mute 省略时静音全部群',
          },
          bystanderEnabled: { type: 'boolean' },
          proactiveReplyEnabled: { type: 'boolean' },
          cooldownSeconds: { type: 'number' },
          slidingWindowSize: { type: 'number' },
          confidenceThreshold: { type: 'number' },
          triggerTopics: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['action'],
      },
      execute: async (args, ctx) => {
        this.assertAuthorized(ctx);
        const action = requireString(args, 'action');
        if (action === 'list') {
          const groups = await this.deps.groups.listGroups();
          const policies = await this.deps.configCenter.listGroupPolicies();
          const policyMap = new Map(
            policies.map((policy) => [policy.conversationId, policy]),
          );
          const defaults =
            this.deps.configCenter.getSystemConfig().defaultBystanderPolicy;
          return JSON.stringify({
            ok: true,
            groups: groups.map((group) => ({
              ...group,
              effectivePolicy: policyMap.get(group.conversationId) ?? {
                conversationId: group.conversationId,
                ...defaults,
              },
            })),
          });
        }

        if (action === 'emergency_mute') {
          const conversationId = optionalString(args, 'conversationId');
          const muted = await this.deps.configCenter.emergencyMute(
            conversationId,
            ctx.senderStaffId,
          );
          await this.recordAudit(
            ctx,
            'EMERGENCY_MUTE',
            { conversationId: conversationId ?? 'ALL' },
            { mutedGroups: muted, defaultMuted: conversationId === undefined },
          );
          return JSON.stringify({
            ok: true,
            mutedGroups: muted,
            defaultMuted: conversationId === undefined,
          });
        }

        if (action === 'update') {
          const conversationId = requireString(args, 'conversationId');
          const topics = Array.isArray(args.triggerTopics)
            ? args.triggerTopics.map((topic) => String(topic))
            : undefined;
          const before = await this.deps.configCenter.getGroupPolicy(
            conversationId,
          );
          const policy = await this.deps.configCenter.updateGroupPolicy(
            conversationId,
            {
              ...(optionalBoolean(args, 'bystanderEnabled') !== undefined
                ? {
                    bystanderEnabled: optionalBoolean(
                      args,
                      'bystanderEnabled',
                    ),
                  }
                : {}),
              ...(optionalBoolean(args, 'proactiveReplyEnabled') !== undefined
                ? {
                    proactiveReplyEnabled: optionalBoolean(
                      args,
                      'proactiveReplyEnabled',
                    ),
                  }
                : {}),
              ...(optionalNumber(args, 'cooldownSeconds') !== undefined
                ? {
                    cooldownSeconds: optionalNumber(args, 'cooldownSeconds'),
                  }
                : {}),
              ...(optionalNumber(args, 'slidingWindowSize') !== undefined
                ? {
                    slidingWindowSize: optionalNumber(
                      args,
                      'slidingWindowSize',
                    ),
                  }
                : {}),
              ...(optionalNumber(args, 'confidenceThreshold') !== undefined
                ? {
                    confidenceThreshold: optionalNumber(
                      args,
                      'confidenceThreshold',
                    ),
                  }
                : {}),
              ...(topics ? { triggerTopics: topics } : {}),
            },
            ctx.senderStaffId,
          );
          await this.recordAudit(
            ctx,
            'UPDATE_GROUP_POLICY',
            this.policySnapshot(before),
            this.policySnapshot(policy),
          );
          return JSON.stringify({ ok: true, policy });
        }

        throw new Error('action 必须是 list / update / emergency_mute');
      },
    };
  }

  private queryTracesTool(): ToolDefinition {
    return {
      name: 'admin_query_traces',
      description:
        '查询今天的 ReAct 执行轨迹，可按耗时或 Token 排序，用于定位最慢/最贵的查询。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['slowest', 'tokens'],
            description: 'slowest=按耗时降序；tokens=按 Token 降序',
          },
          limit: { type: 'number', minimum: 1, maximum: 20 },
          conversationId: { type: 'string' },
        },
      },
      execute: async (args, ctx) => {
        this.assertAuthorized(ctx);
        const metric = optionalString(args, 'metric') ?? 'slowest';
        if (metric !== 'slowest' && metric !== 'tokens') {
          throw new Error('metric 必须是 slowest / tokens');
        }
        const limit = Math.min(
          20,
          Math.max(1, Math.floor(optionalNumber(args, 'limit') ?? 5)),
        );
        const conversationId = optionalString(args, 'conversationId');
        const page = await this.deps.traces.query({
          page: 1,
          pageSize: 100,
          sinceMs: startOfDay(this.now()),
          ...(conversationId ? { conversationId } : {}),
        });
        const sorted = page.items
          .slice()
          .sort((a, b) =>
            metric === 'slowest'
              ? b.durationMs - a.durationMs
              : b.totalTokens - a.totalTokens,
          )
          .slice(0, limit);
        await this.recordAudit(
          ctx,
          'QUERY_STATS',
          { metric, limit, conversationId: conversationId ?? null },
          { returned: sorted.length, ids: sorted.map((trace) => trace.id) },
        );
        return JSON.stringify({
          ok: true,
          metric,
          totalToday: page.total,
          traces: sorted.map((trace) => this.traceSummary(trace)),
        });
      },
    };
  }

  private traceSummary(trace: ReActTraceRecord): Record<string, unknown> {
    return {
      id: trace.id,
      conversationId: trace.conversationId,
      senderNick: trace.senderNick,
      question: trace.question,
      durationMs: trace.durationMs,
      totalTokens: trace.totalTokens,
      stepCount: trace.stepCount,
      createdAt: trace.createdAt,
      tools: trace.steps
        .filter((step) => step.toolName)
        .map((step) => ({
          toolName: step.toolName,
          durationMs: step.durationMs ?? null,
          isError: step.isError ?? false,
        })),
    };
  }

  private policySnapshot(
    policy: GroupBystanderPolicy,
  ): Record<string, unknown> {
    return {
      conversationId: policy.conversationId,
      bystanderEnabled: policy.bystanderEnabled,
      proactiveReplyEnabled: policy.proactiveReplyEnabled,
      cooldownSeconds: policy.cooldownSeconds,
      slidingWindowSize: policy.slidingWindowSize,
      confidenceThreshold: policy.confidenceThreshold,
      triggerTopics: policy.triggerTopics,
    };
  }

  private async recordAudit(
    ctx: ExecutionContext,
    actionType:
      | 'UPDATE_LLM'
      | 'RELOAD_MCP'
      | 'UPDATE_GROUP_POLICY'
      | 'EMERGENCY_MUTE'
      | 'QUERY_STATS',
    beforeSnapshot: Record<string, unknown>,
    afterSnapshot: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.configCenter.recordAudit({
        adminStaffId: ctx.senderStaffId,
        adminNick: ctx.senderNick,
        actionType,
        beforeSnapshot,
        afterSnapshot,
      });
    } catch (error) {
      this.deps.logger?.warn(
        { error: errorMessage(error), actionType },
        'failed to record admin audit log',
      );
    }
  }
}

export { ADMIN_TOOL_NAMES };
