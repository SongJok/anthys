import { describe, expect, it } from 'vitest';
import { AgentHarness } from './AgentHarness.js';
import { ContextAssembler } from '../memory/ContextAssembler.js';
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

function createHarness(engine: AgentEngine) {
  const { repository, conversations, rows } = createRepository();
  const harness = new AgentHarness({
    engine,
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
