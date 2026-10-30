import { describe, expect, it } from 'vitest';
import {
  BystanderTriageEngine,
  HeuristicBystanderClassifier,
  LlmBystanderClassifier,
  type BystanderClassifier,
  type BystanderClassifierInput,
} from './BystanderTriageEngine.js';
import { CooldownLimiter } from './CooldownLimiter.js';
import { GroupTranscriptBuffer } from './GroupTranscriptBuffer.js';
import {
  createDefaultBystanderPolicy,
  type BystanderEvaluationResult,
  type GroupBystanderPolicy,
  type TranscriptEntry,
} from '../types/bystander-and-memory.js';
import type {
  ChatModel,
  ChatStreamChunk,
  InboundMessage,
} from '../types/core.js';

const BASE_TIME = Date.UTC(2026, 9, 30, 6, 0, 0);

function inbound(
  overrides: Partial<InboundMessage> = {},
  nowMs = BASE_TIME,
): InboundMessage {
  return {
    messageId: `msg-${Math.random().toString(16).slice(2)}`,
    conversationId: 'cid-g',
    conversationType: '2',
    senderStaffId: 'staff-a',
    senderNick: '王五',
    isAtBot: false,
    text: '订单接口怎么一直报 504 网关超时？',
    rawPayload: {},
    timestamp: nowMs,
    ...overrides,
  };
}

function transcript(
  messageId: string,
  text: string,
  timestamp: number,
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    conversationId: 'cid-g',
    messageId,
    senderStaffId: 'staff-b',
    senderNick: '李四',
    text,
    isAtBot: false,
    timestamp,
    ...overrides,
  };
}

function setup(options: {
  policy?: Partial<GroupBystanderPolicy>;
  classifier?: BystanderClassifier;
  sleep?: (ms: number) => Promise<void>;
} = {}): {
  engine: BystanderTriageEngine;
  buffer: GroupTranscriptBuffer;
  policy: GroupBystanderPolicy;
  clock: { now: number };
  classifierCalls: BystanderClassifierInput[];
} {
  const clock = { now: BASE_TIME };
  const buffer = new GroupTranscriptBuffer({ defaultWindowSize: 20 });
  const classifierCalls: BystanderClassifierInput[] = [];
  const target = new HeuristicBystanderClassifier();
  const classifier = options.classifier ?? {
    async classify(input) {
      classifierCalls.push(input);
      return target.classify(input);
    },
  };
  const engine = new BystanderTriageEngine({
    buffer,
    cooldown: new CooldownLimiter({ now: () => clock.now }),
    classifier,
    debounceMs: 8_000,
    sleep:
      options.sleep ??
      (async (ms) => {
        clock.now += ms;
      }),
    now: () => clock.now,
  });
  const policy = createDefaultBystanderPolicy('cid-g', options.policy);
  return { engine, buffer, policy, clock, classifierCalls };
}

