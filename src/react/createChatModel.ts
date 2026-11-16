import type {
  ChatModel,
  LLMAndPersonaConfig,
  LlmDialect,
  ModelProfile,
  ThinkingMode,
} from '../types/core.js';
import { AnthropicChatModel } from './AnthropicChatModel.js';
import { sharedLlmRequestGate } from './LlmRequestGate.js';
import { OpenAIChatModel } from './OpenAIChatModel.js';

/** 同一供应商端点下所有角色共享的在途请求上限；0 表示不限流 */
function llmConcurrencyLimit(): number {
  const raw = Number(process.env.LLM_MAX_CONCURRENT_REQUESTS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 12;
}

export function inferDialect(baseUrl: string): LlmDialect {
  const url = baseUrl.toLowerCase();
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('moonshot') || url.includes('kimi')) return 'moonshot';
  if (url.includes('bigmodel') || url.includes('zhipu')) return 'zhipu';
  return 'openai';
}

function resolveThinking(
  config: LLMAndPersonaConfig | ModelProfile,
): ThinkingMode {
  if ('thinking' in config && config.thinking) return config.thinking;
  return 'enableNativeReasoning' in config && !config.enableNativeReasoning
    ? 'off'
    : 'auto';
}

export function createChatModel(
  config: LLMAndPersonaConfig | ModelProfile,
): ChatModel {
  const requestGate = sharedLlmRequestGate(
    config.baseUrl,
    llmConcurrencyLimit(),
  );
  if (config.provider === 'anthropic') {
    return new AnthropicChatModel({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      requestGate,
      ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
    });
  }
  return new OpenAIChatModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    dialect:
      'dialect' in config ? config.dialect : inferDialect(config.baseUrl),
    thinking: resolveThinking(config),
    requestGate,
    ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
  });
}
