import type { ContextAssembler, PersonaInput } from '../memory/ContextAssembler.js';
import type { ConversationRepository } from '../memory/ConversationRepository.js';
import type {
  AgentEngine,
  AgentStreamEvent,
  DynamicLoopPolicy,
  InboundMessage,
  RunResult,
} from '../types/core.js';

export interface HarnessLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
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
}

export interface HandleMessageOptions {
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export function conversationKeyFor(message: InboundMessage): string {
  return message.conversationType === '1'
    ? `single:${message.senderStaffId}`
    : `group:${message.conversationId}`;
}

/**
 * 连接钉钉入站消息、多轮记忆、上下文组装与 ReAct 引擎。
 * 群聊中未 @ 机器人（或解析为非文本）的消息在此直接返回 null，不产生任何副作用。
 */
export class AgentHarness {
  private readonly now: () => number;

  constructor(private readonly options: AgentHarnessOptions) {
    this.now = options.now ?? Date.now;
  }

  public async handleMessage(
    message: InboundMessage,
    handle: HandleMessageOptions,
  ): Promise<RunResult | null> {
    if (message.conversationType === '2' && !message.isAtBot) {
      return null;
    }
    const text = message.text.trim();
    if (!text) return null;

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
    const messages = assembler.build({
      persona,
      history,
      userText: text,
      now: this.now,
    });

    await repository.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: text,
      metadata: { messageId: message.messageId },
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
      },
      emit: handle.emit,
      signal: handle.signal,
    });

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

    return result;
  }
}
