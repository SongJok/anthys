import type {
  ChatModel,
  DynamicLoopPolicy,
  ExecutionContext,
  IToolProvider,
  StreamCitation,
  ToolDefinition,
  ToolExecutionOutput,
} from '../types/core.js';
import { ReActRunner } from './ReActRunner.js';

export interface SubagentLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SubagentToolProviderOptions {
  model: ChatModel | (() => ChatModel);
  /** 主代理可见的工具提供方；子代理会自动过滤掉写操作、管理工具与自身 */
  providers: () => IToolProvider[];
  policy: DynamicLoopPolicy | (() => DynamicLoopPolicy);
  /** 子代理单次执行的最长耗时，默认 90s */
  timeoutMs?: number;
  /** 子代理 Token 预算上限，默认 20k */
  maxTokens?: number;
  logger?: SubagentLogger;
}

const DEFAULT_SUBAGENT_TIMEOUT_MS = 90_000;
const DEFAULT_SUBAGENT_MAX_TOKENS = 20_000;
const SUBAGENT_TOOL_NAME = 'delegate_research';
const WRITE_TOOL_PATTERN =
  /(^|[^a-z])(delete|remove|drop|purge|destroy|revoke|terminate|truncate|reset|unbind|wipe|uninstall|create|update|upsert|insert|set|add|write|upload|send|post|publish|move|rename|import|apply|execute|run|approve|reject|grant|assign|enable|disable|start|stop|restart|mute|cancel|manage|configure|modify|change|edit|patch|deploy|install|archive)([^a-z]|$)/i;

/** 子代理只做研究：读写风险的工具一律不暴露，管理工具也不下放 */
export function isReadOnlyTool(tool: ToolDefinition): boolean {
  if (tool.name === SUBAGENT_TOOL_NAME) return false;
  if (tool.name.startsWith('admin_')) return false;
  if (tool.risk && tool.risk !== 'read') return false;
  return !WRITE_TOOL_PATTERN.test(tool.name);
}

function toReadOnlyProvider(
  providers: IToolProvider[],
  allowedNames: Set<string>,
): IToolProvider {
  return {
    providerName: 'subagent-readonly',
    async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
      const loaded = await Promise.all(
        providers.map((provider) => provider.getTools(ctx)),
      );
      const seen = new Set<string>();
      return loaded.flat().filter((tool) => {
        if (!allowedNames.has(tool.name) || seen.has(tool.name)) return false;
        seen.add(tool.name);
        return true;
      });
    },
  };
}

const DEFINE_SUBAGENT_PROMPT = [
  '你是研究子代理，只负责查证一个具体问题，不直接面向用户。',
  '可以多次调用只读工具收集证据；信息足够后输出简洁的结论摘要，并列出关键来源 URL。',
  '不要执行写操作，不要与用户寒暄。',
].join('\n');

/**
 * A5 子代理：主代理通过 delegate_research 把一次独立的只读研究委派出去。
 * 子代理拥有独立上下文、独立预算与超时，只回传摘要与引用，降低主上下文噪声。
 */
export class SubagentToolProvider implements IToolProvider {
  public readonly providerName = 'subagent';
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(private readonly options: SubagentToolProviderOptions) {
    this.timeoutMs = Math.max(10_000, options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS);
    this.maxTokens = Math.max(
      1_000,
      options.maxTokens ?? DEFAULT_SUBAGENT_MAX_TOKENS,
    );
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const available = await this.availableToolNames(ctx);
    if (available.length === 0) return [];
    return [
      {
        name: SUBAGENT_TOOL_NAME,
        description:
          '把一次独立的只读研究委派给子代理，返回结论摘要与来源。适合需要跨多个工具查证、但结论可以合并回主任务的子问题。',
        risk: 'read',
        source: 'subagent',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '要查证的具体问题，写清目标与已有限制条件',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
        execute: async (args, context) => (await this.delegate(args, context)).text,
        executeStructured: async (args, context) =>
          this.delegate(args, context),
      },
    ];
  }

  /** 排除自身，避免 providers 列表未过滤时递归委派 */
  private visibleProviders(): IToolProvider[] {
    return this.options.providers().filter((provider) => provider !== this);
  }

  private async availableToolNames(ctx: ExecutionContext): Promise<string[]> {
    const loaded = await Promise.all(
      this.visibleProviders().map((provider) => provider.getTools(ctx)),
    );
    const names = new Set<string>();
    for (const tool of loaded.flat()) {
      if (isReadOnlyTool(tool)) names.add(tool.name);
    }
    return [...names];
  }

  private async delegate(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionOutput> {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) {
      return { text: 'Error: delegate_research 需要非空的 task 参数', summary: '缺少 task' };
    }
    const startedAt = context.now();
    const available = await this.availableToolNames(context);
    if (available.length === 0) {
      return {
        text: 'Error: 当前没有可供子代理使用的只读工具',
        summary: '无可用只读工具',
      };
    }

    const policy =
      typeof this.options.policy === 'function'
        ? this.options.policy()
        : this.options.policy;

    const runner = new ReActRunner({
      model: this.resolveModel(),
      toolProviders: [
        toReadOnlyProvider(this.visibleProviders(), new Set(available)),
      ],
      policy: {
        ...policy,
        maxWallTimeMs: Math.min(policy.maxWallTimeMs, this.timeoutMs),
        maxTotalTokens: Math.min(policy.maxTotalTokens, this.maxTokens),
        convergenceCheck: true,
      },
      temperature: 0,
      enableNativeReasoning: false,
      markUntrustedOutput: true,
    });

    try {
      const result = await runner.run({
        messages: [
          { role: 'system', content: DEFINE_SUBAGENT_PROMPT },
          { role: 'user', content: task },
        ],
        context: {
          ...context,
          deadlineAt: Math.min(
            context.deadlineAt,
            startedAt + this.timeoutMs,
          ),
        },
        emit: () => undefined,
      });
      this.options.logger?.info(
        {
          conversationId: context.conversationId,
          steps: result.usage.steps,
          tokens: result.usage.totalTokens,
          durationMs: result.usage.durationMs,
        },
        'subagent research completed',
      );
      const citations = (result.citations ?? []).slice(0, 5);
      const summary = result.answer.trim() || '子代理未产出结论';
      return {
        text: [
          `[子代理结论]\n${summary}`,
          citations.length > 0
            ? `[来源]\n${citations
                .map((item: StreamCitation) => `- ${item.title}${item.url ? ` ${item.url}` : ''}`)
                .join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        citations,
        summary: summary.slice(0, 200),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        { conversationId: context.conversationId, error: message },
        'subagent research failed',
      );
      return {
        text: `Error: 子代理执行失败：${message}`,
        summary: '子代理执行失败',
      };
    }
  }

  private resolveModel(): ChatModel {
    const model = this.options.model;
    return typeof model === 'function' ? model() : model;
  }
}
