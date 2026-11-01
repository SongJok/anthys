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
import type { GlossaryContextProvider } from '../types/glossary.js';
import type {
  AgentEngine,
  AgentStreamEvent,
  DynamicLoopPolicy,
  InboundMessage,
  RunResult,
  RunUsage,
} from '../types/core.js';
import type { AgentJob } from '../types/jobs.js';
import {
  isWorkerName,
  type WorkerName,
  type WorkerOutput,
} from '../types/workers.js';
import type { WorkerProfile } from '../workers/WorkerRegistry.js';
import {
  WORKER_OUTPUT_CONTRACT,
  parseWorkerOutput,
} from '../workers/WorkerOutput.js';
import { QuotaExceededError } from '../billing/UsageGuard.js';
import {
  assessRequestAdmission,
  formatAdmissionRefusal,
} from './RequestAdmission.js';

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

export interface ExtensionPromptInput {
  message: InboundMessage;
  text: string;
  proactive: boolean;
}

/** 技能目录、项目简报等随会话动态生成的系统提示词片段 */
export interface ExtensionPromptProvider {
  build(
    input: ExtensionPromptInput,
  ): Promise<string | undefined> | string | undefined;
}

export interface AgentHarnessOptions {
  engine: AgentEngine;
  /** 只读调查引擎（工具白名单在执行层过滤）；缺省回退主引擎 */
  investigationEngine?: AgentEngine;
  /** Worker 专用引擎与画像；未配置的 Worker 回退主引擎 */
  workerRuntimes?: Partial<Record<WorkerName, WorkerRuntime>>;
  repository: ConversationRepository;
  assembler: ContextAssembler;
  persona: PersonaInput;
  policy: DynamicLoopPolicy;
  windowMessages: number;
  now?: () => number;
  logger?: HarnessLogger;
  memory?: HierarchicalMemoryManager;
  bystander?: HarnessBystanderOptions;
  /** 术语知识库：高频注入 + 按问检索，命中后写入系统提示 */
  glossary?: GlossaryContextProvider;
  /** 技能目录 / 项目手册简报等扩展系统提示词 */
  extensions?: ExtensionPromptProvider;
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
      jobId?: string;
      jobKind?: string;
      worker?: string;
    }): Promise<void>;
  };
}

export interface HandleMessageOptions {
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
  /** 系统发起的主动播报（定时任务），影响用量归因与模型路由 */
  proactive?: boolean;
  /** 工具需要用户干预时向会话追加提醒（如重新授权） */
  notify?: (text: string) => Promise<void> | void;
}

export interface ProactiveHandleOptions {
  decision: BystanderEvaluationResult;
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
  notify?: (text: string) => Promise<void> | void;
}

export interface JobHandleOptions {
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
  notify?: (text: string) => Promise<void> | void;
  /** Worker 名称，用于用量归因、预算与结构化输出 */
  worker?: string;
}

export interface WorkerRuntime {
  profile: WorkerProfile;
  engine: AgentEngine;
}

export interface JobRunResult extends RunResult {
  /** Worker 结构化回执；普通后台任务不返回 */
  workerOutput?: WorkerOutput;
}

