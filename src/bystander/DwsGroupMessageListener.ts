import { spawn as spawnProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { InboundMessage } from '../types/core.js';

export const DWS_GROUP_MESSAGE_EVENT = 'user_im_message_receive_group_all';

const DEFAULT_SETTLE_MS = 3_000;
const DEFAULT_RESTART_DELAY_MS = 5_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 60_000;
const SEEN_LIMIT = 2_000;
/** 订阅的是群消息，但保险起见丢弃已读/撤回/表情/群变更等动作事件 */
const ACTION_EVENT_MARKERS = [
  'read',
  'recall',
  'reaction',
  'member_',
  'updated',
  'disband',
];

export interface DwsGroupListenerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface DwsGroupChildProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type DwsGroupSpawn = (
  command: string,
  args: readonly string[],
) => DwsGroupChildProcess;

export interface DwsGroupMessageListenerOptions {
  /** 收到群消息后交给旁听链路，调用方负责落缓冲与三级漏斗 */
  onMessage: (message: InboundMessage) => Promise<void> | void;
  binary?: string;
  /** 需要旁听的群（openConversationId）；为空时所有消息只做解析后丢弃 */
  allowedConversations?: Iterable<string>;
  /** 已被 StreamGateway 处理过的 @ 消息直接跳过 */
  shouldIgnore?: (messageId: string) => boolean;
  /** 忽略的发送人（展示名或 sender_open_dingtalk_id），用于过滤机器人自己的发言 */
  ignoreSenders?: string[];
  /** 等待 StreamGateway 先处理 @ 消息的静默窗口，默认 3000ms */
  settleMs?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  logger?: DwsGroupListenerLogger;
  spawn?: DwsGroupSpawn;
  sleep?: (ms: number) => Promise<void>;
}

export interface DwsGroupEventFields {
  messageId: string;
  conversationId: string;
  senderOpenId: string;
  senderName: string;
  content: string;
  timestamp: number;
  eventId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function pickNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** 富文本/卡片正文是 JSON 载荷，交给 LLM 只会污染上下文，直接跳过 */
function looksLikeJsonPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 `dws event consume ... --flatten` 输出的单行 NDJSON。
 * 兼容未展平的 transport envelope（业务字段在 data 字符串里）。
 */
export function parseDwsGroupEvent(raw: unknown): DwsGroupEventFields | null {
  const top = asRecord(raw);
  if (!top) return null;

  let fields = top;
  // 未展平时业务字段同时可能出现在 data 字符串或 payload 对象里
  for (const key of ['data', 'payload']) {
    const value = top[key];
    if (typeof value === 'string') {
      try {
        const inner = asRecord(JSON.parse(value));
        if (inner) fields = { ...fields, ...inner };
      } catch {
        // data 不是 JSON 时继续使用顶层字段
      }
      continue;
    }
    const inner = asRecord(value);
    if (inner) fields = { ...fields, ...inner };
  }

  const eventType =
    pickString(fields, ['event_type', 'type']) ??
    pickString(top, ['event_type', 'type']);
  if (
    eventType &&
    !eventType.includes('message_receive') &&
    ACTION_EVENT_MARKERS.some((marker) => eventType.includes(marker))
  ) {
    return null;
  }

  const messageId = pickString(fields, ['message_id', 'messageId']);
  const conversationId = pickString(fields, [
    'conversation_id',
    'conversationId',
  ]);
  if (!messageId || !conversationId) return null;

  const content = pickString(fields, ['content', 'text']);
  if (!content || looksLikeJsonPayload(content)) return null;

  const senderOpenId =
    pickString(fields, [
      'sender_open_dingtalk_id',
      'senderOpenDingTalkId',
      'sender_open_id',
      'sender_id',
    ]) ?? '';
  const senderName =
    pickString(fields, ['sender_name', 'sender_nick', 'sender_nickname']) ??
    pickString(fields, ['sender']) ??
    '';
  if (!senderOpenId && !senderName) return null;

  const timestamp =
    pickNumber(fields, ['timestamp', 'create_time', 'event_time']) ?? Date.now();
  const eventId = pickString(fields, ['event_id', 'eventId']);

  return {
    messageId,
    conversationId,
    senderOpenId,
    senderName,
    content,
    timestamp,
    ...(eventId ? { eventId } : {}),
  };
}

export function toInboundMessage(
  fields: DwsGroupEventFields,
): InboundMessage {
  return {
    messageId: fields.messageId,
    conversationId: fields.conversationId,
    conversationType: '2',
    // DWS 个人事件只提供 openDingTalkId，它不是可以投递卡片的 staffId
    senderStaffId: fields.senderOpenId,
    senderNick: fields.senderName || fields.senderOpenId,
    isAtBot: false,
    text: fields.content,
    cardDeliverUserId: '',
    rawPayload: {
      source: 'dws_event',
      ...(fields.eventId ? { eventId: fields.eventId } : {}),
      senderOpenDingTalkId: fields.senderOpenId,
      senderName: fields.senderName,
    },
    timestamp: fields.timestamp,
  };
}

/**
 * 用 DWS 个人事件长连接补齐「群里不 @ 机器人」的消息来源：
 * 钉钉机器人回调只推送 @ 消息，旁听能力必须另接一路群消息流。
 * 本监听器只负责把 NDJSON 转成 InboundMessage 并按需过滤，
 * 三级漏斗、冷却与主动回复仍复用既有旁听链路。
 */
export class DwsGroupMessageListener {
  private readonly binary: string;
  private readonly settleMs: number;
  private readonly restartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spawn: DwsGroupSpawn;
  private readonly logger?: DwsGroupListenerLogger;
  private readonly shouldIgnore?: (messageId: string) => boolean;
  private readonly ignoreSenders: Set<string>;
  private allowed: Set<string>;
  private seen = new Map<string, number>();
  private pending = new Set<Promise<void>>();
  private child?: DwsGroupChildProcess;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartDelay: number;
  private started = false;

  constructor(private readonly options: DwsGroupMessageListenerOptions) {
    this.binary = options.binary?.trim() || 'dws';
    this.settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
    this.restartDelayMs = Math.max(
      100,
      options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
    );
    this.maxRestartDelayMs = Math.max(
      this.restartDelayMs,
      options.maxRestartDelayMs ?? DEFAULT_MAX_RESTART_DELAY_MS,
    );
    this.restartDelay = this.restartDelayMs;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.spawn = options.spawn ?? defaultSpawn;
    this.logger = options.logger;
    this.shouldIgnore = options.shouldIgnore;
    this.ignoreSenders = new Set(
      (options.ignoreSenders ?? [])
        .map((item) => item.trim())
        .filter(Boolean),
    );
    this.allowed = new Set(options.allowedConversations ?? []);
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.launch();
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        // SIGTERM 让 dws 走优雅退订；kill -9 会泄漏服务端订阅
        child.kill('SIGTERM');
      } catch (error) {
        this.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'dws group listener stop failed',
        );
      }
    }
    this.logger?.info({}, 'dws group message listener stopped');
  }

  public setAllowedConversations(ids: Iterable<string>): void {
    this.allowed = new Set(
      [...ids].map((id) => id.trim()).filter(Boolean),
    );
  }

  public get isRunning(): boolean {
    return this.started;
  }

  public get allowedCount(): number {
    return this.allowed.size;
  }

  private buildArgs(): string[] {
    return [
      'event',
      'consume',
      DWS_GROUP_MESSAGE_EVENT,
      '--flatten',
      '--ephemeral',
      '--format',
      'ndjson',
      '--yes',
    ];
  }

  private launch(): void {
    if (!this.started) return;
    const args = this.buildArgs();
    let child: DwsGroupChildProcess;
    try {
      child = this.spawn(this.binary, args);
    } catch (error) {
      this.logger?.error(
        {
          binary: this.binary,
          error: error instanceof Error ? error.message : String(error),
        },
        'dws group listener spawn failed',
      );
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.logger?.info(
      { binary: this.binary, args, allowedConversations: this.allowed.size },
      'dws group message listener starting',
    );

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.onLine(line));
    }
    if (child.stderr) {
      const lines = createInterface({ input: child.stderr });
      lines.on('line', (line) => this.onStderr(line));
    }

    child.on('error', (error) => {
      this.logger?.error(
        { error: error.message },
        'dws group listener process error',
      );
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (!this.started) return;
      this.logger?.warn(
        { code, signal, retryInMs: this.restartDelay },
        'dws group listener exited, restarting',
      );
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.started || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.maxRestartDelayMs, delay * 2);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.launch();
    }, delay);
    this.restartTimer.unref?.();
  }

  private onStderr(line: string): void {
    const text = line.trim();
    if (!text) return;
    if (text.includes('[event] ready')) {
      this.restartDelay = this.restartDelayMs;
      this.logger?.info({ detail: text }, 'dws group listener ready');
      return;
    }
    if (text.includes('[event]')) return;
    this.logger?.warn({ detail: text }, 'dws group listener stderr');
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text || !text.startsWith('{')) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.logger?.warn({ line: text.slice(0, 200) }, 'invalid dws event line');
      return;
    }
    const fields = parseDwsGroupEvent(payload);
    if (!fields) return;
    if (this.isDuplicate(fields.messageId)) return;
    if (this.ignoreSenders.has(fields.senderOpenId)) return;
    if (this.ignoreSenders.has(fields.senderName)) return;
    if (!this.allowed.has(fields.conversationId)) return;

    this.schedule(toInboundMessage(fields));
  }

  private schedule(message: InboundMessage): void {
    const task = this.deliver(message).catch((error) => {
      this.logger?.error(
        {
          messageId: message.messageId,
          conversationId: message.conversationId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
        'dws group message handling failed',
      );
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private async deliver(message: InboundMessage): Promise<void> {
    if (this.settleMs > 0) await this.sleep(this.settleMs);
    if (!this.started) return;
    if (this.shouldIgnore?.(message.messageId)) {
      this.logger?.info(
        { messageId: message.messageId },
        'dws event already handled by stream gateway',
      );
      return;
    }
    await this.options.onMessage(message);
  }

  private isDuplicate(messageId: string): boolean {
    if (this.seen.has(messageId)) return true;
    this.seen.set(messageId, Date.now());
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return false;
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
): DwsGroupChildProcess {
  return spawnProcess(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as DwsGroupChildProcess;
}
