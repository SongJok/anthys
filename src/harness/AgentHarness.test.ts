import { describe, expect, it } from 'vitest';
import { AgentHarness, conversationTitleFor } from './AgentHarness.js';
import { ContextAssembler } from '../memory/ContextAssembler.js';
import { QuotaExceededError } from '../billing/UsageGuard.js';
import type {
  AppendMessageInput,
  ConversationRepository,
  EnsureConversationInput,
} from '../memory/ConversationRepository.js';
import type {
  AgentEngine,
  AgentStreamEvent,
  ConversationRecord,
  InboundMessage,
  StoredMessage,
} from '../types/core.js';

interface StoredRow extends AppendMessageInput {
  conversationId: string;
  createdAt: number;
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

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '现在几点？',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

const persona = {
  name: '小钉',
  rolePrompt: '你是企业助手',
  speakingStyle: '简洁',
};

function createHarness(
  engine: AgentEngine,
  usageGuard?: ConstructorParameters<typeof AgentHarness>[0]['usageGuard'],
  glossary?: ConstructorParameters<typeof AgentHarness>[0]['glossary'],
) {
  const { repository, conversations, rows } = createRepository();
  const harness = new AgentHarness({
    engine,
    ...(usageGuard ? { usageGuard } : {}),
    ...(glossary ? { glossary } : {}),
    repository,
    assembler: new ContextAssembler({ windowMessages: 20, now: () => 0 }),
    persona,
    policy: {
      maxWallTimeMs: 5_000,
      maxTotalTokens: 1_000,
      maxConsecutiveSameTool: 2,
      convergenceCheck: true,
    },
    windowMessages: 20,
    now: () => 1_000,
  });
  return { harness, conversations, rows };
}

function scriptedEngine(calls: { messages: unknown[] }[]): AgentEngine {
  return {
    async run(input) {
      calls.push({ messages: input.messages });
      input.emit({ type: 'answer_delta', content: '现在' });
      input.emit({
        type: 'completed',
        usage: { totalTokens: 12, steps: 1, durationMs: 8 },
      });
      return {
        answer: '现在是十点。',
        reasoning: '用户询问当前时间',
        usage: { totalTokens: 12, steps: 1, durationMs: 8 },
      };
    },
  };
}

describe('AgentHarness', () => {
  it('群聊未 @ 机器人时直接忽略且不写库', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness, rows } = createHarness(scriptedEngine(calls));
    const result = await harness.handleMessage(
      inbound({ conversationType: '2', isAtBot: false }),
      { emit: () => undefined },
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('单聊完整执行并持久化用户与助手消息', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness, rows, conversations } = createHarness(
      scriptedEngine(calls),
    );
    const events: AgentStreamEvent[] = [];
    const result = await harness.handleMessage(inbound(), {
      emit: (event) => events.push(event),
    });

    expect(result?.answer).toBe('现在是十点。');
    expect(events.map((event) => event.type)).toEqual([
      'answer_delta',
      'completed',
    ]);
    expect(conversations[0]?.conversationKey).toBe('single:staff-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      role: 'user',
      content: '现在几点？',
      metadata: { messageId: 'msg-1' },
    });
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: '现在是十点。',
      reasoning: '用户询问当前时间',
      tokenCount: 12,
    });
    const firstMessages = calls[0]?.messages as Array<{ role: string; content: string }>;
    expect(firstMessages[0]?.role).toBe('system');
    expect(firstMessages[0]?.content).toContain('小钉');
    expect(firstMessages.at(-1)).toEqual({ role: 'user', content: '现在几点？' });
  });

  it('把术语库上下文并入系统提示，异常时不影响主流程', async () => {
    const calls: { messages: unknown[] }[] = [];
    const inputs: Array<{ conversationType: string; query?: string }> = [];
    const { harness } = createHarness(scriptedEngine(calls), undefined, {
      async buildContext(input) {
        inputs.push({
          conversationType: input.conversationType,
          ...(input.query !== undefined ? { query: input.query } : {}),
        });
        return {
          prompt: '## 企业术语知识库\n- CQ：变更请求单',
          injected: [],
          retrieved: [],
        };
      },
    });

    await harness.handleMessage(inbound({ text: 'CQ 怎么提' }), {
      emit: () => undefined,
    });
    const messages = calls[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('## 企业术语知识库');
    expect(messages[0]?.content).toContain('小钉');
    expect(inputs[0]).toMatchObject({ conversationType: '1', query: 'CQ 怎么提' });

    const failing: { messages: unknown[] }[] = [];
    const { harness: brokenHarness } = createHarness(
      scriptedEngine(failing),
      undefined,
      {
        async buildContext() {
          throw new Error('db down');
        },
      },
    );
    const result = await brokenHarness.handleMessage(inbound(), {
      emit: () => undefined,
    });
    expect(result?.answer).toBe('现在是十点。');
    expect(failing).toHaveLength(1);
  });

  it('明文写明 20 分钟以上任务时直接拒接，不调用模型也不写库', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness, rows } = createHarness(scriptedEngine(calls));
    const events: AgentStreamEvent[] = [];
    const result = await harness.handleMessage(
      inbound({ text: '帮我整理季度报表，大概需要 40 分钟' }),
      { emit: (event) => events.push(event) },
    );

    expect(calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
    expect(result?.answer).toContain('机器人不认可这个需求');
    expect(result?.answer).toContain('已关闭执行');
    expect(events.map((event) => event.type)).toEqual([
      'answer_delta',
      'completed',
    ]);
  });

  it('短任务里的时长描述不触发拒接', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness } = createHarness(scriptedEngine(calls));
    await harness.handleMessage(inbound({ text: '25 分钟后提醒我开会' }), {
      emit: () => undefined,
    });
    expect(calls).toHaveLength(1);
  });

  it('同一用户的后续追问带上多轮历史', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness } = createHarness(scriptedEngine(calls));
    await harness.handleMessage(inbound(), { emit: () => undefined });
    await harness.handleMessage(inbound({ messageId: 'msg-2', text: '那明天呢？' }), {
      emit: () => undefined,
    });

    expect(calls).toHaveLength(2);
    const second = calls[1]?.messages as Array<{ role: string; content: string }>;
    expect(second.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(second[1]?.content).toBe('现在几点？');
    expect(second[2]?.content).toBe('现在是十点。');
    expect(second[3]?.content).toBe('那明天呢？');
  });

  it('群聊 @ 机器人时按会话维度复用记忆', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness, conversations } = createHarness(scriptedEngine(calls));
    await harness.handleMessage(
      inbound({ conversationType: '2', isAtBot: true, senderStaffId: 'a' }),
      { emit: () => undefined },
    );
    await harness.handleMessage(
      inbound({
        conversationType: '2',
        isAtBot: true,
        senderStaffId: 'b',
        messageId: 'msg-2',
      }),
      { emit: () => undefined },
    );
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationKey).toBe('group:cid-1');
    const second = calls[1]?.messages as Array<{ role: string }>;
    expect(second.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('群聊标题用群名、单聊用昵称，拿不到群名时不写标题', () => {
    expect(
      conversationTitleFor(
        inbound({ conversationType: '2', conversationTitle: '研发大群' }),
      ),
    ).toBe('研发大群');
    expect(conversationTitleFor(inbound({ conversationType: '2' }))).toBeUndefined();
    expect(
      conversationTitleFor(inbound({ conversationType: '1', senderNick: '张三' })),
    ).toBe('张三');
  });

  it('配额用尽时直接回复提示且不调用模型', async () => {
    const calls: { messages: unknown[] }[] = [];
    const events: AgentStreamEvent[] = [];
    const recorded: unknown[] = [];
    let rejected = false;
    const { harness, rows } = createHarness(scriptedEngine(calls), {
      async assertWithinQuota() {
        if (!rejected) {
          rejected = true;
          throw new QuotaExceededError('user', 1_000, 1_000);
        }
      },
      async record(input) {
        recorded.push(input);
      },
    });

    const result = await harness.handleMessage(inbound(), {
      emit: (event) => events.push(event),
    });
    expect(calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
    expect(result?.answer).toContain('今日个人 Token 配额已用尽');
    expect(events.some((event) => event.type === 'answer_delta')).toBe(true);

    await harness.handleMessage(inbound({ messageId: 'msg-2' }), {
      emit: (event) => events.push(event),
    });
    expect(calls).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      senderStaffId: 'staff-1',
      totalTokens: 12,
      proactive: false,
    });
  });

  it('引擎抛错时不写入助手消息并向上抛出', async () => {
    const engine: AgentEngine = {
      async run() {
        throw new Error('模型不可用');
      },
    };
    const { harness, rows } = createHarness(engine);
    await expect(
      harness.handleMessage(inbound(), { emit: () => undefined }),
    ).rejects.toThrow('模型不可用');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('user');
  });
});
