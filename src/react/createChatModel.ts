import type {
  ChatModel,
  LLMAndPersonaConfig,
  LlmDialect,
  ModelProfile,
  ThinkingMode,
} from '../types/core.js';
import { AnthropicChatModel } from './AnthropicChatModel.js';
import { OpenAIChatModel } from './OpenAIChatModel.js';

function inferDialect(baseUrl: string): LlmDialect {
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
  if (config.provider === 'anthropic') {
    return new AnthropicChatModel({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
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
    ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
  });
}
