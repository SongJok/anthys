import { describe, expect, it } from 'vitest';
import { StreamGateway, type StreamClient } from '../dingtalk/StreamGateway.js';
import { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import {
  BystanderTriageEngine,
  HeuristicBystanderClassifier,
} from '../bystander/BystanderTriageEngine.js';
import { AgentHarness } from './AgentHarness.js';
import { ContextAssembler } from '../memory/ContextAssembler.js';
import { HierarchicalMemoryManager } from '../memory/HierarchicalMemoryManager.js';
import type {
  EpisodicSummaryStore,
  SemanticMemoryStore,
} from '../db/memorySchema.js';
import {
  createDefaultBystanderPolicy,
  type EpisodicSummaryRecord,
  type SemanticMemoryRecord,
} from '../types/bystander-and-memory.js';
import type {
  AgentEngine,
  AgentStreamEvent,
  ConversationRecord,
  InboundMessage,
  StoredMessage,
} from '../types/core.js';
import type {
  AppendMessageInput,
  ConversationRepository,
  EnsureConversationInput,
} from '../memory/ConversationRepository.js';

const BASE_TIME = Date.UTC(2026, 9, 30, 2, 0, 0);

const persona = {
  name: '小钉',
  rolePrompt: '你是企业研发助手',
  speakingStyle: '先结论后要点',
};

class FakeClient implements StreamClient {
  public registerCallbackListener(): unknown {
    return this;
  }
  public socketCallBackResponse(): void {}
  public async connect(): Promise<void> {}
  public disconnect(): void {}
}

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

function createMemoryStores(): {
  summaryStore: EpisodicSummaryStore;
  semanticStore: SemanticMemoryStore;
} {
  const summaries: EpisodicSummaryRecord[] = [];
  const memories: SemanticMemoryRecord[] = [];
  return {
    summaryStore: {
      async appendSummary(input) {
        const record: EpisodicSummaryRecord = {
          ...input,
          id: `summary-${summaries.length + 1}`,
          createdAt: BASE_TIME + summaries.length,
        };
        summaries.push(record);
        return record;
      },
      async listSummaries(conversationId, limit) {
        return summaries
          .filter((item) => item.conversationId === conversationId)
          .slice(-Math.max(1, limit));
      },
    },
    semanticStore: {
      async upsert(input) {
        const record: SemanticMemoryRecord = {
          ...input,
          id: `memory-${memories.length + 1}`,
          embedding: input.embedding ?? null,
          updatedAt: BASE_TIME,
        };
        memories.push(record);
        return record;
      },
      async search() {
        return [];
      },
    },
  };
}

function groupPayload(
  messageId: string,
  text: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    msgId: messageId,
    conversationId: 'cid-group',
    conversationType: '2',
    senderStaffId: 'staff-wang',
    senderNick: '王五',
    msgtype: 'text',
    createAt: BASE_TIME,
    atUsers: [],
    text: { content: text },
    ...overrides,
  });
}

function scriptedEngine(calls: Array<{ messages: unknown[] }>): AgentEngine {
  return {
    async run(input) {
      calls.push({ messages: input.messages });
      input.emit({ type: 'answer_delta', content: '已定位到根因' });
      input.emit({
        type: 'completed',
        usage: { totalTokens: 21, steps: 2, durationMs: 15 },
      });
      return {
        answer: '根因是数据库连接池耗尽，已建议扩容到 200 并回滚 14:32 的发布。',
        reasoning: '查证日志与发布记录',
        usage: { totalTokens: 21, steps: 2, durationMs: 15 },
      };
    },
  };
}

function createHarness(
  engine: AgentEngine,
  buffer: GroupTranscriptBuffer,
  triage: BystanderTriageEngine,
) {
  const { repository, rows, conversations } = createRepository();
  const { summaryStore, semanticStore } = createMemoryStores();
  const harness = new AgentHarness({
    engine,
    repository,
    assembler: new ContextAssembler({
      windowMessages: 20,
      now: () => BASE_TIME,
    }),
    persona,
    policy: {
      maxWallTimeMs: 5_000,
      maxTotalTokens: 1_000,
      maxConsecutiveSameTool: 2,
      convergenceCheck: true,
    },
    windowMessages: 20,
    now: () => BASE_TIME,
    memory: new HierarchicalMemoryManager({
      summaryStore,
      semanticStore,
    }),
    bystander: {
      buffer,
      triage,
      policyProvider: (conversationId) =>
        createDefaultBystanderPolicy(conversationId),
    },
  });
  return { harness, rows, conversations };
}