describe('BystanderTriageEngine', () => {
  it('日常闲聊与确认短语在 L1/L2 零 Token 静默', async () => {
    const casual = setup();
    const casualResult = await casual.engine.evaluate(
      inbound({ text: '今天下午茶吃什么？' }),
      casual.policy,
    );
    expect(casualResult.action).toBe('SILENT');
    expect(casual.classifierCalls).toHaveLength(0);

    const ack = setup();
    const ackResult = await ack.engine.evaluate(
      inbound({ text: '收到' }),
      ack.policy,
    );
    expect(ackResult.action).toBe('SILENT');
    expect(ack.classifierCalls).toHaveLength(0);
  });

  it('线上报错无人响应时升级为 PROACTIVE_REPLY 并提炼查证问题', async () => {
    const ctx = setup();
    const result = await ctx.engine.evaluate(
      inbound({ text: '订单接口一直报 504 网关超时，帮忙看下' }),
      ctx.policy,
    );

    expect(result.action).toBe('PROACTIVE_REPLY');
    expect(result.triggerReason).toBe('PROD_INCIDENT');
    expect(result.confidence).toBeGreaterThanOrEqual(
      ctx.policy.confidenceThreshold,
    );
    expect(result.extractedQuery).toContain('504');
    expect(ctx.classifierCalls).toHaveLength(1);
    expect(ctx.engine.isCoolingDown('cid-g', ctx.policy)).toBe(true);
  });

  it('防抢答窗口内同事已回复时自动取消插话', async () => {
    let bufferRef: GroupTranscriptBuffer | undefined;
    let clockRef: { now: number } | undefined;
    const ctx = setup({
      async sleep(ms) {
        bufferRef?.append(
          transcript('reply-1', '我看了下，是网关连接池打满了', BASE_TIME + 3_000),
        );
        if (clockRef) clockRef.now += ms;
      },
    });
    bufferRef = ctx.buffer;
    clockRef = ctx.clock;

    const result = await ctx.engine.evaluate(inbound(), ctx.policy);
    expect(result.action).toBe('SILENT');
    expect(result.rationale).toContain('防抢答窗口');
    expect(ctx.classifierCalls).toHaveLength(0);
  });

  it('同一群冷却期内不再重复主动回复', async () => {
    const ctx = setup();
    await ctx.engine.evaluate(inbound({ messageId: 'm1' }), ctx.policy);
    const second = await ctx.engine.evaluate(
      inbound({ messageId: 'm2', text: '支付服务也挂了，谁能看下日志？' }),
      ctx.policy,
    );

    expect(second.action).toBe('SILENT');
    expect(second.rationale).toContain('冷却');
  });

  it('置信度低于阈值时保守静默', async () => {
    const classifier: BystanderClassifier = {
      async classify(): Promise<BystanderEvaluationResult> {
        return {
          action: 'PROACTIVE_REPLY',
          confidence: 0.5,
          triggerReason: 'UNANSWERED_QUESTION',
          extractedQuery: '查日志',
          rationale: 'test',
        };
      },
    };
    const ctx = setup({ classifier });
    const result = await ctx.engine.evaluate(inbound(), ctx.policy);

    expect(result.action).toBe('SILENT');
    expect(result.rationale).toContain('低于阈值');
    expect(ctx.engine.isCoolingDown('cid-g', ctx.policy)).toBe(false);
  });

  it('群内过于活跃时 L1 直接静默', async () => {
    const ctx = setup();
    for (let index = 0; index < 11; index += 1) {
      ctx.buffer.append(
        transcript(`chat-${index}`, `讨论 ${index}`, BASE_TIME - index * 1_000),
      );
    }
    const result = await ctx.engine.evaluate(inbound(), ctx.policy);

    expect(result.action).toBe('SILENT');
    expect(result.rationale).toContain('过于活跃');
  });

  it('关闭自主回复后保持静默', async () => {
    const ctx = setup({ policy: { proactiveReplyEnabled: false } });
    const result = await ctx.engine.evaluate(inbound(), ctx.policy);

    expect(result.action).toBe('SILENT');
    expect(result.rationale).toContain('未开启');
  });

  it('L2 拿到最近 15 条窗口且包含当前消息', async () => {
    const captured: BystanderClassifierInput[] = [];
    const classifier: BystanderClassifier = {
      async classify(input) {
        captured.push(input);
        return new HeuristicBystanderClassifier().classify(input);
      },
    };
    const ctx = setup({ classifier });
    for (let index = 0; index < 18; index += 1) {
      ctx.buffer.append(
        transcript(
          `history-${index}`,
          `历史消息 ${index}`,
          BASE_TIME - (60 + index) * 1_000,
        ),
      );
    }
    const message = inbound({ messageId: 'current' });
    await ctx.engine.evaluate(message, ctx.policy);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.window).toHaveLength(15);
    expect(captured[0]?.window.at(-1)?.messageId).toBe('current');
  });
});

describe('LlmBystanderClassifier', () => {
  function scriptedModel(content: string): ChatModel {
    return {
      modelName: 'scripted',
      async *streamChat(): AsyncIterable<ChatStreamChunk> {
        yield { contentDelta: '```json\n' };
        yield { contentDelta: content };
        yield { contentDelta: '\n```' };
      },
    };
  }

  it('解析小模型返回的 JSON 决策', async () => {
    const classifier = new LlmBystanderClassifier({
      model: scriptedModel(
        JSON.stringify({
          action: 'PROACTIVE_REPLY',
          confidence: 0.91,
          triggerReason: 'PROD_INCIDENT',
          extractedQuery: '排查订单接口 504',
          rationale: '线上告警',
        }),
      ),
    });

    const result = await classifier.classify({
      conversationId: 'cid-g',
      current: transcript('m1', '订单接口报 504', BASE_TIME),
      window: [transcript('m1', '订单接口报 504', BASE_TIME)],
      policy: createDefaultBystanderPolicy('cid-g'),
    });

    expect(result).toEqual({
      action: 'PROACTIVE_REPLY',
      confidence: 0.91,
      triggerReason: 'PROD_INCIDENT',
      extractedQuery: '排查订单接口 504',
      rationale: '线上告警',
    });
  });

  it('小模型返回非 JSON 时抛错，由引擎保守静默', async () => {
    const classifier = new LlmBystanderClassifier({
      model: scriptedModel('我觉得可以回复'),
    });
    await expect(
      classifier.classify({
        conversationId: 'cid-g',
        current: transcript('m1', '订单接口报 504', BASE_TIME),
        window: [],
        policy: createDefaultBystanderPolicy('cid-g'),
      }),
    ).rejects.toThrow('no JSON object');
  });
});
