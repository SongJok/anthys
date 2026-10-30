import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CardStreamer,
  type CardApi,
  type CardCreateInput,
  type CardUpdate,
} from './CardStreamer.js';
import type { InboundMessage } from '../types/core.js';

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '你好',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

function fakeApi(options: { failCreate?: boolean } = {}): {
  api: CardApi;
  created: CardCreateInput[];
  updates: CardUpdate[];
} {
  const created: CardCreateInput[] = [];
  const updates: CardUpdate[] = [];
  return {
    created,
    updates,
    api: {
      async createAndDeliver(input) {
        if (options.failCreate) throw new Error('invalid template');
        created.push(input);
      },
      async streamingUpdate(update) {
        updates.push(update);
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

describe('CardStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('单聊卡片投放到 IM_ROBOT 空间并初始化三个区块', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    expect(streamer.isAvailable).toBe(true);
    expect(streamer.outTrackId).toMatch(/^card_[0-9a-f]{32}$/);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      cardTemplateId: 'tpl-1',
      outTrackId: streamer.outTrackId,
      spaceId: 'dtv1.card//IM_ROBOT.cid-1',
      params: {
        thinking_section: '正在思考…',
        answer_section: '',
        status_bar: '正在思考…',
      },
      deliver: {
        conversationType: '1',
        robotCode: 'robot-1',
        userId: 'staff-1',
      },
    });
  });

  it('群聊卡片投放到 IM_GROUP 空间', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound({ conversationType: '2', conversationId: 'cid-9' }),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();
    expect(fake.created[0]?.spaceId).toBe('dtv1.card//IM_GROUP.cid-9');
    expect(fake.created[0]?.deliver.conversationType).toBe('2');
  });

  it('思维链增量按 250ms 节流刷新', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'reasoning_delta', content: '思考'.repeat(10) });
    await vi.advanceTimersByTimeAsync(249);
    expect(fake.updates).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({
      key: 'thinking_section',
      content: '思考'.repeat(10),
      isFull: true,
      isFinalize: false,
    });
  });

  it('正文累积满 80 字符立即刷新', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'answer_delta', content: '答'.repeat(80) });
    await settle();

    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({
      key: 'answer_section',
      content: '答'.repeat(80),
    });
  });

  it('群聊回复在正文最前面点名提问人，思维链不受影响', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound({ conversationType: '2', senderNick: '张三' }),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
      mention: '@张三\n',
    });
    await streamer.start();

    expect(fake.created[0]?.params.answer_section).toBe('');
    streamer.handle({ type: 'reasoning_delta', content: '先分析' });
    streamer.handle({ type: 'answer_delta', content: '答案是 42' });
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(
      fake.updates.find((u) => u.key === 'answer_section')?.content,
    ).toBe('@张三\n答案是 42');
    expect(
      fake.updates.find((u) => u.key === 'thinking_section')?.content,
    ).toBe('先分析');
  });

  it('tool_start / tool_end 立即刷新思考区块与状态角标', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'reasoning_delta', content: '需要查时间' });
    streamer.handle({
      type: 'tool_start',
      toolName: 'current_time',
      args: { timeZone: 'Asia/Shanghai' },
    });
    await settle();

    const thinking = fake.updates.find((u) => u.key === 'thinking_section');
    expect(thinking?.content).toContain('需要查时间');
    expect(thinking?.content).toContain('调用工具 `current_time`');
    expect(thinking?.content).toContain('Asia/Shanghai');
    const status = fake.updates.find((u) => u.key === 'status_bar');
    expect(status?.content).toBe('正在调用工具 current_time');

    fake.updates.length = 0;
    streamer.handle({
      type: 'tool_end',
      toolName: 'current_time',
      summary: '2026-10-30 10:00',
      isError: false,
    });
    await settle();

    const afterEnd = fake.updates.find((u) => u.key === 'thinking_section');
    expect(afterEnd?.content).toContain('已完成：2026-10-30 10:00');
    expect(fake.updates.find((u) => u.key === 'status_bar')?.content).toBe(
      '工具 current_time 已完成',
    );
  });

  it('completed 立即刷新并以 isFinalize 收尾正文', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'answer_delta', content: '最终答案' });
    streamer.handle({
      type: 'completed',
      usage: { totalTokens: 99, steps: 2, durationMs: 1_500 },
    });
    await streamer.finish();

    const finals = fake.updates.filter((update) => update.isFinalize);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      key: 'answer_section',
      content: '最终答案',
      isError: false,
    });
    expect(
      fake.updates.find((update) => update.key === 'status_bar')?.content,
    ).toBe('已完成 · 1.5s · 99 tokens');
  });

  it('error 事件以 isError 收尾并展示失败原因', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'error', message: '模型超时' });
    await streamer.finish();

    expect(
      fake.updates.find((update) => update.key === 'thinking_section')?.content,
    ).toContain('模型超时');
    expect(
      fake.updates.find((update) => update.key === 'status_bar')?.content,
    ).toBe('处理失败');
    expect(fake.updates.filter((update) => update.isFinalize)[0]?.isError).toBe(
      true,
    );
  });

  it('卡片创建失败时降级为不可用且不抛错', async () => {
    const fake = fakeApi({ failCreate: true });
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await expect(streamer.start()).resolves.toBeUndefined();
    expect(streamer.isAvailable).toBe(false);
    streamer.handle({ type: 'answer_delta', content: '答案' });
    await streamer.finish();
    expect(fake.updates).toHaveLength(0);
  });

  it('answer_reset 把过程说明移入思考区并清空正文', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'answer_delta', content: '我先查询一下。' });
    streamer.handle({
      type: 'answer_reset',
      narration: '我先查询一下。',
    });
    streamer.handle({ type: 'answer_delta', content: '最终答案。' });
    streamer.handle({
      type: 'completed',
      usage: { totalTokens: 10, steps: 2, durationMs: 1_000 },
    });
    await streamer.finish();

    const finalAnswer = fake.updates.find((update) => update.isFinalize);
    expect(finalAnswer?.key).toBe('answer_section');
    expect(finalAnswer?.content).toBe('最终答案。');

    const thinkingUpdates = fake.updates.filter(
      (update) => update.key === 'thinking_section',
    );
    expect(thinkingUpdates.at(-1)?.content).toContain('我先查询一下。');
    expect(fake.updates.filter((update) => update.isFinalize)).toHaveLength(1);
  });

  it('刷新期间只发送最新快照，不积压旧增量', async () => {
    const updates: CardUpdate[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api: CardApi = {
      async createAndDeliver() {
        return undefined;
      },
      async streamingUpdate(update) {
        updates.push(update);
        await gate;
      },
    };
    const streamer = new CardStreamer({
      api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'answer_delta', content: 'A'.repeat(80) });
    await settle();
    expect(updates).toHaveLength(1);

    streamer.handle({ type: 'answer_delta', content: 'B'.repeat(40) });
    streamer.handle({ type: 'answer_delta', content: 'C'.repeat(40) });
    release();
    await settle();

    const answers = updates.filter((update) => update.key === 'answer_section');
    expect(answers).toHaveLength(2);
    expect(answers[1]?.content).toBe(`${'A'.repeat(80)}${'B'.repeat(40)}${'C'.repeat(40)}`);
  });

  it('失败更新按退避重试成功', async () => {
    const updates: CardUpdate[] = [];
    let attempts = 0;
    const api: CardApi = {
      async createAndDeliver() {
        return undefined;
      },
      async streamingUpdate(update) {
        attempts += 1;
        if (attempts === 1) throw new Error('rate limited');
        updates.push(update);
      },
    };
    const streamer = new CardStreamer({
      api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
    });
    await streamer.start();

    streamer.handle({ type: 'answer_delta', content: '答'.repeat(80) });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(attempts).toBe(2);
    expect(updates.at(-1)?.content).toBe('答'.repeat(80));
  });

  it('正文更新重试耗尽后标记卡片不可用，交由文本兜底', async () => {
    let attempts = 0;
    const api: CardApi = {
      async createAndDeliver() {
        return undefined;
      },
      async streamingUpdate() {
        attempts += 1;
        throw new Error('card instance not found');
      },
    };
    const streamer = new CardStreamer({
      api,
      message: inbound(),
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
      maxRetries: 1,
    });
    await streamer.start();
    expect(streamer.isAvailable).toBe(true);

    streamer.handle({ type: 'answer_delta', content: '答'.repeat(80) });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(attempts).toBe(2);
    expect(streamer.isAvailable).toBe(false);

    await streamer.finish();
    expect(attempts).toBe(2);
  });

  it('v2 模板额外初始化工具、引用与操作区块', async () => {
    const fake = fakeApi();
    const streamer = new CardStreamer({
      api: fake.api,
      message: inbound(),
      cardTemplateId: 'tpl-2',
      robotCode: 'robot-1',
      layout: 'v2',
    });
    await streamer.start();

    expect(fake.created[0]?.params).toMatchObject({
      thinking_section: '正在思考…',
      answer_section: '',
      status_bar: '正在思考…',
      tools_section: '',
      citations_section: '',
    });
    expect(fake.created[0]?.params.actions_section).toContain('/stop');

    streamer.handle({
      type: 'tool_start',
      toolName: 'current_time',
      args: { timeZone: 'Asia/Shanghai' },
    });
    await settle();
    expect(
      fake.updates.find((update) => update.key === 'tools_section')?.content,
    ).toContain('current_time');
  });

  describe('ai 布局（单 content 流式字段）', () => {
    it('只初始化 content 字段作为思考占位', async () => {
      const fake = fakeApi();
      const streamer = new CardStreamer({
        api: fake.api,
        message: inbound(),
        cardTemplateId: 'tpl-ai',
        robotCode: 'robot-1',
        layout: 'ai',
      });
      await streamer.start();

      expect(fake.created[0]?.params).toEqual({ content: '正在思考…' });
    });

    it('把状态、思考与工具轨迹合成一份 content', async () => {
      const fake = fakeApi();
      const streamer = new CardStreamer({
        api: fake.api,
        message: inbound(),
        cardTemplateId: 'tpl-ai',
        robotCode: 'robot-1',
        layout: 'ai',
      });
      await streamer.start();

      streamer.handle({ type: 'reasoning_delta', content: '需要查时间' });
      streamer.handle({
        type: 'tool_start',
        toolName: 'current_time',
        args: { timeZone: 'Asia/Shanghai' },
      });
      streamer.handle({
        type: 'tool_end',
        toolName: 'current_time',
        summary: '2026-10-30 10:00',
        isError: false,
      });
      await settle();

      const last = fake.updates.at(-1);
      expect(last?.key).toBe('content');
      expect(last?.content).toContain('> 工具 current_time 已完成');
      expect(last?.content).toContain('思考过程');
      expect(last?.content).toContain('需要查时间');
      expect(last?.content).toContain('2026-10-30 10:00');
    });

    it('正文写入 content 并带上群聊提及前缀', async () => {
      const fake = fakeApi();
      const streamer = new CardStreamer({
        api: fake.api,
        message: inbound({ conversationType: '2' }),
        cardTemplateId: 'tpl-ai',
        robotCode: 'robot-1',
        layout: 'ai',
        mention: '@张三\n',
      });
      await streamer.start();

      streamer.handle({ type: 'answer_delta', content: '答'.repeat(80) });
      await settle();

      const update = fake.updates.at(-1);
      expect(update?.key).toBe('content');
      expect(update?.content).toContain(`@张三\n${'答'.repeat(80)}`);
    });

    it('completed 后以 isFinalize 收尾，卡片离开处理中', async () => {
      const fake = fakeApi();
      const streamer = new CardStreamer({
        api: fake.api,
        message: inbound(),
        cardTemplateId: 'tpl-ai',
        robotCode: 'robot-1',
        layout: 'ai',
      });
      await streamer.start();

      streamer.handle({ type: 'answer_delta', content: '最终答案' });
      streamer.handle({
        type: 'completed',
        usage: { totalTokens: 99, steps: 2, durationMs: 1_500 },
      });
      await streamer.finish();

      const finals = fake.updates.filter((update) => update.isFinalize);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toMatchObject({ key: 'content', isError: false });
      expect(finals[0]?.content).toContain('已完成');
      expect(finals[0]?.content).toContain('最终答案');
    });

    it('超出卡片容量的答案截断并保留溢出文本', async () => {
      const fake = fakeApi();
      const streamer = new CardStreamer({
        api: fake.api,
        message: inbound(),
        cardTemplateId: 'tpl-ai',
        robotCode: 'robot-1',
        layout: 'ai',
        maxContentChars: 400,
      });
      await streamer.start();

      streamer.handle({ type: 'answer_delta', content: '答'.repeat(600) });
      await streamer.finish();

      const final = fake.updates.find((update) => update.isFinalize);
      expect(final?.content).toContain('剩余部分随后发送');
      expect(Array.from(final?.content ?? '').length).toBeLessThanOrEqual(400);
      expect(streamer.takeOverflowAnswer()).toBe('答'.repeat(225));
      expect(streamer.takeOverflowAnswer()).toBe('');
    });
  });
});
