import type { ModelRoutingPolicy } from '../types/admin-and-console.js';
import type { AgentEngine, ExecutionContext } from '../types/core.js';

export interface ModelRoutingEngineOptions {
  /** 未命中任何路由规则时使用 */
  fallback: AgentEngine;
  /** 按模型名获取（或懒创建）引擎 */
  engineForModel: (model: string) => AgentEngine;
  routing: () => ModelRoutingPolicy;
  isAdmin?: (staffId: string) => boolean;
}

/**
 * 按场景把一次运行路由到不同模型：
 * 主动回复可用更便宜的模型，管理员单聊可切到更强的模型。
 */
export class ModelRoutingEngine implements AgentEngine {
  private readonly cache = new Map<string, AgentEngine>();

  constructor(private readonly options: ModelRoutingEngineOptions) {}

  public selectModel(context: ExecutionContext): string | undefined {
    const routing = this.options.routing();
    if (context.proactive && routing.proactiveModel?.trim()) {
      return routing.proactiveModel.trim();
    }
    if (
      routing.adminModel?.trim() &&
      this.options.isAdmin?.(context.senderStaffId)
    ) {
      return routing.adminModel.trim();
    }
    return routing.defaultModel?.trim() || undefined;
  }

  public run(
    input: Parameters<AgentEngine['run']>[0],
  ): ReturnType<AgentEngine['run']> {
    const model = this.selectModel(input.context);
    if (!model) return this.options.fallback.run(input);
    let engine = this.cache.get(model);
    if (!engine) {
      engine = this.options.engineForModel(model);
      this.cache.set(model, engine);
    }
    return engine.run(input);
  }
}
