import type {
  AgentEngine,
  ExecutionContext,
} from '../types/core.js';
import type {
  GroupModelRoute,
  GroupModelRouteStore,
} from '../types/group-workspace.js';

export interface GroupModelRoutingEngineOptions {
  /** 未配置群路由、路由停用或读取失败时的引擎 */
  fallback: AgentEngine;
  routes: Pick<GroupModelRouteStore, 'get'>;
  /** 按合并后的路由创建独立引擎；返回 null 表示路由不可用，回退默认引擎 */
  engineForRoute: (route: GroupModelRoute) => AgentEngine | null;
  /** 路由缓存时间；跨实例修改最多延迟这么久生效 */
  cacheTtlMs?: number;
  now?: () => number;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

interface CacheEntry {
  signature: string;
  engine: AgentEngine;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

function routeSignature(route: GroupModelRoute): string {
  return [
    route.enabled,
    route.provider,
    route.baseUrl,
    route.apiKeyEnv,
    route.model,
    route.temperature,
    route.thinking,
    route.maxTokens,
  ].join('|');
}

/**
 * 群级模型路由：同一机器人在不同群里可选用不同供应商/模型。
 * 仅群聊生效，单聊保持原有角色路由；配置读取失败时不阻断对话。
 */
export class GroupModelRoutingEngine implements AgentEngine {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: GroupModelRoutingEngineOptions) {
    this.ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  public invalidate(conversationId?: string): void {
    if (conversationId) {
      this.cache.delete(conversationId);
      return;
    }
    this.cache.clear();
  }

  public async run(
    input: Parameters<AgentEngine['run']>[0],
  ): ReturnType<AgentEngine['run']> {
    const context: ExecutionContext = input.context;
    if (context.conversationType !== '2') {
      return this.options.fallback.run(input);
    }
    let route: GroupModelRoute | null = null;
    try {
      route = await this.options.routes.get(context.conversationId);
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId: context.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'group model route lookup failed, using default engine',
      );
      return this.options.fallback.run(input);
    }
    if (!route || !route.enabled) return this.options.fallback.run(input);

    const signature = routeSignature(route);
    const cached = this.cache.get(route.conversationId);
    if (
      cached &&
      cached.signature === signature &&
      cached.expiresAt > this.now()
    ) {
      return cached.engine.run(input);
    }
    const engine = this.options.engineForRoute(route);
    if (!engine) {
      this.options.logger?.warn(
        {
          conversationId: route.conversationId,
          apiKeyEnv: route.apiKeyEnv,
        },
        'group model route unusable, using default engine',
      );
      return this.options.fallback.run(input);
    }
    this.cache.set(route.conversationId, {
      signature,
      engine,
      expiresAt: this.now() + this.ttlMs,
    });
    return engine.run(input);
  }
}
