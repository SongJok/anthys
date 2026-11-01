import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';
import { matchesToolPattern } from './ToolPattern.js';

export interface ToolExecutionPolicyInput {
  /** 非空时只允许命中的工具 */
  allow?: string[];
  /** 永远优先于 allow */
  deny?: string[];
}

export interface ToolExecutionPolicy {
  /** 执行前判定；deny 优先，allow 为空表示不限制 */
  allows(name: string): boolean;
  /** 供日志与排障展示 */
  describe(): { allow: string[]; deny: string[] };
  isDefault(): boolean;
}

function normalizePatterns(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

export function createToolExecutionPolicy(
  input: ToolExecutionPolicyInput = {},
): ToolExecutionPolicy {
  const allow = normalizePatterns(input.allow);
  const deny = normalizePatterns(input.deny);
  return {
    allows(name) {
      if (deny.some((pattern) => matchesToolPattern(pattern, name))) {
        return false;
      }
      if (allow.length === 0) return true;
      return allow.some((pattern) => matchesToolPattern(pattern, name));
    },
    describe() {
      return { allow: [...allow], deny: [...deny] };
    },
    isDefault() {
      return allow.length === 0 && deny.length === 0;
    },
  };
}

function splitPatterns(raw: string | undefined): string[] {
  return (raw ?? '').split(',');
}

/** 从环境变量读取全局执行白名单：allow 为空表示不启用白名单 */
export function parseToolExecutionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ToolExecutionPolicy {
  return createToolExecutionPolicy({
    allow: splitPatterns(env.TOOL_EXECUTION_ALLOWLIST),
    deny: splitPatterns(env.TOOL_EXECUTION_DENYLIST),
  });
}

export interface PolicyToolProviderOptions {
  providers: () => IToolProvider[];
  policy: ToolExecutionPolicy;
}

/**
 * 全局执行策略包装：即使某个 Provider 未自行过滤，
 * 被禁用的工具也不会出现在模型可见的工具列表与执行映射中。
 */
export class PolicyToolProvider implements IToolProvider {
  public readonly providerName = 'execution-policy';

  constructor(private readonly options: PolicyToolProviderOptions) {}

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const loaded = await Promise.all(
      this.options.providers().map((provider) => provider.getTools(ctx)),
    );
    return loaded
      .flat()
      .filter((tool) => this.options.policy.allows(tool.name));
  }
}
