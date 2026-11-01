import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatModel,
  ChatStreamChunk,
  LlmDialect,
  ThinkingMode,
} from '../types/core.js';

interface ReasoningDelta {
  reasoning_content?: string;
  reasoning?: string;
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIChatModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dialect?: LlmDialect;
  thinking?: ThinkingMode;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  client?: OpenAI;
}

export function toOpenAIMessages(
  messages: ChatMessage[],
  includeReasoning = false,
): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      } satisfies ChatCompletionMessageParam;
    }
    if (message.role === 'assistant') {
      const reasoning =
        includeReasoning && message.reasoning
          ? { reasoning_content: message.reasoning }
          : {};
      if (message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content.length > 0 ? message.content : null,
          tool_calls: message.toolCalls,
          ...reasoning,
        } as ChatCompletionMessageParam;
      }
      return {
        role: 'assistant',
        content: message.content,
        ...reasoning,
      } as ChatCompletionMessageParam;
    }
    return {
      role: message.role,
      content: message.content,
    } satisfies ChatCompletionMessageParam;
  });
}

function applyThinking(
  body: Record<string, unknown>,
  dialect: LlmDialect,
  thinking: ThinkingMode,
): void {
  if (thinking === 'auto') return;
  if (dialect === 'deepseek') {
    body.thinking = { type: thinking === 'off' ? 'disabled' : 'enabled' };
    if (thinking === 'low' || thinking === 'high' || thinking === 'max') {
      body.reasoning_effort = thinking;
    }
    return;
  }
  if (dialect === 'moonshot' && thinking !== 'off') {
    body.reasoning_effort = thinking;
    return;
  }
  if (dialect === 'zhipu') {
    // GLM-5.3 系列强制思考，thinking.type=disabled 会 400，只能调低推理强度
    body.reasoning_effort = thinking === 'off' ? 'low' : thinking;
  }
}

export class OpenAIChatModel implements ChatModel {
  public readonly modelName: string;
  private readonly client: OpenAI;
  private readonly dialect: LlmDialect;
  private readonly thinking: ThinkingMode;
  private readonly maxTokens?: number;

  constructor(options: OpenAIChatModelOptions) {
    this.modelName = options.model;
    this.dialect = options.dialect ?? 'openai';
    this.thinking = options.thinking ?? 'auto';
    this.maxTokens = options.maxTokens;
    this.client =
      options.client ??
      new OpenAI({
        baseURL: options.baseUrl,
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 120_000,
        maxRetries: options.maxRetries ?? 1,
      });
  }

  public async *streamChat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const tools = request.tools.length
      ? (request.tools as unknown as ChatCompletionTool[])
      : undefined;
    const thinking =
      request.enableNativeReasoning === false ? 'off' : this.thinking;
    const maxTokens = request.maxTokens ?? this.maxTokens;

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: toOpenAIMessages(
        request.messages,
        this.dialect === 'deepseek' || this.dialect === 'moonshot',
      ),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools ? { tools, tool_choice: request.toolChoice } : {}),
    };
    // Kimi 只接受固定温度 1.0，直接省略以避免供应商 400
    if (this.dialect !== 'moonshot') {
      body.temperature = request.temperature;
    }
    if (maxTokens) {
      body[
        this.dialect === 'moonshot' ? 'max_completion_tokens' : 'max_tokens'
      ] = maxTokens;
    }
    applyThinking(body, this.dialect, thinking);

    const stream = await this.client.chat.completions.create(
      body as unknown as ChatCompletionCreateParamsStreaming,
      { signal },
    );

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta as ReasoningDelta | undefined;
      const events: ChatStreamChunk[] = [];

      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        events.push({ reasoningDelta: reasoning });
      }
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        events.push({ contentDelta: delta.content });
      }
      for (const call of delta?.tool_calls ?? []) {
        events.push({
          toolCallDelta: {
            index: call.index ?? 0,
            id: call.id,
            name: call.function?.name,
            argumentsDelta: call.function?.arguments,
          },
        });
      }
      if (choice?.finish_reason) {
        events.push({ finishReason: choice.finish_reason });
      }
      const usage = chunk.usage as
        | {
            total_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          }
        | null
        | undefined;
      if (usage?.total_tokens || usage?.prompt_tokens || usage?.completion_tokens) {
        events.push({
          usage: {
            ...(usage.total_tokens ? { totalTokens: usage.total_tokens } : {}),
            ...(usage.prompt_tokens ? { inputTokens: usage.prompt_tokens } : {}),
            ...(usage.completion_tokens
              ? { outputTokens: usage.completion_tokens }
              : {}),
            ...(usage.prompt_tokens_details?.cached_tokens
              ? { cachedTokens: usage.prompt_tokens_details.cached_tokens }
              : {}),
          },
        });
      }
      for (const event of events) {
        yield event;
      }
    }
  }
}
