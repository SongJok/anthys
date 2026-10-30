import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatStreamChunk,
  ToolSchema,
} from '../types/core.js';
import {
  AnthropicChatModel,
  toAnthropicMessages,
} from './AnthropicChatModel.js';
import { OpenAIChatModel, toOpenAIMessages } from './OpenAIChatModel.js';

function asyncStream<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

async function collect(
  iterable: AsyncIterable<ChatStreamChunk>,
): Promise<ChatStreamChunk[]> {
  const chunks: ChatStreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const tools: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'current_time',
      description: '返回当前时间',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function makeRequest(
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    messages: [
      { role: 'system', content: '你是小钉' },
      { role: 'user', content: '现在几点' },
    ],
    tools,
    toolChoice: 'auto',
    temperature: 0.3,
    enableNativeReasoning: true,
    ...overrides,
  };
}

function sseBody(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join('');
}

describe('toOpenAIMessages', () => {
  it('maps tool results, assistant tool calls and plain messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'current_time', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: '12:00', toolCallId: 'call_1' },
      { role: 'user', content: '谢谢' },
    ];

    expect(toOpenAIMessages(messages)).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'current_time', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
      { role: 'user', content: '谢谢' },
    ]);
  });
});

describe('OpenAIChatModel', () => {
  it('streams reasoning, content, tool calls, finish reason and usage in order', async () => {
    const chunks = [
      { choices: [{ delta: { reasoning_content: '先看时间' } }] },
      { choices: [{ delta: { content: '稍等' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'current_time', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { total_tokens: 42 } },
    ];
    const create = vi.fn(
      async (_body: unknown, _options?: unknown) => asyncStream(chunks),
    );
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const model = new OpenAIChatModel({
      baseUrl: 'https://api.deepseek.test/v1',
      apiKey: 'sk-test',
      model: 'deepseek-reasoner',
      client,
    });

    const events = await collect(model.streamChat(makeRequest()));

    expect(events).toEqual([
      { reasoningDelta: '先看时间' },
      { contentDelta: '稍等' },
      {
        toolCallDelta: {
          index: 0,
          id: 'call_1',
          name: 'current_time',
          argumentsDelta: '{}',
        },
      },
      { finishReason: 'tool_calls' },
      { usage: { totalTokens: 42 } },
    ]);

    const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: 'deepseek-reasoner',
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          function: { name: 'current_time' },
        },
      ],
      messages: [
        { role: 'system', content: '你是小钉' },
        { role: 'user', content: '现在几点' },
      ],
    });
  });

  it('omits tool fields when no tools are available', async () => {
    const create = vi.fn(
      async (_body: unknown, _options?: unknown) =>
        asyncStream([{ choices: [{ delta: { content: '完成' } }] }]),
    );
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const model = new OpenAIChatModel({
      baseUrl: 'https://api.deepseek.test/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      client,
    });

    await collect(model.streamChat(makeRequest({ tools: [] })));

    const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tools');
    expect(payload).not.toHaveProperty('tool_choice');
  });
});

describe('toAnthropicMessages', () => {
  it('merges system prompts and keeps tool results in user turns', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '人设一' },
      { role: 'system', content: '人设二' },
      { role: 'user', content: '现在几点' },
      {
        role: 'assistant',
        content: '我查一下',
        toolCalls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: {
              name: 'current_time',
              arguments: '{"timezone":"Asia/Shanghai"}',
            },
          },
        ],
      },
      { role: 'tool', content: '12:00', toolCallId: 'toolu_1' },
    ];

    expect(toAnthropicMessages(messages)).toEqual({
      system: '人设一\n\n人设二',
      messages: [
        { role: 'user', content: '现在几点' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我查一下' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'current_time',
              input: { timezone: 'Asia/Shanghai' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '12:00' },
          ],
        },
      ],
    });
  });
});

describe('AnthropicChatModel', () => {
  it('parses thinking, tool_use, text and usage from SSE', async () => {
    const body = sseBody([
      '{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先查时间"}}',
      '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"current_time"}}',
      '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"timezone\\":\\"Asia/Shanghai\\"}"}}',
      '{"type":"content_block_start","index":2,"content_block":{"type":"text"}}',
      '{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"现在是 12:00"}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
      '[DONE]',
    ]);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const model = new AnthropicChatModel({
      baseUrl: 'https://api.anthropic.test/v1/',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(model.streamChat(makeRequest()));

    expect(events).toEqual([
      { reasoningDelta: '先查时间' },
      { toolCallDelta: { index: 1, id: 'toolu_1', name: 'current_time' } },
      {
        toolCallDelta: {
          index: 1,
          argumentsDelta: '{"timezone":"Asia/Shanghai"}',
        },
      },
      { contentDelta: '现在是 12:00' },
      { finishReason: 'tool_calls' },
      { usage: { totalTokens: 15 } },
    ]);

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://api.anthropic.test/v1/messages');
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-sonnet-4',
      max_tokens: 8192,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      system: '你是小钉',
      tools: [
        {
          name: 'current_time',
          description: '返回当前时间',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: '现在几点' }],
    });
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('temperature');
  });

  it('sends temperature and no thinking block when native reasoning is off', async () => {
    const body = sseBody([
      '{"type":"message_start","message":{"usage":{"input_tokens":2}}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '{"type":"message_stop"}',
    ]);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body, { status: 200 }),
    );
    const model = new AnthropicChatModel({
      baseUrl: 'https://api.anthropic.test',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events = await collect(
      model.streamChat(makeRequest({ enableNativeReasoning: false, tools: [] })),
    );

    expect(events).toEqual([
      { contentDelta: '好' },
      { finishReason: 'stop' },
      { usage: { totalTokens: 3 } },
    ]);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.anthropic.test/v1/messages',
    );
    expect(payload.temperature).toBe(0.3);
    expect(payload).not.toHaveProperty('thinking');
    expect(payload).not.toHaveProperty('tools');
    expect(payload.max_tokens).toBe(4096);
  });

  it('surfaces API errors with status and detail', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 }));
    const model = new AnthropicChatModel({
      baseUrl: 'https://api.anthropic.test',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(collect(model.streamChat(makeRequest()))).rejects.toThrow(
      'Anthropic API 401: bad key',
    );
  });

  it('throws when the stream reports an error event', async () => {
    const body = sseBody([
      '{"type":"error","error":{"message":"overloaded"}}',
    ]);
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const model = new AnthropicChatModel({
      baseUrl: 'https://api.anthropic.test',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(collect(model.streamChat(makeRequest()))).rejects.toThrow(
      'overloaded',
    );
  });
});