function createPipeline(options?: {
  sleep?: (ms: number) => Promise<void>;
}) {
  const buffer = new GroupTranscriptBuffer({ defaultWindowSize: 20 });
  const triage = new BystanderTriageEngine({
    buffer,
    classifier: new HeuristicBystanderClassifier(),
    debounceMs: 0,
    sleep: options?.sleep,
    now: () => BASE_TIME,
  });
  const calls: Array<{ messages: unknown[] }> = [];
  const { harness, rows } = createHarness(scriptedEngine(calls), buffer, triage);

  const handled: InboundMessage[] = [];
  const streamed: AgentStreamEvent[] = [];
  const gateway = new StreamGateway({
    client: new FakeClient(),
    transcriptBuffer: buffer,
    handler: async (message) => {
      handled.push(message);
      await harness.handleMessage(message, {
        emit: (event) => streamed.push(event),
      });
    },
    bystanderHandler: async (message) => {
      const decision = await triage.evaluate(
        message,
        createDefaultBystanderPolicy(message.conversationId),
      );
      if (decision.action !== 'PROACTIVE_REPLY') return;
      await harness.handleBystanderMessage(message, {
        decision,
        emit: (event) => streamed.push(event),
      });
    },
  });

  return { gateway, buffer, calls, rows, handled, streamed, harness };
}

function bufferEntry(
  messageId: string,
  senderNick: string,
  text: string,
  timestamp = BASE_TIME,
) {
  return {
    conversationId: 'cid-group',
    messageId,
    senderStaffId: `staff-${senderNick}`,
    senderNick,
    text,
    isAtBot: false,
    timestamp,
  };
}

