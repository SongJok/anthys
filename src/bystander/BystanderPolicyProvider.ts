import type { BystanderConfig } from '../config/IConfigProvider.js';
import type { BystanderPolicyStore } from '../db/memorySchema.js';
import type { GroupBystanderPolicy } from '../types/bystander-and-memory.js';

export interface BystanderPolicyProviderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface BystanderPolicyProviderOptions {
  defaults: BystanderConfig;
  store?: BystanderPolicyStore;
  logger?: BystanderPolicyProviderLogger;
}

/**
 * 群级旁听策略来源：环境变量提供全局默认值，数据库可按群覆盖。
 * 数据库不可用时回退默认值，绝不阻塞消息处理。
 */
export class BystanderPolicyProvider {
  constructor(private readonly options: BystanderPolicyProviderOptions) {}

  /** 全局默认值热更新（Web/ChatOps 修改 defaultBystanderPolicy 后调用） */
  public setDefaults(defaults: BystanderConfig): void {
    this.options.defaults = defaults;
  }
  public async getPolicy(
    conversationId: string,
  ): Promise<GroupBystanderPolicy> {
    const fallback = this.fromDefaults(conversationId);
    if (!this.options.store) return fallback;

    try {
      const override = await this.options.store.getPolicy(conversationId);
      return override ? { ...fallback, ...override, conversationId } : fallback;
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'bystander policy lookup failed, falling back to defaults',
      );
      return fallback;
    }
  }

  private fromDefaults(conversationId: string): GroupBystanderPolicy {
    const { defaults } = this.options;
    return {
      conversationId,
      bystanderEnabled: defaults.bystanderEnabled,
      proactiveReplyEnabled: defaults.proactiveReplyEnabled,
      slidingWindowSize: defaults.slidingWindowSize,
      cooldownSeconds: defaults.cooldownSeconds,
      confidenceThreshold: defaults.confidenceThreshold,
      triggerTopics: [...defaults.triggerTopics],
    };
  }
}
