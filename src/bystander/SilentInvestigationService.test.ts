import { describe, expect, it } from 'vitest';
import {
  SilentInvestigationService,
  resolveSilentInvestigationConfig,
  scoreInvestigationEvidence,
  type SilentInvestigationServiceOptions,
} from './SilentInvestigationService.js';
import { CooldownLimiter } from './CooldownLimiter.js';
import {
  createDefaultBystanderPolicy,
  type BystanderEvaluationResult,
  type GroupBystanderPolicy,
} from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';
import type {
  InvestigationAuditRecord,
  InvestigationRunResult,
  SilentInvestigationConfig,
} from '../types/investigation.js';

const goodAnswer = JSON.stringify({
  confidence: 0.9,
  findings: ['网关超时时间为 3 秒', '订单服务 P99 响应约 5 秒'],
  sources: ['https://example.com/ops/logs/order-502', '监控面板：网关超时趋势'],
  answer:
    '订单服务 502 的直接原因是网关 3 秒超时小于服务约 5 秒的响应时间。建议先把网关超时调到 10 秒并观察 5xx 曲线，再排查慢查询。',
});

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: false,
    text: '订单服务一直在报 502，是不是网关又把超时改了？',
    rawPayload: {},
    timestamp: 1_000_000,
    ...overrides,
  };
}

function decision(
  overrides: Partial<BystanderEvaluationResult> = {},
): BystanderEvaluationResult {
  return {
    action: 'SILENT',
    confidence: 0.9,
    triggerReason: 'UNANSWERED_QUESTION',
    extractedQuery: '订单服务 502 是否与网关超时配置有关',
    rationale: '群内无人回答，且涉及线上故障',
    ...overrides,
  };
}

function runResult(
  answer: string,
  totalTokens = 1_200,
): InvestigationRunResult {
  return {
    answer,
    usage: { totalTokens, steps: 2, durationMs: 5_000 },
  };
}

interface SetupOptions {
  config?: Partial<SilentInvestigationConfig>;
  policy?: Partial<GroupBystanderPolicy>;
  investigate?: SilentInvestigationServiceOptions['investigate'];
  surface?: (message: InboundMessage, text: string) => Promise<void>;
}

function setup(options: SetupOptions = {}) {
  const audits: InvestigationAuditRecord[] = [];
  const surfaces: string[] = [];
  let investigateCalls = 0;
  let now = 1_000_000;
  const cooldown = new CooldownLimiter({ now: () => now });
  const service = new SilentInvestigationService({
    config: {
      ...resolveSilentInvestigationConfig({}),
      ...options.config,
    },
    cooldown,
    investigate: async (input) => {
      investigateCalls += 1;
      if (options.investigate) return options.investigate(input);
      return runResult(goodAnswer);
    },
    surface: async (message, text) => {
      surfaces.push(text);
      if (options.surface) await options.surface(message, text);
    },
    auditStore: {
      async append(record) {
        audits.push(record);
      },
    },
    now: () => now,
    newId: () => `audit-${audits.length + 1}`,
  });
  return {
    service,
    audits,
    surfaces,
    calls: () => investigateCalls,
    advance(ms: number) {
      now += ms;
    },
    policy: createDefaultBystanderPolicy('cid-1', options.policy),
  };
}

describe('scoreInvestigationEvidence', () => {
  it('解析带代码块的 JSON 并给出结构化证据分', () => {
    const evidence = scoreInvestigationEvidence(`\`\`\`json\n${goodAnswer}\n\`\`\``);
    expect(evidence.format).toBe('json');
    expect(evidence.confidence).toBe(0.9);
    expect(evidence.findings).toHaveLength(2);
    expect(evidence.sources).toHaveLength(2);
    expect(evidence.answer).toContain('建议');
    expect(evidence.answer).not.toContain('"confidence"');
    expect(evidence.score).toBeGreaterThanOrEqual(0.65);
  });

  it('证据不足或明显对冲时分数低于门槛', () => {
    const evidence = scoreInvestigationEvidence(
      JSON.stringify({
        confidence: 0.3,
        findings: [],
        sources: [],
        answer: '这个问题可能和网关有关，但我现在无法确认具体原因。',
      }),
    );
    expect(evidence.score).toBeLessThan(0.65);
  });

  it('非 JSON 输出回退到文本启发式并提取链接', () => {
    const evidence = scoreInvestigationEvidence(
      '根据日志和监控，订单服务 5xx 是因为网关 3 秒超时，详见 https://example.com/logs 与 https://example.com/metrics。',
    );
    expect(evidence.format).toBe('text');
    expect(evidence.sources).toEqual([
      'https://example.com/logs',
      'https://example.com/metrics',
    ]);
    expect(evidence.score).toBeGreaterThan(0.5);
  });
});

