import { describe, expect, it } from 'vitest';
import { BuiltinToolProvider } from './BuiltinTools.js';
import { ReActRunner } from './ReActRunner.js';
import type {
  AgentStreamEvent,
  ChatCompletionRequest,
  ChatModel,
  ChatStreamChunk,
  DynamicLoopPolicy,
  ExecutionContext,
  IToolProvider,
  ToolApprovalRequest,
  ToolDefinition,
} from '../types/core.js';

class ScriptedModel implements ChatModel {
  public readonly modelName = 'scripted-model';
  public requests: ChatCompletionRequest[] = [];

  constructor(private readonly script: ChatStreamChunk[][]) {}

  public async *streamChat(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatStreamChunk> {
    this.requests.push(request);
    const turn = this.script.shift() ?? [{ finishReason: 'stop' }];
    for (const chunk of turn) {
      yield chunk;
    }
  }
}

const policy: DynamicLoopPolicy = {
  maxWallTimeMs: 120_000,
  maxTotalTokens: 64_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: false,
};

function makeContext(): ExecutionContext {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: () => Date.now(),
  };
}

function toolTurn(
  calls: Array<{
    index: number;
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>,
  usage = 10,
): ChatStreamChunk[] {
  return [
    ...calls.map(
      (call): ChatStreamChunk => ({
        toolCallDelta: {
          index: call.index,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.args),
        },
      }),
    ),
    { finishReason: 'tool_calls', usage: { totalTokens: usage } },
  ];
}

const userMessages = [{ role: 'user' as const, content: '现在几点？' }];

