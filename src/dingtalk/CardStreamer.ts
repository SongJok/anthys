import { createRequire } from 'node:module';
import type { AgentStreamEvent, InboundMessage } from '../types/core.js';

export type CardBlockKey =
  | 'thinking_section'
  | 'answer_section'
  | 'status_bar';

export interface CardUpdate {
  outTrackId: string;
  guid: string;
  key: CardBlockKey;
  content: string;
  isFull: boolean;
  isFinalize: boolean;
  isError: boolean;
}

export interface CardCreateInput {
  cardTemplateId: string;
  outTrackId: string;
  spaceId: string;
  params: Record<CardBlockKey, string>;
  deliver: {
    conversationType: '1' | '2';
    robotCode: string;
    userId: string;
    conversationId: string;
  };
}

/** 供测试替换的 AI 卡片 API 边界 */
export interface CardApi {
  createAndDeliver(input: CardCreateInput): Promise<void>;
  streamingUpdate(update: CardUpdate): Promise<void>;
}

export interface CardLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ThrottlerOptions {
  intervalMs?: number;
  maxChars?: number;
  onFlush: () => void;
}

/**
 * 钉钉流式卡片存在 QPS 限制：按每 250ms 或每累积 80 字符触发一次刷新，
 * 工具事件与完成事件由调用方 flushNow 立即刷新。
 */
export class Throttler {
  private pendingChars = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  private readonly maxChars: number;

  constructor(private readonly options: ThrottlerOptions) {
    this.intervalMs = options.intervalMs ?? 250;
    this.maxChars = options.maxChars ?? 80;
  }

  public push(chars: number): void {
    if (chars <= 0) return;
    this.pendingChars += chars;
    if (this.pendingChars >= this.maxChars) {
      this.flushNow();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pendingChars = 0;
        this.options.onFlush();
      }, this.intervalMs);
    }
  }

  public flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const hadPending = this.pendingChars > 0;
    this.pendingChars = 0;
    if (hadPending) this.options.onFlush();
  }

  public cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingChars = 0;
  }
}

export interface CardStreamerOptions {
  api: CardApi;
  message: InboundMessage;
  cardTemplateId: string;
  robotCode: string;
  intervalMs?: number;
  maxChars?: number;
  logger?: CardLogger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 把 AgentStreamEvent 渲染为三区块 AI 卡片：
 * thinking_section（原生思维链 + 工具轨迹）、answer_section（Markdown 正文）、status_bar（状态角标）。
 */
export class CardStreamer {
  public readonly outTrackId: string;
  private readonly spaceId: string;
  private readonly throttler: Throttler;
  private readonly api: CardApi;
  private readonly logger?: CardLogger;

  private reasoning = '';
  private answer = '';
  private status = '正在思考…';
  private readonly toolLines: string[] = [];
  private dirtyThinking = false;
  private dirtyAnswer = false;
  private dirtyStatus = false;
  private available = false;
  private finalizePromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CardStreamerOptions) {
    this.api = options.api;
    this.logger = options.logger;
    this.outTrackId = `card_${options.message.messageId}`;
    this.spaceId =
      options.message.conversationType === '1'
        ? `dtv1.card//im_single.${options.message.senderStaffId}`
        : `dtv1.card//im_group.${options.message.conversationId}`;
    this.throttler = new Throttler({
      intervalMs: options.intervalMs,
      maxChars: options.maxChars,
      onFlush: () => {
        this.flushDirty(false, false);
      },
    });
  }

  public get isAvailable(): boolean {
    return this.available;
  }

  public async start(): Promise<void> {
    try {
      await this.api.createAndDeliver({
        cardTemplateId: this.options.cardTemplateId,
        outTrackId: this.outTrackId,
        spaceId: this.spaceId,
        params: {
          thinking_section: '正在思考…',
          answer_section: '',
          status_bar: this.status,
        },
        deliver: {
          conversationType: this.options.message.conversationType,
          robotCode: this.options.robotCode,
          userId: this.options.message.senderStaffId,
          conversationId: this.options.message.conversationId,
        },
      });
      this.available = true;
    } catch (error) {
      this.logger?.warn(
        { outTrackId: this.outTrackId, error: errorMessage(error) },
        'createAndDeliver failed, card streaming disabled',
      );
    }
  }

