import { describe, expect, it } from 'vitest';
import {
  advancePlan,
  createPlanner,
  finalizePlan,
  parsePlanSteps,
  renderPlanPrompt,
} from './Planner.js';
import type { ChatCompletionRequest, ChatModel, ChatStreamChunk } from '../types/core.js';

class ScriptedModel implements ChatModel {
  public readonly modelName = 'planner-scripted';
  public requests: ChatCompletionRequest[] = [];

  constructor(private readonly chunks: ChatStreamChunk[]) {}

  public async *streamChat(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatStreamChunk> {
    this.requests.push(request);
    for (const chunk of this.chunks) yield chunk;
  }
}

const tools = [
  {
    name: 'dws_doc_search',
    description: 'search',
    parametersJsonSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  },
];

describe('parsePlanSteps', () => {
  it('从 JSON 中提取步骤并限制数量', () => {
    const steps = parsePlanSteps(
      '```json\n{"steps":["查日志","查发布记录","汇总"]}\n```',
    );
    expect(steps).toEqual(['查日志', '查发布记录', '汇总']);
    expect(parsePlanSteps('{"steps":["a","b","c","d"]}', 2)).toEqual([
      'a',
      'b',
    ]);
  });

  it('非法输出返回空数组', () => {
    expect(parsePlanSteps('不是 JSON')).toEqual([]);
    expect(parsePlanSteps('{"steps":[1,2]}')).toEqual([]);
  });
});

describe('createPlanner', () => {
  it('关闭时不创建规划器', () => {
    expect(
      createPlanner({ model: new ScriptedModel([]), enabled: false }),
    ).toBeUndefined();
  });

  it('复杂问题产出计划并请求规划模型', async () => {
    const model = new ScriptedModel([
      { contentDelta: '{"steps":["查询错误日志","核对最近发布","给出结论"]}' },
      { finishReason: 'stop' },
    ]);
    const planner = createPlanner({ model, enabled: true, minQuestionChars: 10 });
    const plan = await planner!({
      messages: [
        {
          role: 'user',
          content: '线上支付接口从今天 9 点开始持续超时，请排查原因并给出处理建议。',
        },
      ],
      tools,
    });
    expect(plan?.map((item) => item.text)).toEqual([
      '查询错误日志',
      '核对最近发布',
      '给出结论',
    ]);
    expect(plan?.[0]?.status).toBe('pending');
    expect(model.requests[0]?.toolChoice).toBe('none');
    expect(model.requests[0]?.messages[0]?.content).toContain('任务规划器');
  });

  it('简单问题不调用规划模型', async () => {
    const model = new ScriptedModel([]);
    const planner = createPlanner({
      model,
      enabled: true,
      minQuestionChars: 100,
      minTools: 100,
    });
    const plan = await planner!({
      messages: [{ role: 'user', content: '现在几点？' }],
      tools,
    });
    expect(plan).toBeNull();
    expect(model.requests).toHaveLength(0);
  });

  it('模型输出不可解析时返回 null 而不是抛错', async () => {
    const model = new ScriptedModel([{ contentDelta: '抱歉我无法规划' }]);
    const planner = createPlanner({ model, enabled: true, minQuestionChars: 1 });
    await expect(
      planner!({
        messages: [{ role: 'user', content: '排查线上故障' }],
        tools,
      }),
    ).resolves.toBeNull();
  });
});

describe('计划状态', () => {
  const items = [
    { id: 'step_1', text: 'a', status: 'pending' as const },
    { id: 'step_2', text: 'b', status: 'pending' as const },
    { id: 'step_3', text: 'c', status: 'pending' as const },
  ];

  it('按完成数推进状态', () => {
    expect(advancePlan(items, 1).map((item) => item.status)).toEqual([
      'done',
      'running',
      'pending',
    ]);
  });

  it('收尾时全部标记完成', () => {
    expect(finalizePlan(items).every((item) => item.status === 'done')).toBe(
      true,
    );
  });

  it('计划提示包含所有步骤', () => {
    const prompt = renderPlanPrompt(items);
    expect(prompt).toContain('1. a');
    expect(prompt).toContain('3. c');
  });
});
