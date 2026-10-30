import {
  buildSystemPrompt,
  type ContextAssembler,
  type PersonaInput,
} from '../memory/ContextAssembler.js';
import type { ConversationRepository } from '../memory/ConversationRepository.js';
import type { HierarchicalMemoryManager } from '../memory/HierarchicalMemoryManager.js';
import {
  toTranscriptEntry,
  type GroupTranscriptBuffer,
} from '../bystander/GroupTranscriptBuffer.js';
import type { BystanderTriageEngine } from '../bystander/BystanderTriageEngine.js';
import type {
  AssembledMemoryContext,
  BystanderEvaluationResult,
  GroupBystanderPolicy,
} from '../types/bystander-and-memory.js';
import type {
  AgentEngine,
  AgentStreamEvent,
  DynamicLoopPolicy,
  InboundMessage,
  RunResult,
  RunUsage,
} from '../types/core.js';
import { QuotaExceededError } from '../billing/UsageGuard.js';

export interface HarnessLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface HarnessBystanderOptions {
  buffer: GroupTranscriptBuffer;
  triage: BystanderTriageEngine;
  policyProvider: (
    conversationId: string,
  ) => Promise<GroupBystanderPolicy> | GroupBystanderPolicy;
}

export interface AgentHarnessOptions {
  engine: AgentEngine;
  repository: ConversationRepository;
  assembler: ContextAssembler;
  persona: PersonaInput;
  policy: DynamicLoopPolicy;
  windowMessages: number;
  now?: () => number;
  logger?: HarnessLogger;
  memory?: HierarchicalMemoryManager;
  bystander?: HarnessBystanderOptions;
  /** 压缩/摘要回看的历史消息上限，默认 200 */
  fullHistoryLimit?: number;
  /** 每日 Token 配额与用量记账 */
  usageGuard?: {
    assertWithinQuota(input: {
      senderStaffId: string;
      conversationId: string;
      conversationType: '1' | '2';
    }): Promise<void>;
    record(input: {
      conversationId: string;
      conversationType: '1' | '2';
      senderStaffId: string;
      senderNick: string;
      model: string;
      totalTokens: number;
      steps: number;
      durationMs: number;
      proactive: boolean;
    }): Promise<void>;
  };
}

