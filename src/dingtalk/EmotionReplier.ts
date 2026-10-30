import { createRequire } from 'node:module';
import type { InboundMessage } from '../types/core.js';

export interface EmotionLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface EmotionTarget {
  robotCode: string;
  openConversationId: string;
  openMsgId: string;
  emotionType: number;
  emotionName: string;
}

/** 供测试替换的机器人贴表情 API 边界 */
export interface RobotEmotionApi {
  reply(target: EmotionTarget): Promise<void>;
  recall(target: EmotionTarget): Promise<void>;
}

export interface EmotionReplierOptions {
  api: RobotEmotionApi;
  enabled: boolean;
  emotionName: string;
  robotCode: () => string;
  logger?: EmotionLogger;
  /** 单次调用超时，默认 3s */
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 处理中给用户消息贴表情、结束后撤回。
 * 贴表情只是体验增强：任何失败都只记日志，不阻塞卡片与答案交付。
 */
export class EmotionReplier {
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly recent = new Set<string>();
  private readonly timeoutMs: number;

  constructor(private readonly options: EmotionReplierOptions) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  /** 立即贴表情（不等待），同一消息只贴一次 */
  public mark(message: InboundMessage): void {
    if (!this.options.enabled) return;
    const id = message.messageId;
    if (!id || this.pending.has(id) || this.recent.has(id)) return;
    this.remember(id);
    this.pending.set(id, this.doReply(message));
  }

  /** 撤回本机器人贴的表情；未贴成功时静默跳过 */
  public async clear(message: InboundMessage): Promise<void> {
    const id = message.messageId;
    const reply = this.pending.get(id);
    if (!reply) return;
    this.pending.delete(id);
    if (!(await reply.catch(() => false))) return;
    try {
      await withTimeout(
        this.options.api.recall(this.target(message)),
        this.timeoutMs,
        'recallEmotion',
      );
    } catch (error) {
      this.options.logger?.warn(
        { messageId: id, error: errorMessage(error) },
        'recall emotion failed',
      );
    }
  }

  private async doReply(message: InboundMessage): Promise<boolean> {
    try {
      await withTimeout(
        this.options.api.reply(this.target(message)),
        this.timeoutMs,
        'replyEmotion',
      );
      return true;
    } catch (error) {
      this.options.logger?.warn(
        { messageId: message.messageId, error: errorMessage(error) },
        'reply emotion failed',
      );
      return false;
    }
  }

  private target(message: InboundMessage): EmotionTarget {
    const robotCode = this.options.robotCode();
    return {
      robotCode,
      openConversationId: message.conversationId,
      openMsgId: message.messageId,
      emotionType: 1,
      emotionName: this.options.emotionName,
    };
  }

  private remember(messageId: string): void {
    this.recent.add(messageId);
    if (this.recent.size <= 500) return;
    const oldest = this.recent.values().next();
    if (!oldest.done) this.recent.delete(oldest.value);
  }
}

interface EmotionResponse {
  statusCode?: number;
  body?: { success?: boolean };
}

interface DingTalkRobotSdkClient {
  robotReplyEmotionWithOptions(
    request: unknown,
    headers: unknown,
    runtime: unknown,
  ): Promise<EmotionResponse>;
  robotRecallEmotionWithOptions(
    request: unknown,
    headers: unknown,
    runtime: unknown,
  ): Promise<EmotionResponse>;
}

export interface OpenApiRobotEmotionApiOptions {
  clientId: string;
  clientSecret: string;
  getAccessToken: () => Promise<string>;
  endpoint?: string;
  protocol?: 'http' | 'https';
  logger?: EmotionLogger;
}

/** 基于 @alicloud/dingtalk/robot_1_0 的正式实现（CJS 包通过 createRequire 加载） */
export class OpenApiRobotEmotionApi implements RobotEmotionApi {
  private readonly client: DingTalkRobotSdkClient;
  private readonly sdk: {
    RobotReplyEmotionRequest: new (value: Record<string, unknown>) => unknown;
    RobotReplyEmotionHeaders: new (value: Record<string, unknown>) => unknown;
    RobotRecallEmotionRequest: new (value: Record<string, unknown>) => unknown;
    RobotRecallEmotionHeaders: new (value: Record<string, unknown>) => unknown;
    RuntimeOptions: new (value: Record<string, unknown>) => unknown;
  };
  private readonly logger?: EmotionLogger;

