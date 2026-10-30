import type { ChatModel, LLMAndPersonaConfig } from '../types/core.js';
import { AnthropicChatModel } from './AnthropicChatModel.js';
import { OpenAIChatModel } from './OpenAIChatModel.js';

export function createChatModel(config: LLMAndPersonaConfig): ChatModel {
  if (config.provider === 'anthropic') {
    return new AnthropicChatModel({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }
  return new OpenAIChatModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}
