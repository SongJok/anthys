import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  AgentStreamEvent,
  InboundMessage,
  PlanItem,
  StreamCitation,
} from '../types/core.js';

export type CardBlockKey =
  | 'thinking_section'
  | 'answer_section'
  | 'status_bar'
  | 'tools_section'
  | 'citations_section'
  | 'actions_section';

export type CardLayout = 'v1' | 'v2';

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
  params: Record<string, string> & {
    thinking_section: string;
    answer_section: string;
    status_bar: string;
  };
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
  info?(obj: Record<string, unknown>, msg: string): void;
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
  /** v1 为三区块模板；v2 追加 tools/citations/actions 区块 */
  layout?: CardLayout;
  /** 单次 streamingUpdate 超时，默认 5s */
  updateTimeoutMs?: number;
  /** 失败重试次数，默认 2 */
  maxRetries?: number;
  /** 创建卡片重试次数，默认 0（不阻塞首包） */
  createRetries?: number;
  /** 限流：默认每秒 4 次、突发 8 次 */
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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

/** 令牌桶：约束 streamingUpdate 的 QPS，避免钉钉侧限流导致整张卡片失败 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  public async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      const elapsed = now - this.lastRefill;
      if (elapsed > 0) {
        this.tokens = Math.min(
          this.burst,
          this.tokens + (elapsed / 1000) * this.perSecond,
        );
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
      await sleep(Math.max(10, waitMs));
    }
  }
}

/**
 * 把 AgentStreamEvent 渲染为 AI 卡片：
 * thinking_section（原生思维链 + 过程说明 + 工具轨迹）、answer_section（最终答案）、
 * status_bar（状态角标）；v2 模板额外使用 tools_section / citations_section / actions_section。
 *
 * 刷新策略为「最新值合并 + 单飞」：同一区块只保留最新内容，
 * 网络慢时不会积压历史快照，也不会在结束后继续回放旧内容。
 */
export class CardStreamer {
  public readonly outTrackId: string;
  private readonly spaceId: string;
  private readonly throttler: Throttler;
  private readonly api: CardApi;
  private readonly logger?: CardLogger;
  private readonly layout: CardLayout;
  private readonly updateTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly createRetries: number;
  private readonly limiter: TokenBucket;

