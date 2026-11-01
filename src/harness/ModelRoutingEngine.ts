import type {
  AgentEngine,
  ExecutionContext,
  ModelRole,
} from '../types/core.js';

export interface ModelRoutingEngineOptions {
  /** 未命中角色时使用 */
  fallback: AgentEngine;
  /** 按角色获取（或懒创建）引擎；角色配置由 .env 的 LLM_* / LLM_ADMIN_* / LLM_PROACTIVE_* 决定 */
  engineForRole: (role: ModelRole) => AgentEngine;
  /** 自定义角色判定，优先于内置规则 */
  roleFor?: (context: ExecutionContext) => ModelRole | undefined;
  isAdmin?: (staffId: string) => boolean;
}

/**
 * 按场景把一次运行路由到不同供应商：
 * 主动回复用便宜的旁听模型，管理员单聊用更强的模型，其余走默认模型。
 */
export class ModelRoutingEngine implements AgentEngine {
  private readonly cache = new Map<ModelRole, AgentEngine>();

  constructor(private readonly options: ModelRoutingEngineOptions) {}

  public selectRole(context: ExecutionContext): ModelRole | undefined {
    if (this.options.roleFor) return this.options.roleFor(context);
    if (context.proactive) return 'proactive';
    if (this.options.isAdmin?.(context.senderStaffId)) return 'admin';
    return undefined;
  }

  public run(
    input: Parameters<AgentEngine['run']>[0],
  ): ReturnType<AgentEngine['run']> {
    const role = this.selectRole(input.context);
    if (!role) return this.options.fallback.run(input);
    let engine = this.cache.get(role);
    if (!engine) {
      engine = this.options.engineForRole(role);
      this.cache.set(role, engine);
    }
    return engine.run(input);
  }
}
