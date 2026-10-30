import { describe, expect, it } from 'vitest';
import { SubagentToolProvider, isReadOnlyTool } from './SubagentToolProvider.js';
import type {
  ChatCompletionRequest,
  ChatModel,
  ChatStreamChunk,
  DynamicLoopPolicy,
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';

class ScriptedModel implements ChatModel {
  public readonly modelName = 'subagent-scripted';
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
  maxWallTimeMs: 120_000,
  maxTotalTokens: 64_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: false,
};

function context(): ExecutionContext {
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

function provider(tools: ToolDefinition[]): IToolProvider {
  return {
    providerName: 'test-tools',
    getTools: async () => tools,
  };
}

describe('isReadOnlyTool', () => {
  it('过滤写操作、管理工具与自身', () => {
    const base = {
      description: '',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: async () => '',
    };
    expect(isReadOnlyTool({ ...base, name: 'search_docs' })).toBe(true);
    expect(isReadOnlyTool({ ...base, name: 'create_ticket' })).toBe(false);
    expect(isReadOnlyTool({ ...base, name: 'delegate_research' })).toBe(false);
    expect(isReadOnlyTool({ ...base, name: 'admin_inspect_system_status' })).toBe(
      false,
    );
    expect(
      isReadOnlyTool({ ...base, name: 'mcp__crm__delete_contact', risk: 'read' }),
    ).toBe(false);
  });
});

describe('SubagentToolProvider', () => {
  it('委派只读研究并在隔离上下文中返回摘要与引用', async () => {
    let writeCalls = 0;
    const readTool: ToolDefinition = {
      name: 'read_log',
      description: '读取错误日志',
      risk: 'read',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: async () => 'ERROR 12:09 timeout at https://ops.example.com/logs/42',
    };
    const writeTool: ToolDefinition = {
      name: 'create_ticket',
      description: '创建工单',
      risk: 'write',
      parametersJsonSchema: { type: 'object', properties: {} },
      execute: async () => {
        writeCalls += 1;
        return 'created';
      },
    };
    const model = new ScriptedModel([
      [
        {
          toolCallDelta: {
            index: 0,
            id: 'call_1',
            name: 'read_log',
            argumentsDelta: '{"service":"pay"}',
          },
        },
        { finishReason: 'tool_calls' },
      ],
      [
        {
          contentDelta:
            '支付接口超时的根因是下游风控服务抖动，详见 https://ops.example.com/logs/42',
        },
        { finishReason: 'stop' },
      ],
    ]);
    const container: IToolProvider[] = [provider([readTool, writeTool])];
    const subagent = new SubagentToolProvider({
      model,
      providers: () => container,
      policy,
    });
    container.push(subagent);
    const tools = await subagent.getTools(context());
    expect(tools.map((tool) => tool.name)).toEqual(['delegate_research']);

    const output = await tools[0]!.executeStructured!(
      { task: '排查支付接口超时' },
      context(),
    );
    expect(writeCalls).toBe(0);
    expect(output.text).toContain('[子代理结论]');
    expect(output.text).toContain('https://ops.example.com/logs/42');
    expect(output.citations?.[0]?.url).toBe('https://ops.example.com/logs/42');
    expect(output.summary).toContain('下游风控服务');
    expect(model.requests).toHaveLength(2);
    const subagentToolNames = model.requests[0]?.tools.map(
      (tool) => tool.function.name,
    );
    expect(subagentToolNames).toEqual(['read_log']);
  });

  it('没有可用只读工具时不暴露委派工具', async () => {
    const subagent = new SubagentToolProvider({
      model: new ScriptedModel([]),
      providers: () => [
        provider([
          {
            name: 'send_message',
            description: '发送消息',
            risk: 'write',
            parametersJsonSchema: { type: 'object', properties: {} },
            execute: async () => '',
          },
        ]),
      ],
      policy,
    });
    expect(await subagent.getTools(context())).toEqual([]);
  });

  it('task 为空时返回错误而不调用模型', async () => {
    const model = new ScriptedModel([]);
    const subagent = new SubagentToolProvider({
      model,
      providers: () => [
        provider([
          {
            name: 'read_log',
            description: '读取日志',
            parametersJsonSchema: { type: 'object', properties: {} },
            execute: async () => '',
          },
        ]),
      ],
      policy,
    });
    const [tool] = await subagent.getTools(context());
    const output = await tool!.executeStructured!({ task: '   ' }, context());
    expect(output.text).toContain('Error');
    expect(model.requests).toHaveLength(0);
  });
});
