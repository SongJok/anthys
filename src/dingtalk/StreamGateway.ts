import { TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import { parseCardAction, type CardActionEvent } from './CardActions.js';
import { parseStreamMessage } from './MessageParser.js';
import { toTranscriptEntry } from '../bystander/GroupTranscriptBuffer.js';
import type { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import type { InboundMessage } from '../types/core.js';

export interface StreamCallbackMessage {
  headers: { messageId: string };
  data: string;
}

/** DWClient 的最小结构接口，便于测试替换 */
export interface StreamClient {
  registerCallbackListener(
    topic: string,
    callback: (message: StreamCallbackMessage) => void,
  ): unknown;
  socketCallBackResponse(messageId: string, result: unknown): void;
  connect(): Promise<void>;
  disconnect(): void;
}

export interface StreamGatewayLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface StreamGatewayOptions {
  client: StreamClient;
  handler: (message: InboundMessage) => Promise<void>;
  /**
   * 群聊非@消息的旁听处理入口：由调用方判断是否主动插话。
   * 未提供时保持旧行为（直接丢弃）。
   */
  bystanderHandler?: (message: InboundMessage) => Promise<void>;
  /** 群聊旁听缓冲池，所有群消息（含@）都会先写入 */
  transcriptBuffer?: GroupTranscriptBuffer;
  /** 互动卡片按钮 / 快捷操作回调 */
  cardActionHandler?: (action: CardActionEvent) => Promise<void>;
  logger?: StreamGatewayLogger;
  now?: () => number;
  /** 已处理消息的去重窗口，默认 1000 条 */
  dedupeLimit?: number;
}

/**
 * 钉钉 Stream 网关：收到回调后立即 ACK（防止钉钉 60s 内重试），
 * 再异步解析并交给 AgentHarness。群聊消息全部写入旁听缓冲，
 * 未 @ 机器人的消息交给旁听引擎评估，@ 消息走主处理链路。
 */
export class StreamGateway {
  private readonly seen = new Map<string, number>();
  private readonly dedupeLimit: number;
  private readonly now: () => number;
  private started = false;

  constructor(private readonly options: StreamGatewayOptions) {
    this.dedupeLimit = options.dedupeLimit ?? 1000;
    this.now = options.now ?? Date.now;
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.options.client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      this.onRawMessage(message);
    });
    if (this.options.cardActionHandler) {
      this.options.client.registerCallbackListener(TOPIC_CARD, (message) => {
        this.onRawCardMessage(message);
      });
    }
    await this.options.client.connect();
    this.started = true;
    this.options.logger?.info(
      {
        topics: this.options.cardActionHandler
          ? [TOPIC_ROBOT, TOPIC_CARD]
          : [TOPIC_ROBOT],
      },
      'stream gateway started',
    );
  }

  public stop(): void {
    if (!this.started) return;
    this.options.client.disconnect();
    this.started = false;
  }

  /** 同步 ACK 后异步处理，保证钉钉不会因处理耗时重推消息 */
  public onRawMessage(message: StreamCallbackMessage): void {
    const messageId = message.headers?.messageId ?? '';
    if (!messageId) {
      this.options.logger?.warn({}, 'stream message without messageId ignored');
      return;
    }
    this.options.client.socketCallBackResponse(messageId, {
      status: 'SUCCESS',
    });
    void this.dispatch(message.data, messageId);
  }

  /** 卡片回调：同样先 ACK 再异步分发，解析失败只记日志 */
  public onRawCardMessage(message: StreamCallbackMessage): void {
    const messageId = message.headers?.messageId ?? '';
    if (messageId) {
      this.options.client.socketCallBackResponse(messageId, {
        status: 'SUCCESS',
      });
    }
    void this.dispatchCardAction(message.data, messageId);
  }

  public async dispatchCardAction(
    data: string,
    messageId: string,
  ): Promise<void> {
    if (messageId && this.seen.has(messageId)) {
      this.options.logger?.info({ messageId }, 'duplicate card callback ignored');
      return;
    }
    if (messageId) this.remember(messageId);

    const handler = this.options.cardActionHandler;
    if (!handler) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      this.options.logger?.warn(
        {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'invalid card callback payload',
      );
      return;
    }
    const action = parseCardAction(payload);
    if (!action) {
      this.options.logger?.info({ messageId }, 'unrecognized card action ignored');
      return;
    }
    try {
      await handler(action);
    } catch (error) {
      this.options.logger?.error(
        {
          messageId,
          actionId: action.actionId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
        'card action handler failed',
      );
    }
  }

  /** 测试与复用入口：解析一条原始 data 字符串 */
  public async dispatch(data: string, messageId: string): Promise<void> {
    if (!messageId) {
      this.options.logger?.warn({}, 'stream message without messageId ignored');
      return;
    }
    if (this.seen.has(messageId)) {
      this.options.logger?.info({ messageId }, 'duplicate stream message ignored');
      return;
    }
    this.remember(messageId);

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      this.options.logger?.warn(
        { messageId, error: error instanceof Error ? error.message : String(error) },
        'invalid stream payload',
      );
      return;
    }

    const message = parseStreamMessage(payload, this.now);
    if (!message) {
      this.options.logger?.info({ messageId }, 'non-text stream message ignored');
      return;
    }
    if (message.conversationType === '2') {
      this.options.transcriptBuffer?.append(toTranscriptEntry(message));
      if (!message.isAtBot) {
        await this.dispatchBystander(message);
        return;
      }
    }

    try {
      await this.options.handler(message);
    } catch (error) {
      this.options.logger?.error(
        {
          messageId: message.messageId,
          conversationId: message.conversationId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
        'agent handler failed',
      );
    }
  }

  /** 非@群消息交由旁听引擎评估，异常不得影响后续消息处理 */
  private async dispatchBystander(message: InboundMessage): Promise<void> {
    const handler = this.options.bystanderHandler;
    if (!handler) {
      this.options.logger?.info(
        { messageId: message.messageId, conversationId: message.conversationId },
        'group message without @bot ignored',
      );
      return;
    }
    try {
      await handler(message);
    } catch (error) {
      this.options.logger?.error(
        {
          messageId: message.messageId,
          conversationId: message.conversationId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
        'bystander handler failed',
      );
    }
  }

  private remember(messageId: string): void {
    this.seen.set(messageId, this.now());
    if (this.seen.size <= this.dedupeLimit) return;
    const oldest = this.seen.keys().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }
}
