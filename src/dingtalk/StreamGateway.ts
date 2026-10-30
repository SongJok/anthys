import { TOPIC_ROBOT } from 'dingtalk-stream';
import { parseStreamMessage } from './MessageParser.js';
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
  logger?: StreamGatewayLogger;
  now?: () => number;
  /** 已处理消息的去重窗口，默认 1000 条 */
  dedupeLimit?: number;
}

/**
 * 钉钉 Stream 网关：收到回调后立即 ACK（防止钉钉 60s 内重试），
 * 再异步解析并交给 AgentHarness。群聊中未 @ 机器人的消息直接忽略。
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
    await this.options.client.connect();
    this.started = true;
    this.options.logger?.info({ topic: TOPIC_ROBOT }, 'stream gateway started');
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
    if (message.conversationType === '2' && !message.isAtBot) {
      this.options.logger?.info(
        { messageId, conversationId: message.conversationId },
        'group message without @bot ignored',
      );
      return;
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

  private remember(messageId: string): void {
    this.seen.set(messageId, this.now());
    if (this.seen.size <= this.dedupeLimit) return;
    const oldest = this.seen.keys().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }
}