export interface HandleMessageOptions {
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export interface ProactiveHandleOptions {
  decision: BystanderEvaluationResult;
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

function emptyUsage(): RunUsage {
  return { totalTokens: 0, steps: 0, durationMs: 0 };
}

export function conversationKeyFor(message: InboundMessage): string {
  return message.conversationType === '1'
    ? `single:${message.senderStaffId}`
    : `group:${message.conversationId}`;
}

/**
 * 连接钉钉入站消息、多轮记忆、上下文组装与 ReAct 引擎。
 * 群聊全量消息先入旁听缓冲；非 @ 消息由 BystanderTriageEngine 判定后，
 * 只有 PROACTIVE_REPLY 才通过 handleBystanderMessage 唤醒 ReAct。
 */
export class AgentHarness {
  private readonly now: () => number;
  private readonly memoryTasks = new Set<Promise<void>>();

  constructor(private readonly options: AgentHarnessOptions) {
    this.now = options.now ?? Date.now;
  }

  public async handleMessage(
    message: InboundMessage,
    handle: HandleMessageOptions,
  ): Promise<RunResult | null> {
    if (message.conversationType === '2') {
      this.options.bystander?.buffer.append(toTranscriptEntry(message));
    }
    if (message.conversationType === '2' && !message.isAtBot) {
      return null;
    }
    const text = message.text.trim();
    if (!text) return null;
    const quotaAnswer = await this.enforceQuota(message, handle.emit, false);
    if (quotaAnswer) return quotaAnswer;

    const { repository, assembler, engine, policy, persona } = this.options;
    const conversation = await repository.ensureConversation({
      conversationKey: conversationKeyFor(message),
      conversationType: message.conversationType,
      title: message.senderNick,
      metadata: {
        conversationId: message.conversationId,
        senderStaffId: message.senderStaffId,
      },
    });

    const history = await repository.recentMessages(
      conversation.id,
      this.options.windowMessages,
    );
    const memoryContext = await this.buildMemoryContext(
      message,
      conversation.id,
      text,
      message.messageId,
    );
    const messages = assembler.build({
      persona,
      history,
      userText: text,
      now: this.now,
      memoryContext,
      groupChat: message.conversationType === '2',
      userSpeaker: message.senderNick,
    });

    await repository.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: text,
      metadata: {
        messageId: message.messageId,
        senderStaffId: message.senderStaffId,
        senderNick: message.senderNick,
        conversationType: message.conversationType,
      },
    });

    const startedAt = this.now();
    const result = await engine.run({
      messages,
      context: {
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderStaffId: message.senderStaffId,
        senderNick: message.senderNick,
        conversationType: message.conversationType,
        deadlineAt: startedAt + policy.maxWallTimeMs,
        now: this.now,
        proactive: false,
      },
      emit: handle.emit,
      signal: handle.signal,
    });
    await this.recordUsage(message, result, false);

    await repository.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      reasoning: result.reasoning || null,
      tokenCount: result.usage.totalTokens,
      metadata: {
        messageId: message.messageId,
        steps: result.usage.steps,
        durationMs: result.usage.durationMs,
        ...(result.model ? { model: result.model } : {}),
      },
    });

    this.options.logger?.info(
      {
        conversationKey: conversation.conversationKey,
        messageId: message.messageId,
        steps: result.usage.steps,
        tokens: result.usage.totalTokens,
        durationMs: result.usage.durationMs,
      },
      'agent turn completed',
    );

    this.scheduleMemoryMaintenance(
      conversation.id,
      message,
      text,
      result.answer,
    );
    return result;
  }

  /**
   * L3：旁听漏斗判定 PROACTIVE_REPLY 后，携带群聊上下文唤醒 ReAct 主引擎。
   * 非群聊、@ 消息或非主动回复决策一律不执行。
   */
  public async handleBystanderMessage(
    message: InboundMessage,
    handle: ProactiveHandleOptions,
  ): Promise<RunResult | null> {
    if (message.conversationType !== '2' || message.isAtBot) return null;
    if (handle.decision.action !== 'PROACTIVE_REPLY') return null;

    const text = handle.decision.extractedQuery.trim() || message.text.trim();
    if (!text) return null;
    if (await this.enforceQuota(message, handle.emit, true)) return null;

    const { repository, assembler, engine, policy, persona } = this.options;
    const policyConfig = await this.loadBystanderPolicy(message.conversationId);
    if (
      policyConfig &&
      handle.decision.confidence < policyConfig.confidenceThreshold
    ) {
      this.options.logger?.info(
        {
          conversationId: message.conversationId,
          confidence: handle.decision.confidence,
          threshold: policyConfig.confidenceThreshold,
        },
        'proactive reply rejected by harness threshold',
      );
      return null;
    }

    const conversation = await repository.ensureConversation({
      conversationKey: conversationKeyFor(message),
      conversationType: message.conversationType,
      title: message.senderNick,
      metadata: {
        conversationId: message.conversationId,
        senderStaffId: message.senderStaffId,
      },
    });

    const history = await repository.recentMessages(
      conversation.id,
      this.options.windowMessages,
    );
    const memoryContext = await this.buildMemoryContext(
      message,
      conversation.id,
      text,
    );
    const proactiveInstruction = [
      '你正在钉钉群里主动提供帮助（并非被 @）。',
      '请结合群聊旁听记录核实问题，直接给出结论、关键依据与下一步建议。',
      '不要说明你在旁听，不要复述整段群聊，保持简洁，避免刷屏。',
      `需要查证的问题：${text}`,
    ].join('\n');
    const messages = assembler.build({
      persona,
      history,
      userText: proactiveInstruction,
      now: this.now,
      memoryContext,
      groupChat: true,
      // 主动回复的 user 消息是系统指令，不使用成员昵称加前缀
    });

    await repository.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: text,
      metadata: {
        messageId: message.messageId,
        senderStaffId: message.senderStaffId,
        senderNick: message.senderNick,
        conversationType: message.conversationType,
        proactive: true,
        triggerReason: handle.decision.triggerReason,
        confidence: handle.decision.confidence,
      },
    });

    const startedAt = this.now();
    const result = await engine.run({
      messages,
      context: {
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderStaffId: message.senderStaffId,
        senderNick: message.senderNick,
        conversationType: message.conversationType,
        deadlineAt: startedAt + policy.maxWallTimeMs,
        now: this.now,
        proactive: true,
      },
      emit: handle.emit,
      signal: handle.signal,
    });
    await this.recordUsage(message, result, true);

    await repository.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      reasoning: result.reasoning || null,
      tokenCount: result.usage.totalTokens,
      metadata: {
        messageId: message.messageId,
        proactive: true,
        steps: result.usage.steps,
        durationMs: result.usage.durationMs,
        ...(result.model ? { model: result.model } : {}),
      },
    });

    this.options.logger?.info(
      {
        conversationKey: conversation.conversationKey,
        messageId: message.messageId,
        triggerReason: handle.decision.triggerReason,
        confidence: handle.decision.confidence,
        steps: result.usage.steps,
        tokens: result.usage.totalTokens,
      },
      'proactive reply completed',
    );

    this.scheduleMemoryMaintenance(
      conversation.id,
      message,
      text,
      result.answer,
    );
    return result;
  }

  /** 测试与优雅停机时等待后台摘要/画像抽取完成 */
  public async flushMemoryTasks(): Promise<void> {
    await Promise.allSettled([...this.memoryTasks]);
  }

  /** 人设热更新：下一条消息立即使用新 Prompt */
  public updatePersona(persona: PersonaInput): void {
    this.options.persona = persona;
  }

  /** 动态循环预算热更新 */
  public updatePolicy(policy: DynamicLoopPolicy): void {
    this.options.policy = policy;
  }

  private async buildMemoryContext(
    message: InboundMessage,
    dbConversationId: string,
    userText: string,
    excludeMessageId?: string,
  ): Promise<AssembledMemoryContext | undefined> {
    const memory = this.options.memory;
    if (!memory) return undefined;

    let groupTranscript = '';
    if (message.conversationType === '2' && this.options.bystander) {
      const policy = await this.loadBystanderPolicy(message.conversationId);
      groupTranscript = this.options.bystander.buffer.format(
        message.conversationId,
        {
          limit: policy?.slidingWindowSize ?? 20,
          excludeMessageId,
        },
      );
    }

    return memory.assemble({
      personaSystemPrompt: buildSystemPrompt(
        this.options.persona,
        this.now,
      ),
      userId: message.senderStaffId,
      speakerNick: message.senderNick,
      conversationId: dbConversationId,
      groupConversationId: message.conversationId,
      groupRecentTranscript: groupTranscript,
      activeTurnMessages: [{ role: 'user', content: userText }],
      semanticQuery: userText,
    });
  }

  private async loadBystanderPolicy(
    conversationId: string,
  ): Promise<GroupBystanderPolicy | undefined> {
    const bystander = this.options.bystander;
    if (!bystander) return undefined;
    try {
      return await bystander.policyProvider(conversationId);
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to load bystander policy, using defaults',
      );
      return undefined;
    }
  }

  /**
   * 主动回复超出配额时静默放弃，@ 消息则直接回复配额提示，避免白白调用模型。
   */
  private async enforceQuota(
    message: InboundMessage,
    emit: (event: AgentStreamEvent) => void,
    proactive: boolean,
  ): Promise<RunResult | null> {
    const guard = this.options.usageGuard;
    if (!guard) return null;
    try {
      await guard.assertWithinQuota({
        senderStaffId: message.senderStaffId,
        conversationId: message.conversationId,
        conversationType: message.conversationType,
      });
      return null;
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error;
      this.options.logger?.warn(
        {
          conversationId: message.conversationId,
          senderStaffId: message.senderStaffId,
          scope: error.scope,
          used: error.used,
          limit: error.limit,
          proactive,
        },
        'daily token quota exceeded',
      );
      if (proactive) return { answer: '', reasoning: '', usage: emptyUsage() };
      const answer = `${error.message}，配额将在次日 0 点（Asia/Shanghai）重置。`;
      emit({ type: 'answer_delta', content: answer, final: true });
      emit({ type: 'completed', usage: emptyUsage() });
      return { answer, reasoning: '', usage: emptyUsage() };
    }
  }

  private async recordUsage(
    message: InboundMessage,
    result: RunResult,
    proactive: boolean,
  ): Promise<void> {
    const guard = this.options.usageGuard;
    if (!guard) return;
    try {
      await guard.record({
        conversationId: message.conversationId,
        conversationType: message.conversationType,
        senderStaffId: message.senderStaffId,
        senderNick: message.senderNick,
        model: result.model ?? 'unknown',
        totalTokens: result.usage.totalTokens,
        steps: result.usage.steps,
        durationMs: result.usage.durationMs,
        proactive,
      });
    } catch (error) {
      this.options.logger?.warn(
        {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to record token usage',
      );
    }
  }

  private scheduleMemoryMaintenance(
    conversationId: string,
    message: InboundMessage,
    userText: string,
    assistantText: string,
  ): void {
    const memory = this.options.memory;
    if (!memory) return;

    let tracked: Promise<void>;
    tracked = (async () => {
      const history = await this.options.repository.recentMessages(
        conversationId,
        this.options.fullHistoryLimit ?? 200,
      );
      await memory.maybeCompress(conversationId, history);
      if (memory.shouldExtractSemantic(userText)) {
        await memory.captureSemantic({
          userId: message.senderStaffId,
          speakerNick: message.senderNick,
          conversationId: message.conversationId,
          conversationType: message.conversationType,
          userText,
          assistantText,
        });
      }
    })()
      .catch((error) => {
        this.options.logger?.warn(
          {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          },
          'memory maintenance failed',
        );
      })
      .finally(() => {
        this.memoryTasks.delete(tracked);
      });
    this.memoryTasks.add(tracked);
  }
}