  private reasoning = '';
  private answer = '';
  private status = '正在思考…';
  private readonly toolLines: string[] = [];
  private planItems: PlanItem[] = [];
  private citations: StreamCitation[] = [];
  private readonly activeTools = new Map<string, number>();
  private dirtyThinking = false;
  private dirtyAnswer = false;
  private dirtyStatus = false;
  private dirtyTools = false;
  private dirtyCitations = false;
  private available = false;
  private finalizePromise: Promise<void> | null = null;
  private pending = new Map<CardBlockKey, CardUpdate>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CardStreamerOptions) {
    this.api = options.api;
    this.logger = options.logger;
    this.layout = options.layout ?? 'v1';
    this.updateTimeoutMs = options.updateTimeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.createRetries = options.createRetries ?? 0;
    this.limiter = new TokenBucket(
      options.rateLimitPerSecond ?? 4,
      options.rateLimitBurst ?? 8,
    );
    // messageId 可能含 base64 的 / + =，不能直接做卡片标识
    this.outTrackId = `card_${randomUUID().replace(/-/g, '')}`;
    this.spaceId =
      options.message.conversationType === '1'
        ? `dtv1.card//IM_ROBOT.${options.message.conversationId}`
        : `dtv1.card//IM_GROUP.${options.message.conversationId}`;
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
    const params: CardCreateInput['params'] = {
      thinking_section: '正在思考…',
      answer_section: '',
      status_bar: this.status,
    };
    if (this.layout === 'v2') {
      params.tools_section = '';
      params.citations_section = '';
      params.actions_section = this.actionsText();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.api.createAndDeliver({
          cardTemplateId: this.options.cardTemplateId,
          outTrackId: this.outTrackId,
          spaceId: this.spaceId,
          params,
          deliver: {
            conversationType: this.options.message.conversationType,
            robotCode: this.options.robotCode,
            userId: this.options.message.senderStaffId,
            conversationId: this.options.message.conversationId,
          },
        });
        this.available = true;
        this.logger?.info?.(
          { outTrackId: this.outTrackId, spaceId: this.spaceId },
          'card created and delivered',
        );
        return;
      } catch (error) {
        if (attempt >= this.createRetries) {
          this.logger?.warn(
            { outTrackId: this.outTrackId, error: errorMessage(error) },
            'createAndDeliver failed, card streaming disabled',
          );
          return;
        }
        await sleep(300 * 2 ** attempt);
      }
    }
  }

  public handle(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn_start': {
        if (this.activeTools.size === 0) {
          this.status = event.step > 1 ? `第 ${event.step} 轮推理中…` : '正在思考…';
          this.dirtyStatus = true;
          this.throttler.push(1);
        }
        return;
      }
      case 'reasoning_delta': {
        if (!event.content) return;
        this.reasoning += event.content;
        this.dirtyThinking = true;
        this.throttler.push(event.content.length);
        return;
      }
      case 'narration_delta': {
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
      case 'answer_reset': {
        if (event.narration.trim()) {
          this.reasoning +=
            (this.reasoning.trim() ? '\n\n' : '') + event.narration.trim();
        }
        this.answer = '';
        this.dirtyThinking = true;
        this.dirtyAnswer = true;
        this.throttler.cancel();
        this.flushDirty(false, false);
        return;
      }
      case 'plan': {
        this.planItems = event.items.map((item) => ({ ...item }));
        this.dirtyThinking = true;
        this.throttler.push(1);
        return;
      }
      case 'citation': {
        this.citations = [...this.citations, ...event.citations];
        this.dirtyCitations = this.layout === 'v2';
        if (this.layout !== 'v2') this.dirtyThinking = true;
        this.throttler.push(1);
        return;
      }
      case 'status': {
        if (!event.message) return;
        this.status = event.message;
        this.dirtyStatus = true;
        this.throttler.push(1);
        return;
      }
      case 'tool_start': {
        const line = `- 调用工具 \`${event.toolName}\`，参数 \`${safeJson(event.args)}\``;
        this.toolLines.push(line);
        this.activeTools.set(event.toolName, (this.activeTools.get(event.toolName) ?? 0) + 1);
        this.status = `正在调用工具 ${event.toolName}`;
        this.dirtyThinking = this.layout === 'v1';
        this.dirtyTools = this.layout === 'v2';
        this.dirtyStatus = true;
        this.throttler.cancel();
        this.flushDirty(false, false);
        return;
      }
      case 'tool_progress': {
        const seconds = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
        this.status = `工具 ${event.toolName} 运行中 · ${seconds}s`;
        this.dirtyStatus = true;
        this.throttler.push(1);
        return;
      }
      case 'tool_end': {
        const line = `- \`${event.toolName}\` ${event.isError ? '执行失败' : '已完成'}：${event.summary}`;
        this.toolLines.push(line);
        const active = (this.activeTools.get(event.toolName) ?? 1) - 1;
        if (active <= 0) this.activeTools.delete(event.toolName);
        else this.activeTools.set(event.toolName, active);
        this.status = `工具 ${event.toolName} ${event.isError ? '执行失败' : '已完成'}`;
        this.dirtyThinking = this.layout === 'v1';
        this.dirtyTools = this.layout === 'v2';
        this.dirtyStatus = true;
        this.flushDirty(false, false);
        return;
      }
      case 'completed': {
        this.status = event.usage.stopped
          ? `已停止 · ${(event.usage.durationMs / 1000).toFixed(1)}s · ${event.usage.totalTokens} tokens`
          : `已完成 · ${(event.usage.durationMs / 1000).toFixed(1)}s · ${event.usage.totalTokens} tokens`;
        this.dirtyStatus = true;
        this.throttler.cancel();
        this.flushDirty(false, false);
        void this.finalize(false);
        return;
      }
      case 'error': {
        this.toolLines.push(`- 处理出错：${event.message}`);
        this.status = event.retryable === false ? '处理失败' : '处理失败';
        this.dirtyThinking = this.layout === 'v1';
        this.dirtyTools = this.layout === 'v2';
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

  private reasoningText(): string {
    const parts: string[] = [];
    if (this.reasoning.trim()) parts.push(this.reasoning.trim());
    if (this.planItems.length > 0) {
      parts.push(
        `执行计划：\n${this.planItems
          .map((item) => `- [${item.status === 'done' ? 'x' : ' '}] ${item.text}`)
          .join('\n')}`,
      );
    }
    if (this.citations.length > 0 && this.layout !== 'v2') {
      parts.push(`参考来源：\n${this.citationsText()}`);
    }
    return parts.join('\n\n');
  }

  private thinkingText(): string {
    const parts: string[] = [];
    const base = this.reasoningText();
    if (base) parts.push(base);
    if (this.toolLines.length > 0 && this.layout === 'v1') {
      parts.push(`工具调用记录：\n${this.toolLines.join('\n')}`);
    }
    return parts.join('\n\n');
  }

  private toolsText(): string {
    if (this.toolLines.length === 0) return '';
    return `工具调用记录：\n${this.toolLines.join('\n')}`;
  }

  private citationsText(): string {
    if (this.citations.length === 0) return '';
    return this.citations
      .map((citation) => {
        const title = citation.url
          ? `[${citation.title}](${citation.url})`
          : citation.title;
        return `${citation.index}. ${title}${citation.source ? ` · ${citation.source}` : ''}`;
      })
      .join('\n');
  }

  private actionsText(): string {
    return '遇到问题可发送 `/stop` 停止、`/retry` 重试、`/feedback` 反馈。';
  }

  private enqueue(update: CardUpdate): void {
    if (!this.available) return;
    this.pending.set(update.key, update);
    this.queue = this.queue.then(() => this.drain());
  }

  /** 顺序发送合并后的最新值；发送期间到达的新值会覆盖尚未发送的旧值 */
  private async drain(): Promise<void> {
    if (!this.available) {
      this.pending.clear();
      return;
    }
    for (;;) {
      const next = this.pending.entries().next();
      if (next.done) return;
      const [key, update] = next.value;
      this.pending.delete(key);
      await this.send(update);
    }
  }

  private async send(update: CardUpdate): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.limiter.acquire();
        await withTimeout(
          this.api.streamingUpdate(update),
          this.updateTimeoutMs,
          'streamingUpdate',
        );
        return;
      } catch (error) {
        if (attempt >= this.maxRetries) {
          this.logger?.warn(
            {
              outTrackId: this.outTrackId,
              key: update.key,
              error: errorMessage(error),
            },
            'streamingUpdate failed',
          );
          return;
        }
        await sleep(250 * 2 ** attempt);
      }
    }
  }

  private flushDirty(isFinalize: boolean, isError: boolean): void {
    if (!this.available) {
      this.dirtyThinking = false;
      this.dirtyAnswer = false;
      this.dirtyStatus = false;
      this.dirtyTools = false;
      this.dirtyCitations = false;
      return;
    }
    if (this.dirtyThinking) {
      this.enqueue(this.buildUpdate('thinking_section', this.thinkingText(), {
        isFinalize: false,
        isError,
      }));
      this.dirtyThinking = false;
    }
    if (this.dirtyTools) {
      this.enqueue(this.buildUpdate('tools_section', this.toolsText(), {
        isFinalize: false,
        isError,
      }));
      this.dirtyTools = false;
    }
    if (this.dirtyCitations) {
      this.enqueue(this.buildUpdate('citations_section', this.citationsText(), {
        isFinalize: false,
        isError,
      }));
      this.dirtyCitations = false;
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

interface CardDeliverResult {
  success?: boolean;
  errorMsg?: string;
}

interface DingTalkCardResponse {
  statusCode?: number;
  body?: {
    success?: boolean;
    result?: {
      outTrackId?: string;
      cardInstanceId?: string;
      deliverResults?: CardDeliverResult[];
    };
  };
}

interface DingTalkCardSdkClient {
  createAndDeliverWithOptions(
    request: unknown,
    headers: unknown,
    runtime: unknown,
  ): Promise<DingTalkCardResponse>;
  streamingUpdateWithOptions(
    request: unknown,
    headers: unknown,
    runtime: unknown,
  ): Promise<DingTalkCardResponse>;
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
    CreateAndDeliverRequestImRobotOpenDeliverModel: new (
      value: Record<string, unknown>,
    ) => unknown;
    CreateAndDeliverRequestImRobotOpenSpaceModel: new (
      value: Record<string, unknown>,
    ) => unknown;
    CreateAndDeliverRequestImGroupOpenDeliverModel: new (
      value: Record<string, unknown>,
    ) => unknown;
    CreateAndDeliverRequestImGroupOpenSpaceModel: new (
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
      CreateAndDeliverRequestImRobotOpenDeliverModel: new (
        value: Record<string, unknown>,
      ) => unknown;
      CreateAndDeliverRequestImRobotOpenSpaceModel: new (
        value: Record<string, unknown>,
      ) => unknown;
      CreateAndDeliverRequestImGroupOpenDeliverModel: new (
        value: Record<string, unknown>,
      ) => unknown;
      CreateAndDeliverRequestImGroupOpenSpaceModel: new (
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
      CreateAndDeliverRequestImRobotOpenDeliverModel:
        cardModule.CreateAndDeliverRequestImRobotOpenDeliverModel,
      CreateAndDeliverRequestImRobotOpenSpaceModel:
        cardModule.CreateAndDeliverRequestImRobotOpenSpaceModel,
      CreateAndDeliverRequestImGroupOpenDeliverModel:
        cardModule.CreateAndDeliverRequestImGroupOpenDeliverModel,
      CreateAndDeliverRequestImGroupOpenSpaceModel:
        cardModule.CreateAndDeliverRequestImGroupOpenSpaceModel,
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
      callbackType: 'STREAM',
      cardData: new this.sdk.CreateAndDeliverRequestCardData({
        cardParamMap: input.params,
      }),
      userId: input.deliver.userId,
      userIdType: 1,
      imRobotOpenDeliverModel:
        input.deliver.conversationType === '1'
          ? new this.sdk.CreateAndDeliverRequestImRobotOpenDeliverModel({
              spaceType: 'IM_ROBOT',
              robotCode: input.deliver.robotCode,
            })
          : undefined,
      imRobotOpenSpaceModel:
        input.deliver.conversationType === '1'
          ? new this.sdk.CreateAndDeliverRequestImRobotOpenSpaceModel({
              supportForward: true,
            })
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
      imGroupOpenSpaceModel:
        input.deliver.conversationType === '2'
          ? new this.sdk.CreateAndDeliverRequestImGroupOpenSpaceModel({
              supportForward: true,
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
    const failedDelivery = response.body?.result?.deliverResults?.find(
      (result) => result.success === false,
    );
    if (failedDelivery) {
      throw new Error(
        `createAndDeliver delivery failed: ${failedDelivery.errorMsg ?? 'unknown'}`,
      );
    }
    this.logger?.info?.(
      { outTrackId: input.outTrackId, result: response.body?.result },
      'createAndDeliver response',
    );
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