describe('SilentInvestigationService', () => {
  it('证据达标时浮出并写入审计', async () => {
    const ctx = setup();
    const outcome = await ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });

    expect(outcome?.status).toBe('surfaced');
    expect(ctx.surfaces).toHaveLength(1);
    expect(ctx.surfaces[0]).toContain('建议');
    expect(ctx.surfaces[0]).not.toContain('"confidence"');
    expect(ctx.audits).toHaveLength(1);
    expect(ctx.audits[0]).toMatchObject({
      conversationId: 'cid-1',
      triggerMessageId: 'msg-1',
      status: 'surfaced',
      tokens: 1_200,
      durationMs: 5_000,
    });
    expect(ctx.audits[0]?.evidenceScore).toBeGreaterThanOrEqual(0.65);
  });

  it('证据不足时静默丢弃且不打扰群聊', async () => {
    const ctx = setup({
      investigate: async () =>
        runResult(
          JSON.stringify({
            confidence: 0.3,
            findings: [],
            sources: [],
            answer:
              '这个问题可能与网关有关，但我暂时无法确认具体原因，需要更多日志和监控数据。',
          }),
        ),
    });
    const outcome = await ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });

    expect(outcome?.status).toBe('discarded');
    expect(outcome?.reason).toContain('证据分');
    expect(ctx.surfaces).toHaveLength(0);
    expect(ctx.audits[0]).toMatchObject({ status: 'discarded' });
  });

  it('超出 token 预算时丢弃并留审计', async () => {
    const ctx = setup({
      config: { maxTokens: 8_000 },
      investigate: async () => runResult(goodAnswer, 9_000),
    });
    const outcome = await ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });

    expect(outcome?.status).toBe('discarded');
    expect(outcome?.reason).toContain('超出调查预算');
    expect(ctx.surfaces).toHaveLength(0);
    expect(ctx.audits[0]).toMatchObject({
      status: 'discarded',
      tokens: 9_000,
    });
  });

  it('群级开关或主动回复关闭时不启动调查', async () => {
    const disabled = setup({ policy: { silentInvestigationEnabled: false } });
    expect(
      await disabled.service.consider({
        message: inbound(),
        decision: decision(),
        policy: disabled.policy,
      }),
    ).toBeNull();
    expect(disabled.calls()).toBe(0);

    const noProactive = setup({ policy: { proactiveReplyEnabled: false } });
    expect(
      await noProactive.service.consider({
        message: inbound(),
        decision: decision(),
        policy: noProactive.policy,
      }),
    ).toBeNull();
    expect(noProactive.calls()).toBe(0);
  });

  it('触发原因为 NONE 或置信度不足时不调查', async () => {
    const ctx = setup();
    expect(
      await ctx.service.consider({
        message: inbound(),
        decision: decision({ triggerReason: 'NONE' }),
        policy: ctx.policy,
      }),
    ).toBeNull();
    expect(
      await ctx.service.consider({
        message: inbound(),
        decision: decision({ confidence: 0.2 }),
        policy: ctx.policy,
      }),
    ).toBeNull();
    expect(ctx.calls()).toBe(0);
  });

  it('浮出后进入冷却，冷却结束才允许下一次调查', async () => {
    const ctx = setup();
    await ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });
    expect(ctx.calls()).toBe(1);

    ctx.advance(60_000);
    expect(
      await ctx.service.consider({
        message: inbound({ messageId: 'msg-2' }),
        decision: decision(),
        policy: ctx.policy,
      }),
    ).toBeNull();
    expect(ctx.calls()).toBe(1);

    ctx.advance(600_000);
    const outcome = await ctx.service.consider({
      message: inbound({ messageId: 'msg-3' }),
      decision: decision(),
      policy: ctx.policy,
    });
    expect(outcome?.status).toBe('surfaced');
    expect(ctx.calls()).toBe(2);
  });

  it('并发上限内同群只跑一个调查', async () => {
    let release!: (value: InvestigationRunResult) => void;
    const pending = new Promise<InvestigationRunResult>((resolve) => {
      release = resolve;
    });
    const ctx = setup({
      config: { maxConcurrency: 1 },
      investigate: () => pending,
    });

    const first = ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });
    const second = await ctx.service.consider({
      message: inbound({ messageId: 'msg-2' }),
      decision: decision(),
      policy: ctx.policy,
    });

    expect(second).toBeNull();
    release(runResult(goodAnswer));
    expect((await first)?.status).toBe('surfaced');
    expect(ctx.calls()).toBe(1);
  });

  it('调查异常时记录 failed 且不浮出', async () => {
    const ctx = setup({
      investigate: async () => {
        throw new Error('模型超时');
      },
    });
    const outcome = await ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });

    expect(outcome?.status).toBe('failed');
    expect(outcome?.reason).toContain('模型超时');
    expect(ctx.surfaces).toHaveLength(0);
    expect(ctx.audits[0]).toMatchObject({
      status: 'failed',
      tokens: 0,
    });
  });

  it('发送失败时记录 failed 并保留证据分', async () => {
    const ctx = setup({
      surface: async () => {
        throw new Error('钉钉发送失败');
      },
    });
    const outcome = await ctx.service.consider({
      message: inbound(),
      decision: decision(),
      policy: ctx.policy,
    });

    expect(outcome?.status).toBe('failed');
    expect(outcome?.reason).toContain('钉钉发送失败');
    expect(outcome?.evidenceScore).toBeGreaterThanOrEqual(0.65);
    expect(ctx.audits[0]).toMatchObject({ status: 'failed' });
  });
});