export interface InvestigationHandleOptions {
  query: string;
  signal?: AbortSignal;
  /** 默认丢弃过程事件；需要排查时可临时接入 */
  emit?: (event: AgentStreamEvent) => void;
  /** 调查墙钟预算，缺省复用循环策略 */
  maxWallTimeMs?: number;
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
 * 会话标题：群聊用群名，单聊用对方昵称。
 * 拿不到群名时返回 undefined，避免把发送人昵称存成群名。
 */
export function conversationTitleFor(
  message: InboundMessage,
): string | undefined {
  if (message.conversationType === '1') return message.senderNick;
  return message.conversationTitle;
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
    const admissionAnswer = this.enforceAdmission(
      message.senderStaffId,
      message.conversationId,
      text,
      handle.emit,
      handle.proactive ?? false,
    );
    if (admissionAnswer) return admissionAnswer;

    const { repository, assembler, engine, policy, persona } = this.options;
    const conversation = await repository.ensureConversation({
      conversationKey: conversationKeyFor(message),
      conversationType: message.conversationType,
      title: conversationTitleFor(message),
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
    const extraSystemPrompt = await this.buildExtraSystemPrompt(
      message,
      text,
      handle.proactive ?? false,
    );
    const messages = assembler.build({
      persona,
      history,
      userText: text,
      now: this.now,
      memoryContext,
      ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
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
        proactive: handle.proactive ?? false,
        ...(handle.notify ? { notify: handle.notify } : {}),
      },
      emit: handle.emit,
      signal: handle.signal,
    });
    await this.recordUsage(message, result, handle.proactive ?? false);

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
    if (!assessRequestAdmission(text).accepted) {
      this.options.logger?.info(
        {
          conversationId: message.conversationId,
          messageId: message.messageId,
        },
        'proactive reply skipped: request exceeds admission limits',
      );
      return null;
    }
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
      title: conversationTitleFor(message),
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
    const glossaryPrompt = await this.buildGlossaryPrompt(message, text);
    const proactiveInstruction = [
      '你正在钉钉群里主动提供帮助（并非被 @）。',
      '请结合群聊旁听记录核实问题，直接给出结论、关键依据与下一步建议。',
      '不要说明你在旁听，不要复述整段群聊，保持简洁，避免刷屏。',
      `需要查证的问题：${text}`,
    ].join('\n');
    const extensionPrompt = await this.buildExtensionPrompt(
      message,
      text,
      true,
    );
    const extraSystemPrompt = [extensionPrompt, glossaryPrompt]
      .filter((section): section is string => Boolean(section))
      .join('\n\n');
    const messages = assembler.build({
      persona,
      history,
      userText: proactiveInstruction,
      now: this.now,
      memoryContext,
      ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
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
        ...(handle.notify ? { notify: handle.notify } : {}),
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

  /**
   * 静默调查入口：对群里未触发主动回复的疑点做只读查证。
   * 不写会话历史、不流式打扰群成员，仅记录用量归因；是否浮出由调用方决定。
   */
  public async investigate(
    message: InboundMessage,
    input: InvestigationHandleOptions,
  ): Promise<RunResult> {
    const query = input.query.trim();
    if (!query) throw new Error('静默调查缺少待核实的问题');
    const engine = this.options.investigationEngine ?? this.options.engine;
    const { repository, assembler, policy, persona } = this.options;

    const conversation = await repository.ensureConversation({
      conversationKey: conversationKeyFor(message),
      conversationType: message.conversationType,
      title: conversationTitleFor(message),
      metadata: {
        conversationId: message.conversationId,
        senderStaffId: message.senderStaffId,
      },
    });
    const memoryContext = await this.buildMemoryContext(
      message,
      conversation.id,
      query,
      message.messageId,
    );
    const extensionPrompt = await this.buildExtensionPrompt(message, query, true);
    const instruction = [
      '你正在钉钉群里做静默调查（只读），群成员看不到调查过程。',
      '只使用只读工具（检索、读取、查询）核实事实；不要声称已执行任何写操作，不要编造数据。',
      '最多进行 3 轮工具调用；证据不足就停止，不要反复搜索。',
      '最终只输出一个 JSON 对象，不要输出 JSON 之外的文字：',
      '{"confidence":0到1的数字,"findings":["可核实的事实"],"sources":["链接或数据来源"],"answer":"可直接发到群里的简洁答复"}',
      '若证据不足：confidence 低于 0.4，findings 与 sources 留空，answer 说明无法确认。',
      `待核实问题：${query}`,
    ].join('\n');
    const messages = assembler.build({
      persona,
      history: [],
      userText: instruction,
      now: this.now,
      memoryContext,
      ...(extensionPrompt ? { extraSystemPrompt: extensionPrompt } : {}),
      groupChat: true,
    });

    const startedAt = this.now();
    const deadlineMs = input.maxWallTimeMs ?? policy.maxWallTimeMs;
    const emit = input.emit ?? ((): void => {});
    const result = await engine.run({
      messages,
      context: {
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderStaffId: message.senderStaffId,
        senderNick: message.senderNick,
        conversationType: message.conversationType,
        deadlineAt: startedAt + deadlineMs,
        now: this.now,
        proactive: true,
        jobKind: 'investigation',
        worker: 'research',
      },
      emit,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await this.recordUsage(message, result, true, {
      jobKind: 'investigation',
      worker: 'research',
    });

    this.options.logger?.info(
      {
        conversationId: message.conversationId,
        messageId: message.messageId,
        steps: result.usage.steps,
        tokens: result.usage.totalTokens,
        durationMs: result.usage.durationMs,
      },
      'silent investigation turn completed',
    );
    return result;
  }

  /**
   * 后台任务入口：由持久化任务队列在独立上下文中调用。
   * 与即时对话共享会话、记忆与用量链路，但不占用用户请求队列。
   */
  public async runJob(
    job: AgentJob,
    handle: JobHandleOptions,
  ): Promise<JobRunResult> {
    const text = job.prompt.trim();
    if (!text) throw new Error('后台任务缺少需求描述');
    const workerName =
      handle.worker !== undefined && isWorkerName(handle.worker)
        ? handle.worker
        : undefined;
    const workerRuntime = workerName
      ? this.options.workerRuntimes?.[workerName]
      : undefined;
    const workerProfile = workerRuntime?.profile;
    if (handle.worker && !workerRuntime) {
      this.options.logger?.warn(
        { jobId: job.id, worker: handle.worker },
        'unknown worker, falling back to main engine',
      );
    }

    const message: InboundMessage = {
      messageId: job.messageId || `job_${job.id}`,
      conversationId: job.conversationId,
      conversationType: job.conversationType,
      senderStaffId: job.senderStaffId || 'job-runner',
      senderNick: job.senderNick || '后台任务',
      isAtBot: true,
      text,
      rawPayload: {
        source: 'agent_job',
        jobId: job.id,
        jobKind: job.kind,
        ...(workerName ? { worker: workerName } : {}),
      },
      timestamp: job.createdAt,
    };
    const proactive = job.metadata.proactive === true;

    const quotaAnswer = await this.enforceQuota(message, handle.emit, false);
    if (quotaAnswer) return quotaAnswer;

    const { repository, assembler, persona } = this.options;
    const engine = workerRuntime?.engine ?? this.options.engine;
    const policy = workerProfile?.policy ?? this.options.policy;
    const conversation = await repository.ensureConversation({
      conversationKey: conversationKeyFor(message),
      conversationType: message.conversationType,
      title: conversationTitleFor(message),
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
    const extraSystemPrompt = await this.buildExtraSystemPrompt(
      message,
      text,
      proactive,
    );
    const jobInstruction = [
      `这是一个后台任务（${job.kind}），用户不会实时查看执行过程。`,
      ...(workerProfile
        ? [
            `执行单元：${workerProfile.title}（${workerProfile.name}）`,
            workerProfile.instruction,
            WORKER_OUTPUT_CONTRACT,
          ]
        : []),
      '请独立完成需求，在最终回答中给出可交付结果、关键依据与后续建议；不要输出“稍后马上”之类的过程承诺。',
      `后台任务 ID：${job.id}`,
      `任务需求：${text}`,
    ].join('\n');
    const messages = assembler.build({
      persona,
      history,
      userText: jobInstruction,
      now: this.now,
      memoryContext,
      ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
      groupChat: message.conversationType === '2',
      ...(message.conversationType === '1'
        ? { userSpeaker: message.senderNick }
        : {}),
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
        jobId: job.id,
        jobKind: job.kind,
        ...(workerName ? { worker: workerName } : {}),
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
        proactive,
        jobId: job.id,
        jobKind: job.kind,
        ...(workerName ? { worker: workerName } : {}),
        ...(handle.notify ? { notify: handle.notify } : {}),
      },
      emit: handle.emit,
      signal: handle.signal,
    });
    await this.recordUsage(message, result, proactive, {
      jobId: job.id,
      jobKind: job.kind,
      ...(workerName ? { worker: workerName } : {}),
    });

    let workerOutput: WorkerOutput | undefined;
    if (workerProfile) {
      workerOutput = parseWorkerOutput(result.answer) ?? undefined;
      if (!workerOutput) {
        this.options.logger?.warn(
          { jobId: job.id, worker: workerProfile.name },
          'worker output is not structured JSON, falling back to raw answer',
        );
      }
    }
    const finalAnswer = workerOutput?.summary ?? result.answer;

    await repository.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: finalAnswer,
      reasoning: result.reasoning || null,
      tokenCount: result.usage.totalTokens,
      metadata: {
        messageId: message.messageId,
        jobId: job.id,
        jobKind: job.kind,
        ...(workerName ? { worker: workerName } : {}),
        ...(workerOutput ? { workerStatus: workerOutput.status } : {}),
        steps: result.usage.steps,
        durationMs: result.usage.durationMs,
        ...(result.model ? { model: result.model } : {}),
      },
    });

    this.options.logger?.info(
      {
        conversationKey: conversation.conversationKey,
        jobId: job.id,
        jobKind: job.kind,
        ...(workerName ? { worker: workerName } : {}),
        ...(workerOutput ? { workerStatus: workerOutput.status } : {}),
        steps: result.usage.steps,
        tokens: result.usage.totalTokens,
        durationMs: result.usage.durationMs,
      },
      'agent job completed',
    );

    this.scheduleMemoryMaintenance(
      conversation.id,
      message,
      text,
      finalAnswer,
    );
    return {
      ...result,
      answer: finalAnswer,
      ...(workerOutput ? { workerOutput } : {}),
    };
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

  private async buildGlossaryPrompt(
    message: InboundMessage,
    query: string,
  ): Promise<string | undefined> {
    const glossary = this.options.glossary;
    if (!glossary) return undefined;
    try {
      const result = await glossary.buildContext({
        conversationType: message.conversationType,
        query,
      });
      const prompt = result.prompt.trim();
      return prompt || undefined;
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId: message.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to build glossary prompt, continuing without it',
      );
      return undefined;
    }
  }

  private async buildExtraSystemPrompt(
    message: InboundMessage,
    text: string,
    proactive: boolean,
  ): Promise<string | undefined> {
    const extensionPrompt = await this.buildExtensionPrompt(
      message,
      text,
      proactive,
    );
    const glossaryPrompt = await this.buildGlossaryPrompt(message, text);
    const sections = [extensionPrompt, glossaryPrompt].filter(
      (section): section is string => Boolean(section),
    );
    return sections.length > 0 ? sections.join('\n\n') : undefined;
  }

  private async buildExtensionPrompt(
    message: InboundMessage,
    text: string,
    proactive: boolean,
  ): Promise<string | undefined> {
    const extensions = this.options.extensions;
    if (!extensions) return undefined;
    try {
      const prompt = (await extensions.build({ message, text, proactive }))
        ?.trim();
      return prompt || undefined;
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId: message.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to build extension prompt, continuing without it',
      );
      return undefined;
    }
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

  /**
   * 明文里已经写明是 20 分钟以上的任务时，不调用模型、不写记忆，
   * 直接告知提问者机器人不认可该需求。
   */
  private enforceAdmission(
    senderStaffId: string,
    conversationId: string,
    text: string,
    emit: (event: AgentStreamEvent) => void,
    proactive: boolean,
  ): RunResult | null {
    const decision = assessRequestAdmission(text);
    if (decision.accepted) return null;
    const answer = formatAdmissionRefusal(decision, this.options.policy);
    this.options.logger?.info(
      {
        conversationId,
        senderStaffId,
        matched: decision.matched,
        durationMs: decision.durationMs,
        proactive,
      },
      'request refused by admission guard',
    );
    emit({ type: 'answer_delta', content: answer, final: true });
    emit({ type: 'completed', usage: emptyUsage() });
    return { answer, reasoning: '', usage: emptyUsage() };
  }

  private async recordUsage(
    message: InboundMessage,
    result: RunResult,
    proactive: boolean,
    attribution: { jobId?: string; jobKind?: string; worker?: string } = {},
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
        ...(attribution.jobId ? { jobId: attribution.jobId } : {}),
        ...(attribution.jobKind ? { jobKind: attribution.jobKind } : {}),
        ...(attribution.worker ? { worker: attribution.worker } : {}),
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
