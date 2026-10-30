import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatModel,
  ChatStreamChunk,
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
  timeoutMs?: number;
  maxRetries?: number;
  client?: OpenAI;
}

export function toOpenAIMessages(
  messages: ChatMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      } satisfies ChatCompletionMessageParam;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls,
      } satisfies ChatCompletionMessageParam;
    }
    return {
      role: message.role,
      content: message.content,
    } satisfies ChatCompletionMessageParam;
  });
}

export class OpenAIChatModel implements ChatModel {
  public readonly modelName: string;
  private readonly client: OpenAI;

  constructor(options: OpenAIChatModelOptions) {
    this.modelName = options.model;
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

    const stream = await this.client.chat.completions.create(
      {
        model: this.modelName,
        messages: toOpenAIMessages(request.messages),
        temperature: request.temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools
          ? { tools, tool_choice: request.toolChoice }
          : {}),
      },
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
      if (chunk.usage?.total_tokens) {
        events.push({ usage: { totalTokens: chunk.usage.total_tokens } });
      }
      for (const event of events) {
        yield event;
      }
    }
  }
}
