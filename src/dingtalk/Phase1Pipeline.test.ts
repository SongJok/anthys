import { TOPIC_ROBOT } from 'dingtalk-stream';
import { describe, expect, it, vi } from 'vitest';
import { AgentHarness } from '../harness/AgentHarness.js';
import {
  ContextAssembler,
  type PersonaInput,
} from '../memory/ContextAssembler.js';
import type {
  AppendMessageInput,
  ConversationRepository,
  EnsureConversationInput,
} from '../memory/ConversationRepository.js';
import { ReActRunner } from '../react/ReActRunner.js';
import type {
  ChatCompletionRequest,
  ChatModel,
  ChatStreamChunk,
  ConversationRecord,
  DynamicLoopPolicy,
  IToolProvider,
  StoredMessage,
  ToolDefinition,
} from '../types/core.js';
import {
  CardStreamer,
  type CardApi,
  type CardCreateInput,
  type CardUpdate,
} from './CardStreamer.js';
import {
  StreamGateway,
  type StreamCallbackMessage,
  type StreamClient,
} from './StreamGateway.js';

interface StoredRow extends AppendMessageInput {
  conversationId: string;
  createdAt: number;
}

class FakeStreamClient implements StreamClient {
  public topic: string | null = null;
  public callback: ((message: StreamCallbackMessage) => void) | null = null;
  public acked: Array<{ messageId: string; result: unknown }> = [];
  public connected = 0;
  public disconnected = 0;

  public registerCallbackListener(
    topic: string,
    callback: (message: StreamCallbackMessage) => void,
  ): unknown {
    this.topic = topic;
    this.callback = callback;
    return undefined;
  }

  public socketCallBackResponse(messageId: string, result: unknown): void {
    this.acked.push({ messageId, result });
  }

  public async connect(): Promise<void> {
    this.connected += 1;
  }

  public disconnect(): void {
    this.disconnected += 1;
  }

  public emit(message: StreamCallbackMessage): void {
    this.callback?.(message);
  }
}

function createRepository(): {
  repository: ConversationRepository;
  conversations: ConversationRecord[];
  rows: StoredRow[];
} {
  const conversations: ConversationRecord[] = [];
  const rows: StoredRow[] = [];

  const repository: ConversationRepository = {
    async ensureConversation(
      input: EnsureConversationInput,
    ): Promise<ConversationRecord> {
      const existing = conversations.find(
        (item) => item.conversationKey === input.conversationKey,
      );
      if (existing) return existing;
      const record: ConversationRecord = {
        id: `conv-${conversations.length + 1}`,
        conversationKey: input.conversationKey,
        conversationType: input.conversationType,
        createdAt: 0,
      };
      conversations.push(record);
      return record;
    },
    async appendMessage(input: AppendMessageInput): Promise<string> {
      rows.push({ ...input, createdAt: rows.length });
      return `message-${rows.length}`;
    },
    async recentMessages(
      conversationId: string,
      limit: number,
    ): Promise<StoredMessage[]> {
      return rows
        .filter((row) => row.conversationId === conversationId)
        .slice(-Math.max(1, limit))
        .map((row, index) => ({
          id: `message-${index}`,
          role: row.role,
          content: row.content,
          reasoning: row.reasoning ?? null,
          createdAt: row.createdAt,
        }));
    },
    async clearMessages(conversationId: string): Promise<number> {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]?.conversationId === conversationId) rows.splice(index, 1);
      }
      return before - rows.length;
    },
  };

  return { repository, conversations, rows };
}

const persona: PersonaInput = {
  name: '小钉',
  rolePrompt: '你是企业助手',
  speakingStyle: '简洁',
};

