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
  for (let index = 0; index < 10; index += 1) {
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
});