  constructor(private readonly options: OpenApiRobotEmotionApiOptions) {
    const projectRequire = createRequire(import.meta.url);
    const sdkRequire = createRequire(
      projectRequire.resolve('@alicloud/dingtalk/package.json'),
    );
    const robotModule = sdkRequire('@alicloud/dingtalk/robot_1_0') as {
      default: new (config: unknown) => DingTalkRobotSdkClient;
      RobotReplyEmotionRequest: new (value: Record<string, unknown>) => unknown;
      RobotReplyEmotionHeaders: new (value: Record<string, unknown>) => unknown;
      RobotRecallEmotionRequest: new (value: Record<string, unknown>) => unknown;
      RobotRecallEmotionHeaders: new (value: Record<string, unknown>) => unknown;
    };
    const { Config } = sdkRequire('@alicloud/openapi-client') as {
      Config: new (value: Record<string, unknown>) => unknown;
    };
    const { RuntimeOptions } = sdkRequire('@alicloud/tea-util') as {
      RuntimeOptions: new (value: Record<string, unknown>) => unknown;
    };

    this.client = new robotModule.default(
      new Config({
        accessKeyId: options.clientId,
        accessKeySecret: options.clientSecret,
        endpoint: options.endpoint ?? 'api.dingtalk.com',
        protocol: options.protocol ?? 'https',
      }),
    );
    this.sdk = {
      RobotReplyEmotionRequest: robotModule.RobotReplyEmotionRequest,
      RobotReplyEmotionHeaders: robotModule.RobotReplyEmotionHeaders,
      RobotRecallEmotionRequest: robotModule.RobotRecallEmotionRequest,
      RobotRecallEmotionHeaders: robotModule.RobotRecallEmotionHeaders,
      RuntimeOptions,
    };
    this.logger = options.logger;
  }

  public async reply(target: EmotionTarget): Promise<void> {
    const token = await this.options.getAccessToken();
    const request = new this.sdk.RobotReplyEmotionRequest({
      robotCode: target.robotCode,
      openMsgId: target.openMsgId,
      openConversationId: target.openConversationId,
      emotionType: target.emotionType,
      emotionName: target.emotionName,
    });
    const response = await this.client.robotReplyEmotionWithOptions(
      request,
      new this.sdk.RobotReplyEmotionHeaders({
        xAcsDingtalkAccessToken: token,
      }),
      new this.sdk.RuntimeOptions({}),
    );
    if (response.body?.success === false) {
      throw new Error('robotReplyEmotion rejected by DingTalk');
    }
    this.logger?.info?.(
      { openMsgId: target.openMsgId, emotionName: target.emotionName },
      'emotion replied',
    );
  }

  public async recall(target: EmotionTarget): Promise<void> {
    const token = await this.options.getAccessToken();
    const request = new this.sdk.RobotRecallEmotionRequest({
      robotCode: target.robotCode,
      openMsgId: target.openMsgId,
      openConversationId: target.openConversationId,
      emotionType: target.emotionType,
      emotionName: target.emotionName,
    });
    const response = await this.client.robotRecallEmotionWithOptions(
      request,
      new this.sdk.RobotRecallEmotionHeaders({
        xAcsDingtalkAccessToken: token,
      }),
      new this.sdk.RuntimeOptions({}),
    );
    if (response.body?.success === false) {
      throw new Error('robotRecallEmotion rejected by DingTalk');
    }
  }
}