const policy: DynamicLoopPolicy = {
  maxWallTimeMs: 5_000,
  maxTotalTokens: 1_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: false,
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const calculator: ToolDefinition = {
  name: 'calculator',
  description: '四则运算',
  parametersJsonSchema: {
    type: 'object',
    properties: { expression: { type: 'string' } },
  },
  async execute(args) {
    return args.expression === '2+2' ? '4' : '0';
  },
};

const toolProvider: IToolProvider = {
  providerName: 'test-tools',
  async getTools() {
    return [calculator];
  },
};

function scriptedModel(requests: ChatCompletionRequest[]): ChatModel {
  return {
    modelName: 'scripted',
    async *streamChat(
      request: ChatCompletionRequest,
    ): AsyncIterable<ChatStreamChunk> {
      requests.push(request);
      const last = request.messages.at(-1);
      if (last?.role === 'user' && last.content === '2+2 等于多少？') {
        yield { reasoningDelta: '我需要计算一下。' };
        yield {
          toolCallDelta: {
            index: 0,
            id: 'call_1',
            name: 'calculator',
            argumentsDelta: '{"expression":"2+2"}',
          },
        };
        yield { finishReason: 'tool_calls', usage: { totalTokens: 10 } };
        return;
      }
      if (last?.role === 'tool') {
        yield { reasoningDelta: '计算结果是 4。' };
        yield { contentDelta: '答案是 4。' };
        yield { finishReason: 'stop', usage: { totalTokens: 5 } };
        return;
      }
      yield { contentDelta: '4 再加 1 等于 5。' };
      yield { finishReason: 'stop', usage: { totalTokens: 3 } };
    },
  };
}

function singlePayload(messageId: string, content: string): string {
  return JSON.stringify({
    msgId: messageId,
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    msgtype: 'text',
    createAt: 1_700_000_000_000,
    text: { content },
  });
}

function groupPayload(
  messageId: string,
  content: string,
  isAtBot: boolean,
): string {
  return JSON.stringify({
    msgId: messageId,
    conversationId: 'cid-g',
    conversationType: '2',
    senderStaffId: 'staff-a',
    senderNick: '李四',
    msgtype: 'text',
    createAt: 1_700_000_000_000,
    chatbotUserId: 'bot-1',
    isInAtList: isAtBot,
    atUsers: isAtBot ? [{ dingtalkId: 'bot-1' }] : [],
    text: { content },
  });
}

function setup() {
  const { repository, conversations, rows } = createRepository();
  const requests: ChatCompletionRequest[] = [];
  const harness = new AgentHarness({
    engine: new ReActRunner({
      model: scriptedModel(requests),
      toolProviders: [toolProvider],
      policy,
      now: () => 1_000,
    }),
    repository,
    assembler: new ContextAssembler({ windowMessages: 20, now: () => 1_000 }),
    persona,
    policy,
    windowMessages: 20,
    now: () => 1_000,
    logger: silentLogger,
  });

  const creates: CardCreateInput[] = [];
  const updates: CardUpdate[] = [];
  const cardApi: CardApi = {
    async createAndDeliver(input) {
      creates.push(input);
    },
    async streamingUpdate(update) {
      updates.push(update);
    },
  };

  const waiters = new Map<string, () => void>();
  const handler = vi.fn(async (message: InboundMessageLike) => {
    const streamer = new CardStreamer({
      api: cardApi,
      message,
      cardTemplateId: 'tpl-1',
      robotCode: 'robot-1',
      logger: silentLogger,
    });
    await streamer.start();
    try {
      await harness.handleMessage(message, {
        emit: (event) => streamer.handle(event),
      });
    } finally {
      await streamer.finish();
      waiters.get(message.messageId)?.();
    }
  });

  const client = new FakeStreamClient();
  const gateway = new StreamGateway({
    client,
    handler,
    logger: silentLogger,
    now: () => 1_000,
  });

  const waitFor = (messageId: string): Promise<void> =>
    new Promise((resolve) => {
      waiters.set(messageId, resolve);
    });

  return {
    gateway,
    client,
    handler,
    requests,
    creates,
    updates,
    rows,
    conversations,
    waitFor,
  };
}

type InboundMessageLike = Parameters<AgentHarness['handleMessage']>[0];

describe('阶段一链路集成（网关 → Harness → ReAct → 卡片）', () => {
  it('单聊：即时 ACK、思维链/工具轨迹/正文流式卡片、多轮记忆', async () => {
    const ctx = setup();
    await ctx.gateway.start();
    expect(ctx.client.topic).toBe(TOPIC_ROBOT);
    expect(ctx.client.connected).toBe(1);

    const done = ctx.waitFor('msg-1');
    ctx.client.emit({
      headers: { messageId: 'msg-1' },
      data: singlePayload('msg-1', '2+2 等于多少？'),
    });

    expect(ctx.client.acked).toEqual([
      { messageId: 'msg-1', result: { status: 'SUCCESS' } },
    ]);
    await done;

    expect(ctx.creates).toHaveLength(1);
    expect(ctx.creates[0]?.outTrackId).toMatch(/^card_[0-9a-f]{32}$/);
    expect(ctx.creates[0]).toMatchObject({
      cardTemplateId: 'tpl-1',
      outTrackId: ctx.creates[0]?.outTrackId,
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
        conversationId: 'cid-1',
      },
    });

    const thinking = ctx.updates
      .filter((update) => update.key === 'thinking_section')
      .map((update) => update.content);
    expect(
      thinking.some(
        (text) =>
          text.includes('我需要计算一下。') &&
          text.includes('计算结果是 4。') &&
          text.includes('`calculator` 已完成：4'),
      ),
    ).toBe(true);
    expect(
      thinking.some((text) => text.includes('调用工具 `calculator`')),
    ).toBe(true);

    const answers = ctx.updates.filter(
      (update) => update.key === 'answer_section',
    );
    expect(
      answers.some(
        (update) =>
          update.content === '答案是 4。' &&
          update.isFinalize &&
          update.isFull,
      ),
    ).toBe(true);
    expect(
      ctx.updates.some(
        (update) =>
          update.key === 'status_bar' &&
          update.content === '已完成 · 0.0s · 15 tokens',
      ),
    ).toBe(true);

    expect(ctx.rows).toHaveLength(2);
    expect(ctx.rows[0]).toMatchObject({
      role: 'user',
      content: '2+2 等于多少？',
    });
    expect(ctx.rows[1]?.role).toBe('assistant');
    expect(ctx.rows[1]?.content).toBe('答案是 4。');
    expect(ctx.rows[1]?.reasoning).toContain('我需要计算一下。');
    expect(ctx.rows[1]?.reasoning).toContain('计算结果是 4。');
    expect(ctx.rows[1]?.tokenCount).toBe(15);

    const followUp = ctx.waitFor('msg-2');
    ctx.client.emit({
      headers: { messageId: 'msg-2' },
      data: singlePayload('msg-2', '再加 1 呢？'),
    });
    await followUp;

    expect(ctx.rows).toHaveLength(4);
    expect(ctx.rows[3]?.content).toBe('4 再加 1 等于 5。');
    const secondTurn = ctx.requests[2];
    expect(secondTurn?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(secondTurn?.messages[2]?.content).toBe('答案是 4。');
    expect(secondTurn?.messages[3]?.content).toBe('再加 1 呢？');
    expect(
      ctx.updates.some(
        (update) =>
          update.outTrackId === ctx.creates[1]?.outTrackId &&
          update.key === 'answer_section' &&
          update.content === '4 再加 1 等于 5。' &&
          update.isFinalize,
      ),
    ).toBe(true);
  });

  it('群聊未 @ 机器人：仍即时 ACK，但不建卡、不写库、不调用模型', async () => {
    const ctx = setup();
    await ctx.gateway.start();

    ctx.client.emit({
      headers: { messageId: 'msg-g0' },
      data: groupPayload('msg-g0', '@小钉 随便聊聊', false),
    });

    expect(ctx.client.acked).toEqual([
      { messageId: 'msg-g0', result: { status: 'SUCCESS' } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.handler).not.toHaveBeenCalled();
    expect(ctx.creates).toHaveLength(0);
    expect(ctx.updates).toHaveLength(0);
    expect(ctx.rows).toHaveLength(0);
    expect(ctx.requests).toHaveLength(0);
  });

  it('群聊 @ 机器人：投放群卡片并按群会话记忆', async () => {
    const ctx = setup();
    await ctx.gateway.start();

    const done = ctx.waitFor('msg-g1');
    ctx.client.emit({
      headers: { messageId: 'msg-g1' },
      data: groupPayload('msg-g1', '@小钉 现在几点？', true),
    });
    await done;

    expect(ctx.creates[0]?.outTrackId).toMatch(/^card_[0-9a-f]{32}$/);
    expect(ctx.creates[0]).toMatchObject({
      outTrackId: ctx.creates[0]?.outTrackId,
      spaceId: 'dtv1.card//IM_GROUP.cid-g',
      deliver: {
        conversationType: '2',
        userId: 'staff-a',
        conversationId: 'cid-g',
      },
    });
    expect(ctx.conversations[0]?.conversationKey).toBe('group:cid-g');
    expect(
      ctx.updates.some(
        (update) =>
          update.outTrackId === ctx.creates[0]?.outTrackId &&
          update.key === 'answer_section' &&
          update.isFinalize &&
          update.content === '4 再加 1 等于 5。',
      ),
    ).toBe(true);
    expect(ctx.rows[0]).toMatchObject({
      role: 'user',
      content: '现在几点？',
    });
  });
});