  public handle(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'reasoning_delta': {
        if (!event.content) return;
        this.reasoning += event.content;
        this.dirtyThinking = true;
        this.throttler.push(event.content.length);
        return;
      }
      case 'answer_delta': {
        if (!event.content) return;
        this.answer += event.content;
        this.dirtyAnswer = true;
        this.throttler.push(event.content.length);
        return;
      }
      case 'tool_start': {
        this.toolLines.push(
          `- 调用工具 \`${event.toolName}\`，参数 \`${safeJson(event.args)}\``,
        );
        this.status = `正在调用工具 ${event.toolName}`;
        this.dirtyThinking = true;
        this.dirtyStatus = true;
        this.throttler.cancel();
        this.flushDirty(false, false);
        return;
      }
      case 'tool_end': {
        this.toolLines.push(
          `- \`${event.toolName}\` ${event.isError ? '执行失败' : '已完成'}：${event.summary}`,
        );
        this.status = `工具 ${event.toolName} ${event.isError ? '执行失败' : '已完成'}`;
        this.dirtyThinking = true;
        this.dirtyStatus = true;
        this.flushDirty(false, false);
        return;
      }
      case 'completed': {
        this.status = `已完成 · ${(event.usage.durationMs / 1000).toFixed(1)}s · ${event.usage.totalTokens} tokens`;
        this.dirtyStatus = true;
        this.throttler.cancel();
        this.flushDirty(false, false);
        void this.finalize(false);
        return;
      }
      case 'error': {
        this.toolLines.push(`- 处理出错：${event.message}`);
        this.status = '处理失败';
        this.dirtyThinking = true;
        this.dirtyStatus = true;
        this.throttler.cancel();
        this.flushDirty(false, true);
        void this.finalize(true);
        return;
      }
    }
  }

  public async finish(): Promise<void> {
    await this.finalize(false);
  }

  private thinkingText(): string {
    const parts: string[] = [];
    if (this.reasoning.trim()) parts.push(this.reasoning.trim());
    if (this.toolLines.length > 0) {
      parts.push(`工具调用记录：\n${this.toolLines.join('\n')}`);
    }
    return parts.join('\n\n');
  }

  private enqueue(update: CardUpdate): void {
    if (!this.available) return;
    this.queue = this.queue.then(async () => {
      try {
        await this.api.streamingUpdate(update);
      } catch (error) {
        this.logger?.warn(
          { outTrackId: this.outTrackId, key: update.key, error: errorMessage(error) },
          'streamingUpdate failed',
        );
      }
    });
  }

  private flushDirty(isFinalize: boolean, isError: boolean): void {
    if (!this.available) {
      this.dirtyThinking = false;
      this.dirtyAnswer = false;
      this.dirtyStatus = false;
      return;
    }
    if (this.dirtyThinking) {
      this.enqueue(this.buildUpdate('thinking_section', this.thinkingText(), {
        isFinalize: false,
        isError,
      }));
      this.dirtyThinking = false;
    }
    if (this.dirtyAnswer) {
      this.enqueue(this.buildUpdate('answer_section', this.answer, {
        isFinalize: false,
        isError,
      }));
      this.dirtyAnswer = false;
    }
    if (this.dirtyStatus) {
      this.enqueue(this.buildUpdate('status_bar', this.status, {
        isFinalize: false,
        isError,
      }));
      this.dirtyStatus = false;
    }
    if (isFinalize) {
      this.enqueue(
        this.buildUpdate(
          'answer_section',
          this.answer || '（本次没有生成正文，请重新提问或稍后再试）',
          { isFinalize: true, isError },
        ),
      );
    }
  }

  private buildUpdate(
    key: CardBlockKey,
    content: string,
    flags: { isFinalize: boolean; isError: boolean },
  ): CardUpdate {
    return {
      outTrackId: this.outTrackId,
      guid: `${this.outTrackId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      key,
      content,
      isFull: true,
      isFinalize: flags.isFinalize,
      isError: flags.isError,
    };
  }

  private finalize(isError: boolean): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;
    this.throttler.cancel();
    this.flushDirty(true, isError);
    this.finalizePromise = this.queue;
    return this.finalizePromise;
  }
}

interface DingTalkCardSdkClient {
  createAndDeliverWithOptions(
    request: unknown,
    headers: unknown,
    runtime: unknown,
  ): Promise<{ statusCode?: number; body?: { success?: boolean } }>;
  streamingUpdateWithOptions(
    request: unknown,
    headers: unknown,
    runtime: unknown,
  ): Promise<{ statusCode?: number; body?: { success?: boolean } }>;
}

export interface OpenApiCardApiOptions {
  clientId: string;
  clientSecret: string;
  getAccessToken: () => Promise<string>;
  endpoint?: string;
  protocol?: 'http' | 'https';
  logger?: CardLogger;
}

/** 基于 @alicloud/dingtalk/card_1_0 的正式实现（CJS 包通过 createRequire 加载） */
export class OpenApiCardApi implements CardApi {
  private readonly client: DingTalkCardSdkClient;
  private readonly sdk: {
    CreateAndDeliverRequest: new (value: Record<string, unknown>) => unknown;
    CreateAndDeliverHeaders: new (value: Record<string, unknown>) => unknown;
    CreateAndDeliverRequestCardData: new (
      value: Record<string, unknown>,
    ) => unknown;
    CreateAndDeliverRequestImSingleOpenDeliverModel: new (
      value: Record<string, unknown>,
    ) => unknown;
    CreateAndDeliverRequestImGroupOpenDeliverModel: new (
      value: Record<string, unknown>,
    ) => unknown;
    StreamingUpdateRequest: new (value: Record<string, unknown>) => unknown;
    StreamingUpdateHeaders: new (value: Record<string, unknown>) => unknown;
    RuntimeOptions: new (value: Record<string, unknown>) => unknown;
  };
  private readonly logger?: CardLogger;

  constructor(private readonly options: OpenApiCardApiOptions) {
    const projectRequire = createRequire(import.meta.url);
    const sdkRequire = createRequire(
      projectRequire.resolve('@alicloud/dingtalk/package.json'),
    );
    const cardModule = sdkRequire('@alicloud/dingtalk/card_1_0') as {
      default: new (config: unknown) => DingTalkCardSdkClient;
      CreateAndDeliverRequest: new (value: Record<string, unknown>) => unknown;
      CreateAndDeliverHeaders: new (value: Record<string, unknown>) => unknown;
      CreateAndDeliverRequestCardData: new (
        value: Record<string, unknown>,
      ) => unknown;
      CreateAndDeliverRequestImSingleOpenDeliverModel: new (
        value: Record<string, unknown>,
      ) => unknown;
      CreateAndDeliverRequestImGroupOpenDeliverModel: new (
        value: Record<string, unknown>,
      ) => unknown;
      StreamingUpdateRequest: new (value: Record<string, unknown>) => unknown;
      StreamingUpdateHeaders: new (value: Record<string, unknown>) => unknown;
    };
    const { Config } = sdkRequire('@alicloud/openapi-client') as {
      Config: new (value: Record<string, unknown>) => unknown;
    };
    const { RuntimeOptions } = sdkRequire('@alicloud/tea-util') as {
      RuntimeOptions: new (value: Record<string, unknown>) => unknown;
    };

    this.client = new cardModule.default(
      new Config({
        accessKeyId: options.clientId,
        accessKeySecret: options.clientSecret,
        endpoint: options.endpoint ?? 'api.dingtalk.com',
        protocol: options.protocol ?? 'https',
      }),
    );
    this.sdk = {
      CreateAndDeliverRequest: cardModule.CreateAndDeliverRequest,
      CreateAndDeliverHeaders: cardModule.CreateAndDeliverHeaders,
      CreateAndDeliverRequestCardData:
        cardModule.CreateAndDeliverRequestCardData,
      CreateAndDeliverRequestImSingleOpenDeliverModel:
        cardModule.CreateAndDeliverRequestImSingleOpenDeliverModel,
      CreateAndDeliverRequestImGroupOpenDeliverModel:
        cardModule.CreateAndDeliverRequestImGroupOpenDeliverModel,
      StreamingUpdateRequest: cardModule.StreamingUpdateRequest,
      StreamingUpdateHeaders: cardModule.StreamingUpdateHeaders,
      RuntimeOptions,
    };
    this.logger = options.logger;
  }

  public async createAndDeliver(input: CardCreateInput): Promise<void> {
    const token = await this.options.getAccessToken();
    const request = new this.sdk.CreateAndDeliverRequest({
      cardTemplateId: input.cardTemplateId,
      outTrackId: input.outTrackId,
      openSpaceId: input.spaceId,
      cardData: new this.sdk.CreateAndDeliverRequestCardData({
        cardParamMap: input.params,
      }),
      userId: input.deliver.userId,
      userIdType: 1,
      imSingleOpenDeliverModel:
        input.deliver.conversationType === '1'
          ? new this.sdk.CreateAndDeliverRequestImSingleOpenDeliverModel({})
          : undefined,
      imGroupOpenDeliverModel:
        input.deliver.conversationType === '2'
          ? new this.sdk.CreateAndDeliverRequestImGroupOpenDeliverModel({
              robotCode: input.deliver.robotCode,
              atUserIds: {
                [input.deliver.userId]: input.deliver.userId,
              },
            })
          : undefined,
    });
    const headers = new this.sdk.CreateAndDeliverHeaders({
      xAcsDingtalkAccessToken: token,
    });
    const response = await this.client.createAndDeliverWithOptions(
      request,
      headers,
      new this.sdk.RuntimeOptions({}),
    );
    if (response.body?.success === false) {
      throw new Error('createAndDeliver rejected by DingTalk');
    }
  }

  public async streamingUpdate(update: CardUpdate): Promise<void> {
    const token = await this.options.getAccessToken();
    const request = new this.sdk.StreamingUpdateRequest({
      outTrackId: update.outTrackId,
      guid: update.guid,
      key: update.key,
      content: update.content,
      isFull: update.isFull,
      isFinalize: update.isFinalize,
      isError: update.isError,
    });
    const headers = new this.sdk.StreamingUpdateHeaders({
      xAcsDingtalkAccessToken: token,
    });
    const response = await this.client.streamingUpdateWithOptions(
      request,
      headers,
      new this.sdk.RuntimeOptions({}),
    );
    if (response.body?.success === false) {
      throw new Error('streamingUpdate rejected by DingTalk');
    }
  }
}
