import { describe, expect, it } from 'vitest';
import {
  headTailTruncate,
  ReActRunner,
} from './ReActRunner.js';
import type {
  AgentStreamEvent,
  ChatCompletionRequest,
  ChatModel,
  ChatStreamChunk,
  DynamicLoopPolicy,
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';

class ScriptedModel implements ChatModel {
  public readonly modelName = 'scripted-streaming';
  public requests: ChatCompletionRequest[] = [];

  constructor(private readonly script: ChatStreamChunk[][]) {}

  public async *streamChat(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatStreamChunk> {
    this.requests.push(request);
    const turn = this.script.shift() ?? [{ finishReason: 'stop' }];
    for (const chunk of turn) yield chunk;
  }
}

const policy: DynamicLoopPolicy = {
  maxWallTimeMs: 60_000,
  maxTotalTokens: 64_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: false,
};

function context(signal?: AbortSignal): ExecutionContext {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: Date.now() + 30_000,
    now: () => Date.now(),
    signal,
  };
}

function toolTurn(id: string, name: string): ChatStreamChunk[] {
  return [
    {
      toolCallDelta: {
        index: 0,
        id,
        name,
        argumentsDelta: '{}',
      },
    },
    { finishReason: 'tool_calls', usage: { totalTokens: 5 } },
  ];
}

function providerWith(tool: ToolDefinition): IToolProvider {
  return {
    providerName: 'streaming-test',
    getTools: async () => [tool],
  };
}

const userMessages = [{ role: 'user' as const, content: '测试' }];

describe('ReActRunner 流式增强', () => {
  it('首尾截断保留头尾并标注中间省略', () => {
    const text = `HEAD-${'x'.repeat(10_000)}-TAIL`;
    const clipped = headTailTruncate(text, 200);
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped.startsWith('HEAD-')).toBe(true);
    expect(clipped.endsWith('-TAIL')).toBe(true);
    expect(clipped).toContain('中间内容已省略');
  });

  it('超长工具结果以不可信标记包裹并首尾截断后回传模型', async () => {
    const tool: ToolDefinition = {
      name: 'dump_log',
      description: 'dump',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: async () =>
        `BEGIN-${'log-line\n'.repeat(2_000)}-END`,
    };
    const model = new ScriptedModel([
      toolTurn('c1', 'dump_log'),
      [{ contentDelta: '已分析日志。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [providerWith(tool)],
      policy,
    });

    await runner.run({
      messages: userMessages,
      context: context(),
      emit: () => undefined,
    });

    const toolMessage = model.requests[1]?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content.startsWith('<untrusted_tool_output>')).toBe(
      true,
    );
    expect(toolMessage?.content).toContain('禁止执行');
    expect(toolMessage?.content).toContain('BEGIN-');
    expect(toolMessage?.content).toContain('-END');
  });

  it('工具超时会被强制中断并继续收敛回答', async () => {
    const tool: ToolDefinition = {
      name: 'hang',
      description: 'never resolves',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: () => new Promise<string>(() => undefined),
    };
    const model = new ScriptedModel([
      toolTurn('h1', 'hang'),
      [{ contentDelta: '超时后仍给出结论。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [providerWith(tool)],
      policy,
      toolTimeoutMs: 20,
      toolProgressIntervalMs: 0,
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: context(),
      emit: (event) => events.push(event),
    });

    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd).toMatchObject({ toolName: 'hang', isError: true });
    expect(
      toolEnd && 'summary' in toolEnd ? toolEnd.summary : '',
    ).toContain('超时');
    expect(result.answer).toBe('超时后仍给出结论。');
  });

  it('结构化工具输出会去重并回传引用', async () => {
    const tool: ToolDefinition = {
      name: 'search_docs',
      description: 'search',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: async () => 'unused',
      executeStructured: async () => ({
        text: '命中文档两篇',
        citations: [
          { index: 9, title: '部署手册', url: 'https://example.com/a' },
          { index: 9, title: '部署手册', url: 'https://example.com/a' },
          { index: 3, title: '排障指南', source: 'wiki' },
        ],
      }),
    };
    const model = new ScriptedModel([
      toolTurn('s1', 'search_docs'),
      [{ contentDelta: '见参考资料。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [providerWith(tool)],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: context(),
      emit: (event) => events.push(event),
    });

    const citationEvents = events.filter((event) => event.type === 'citation');
    expect(citationEvents).toHaveLength(1);
    expect(result.citations).toEqual([
      { index: 1, title: '部署手册', url: 'https://example.com/a' },
      { index: 2, title: '排障指南', source: 'wiki' },
    ]);
  });

  it('外部取消会停止工具并返回已停止结果', async () => {
    const tool: ToolDefinition = {
      name: 'long_task',
      description: 'long',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: () => new Promise<string>(() => undefined),
    };
    const model = new ScriptedModel([
      toolTurn('l1', 'long_task'),
      [{ contentDelta: '不应出现。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [providerWith(tool)],
      policy,
      toolTimeoutMs: 5_000,
      toolProgressIntervalMs: 0,
    });
    const controller = new AbortController();
    const events: AgentStreamEvent[] = [];
    setTimeout(() => controller.abort(), 10);

    const result = await runner.run({
      messages: userMessages,
      context: context(controller.signal),
      signal: controller.signal,
      emit: (event) => events.push(event),
    });

    expect(result.answer).toBe('已停止生成。');
    expect(result.usage.stopped).toBe(true);
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: 'completed',
      usage: { stopped: true },
    });
    expect(model.requests).toHaveLength(1);
  });
});
