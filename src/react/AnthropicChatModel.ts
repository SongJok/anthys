import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatModel,
  ChatStreamChunk,
} from '../types/core.js';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicChatModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 模型输出的参数不合法时回退为空对象，由工具侧报错
  }
  return {};
}

export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      };
      const last = converted[converted.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        converted.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant') {
      if (message.toolCalls?.length) {
        const blocks: AnthropicBlock[] = [];
        if (message.content.length > 0) {
          blocks.push({ type: 'text', text: message.content });
        }
        for (const call of message.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: safeParseArguments(call.function.arguments),
          });
        }
        converted.push({ role: 'assistant', content: blocks });
      } else {
        converted.push({ role: 'assistant', content: message.content });
      }
      continue;
    }
    converted.push({ role: 'user', content: message.content });
  }

  return { system: systemParts.join('\n\n'), messages: converted };
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        line = line.replace(/\r$/, '');
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') {
            yield JSON.parse(data) as Record<string, unknown>;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class AnthropicChatModel implements ChatModel {
  public readonly modelName: string;
  private readonly options: AnthropicChatModelOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicChatModelOptions) {
    this.options = options;
    this.modelName = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async *streamChat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const thinking = request.enableNativeReasoning;
    const maxTokens = thinking
      ? Math.max(this.options.maxTokens ?? 8_192, 2_048)
      : (this.options.maxTokens ?? 4_096);
    const thinkingBudget = Math.min(
      this.options.thinkingBudgetTokens ?? 2_048,
      maxTokens - 1_024,
    );

    const { system, messages } = toAnthropicMessages(request.messages);
    const url = this.options.baseUrl.replace(/\/$/, '');
    const endpoint = url.endsWith('/v1')
      ? `${url}/messages`
      : `${url}/v1/messages`;

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (!thinking) body.temperature = request.temperature;
    if (thinking && thinkingBudget >= 1_024) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
      body.tool_choice =
        request.toolChoice === 'none' ? { type: 'none' } : { type: 'auto' };
    } else if (request.toolChoice === 'none') {
      body.tool_choice = { type: 'none' };
    }

    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version':
          this.options.anthropicVersion ?? '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Anthropic API ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of readSse(response.body)) {
      const type = event.type;
      if (type === 'message_start') {
        const message = event.message as
          | { usage?: { input_tokens?: number } }
          | undefined;
        inputTokens = message?.usage?.input_tokens ?? inputTokens;
        continue;
      }
      if (type === 'content_block_start') {
        const index = Number(event.index ?? 0);
        const block = event.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (block?.type === 'tool_use') {
          yield {
            toolCallDelta: { index, id: block.id, name: block.name },
          };
        }
        continue;
      }
      if (type === 'content_block_delta') {
        const index = Number(event.index ?? 0);
        const delta = event.delta as
          | {
              type?: string;
              text?: string;
              thinking?: string;
              partial_json?: string;
            }
          | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          yield { contentDelta: delta.text };
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { reasoningDelta: delta.thinking };
        } else if (
          delta?.type === 'input_json_delta' &&
          delta.partial_json
        ) {
          yield {
            toolCallDelta: { index, argumentsDelta: delta.partial_json },
          };
        }
        continue;
      }
      if (type === 'message_delta') {
        const delta = event.delta as { stop_reason?: string } | undefined;
        const usage = event.usage as
          | { output_tokens?: number }
          | undefined;
        outputTokens = usage?.output_tokens ?? outputTokens;
        if (delta?.stop_reason) {
          yield {
            finishReason:
              delta.stop_reason === 'tool_use'
                ? 'tool_calls'
                : delta.stop_reason === 'end_turn'
                  ? 'stop'
                  : delta.stop_reason,
          };
        }
        continue;
      }
      if (type === 'error') {
        const error = event.error as { message?: string } | undefined;
        throw new Error(error?.message ?? 'Anthropic 流式响应错误');
      }
      if (type === 'message_stop') {
        yield { usage: { totalTokens: inputTokens + outputTokens } };
      }
    }
  }
}