describe('ReActRunner', () => {
  it('流式输出原生思维链并完成多步工具调用', async () => {
    const fixed = Date.UTC(2026, 9, 30, 2, 0, 0);
    const model = new ScriptedModel([
      [
        { reasoningDelta: '我需要先获取当前时间。' },
        { contentDelta: '我来查询一下。' },
        ...toolTurn(
          [{ index: 0, id: 'call_time', name: 'current_time', args: {} }],
          12,
        ),
      ],
      [
        { reasoningDelta: '已经拿到时间。' },
        { contentDelta: '现在是 2026 年 10 月 30 日。' },
        { finishReason: 'stop', usage: { totalTokens: 8 } },
      ],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider({ now: () => fixed })],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      'turn_start',
      'reasoning_delta',
      'answer_delta',
      'answer_reset',
      'tool_start',
      'tool_end',
      'turn_start',
      'reasoning_delta',
      'answer_delta',
      'completed',
    ]);
    const reset = events.find((event) => event.type === 'answer_reset');
    expect(reset).toMatchObject({
      type: 'answer_reset',
      narration: '我来查询一下。',
    });
    const toolStart = events.find((event) => event.type === 'tool_start');
    expect(toolStart).toMatchObject({
      type: 'tool_start',
      toolName: 'current_time',
      args: {},
    });
    expect(
      toolStart && 'stepId' in toolStart ? toolStart.stepId : undefined,
    ).toBeTruthy();
    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd).toMatchObject({
      type: 'tool_end',
      toolName: 'current_time',
      isError: false,
    });
    expect(
      toolEnd && 'summary' in toolEnd ? toolEnd.summary : '',
    ).toContain('Asia/Shanghai');

    expect(result.answer).toBe('现在是 2026 年 10 月 30 日。');
    expect(result.narration).toBe('我来查询一下。');
    expect(result.reasoning).toBe('我需要先获取当前时间。已经拿到时间。');
    expect(result.usage.steps).toBe(2);
    expect(result.usage.totalTokens).toBe(20);

    expect(model.requests).toHaveLength(2);
    const second = model.requests[1];
    expect(second?.toolChoice).toBe('auto');
    expect(second?.tools.map((tool) => tool.function.name).sort()).toEqual([
      'calculator',
      'current_time',
      'system_status',
    ]);
    const toolMessage = second?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.toolCallId).toBe('call_time');
    const assistantWithCalls = second?.messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(assistantWithCalls?.toolCalls?.[0]?.function.name).toBe(
      'current_time',
    );
  });

  it('不设置静态步数上限，可连续多步工具直到自然收敛', async () => {
    const script: ChatStreamChunk[][] = [];
    for (let index = 0; index < 7; index += 1) {
      script.push(
        toolTurn([
          {
            index: 0,
            id: `call_${index}`,
            name: 'calculator',
            args: { expression: `${index}+1` },
          },
        ]),
      );
    }
    script.push([{ contentDelta: '全部计算完成。' }, { finishReason: 'stop' }]);

    const model = new ScriptedModel(script);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(model.requests).toHaveLength(8);
    expect(result.usage.steps).toBe(8);
    expect(
      events.filter((event) => event.type === 'tool_start'),
    ).toHaveLength(7);
    expect(result.answer).toBe('全部计算完成。');
  });

  it('同一轮内的多个工具会并发执行', async () => {
    let active = 0;
    let maxActive = 0;
    const makeTool = (name: string): ToolDefinition => ({
      name,
      description: name,
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return `${name} done`;
      },
    });
    const provider: IToolProvider = {
      providerName: 'parallel-test',
      getTools: async () => [makeTool('tool_a'), makeTool('tool_b')],
    };
    const model = new ScriptedModel([
      toolTurn([
        { index: 0, id: 'a', name: 'tool_a', args: {} },
        { index: 1, id: 'b', name: 'tool_b', args: {} },
      ]),
      [{ contentDelta: '完成' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [provider],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(maxActive).toBe(2);
    expect(
      events.filter((event) => event.type === 'tool_end'),
    ).toHaveLength(2);
  });

  it('连续相同工具调用会向模型注入 Harness 警告', async () => {
    const model = new ScriptedModel([
      toolTurn([{ index: 0, id: 'c1', name: 'current_time', args: {} }]),
      toolTurn([{ index: 0, id: 'c2', name: 'current_time', args: {} }]),
      [{ contentDelta: '时间已知。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy,
    });
    await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: () => undefined,
    });

    const thirdRequest = model.requests[2];
    expect(
      thirdRequest?.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Harness System Warning'),
      ),
    ).toBe(true);
  });

  it('Token 预算耗尽时进入禁止调用工具的收敛收尾', async () => {
    const model = new ScriptedModel([
      toolTurn([{ index: 0, id: 'c1', name: 'current_time', args: {} }], 10),
      [{ contentDelta: '根据已获取的信息完成回答。' }, { finishReason: 'stop', usage: { totalTokens: 5 } }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy: { ...policy, maxTotalTokens: 10 },
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.toolChoice).toBe('none');
    expect(
      model.requests[1]?.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Token 预算上限'),
      ),
    ).toBe(true);
    expect(result.answer).toBe('根据已获取的信息完成回答。');
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('时间预算耗尽时中止循环并完成收尾回答', async () => {
    let now = 0;
    const basePolicy = { ...policy, maxWallTimeMs: 1_000 };
    const model: ChatModel = {
      modelName: 'time-scripted',
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            toolCallDelta: {
              index: 0,
              id: 'c1',
              name: 'current_time',
              argumentsDelta: '{}',
            },
          };
          now = 2_000;
          yield { finishReason: 'tool_calls', usage: { totalTokens: 5 } };
          return;
        }
        yield { contentDelta: '时间预算已到，先给出已有结论。' };
        yield { finishReason: 'stop' };
      },
    };
    const requests: ChatCompletionRequest[] = [];
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy: basePolicy,
      now: () => now,
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: { ...makeContext(), deadlineAt: 1_000 },
      emit: (event) => events.push(event),
    });

    expect(requests[1]?.toolChoice).toBe('none');
    expect(result.answer).toBe('时间预算已到，先给出已有结论。');
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('工具抛错时标记 isError 并把错误观察交给模型', async () => {
    const provider: IToolProvider = {
      providerName: 'failing',
      getTools: async () => [
        {
          name: 'explode',
          description: 'always fails',
          parametersJsonSchema: { type: 'object', properties: {} },
          execute: async () => {
            throw new Error('磁盘已满');
          },
        },
      ],
    };
    const model = new ScriptedModel([
      toolTurn([{ index: 0, id: 'e1', name: 'explode', args: {} }]),
      [{ contentDelta: '工具执行失败，但已给出结论。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({ model, toolProviders: [provider], policy });
    const events: AgentStreamEvent[] = [];

    await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd).toMatchObject({ isError: true });
    expect(
      toolEnd && 'summary' in toolEnd ? toolEnd.summary : '',
    ).toContain('磁盘已满');
    const toolMessage = model.requests[1]?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content).toContain('Error: 磁盘已满');
  });

  it('调用不存在的工具会返回错误观察', async () => {
    const model = new ScriptedModel([
      toolTurn([{ index: 0, id: 'u1', name: 'missing_tool', args: {} }]),
      [{ contentDelta: '改用现有信息回答。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd).toMatchObject({ toolName: 'missing_tool', isError: true });
    expect(
      toolEnd && 'summary' in toolEnd ? toolEnd.summary : '',
    ).toContain('不存在');
  });

  it('没有工具调用时单轮自然收敛', async () => {
    const model = new ScriptedModel([
      [
        { reasoningDelta: '这是简单问题。' },
        { contentDelta: '直接回答。' },
        { finishReason: 'stop', usage: { totalTokens: 3 } },
      ],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(model.requests).toHaveLength(1);
    expect(result.usage.steps).toBe(1);
    expect(events.some((event) => event.type === 'tool_start')).toBe(false);
    expect(result.reasoning).toBe('这是简单问题。');
  });

  it('写操作未获确认时阻断执行并直接给出确认提示', async () => {
    let executed = 0;
    const provider: IToolProvider = {
      providerName: 'risky',
      getTools: async () => [
        {
          name: 'delete_user',
          description: '删除用户',
          risk: 'destructive',
          parametersJsonSchema: { type: 'object', properties: {} },
          execute: async () => {
            executed += 1;
            return 'deleted';
          },
        },
      ],
    };
    const model = new ScriptedModel([
      toolTurn([
        { index: 0, id: 'd1', name: 'delete_user', args: { id: 'u-1' } },
      ]),
      [{ contentDelta: '模型不应有机会继续。' }, { finishReason: 'stop' }],
    ]);
    const approvals: ToolApprovalRequest[] = [];
    const runner = new ReActRunner({
      model,
      toolProviders: [provider],
      policy,
      approval: async (request) => {
        approvals.push(request);
        return {
          approved: false,
          reason: '删除用户需要二次确认，发送 /confirm 在 60 秒内确认。',
        };
      },
    });
    const events: AgentStreamEvent[] = [];

    const result = await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(executed).toBe(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      toolName: 'delete_user',
      risk: 'destructive',
      args: { id: 'u-1' },
      conversationId: 'conv-1',
      senderStaffId: 'staff-1',
    });
    expect(model.requests).toHaveLength(1);
    expect(result.answer).toContain('/confirm');
    const toolEnd = events.find((event) => event.type === 'tool_end');
    expect(toolEnd).toMatchObject({ toolName: 'delete_user', isError: true });
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('规划器产出计划并在工具轮后推进状态', async () => {
    const model = new ScriptedModel([
      toolTurn([{ index: 0, id: 'c1', name: 'current_time', args: {} }]),
      [{ contentDelta: '时间已知。' }, { finishReason: 'stop' }],
    ]);
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy,
      planner: async () => [
        { id: 'step_1', text: '获取当前时间', status: 'pending' },
        { id: 'step_2', text: '汇总结论', status: 'pending' },
      ],
    });
    const events: AgentStreamEvent[] = [];

    await runner.run({
      messages: userMessages,
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    const plans = events.filter((event) => event.type === 'plan');
    expect(plans).toHaveLength(3);
    expect(plans[0]).toMatchObject({
      items: [
        { text: '获取当前时间', status: 'pending' },
        { text: '汇总结论', status: 'pending' },
      ],
    });
    expect(plans[1]).toMatchObject({
      items: [
        { text: '获取当前时间', status: 'done' },
        { text: '汇总结论', status: 'running' },
      ],
    });
    expect(plans[2]).toMatchObject({
      items: [
        { text: '获取当前时间', status: 'done' },
        { text: '汇总结论', status: 'done' },
      ],
    });
    expect(
      model.requests[0]?.messages.some(
        (message) =>
          message.role === 'system' && message.content.includes('执行计划'),
      ),
    ).toBe(true);
  });

  it('模型异常时发出 error 事件并向上抛出', async () => {
    const model: ChatModel = {
      modelName: 'broken',
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('上游模型不可用');
      },
    };
    const runner = new ReActRunner({
      model,
      toolProviders: [new BuiltinToolProvider()],
      policy,
    });
    const events: AgentStreamEvent[] = [];

    await expect(
      runner.run({
        messages: userMessages,
        context: makeContext(),
        emit: (event) => events.push(event),
      }),
    ).rejects.toThrow('上游模型不可用');
    expect(events).toEqual([
      { type: 'turn_start', turnId: expect.any(String), step: 1 },
      { type: 'error', message: '上游模型不可用', retryable: true },
    ]);
  });
});
