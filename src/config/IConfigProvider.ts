import type { DynamicLoopPolicy, LLMAndPersonaConfig } from '../types/core.js';

export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  cardTemplateId: string;
}

export interface MemoryConfig {
  windowMessages: number;
}

export interface IConfigProvider {
  getLLMConfig(): LLMAndPersonaConfig;
  getLoopPolicy(): DynamicLoopPolicy;
  getDingTalkConfig(): DingTalkConfig;
  getMemoryConfig(): MemoryConfig;
  getDatabaseUrl(): string;
  /** 校验启动必需配置，缺失时抛出可读错误 */
  assertReady(): void;
}