describe('群聊旁听与非 @ 自主回复主链路', () => {
  it('网关缓冲全部群消息，未 @ 消息交给旁听入口而不是主处理链路', async () => {
    const buffer = new GroupTranscriptBuffer();
    const handled: InboundMessage[] = [];
    const bystander: InboundMessage[] = [];
    const gateway = new StreamGateway({
      client: new FakeClient(),
      transcriptBuffer: buffer,
      handler: async (message) => {
        handled.push(message);
      },
      bystanderHandler: async (message) => {
        bystander.push(message);
      },
    });

    await gateway.dispatch(groupPayload('m-1', '数据库连接池打满了'), 'm-1');
    await gateway.dispatch(
      groupPayload('m-2', '@小钉 帮忙看下日志', {
        isInAtList: true,
        senderStaffId: 'staff-zhao',
        senderNick: '赵六',
      }),
      'm-2',
    );

    expect(bystander.map((message) => message.messageId)).toEqual(['m-1']);
    expect(handled.map((message) => message.messageId)).toEqual(['m-2']);
    expect(buffer.recent('cid-group').map((entry) => entry.messageId)).toEqual([
      'm-1',
      'm-2',
    ]);
  });

  it('未 @ 的线上报错经过漏斗后主动唤醒 ReAct 并携带旁听上下文回复', async () => {
    const pipeline = createPipeline();
    pipeline.buffer.append(
      bufferEntry('m-0', '王五', '订单服务从 14:00 开始报 504，日志里数据库连接池打满'),
    );

    await pipeline.gateway.dispatch(
      groupPayload('m-1', '订单接口一直报 504 网关超时，帮忙查一下日志', {
        createAt: BASE_TIME + 1_000,
      }),
      'm-1',
    );

    expect(pipeline.handled).toHaveLength(0);
    expect(pipeline.calls).toHaveLength(1);

    const messages = pipeline.calls[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('群聊旁听记录');
    expect(messages[0]?.content).toContain('王五');
    expect(messages[0]?.content).toContain('数据库连接池打满');
    expect(messages.at(-1)?.content).toContain('主动提供帮助');
    expect(messages.at(-1)?.content).toContain('订单接口一直报 504');

    expect(pipeline.rows).toHaveLength(2);
    expect(pipeline.rows[0]).toMatchObject({
      role: 'user',
      metadata: { proactive: true, triggerReason: 'PROD_INCIDENT' },
    });
    expect(pipeline.rows[1]).toMatchObject({
      role: 'assistant',
      metadata: { proactive: true },
    });
    expect(pipeline.streamed.map((event) => event.type)).toEqual([
      'answer_delta',
      'completed',
    ]);
  });

  it('未 @ 的日常闲聊保持静默，不调用 ReAct 也不写库', async () => {
    const pipeline = createPipeline();

    await pipeline.gateway.dispatch(
      groupPayload('m-1', '今天中午吃什么？'),
      'm-1',
    );

    expect(pipeline.calls).toHaveLength(0);
    expect(pipeline.rows).toHaveLength(0);
    expect(pipeline.streamed).toHaveLength(0);
    expect(pipeline.buffer.recent('cid-group')).toHaveLength(1);
  });

  it('防抢答窗口内同事已回复时取消主动插话', async () => {
    let triageContext:
      | { buffer: GroupTranscriptBuffer; clock: number }
      | undefined;
    const sleep = async (): Promise<void> => {
      if (!triageContext) return;
      triageContext.buffer.append(
        bufferEntry(
          'm-reply',
          '赵六',
          '我看下，应该是连接池配置的 max 太小，先扩到 200',
          triageContext.clock,
        ),
      );
    };
    const pipeline = createPipeline({ sleep });
    triageContext = { buffer: pipeline.buffer, clock: BASE_TIME + 1 };

    await pipeline.gateway.dispatch(
      groupPayload('m-1', '订单接口一直报 504，谁帮忙看下日志'),
      'm-1',
    );

    expect(pipeline.calls).toHaveLength(0);
    expect(pipeline.rows).toHaveLength(0);
  });

  it('@ 追问时系统提示自动带上之前的群聊讨论，无需复述背景', async () => {
    const buffer = new GroupTranscriptBuffer();
    const calls: Array<{ messages: unknown[] }> = [];
    const { harness, rows } = createHarness(
      scriptedEngine(calls),
      buffer,
      new BystanderTriageEngine({
        buffer,
        classifier: new HeuristicBystanderClassifier(),
        debounceMs: 0,
        now: () => BASE_TIME,
      }),
    );
    const gateway = new StreamGateway({
      client: new FakeClient(),
      transcriptBuffer: buffer,
      handler: async (message) => {
        await harness.handleMessage(message, { emit: () => undefined });
      },
    });

    await gateway.dispatch(
      groupPayload('m-1', '数据库连接池打满了，订单接口全部 504', {
        createAt: BASE_TIME,
      }),
      'm-1',
    );
    await gateway.dispatch(
      groupPayload('m-2', '王五你看下这个报错堆栈', {
        createAt: BASE_TIME + 1_000,
        senderStaffId: 'staff-zhao',
        senderNick: '赵六',
      }),
      'm-2',
    );
    await gateway.dispatch(
      groupPayload('m-3', '@小钉 按刚才大家讨论的报错现象帮我查一下日志', {
        createAt: BASE_TIME + 2_000,
        isInAtList: true,
        senderStaffId: 'staff-li',
        senderNick: '李四',
        text: { content: '@小钉 按刚才大家讨论的报错现象帮我查一下日志' },
      }),
      'm-3',
    );

    expect(calls).toHaveLength(1);
    const messages = calls[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.content).toContain('群聊旁听记录');
    expect(messages[0]?.content).toContain('数据库连接池打满了');
    expect(messages[0]?.content).toContain('王五你看下这个报错堆栈');
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: '按刚才大家讨论的报错现象帮我查一下日志',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.metadata).toEqual({ messageId: 'm-3' });
  });
});
