import type { DynamicLoopPolicy, LLMAndPersonaConfig } from '../types/core.js';
import type {
  ModelRoutingPolicy,
  UsagePolicy,
} from '../types/admin-and-console.js';

export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  cardTemplateId: string;
}

export interface MemoryConfig {
  windowMessages: number;
  /** 触发情景记忆压缩的单会话上下文 Token 阈值 */
  compressionThresholdTokens: number;
  /** 每次压缩覆盖的对话比例，默认 0.6 */
  compressionRatio: number;
  /** 语义记忆单次召回条数 */
  semanticLimit: number;
}

/** 群聊旁听与主动回复的全局默认值，可被数据库策略覆盖 */
export interface BystanderConfig {
  bystanderEnabled: boolean;
  proactiveReplyEnabled: boolean;
  slidingWindowSize: number;
  cooldownSeconds: number;
  confidenceThreshold: number;
  triggerTopics: string[];
  /** 疑似提问后的防抢答等待窗口，默认 8000ms */
  debounceMs: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface VisionConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type WebSearchEngine =
  | 'search_std'
  | 'search_pro'
  | 'search_pro_sogou'
  | 'search_pro_quark';

export type WebSearchContentSize = 'medium' | 'high';

/** 公网搜索配置；默认复用智谱大模型的 baseUrl 与 API Key */
export interface WebSearchConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  engine: WebSearchEngine;
  /** 单次返回结果条数 */
  count: number;
  contentSize: WebSearchContentSize;
  timeoutMs: number;
  /** 出站前对查询做手机号/邮箱/证件/密钥脱敏 */
  redactOutbound: boolean;
  /** 相同查询的结果缓存秒数，0 表示关闭缓存 */
  cacheTtlSeconds: number;
  /** 单会话每小时最多真实调用次数，0 表示不限制 */
  maxCallsPerHour: number;
  /** 进程内每天最多真实调用次数，0 表示不限制 */
  dailyLimit: number;
}

export interface IConfigProvider {
  getLLMConfig(): LLMAndPersonaConfig;
  getLoopPolicy(): DynamicLoopPolicy;
  getDingTalkConfig(): DingTalkConfig;
  getMemoryConfig(): MemoryConfig;
  getBystanderConfig(): BystanderConfig;
  /** 每日 Token 配额，默认关闭 */
  getUsagePolicy?(): UsagePolicy;
  /** 按场景选择模型，默认沿用全局模型 */
  getModelRouting?(): ModelRoutingPolicy;
  /** 向量检索配置；未配置或关闭时回退关键词召回 */
  getEmbeddingConfig?(): EmbeddingConfig | undefined;
  /** 图片理解模型；未配置时图片只落盘不识别 */
  getVisionConfig?(): VisionConfig | undefined;
  /** 公网搜索；未配置时不下发 web_search 工具 */
  getWebSearchConfig?(): WebSearchConfig | undefined;
  getDatabaseUrl(): string;
  /** 校验启动必需配置，缺失时抛出可读错误 */
  assertReady(): void;
}
