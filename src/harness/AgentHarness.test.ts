import { describe, expect, it, vi } from 'vitest';
import { AgentHarness, conversationTitleFor } from './AgentHarness.js';
import { ContextAssembler } from '../memory/ContextAssembler.js';
import { PersonaResolver } from '../persona/PersonaResolver.js';
import type { HierarchicalMemoryManager } from '../memory/HierarchicalMemoryManager.js';
import type { PersonaProfileStore } from '../types/persona-and-identity.js';
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
import type { AgentJob } from '../types/jobs.js';

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
  investigationEngine?: AgentEngine,
  workerRuntimes?: ConstructorParameters<
    typeof AgentHarness
  >[0]['workerRuntimes'],
  extras?: {
    memory?: HierarchicalMemoryManager;
    personas?: PersonaResolver;
    identity?: ConstructorParameters<typeof AgentHarness>[0]['identity'];
    personSettings?: ConstructorParameters<
      typeof AgentHarness
    >[0]['personSettings'];
  },
) {
  const { repository, conversations, rows } = createRepository();
  const harness = new AgentHarness({
    engine,
    ...(investigationEngine ? { investigationEngine } : {}),
    ...(workerRuntimes ? { workerRuntimes } : {}),
    ...(usageGuard ? { usageGuard } : {}),
    ...(glossary ? { glossary } : {}),
    ...(extras?.memory ? { memory: extras.memory } : {}),
    ...(extras?.personas ? { personas: extras.personas } : {}),
    ...(extras?.identity ? { identity: extras.identity } : {}),
    ...(extras?.personSettings
      ? { personSettings: extras.personSettings }
      : {}),
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

  it('群聊定时任务未 @ 机器人时仍执行引擎并写库（proactive 系统发起）', async () => {
    const calls: { messages: unknown[] }[] = [];
    const { harness, rows } = createHarness(scriptedEngine(calls));
    const events: AgentStreamEvent[] = [];
    const result = await harness.handleMessage(
      inbound({
        conversationType: '2',
        isAtBot: false,
        senderStaffId: 'scheduler',
        senderNick: '定时任务',
        text: '播报今天的群摘要',
      }),
      { emit: (event) => events.push(event), proactive: true },
    );

    expect(result?.answer).toBe('现在是十点。');
    expect(calls).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(events.some((event) => event.type === 'answer_delta')).toBe(true);
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

  it('分层人设与归一身份贯穿上下文和记忆归属', async () => {
    const calls: { messages: unknown[] }[] = [];
    const memoryInputs: Array<
      Parameters<HierarchicalMemoryManager['assemble']>[0]
    > = [];
    const memory = {
      async assemble(
        input: Parameters<HierarchicalMemoryManager['assemble']>[0],
      ) {
        memoryInputs.push(input);
        return {
          personaSystemPrompt: input.personaSystemPrompt,
          userSemanticProfile: '',
          groupRecentTranscript: '',
          episodicSummary: '',
          activeTurnMessages: input.activeTurnMessages ?? [],
        };
      },
      async maybeCompress() {
        return { compressed: false };
      },
      shouldExtractSemantic() {
        return false;
      },
      async captureSemantic() {
        return [];
      },
    } as unknown as HierarchicalMemoryManager;
    const personaStore: PersonaProfileStore = {
      async list() {
        return [];
      },
      async get(scope, subjectKey) {
        if (scope === 'group' && subjectKey === 'cid-group') {
          return {
            scope: 'group',
            subjectKey,
            name: '支付群助手',
            rolePrompt: '只回答支付网关与结算问题',
            speakingStyle: '简洁',
            enabled: true,
            updatedBy: 'admin',
            createdAt: 0,
            updatedAt: 0,
          };
        }
        if (scope === 'user' && subjectKey === 'staff:canonical') {
          return {
            scope: 'user',
            subjectKey,
            name: '个人助手',
            rolePrompt: '个人事务',
            speakingStyle: '幽默',
            enabled: true,
            updatedBy: 'admin',
            createdAt: 0,
            updatedAt: 0,
          };
        }
        return null;
      },
      async upsert(profile) {
        return profile;
      },
      async remove() {
        return false;
      },
      async reassignSubjectKey() {
        return 0;
      },
    };
    const resolved: string[] = [];
    const identity = {
      async resolve(message: InboundMessage) {
        resolved.push(message.messageId);
        return {
          personKey: 'staff:canonical',
          displayName: '张三',
          alias: 'open:abc',
          source: 'open' as const,
          bound: true,
        };
      },
    };
    const { harness } = createHarness(
      scriptedEngine(calls),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        memory,
        personas: new PersonaResolver({
          store: personaStore,
          fallback: () => persona,
        }),
        identity,
      },
    );

    await harness.handleMessage(
      inbound({ conversationType: '2', conversationId: 'cid-group' }),
      { emit: () => undefined },
    );
    await harness.flushMemoryTasks();

    const system = (
      calls[0]?.messages as Array<{ role: string; content: string }>
    ).find((message) => message.role === 'system');
    expect(system?.content).toContain('你是「支付群助手」');
    expect(system?.content).toContain('只回答支付网关与结算问题');
    expect(system?.content).toContain('说话风格：幽默');
    expect(system?.content).not.toContain('个人事务');
    expect(resolved).toEqual(['msg-1']);
    expect(memoryInputs).toHaveLength(1);
    expect(memoryInputs[0]).toMatchObject({
      userId: 'staff:canonical',
      audience: 'group',
      groupConversationId: 'cid-group',
    });
  });

  it('个人偏好只在单聊注入系统提示，群聊按授权档位召回记忆', async () => {
    const calls: { messages: unknown[] }[] = [];
    const memoryInputs: Array<
      Parameters<HierarchicalMemoryManager['assemble']>[0]
    > = [];
    const memory = {
      async assemble(
        input: Parameters<HierarchicalMemoryManager['assemble']>[0],
      ) {
        memoryInputs.push(input);
        return {
          personaSystemPrompt: input.personaSystemPrompt,
          userSemanticProfile: '',
          groupRecentTranscript: '',
          episodicSummary: '',
          activeTurnMessages: input.activeTurnMessages ?? [],
        };
      },
      async maybeCompress() {
        return { compressed: false };
      },
      shouldExtractSemantic() {
        return false;
      },
      async captureSemantic() {
        return [];
      },
    } as unknown as HierarchicalMemoryManager;
    const buildPrompt = vi.fn(
      async (_personKey: string, conversationType: '1' | '2') =>
        conversationType === '1'
          ? '【员工个人偏好】\n- 称呼这位员工为「老张」。'
          : undefined,
    );
    const resolveGroupMode = vi.fn(async () => 'off' as const);
    const { harness } = createHarness(
      scriptedEngine(calls),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        memory,
        personSettings: { buildPrompt, resolveGroupMode },
      },
    );

    await harness.handleMessage(inbound(), { emit: () => undefined });
    await harness.flushMemoryTasks();
    const singleSystem = (
      calls[0]?.messages as Array<{ role: string; content: string }>
    ).find((message) => message.role === 'system');
    expect(singleSystem?.content).toContain('称呼这位员工为「老张」');
    expect(buildPrompt).toHaveBeenCalledWith('staff:staff-1', '1');
    expect(resolveGroupMode).not.toHaveBeenCalled();
    expect(memoryInputs.at(-1)?.userGroupSharing).toBeUndefined();

    await harness.handleMessage(
      inbound({
        messageId: 'msg-group',
        conversationType: '2',
        conversationId: 'cid-group-1',
      }),
      { emit: () => undefined },
    );
    await harness.flushMemoryTasks();
    const groupSystem = (
      calls[1]?.messages as Array<{ role: string; content: string }>
    ).find((message) => message.role === 'system');
    expect(groupSystem?.content).not.toContain('称呼这位员工为「老张」');
    expect(resolveGroupMode).toHaveBeenCalledWith(
      'staff:staff-1',
      'cid-group-1',
    );
    expect(memoryInputs.at(-1)).toMatchObject({
      audience: 'group',
      userGroupSharing: 'off',
    });
  });

  it('授权解析失败时群聊继续执行，但关闭个人记忆共享', async () => {
    const calls: { messages: unknown[] }[] = [];
    const memoryInputs: Array<
      Parameters<HierarchicalMemoryManager['assemble']>[0]
    > = [];
    const memory = {
      async assemble(
        input: Parameters<HierarchicalMemoryManager['assemble']>[0],
      ) {
        memoryInputs.push(input);
        return {
          personaSystemPrompt: input.personaSystemPrompt,
          userSemanticProfile: '',
          groupRecentTranscript: '',
          episodicSummary: '',
          activeTurnMessages: input.activeTurnMessages ?? [],
        };
      },
      async maybeCompress() {
        return { compressed: false };
      },
      shouldExtractSemantic() {
        return false;
      },
      async captureSemantic() {
        return [];
      },
    } as unknown as HierarchicalMemoryManager;
    const { harness } = createHarness(
      scriptedEngine(calls),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        memory,
        personSettings: {
          async buildPrompt() {
            return undefined;
          },
          async resolveGroupMode() {
            throw new Error('consent store down');
          },
        },
      },
    );

    const result = await harness.handleMessage(
      inbound({ conversationType: '2', conversationId: 'cid-group-1' }),
      { emit: () => undefined },
    );
    await harness.flushMemoryTasks();
    expect(result?.answer).toBe('现在是十点。');
    expect(calls).toHaveLength(1);
    expect(memoryInputs.at(-1)?.userGroupSharing).toBe('off');
  });

  it('后台任务复用会话链路执行并带任务归因', async () => {
    const calls: { messages: unknown[] }[] = [];
    const contexts: Array<{ jobId?: string; jobKind?: string }> = [];
    const engine: AgentEngine = {
      async run(input) {
        calls.push({ messages: input.messages });
        contexts.push({
          ...(input.context.jobId ? { jobId: input.context.jobId } : {}),
          ...(input.context.jobKind ? { jobKind: input.context.jobKind } : {}),
        });
        input.emit({
          type: 'completed',
          usage: { totalTokens: 20, steps: 2, durationMs: 10 },
        });
        return {
          answer: '后台任务结果',
          reasoning: '',
          usage: { totalTokens: 20, steps: 2, durationMs: 10 },
        };
      },
    };
    const { harness, rows, conversations } = createHarness(engine);
    const job: AgentJob = {
      id: 'job-1',
      conversationId: 'cid-1',
      conversationType: '1',
      messageId: 'job_msg-1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      kind: 'task',
      status: 'running',
      prompt: '整理本周客户反馈',
      metadata: {},
      result: null,
      error: null,
      priority: 0,
      attempts: 1,
      maxAttempts: 2,
      leaseOwner: 'runner',
      leaseExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
      startedAt: 0,
      finishedAt: null,
    };

    const result = await harness.runJob(job, { emit: () => undefined });
    expect(result.answer).toBe('后台任务结果');
    expect(conversations[0]?.conversationKey).toBe('single:staff-1');
    expect(contexts[0]).toEqual({ jobId: 'job-1', jobKind: 'task' });
    expect(rows[0]).toMatchObject({
      role: 'user',
      content: '整理本周客户反馈',
      metadata: { jobId: 'job-1', jobKind: 'task' },
    });
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: '后台任务结果',
      metadata: { jobId: 'job-1' },
    });
    const messages = calls[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.at(-1)?.content).toContain('后台任务 ID：job-1');
    expect(messages.at(-1)?.content).toContain('整理本周客户反馈');
  });

  it('Worker 任务使用专属引擎、预算与结构化输出', async () => {
    const mainCalls: { messages: unknown[] }[] = [];
    const workerCalls: Array<{
      jobKind?: string;
      worker?: string;
      deadlineAt: number;
      messages: unknown[];
    }> = [];
    const records: Array<{ jobKind?: string; worker?: string }> = [];
    const workerEngine: AgentEngine = {
      async run(input) {
        workerCalls.push({
          ...(input.context.jobKind
            ? { jobKind: input.context.jobKind }
            : {}),
          ...(input.context.worker ? { worker: input.context.worker } : {}),
          deadlineAt: input.context.deadlineAt,
          messages: input.messages,
        });
        input.emit({
          type: 'completed',
          usage: { totalTokens: 25, steps: 3, durationMs: 14 },
        });
        return {
          answer: JSON.stringify({
            status: 'completed',
            summary: '网关超时要调大',
            findings: [{ claim: '超时阈值为 3 秒', source: '监控面板' }],
            actions: [],
            sources: ['https://monitor.example.com'],
            openQuestions: [],
          }),
          reasoning: '',
          usage: { totalTokens: 25, steps: 3, durationMs: 14 },
        };
      },
    };
    const { harness, rows } = createHarness(
      scriptedEngine(mainCalls),
      {
        async assertWithinQuota() {},
        async record(input) {
          records.push({
            ...(input.jobKind ? { jobKind: input.jobKind } : {}),
            ...(input.worker ? { worker: input.worker } : {}),
          });
        },
      },
      undefined,
      undefined,
      {
        research: {
          profile: {
            name: 'research',
            title: '研究 Worker',
            description: '只读查证',
            scope: { readOnly: true },
            policy: {
              maxWallTimeMs: 2_000,
              maxTotalTokens: 500,
              maxConsecutiveSameTool: 2,
              convergenceCheck: true,
              maxIterations: 5,
            },
            instruction: '只做只读查证，不要执行写操作。',
          },
          engine: workerEngine,
        },
      },
    );
    const job: AgentJob = {
      id: 'job-worker-1',
      conversationId: 'cid-1',
      conversationType: '1',
      messageId: 'job_msg-worker-1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      kind: 'worker',
      status: 'running',
      prompt: '查一下网关超时原因',
      metadata: { worker: 'research' },
      result: null,
      error: null,
      priority: 0,
      attempts: 1,
      maxAttempts: 2,
      leaseOwner: 'runner',
      leaseExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
      startedAt: 0,
      finishedAt: null,
    };

    const result = await harness.runJob(job, {
      emit: () => undefined,
      worker: 'research',
    });
    expect(mainCalls).toHaveLength(0);
    expect(workerCalls[0]).toMatchObject({
      jobKind: 'worker',
      worker: 'research',
      deadlineAt: 3_000,
    });
    expect(result.answer).toBe('网关超时要调大');
    expect(result.workerOutput).toMatchObject({
      status: 'completed',
      findings: [{ claim: '超时阈值为 3 秒', source: '监控面板' }],
      sources: ['https://monitor.example.com'],
    });
    expect(records[0]).toEqual({ jobKind: 'worker', worker: 'research' });
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: '网关超时要调大',
      metadata: { worker: 'research', workerStatus: 'completed' },
    });
    const prompt = (
      workerCalls[0]?.messages.at(-1) as { content: string } | undefined
    )?.content;
    expect(prompt).toContain('只做只读查证，不要执行写操作。');
    expect(prompt).toContain('"status":"completed|partial|blocked"');
  });

  it('Worker 输出不是 JSON 时回退原始回答', async () => {
    const workerEngine: AgentEngine = {
      async run() {
        return {
          answer: '网关超时集中在 10 点',
          reasoning: '',
          usage: { totalTokens: 8, steps: 1, durationMs: 5 },
        };
      },
    };
    const { harness, rows } = createHarness(
      scriptedEngine([]),
      undefined,
      undefined,
      undefined,
      {
        research: {
          profile: {
            name: 'research',
            title: '研究 Worker',
            description: '只读查证',
            scope: { readOnly: true },
            policy: {
              maxWallTimeMs: 2_000,
              maxTotalTokens: 500,
              maxConsecutiveSameTool: 2,
              convergenceCheck: true,
              maxIterations: 5,
            },
            instruction: '只做只读查证。',
          },
          engine: workerEngine,
        },
      },
    );
    const job: AgentJob = {
      id: 'job-worker-2',
      conversationId: 'cid-1',
      conversationType: '1',
      messageId: 'job_msg-worker-2',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      kind: 'worker',
      status: 'running',
      prompt: '查一下网关超时原因',
      metadata: { worker: 'research' },
      result: null,
      error: null,
      priority: 0,
      attempts: 1,
      maxAttempts: 2,
      leaseOwner: 'runner',
      leaseExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
      startedAt: 0,
      finishedAt: null,
    };
    const result = await harness.runJob(job, {
      emit: () => undefined,
      worker: 'research',
    });
    expect(result.answer).toBe('网关超时集中在 10 点');
    expect(result.workerOutput).toBeUndefined();
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: '网关超时集中在 10 点',
    });
  });

  it('静默调查使用只读引擎且不写会话历史', async () => {
    const mainCalls: { messages: unknown[] }[] = [];
    const investigationCalls: Array<{
      jobKind?: string;
      worker?: string;
      deadlineAt: number;
    }> = [];
    const records: Array<{ jobKind?: string; worker?: string }> = [];
    const investigationEngine: AgentEngine = {
      async run(input) {
        investigationCalls.push({
          ...(input.context.jobKind
            ? { jobKind: input.context.jobKind }
            : {}),
          ...(input.context.worker ? { worker: input.context.worker } : {}),
          deadlineAt: input.context.deadlineAt,
        });
        input.emit({
          type: 'completed',
          usage: { totalTokens: 30, steps: 2, durationMs: 12 },
        });
        return {
          answer: '{"confidence":0.9,"findings":["网关超时 3 秒"],"sources":[],"answer":"建议调大网关超时"}',
          reasoning: '',
          usage: { totalTokens: 30, steps: 2, durationMs: 12 },
        };
      },
    };
    const { harness, rows, conversations } = createHarness(
      scriptedEngine(mainCalls),
      {
        async assertWithinQuota() {},
        async record(input) {
          records.push({
            ...(input.jobKind ? { jobKind: input.jobKind } : {}),
            ...(input.worker ? { worker: input.worker } : {}),
          });
        },
      },
      undefined,
      investigationEngine,
    );
    const message = inbound({
      conversationType: '2',
      isAtBot: false,
      text: '订单服务 502 是不是网关超时？',
    });

    const result = await harness.investigate(message, {
      query: '订单服务 502 是否与网关超时有关',
      maxWallTimeMs: 20_000,
    });

    expect(result.answer).toContain('"confidence"');
    expect(mainCalls).toHaveLength(0);
    expect(investigationCalls).toEqual([
      { jobKind: 'investigation', worker: 'research', deadlineAt: 21_000 },
    ]);
    expect(records).toEqual([{ jobKind: 'investigation', worker: 'research' }]);
    expect(rows).toHaveLength(0);
    expect(conversations[0]?.conversationKey).toBe('group:cid-1');
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
    expect(second[2]?.content).toContain('现在是十点。');
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
