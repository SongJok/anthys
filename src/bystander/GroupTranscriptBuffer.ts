import {
  DEFAULT_SLIDING_WINDOW_SIZE,
  type TranscriptEntry,
} from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';

export interface GroupTranscriptBufferOptions {
  /** 未显式配置的群默认保留条数 */
  defaultWindowSize?: number;
  /** 最多同时跟踪多少个群，超出后淘汰最久未写入的群 */
  maxConversations?: number;
  /** 缓冲变化回调，用于多实例共享状态持久化 */
  onChange?: (conversationId: string) => void;
  /** 新发言入池回调（去重后只在首次写入触发），用于持久化归档 */
  onAppend?: (entry: TranscriptEntry) => void;
}

export interface GroupTranscriptSnapshot {
  entries: TranscriptEntry[];
  windowSize: number;
}

export interface FormattedTranscriptOptions {
  limit?: number;
  /** 排除指定 messageId（通常是当前正在处理的 @ 消息） */
  excludeMessageId?: string;
  /** 渲染总字符预算，超出时从最旧一侧丢弃，保留最近上下文 */
  charBudget?: number;
  /** 单条发言渲染截断长度 */
  perEntryCharLimit?: number;
}

const DEFAULT_TRANSCRIPT_CHAR_BUDGET = 3_000;
const DEFAULT_TRANSCRIPT_ENTRY_CHARS = 200;

const SHANGHAI_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatClock(timestamp: number): string {
  const parts = SHANGHAI_TIME.formatToParts(new Date(timestamp));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function normalizeText(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' / ').trim();
}

export function toTranscriptEntry(message: InboundMessage): TranscriptEntry {
  return {
    conversationId: message.conversationId,
    messageId: message.messageId,
    senderStaffId: message.senderStaffId,
    senderNick: message.senderNick,
    text: message.text,
    isAtBot: message.isAtBot,
    timestamp: message.timestamp,
  };
}

/**
 * 群聊旁听滚动缓冲池：每个群一个内存 RingBuffer，写入即裁剪，
 * 为 @ 追问和非 @ 主动回复提供最近 N 条带发言人/时间戳的上下文。
 */
export class GroupTranscriptBuffer {
  private readonly entries = new Map<string, TranscriptEntry[]>();
  private readonly windows = new Map<string, number>();
  private readonly defaultWindowSize: number;
  private readonly maxConversations: number;
  private readonly onChange?: (conversationId: string) => void;
  private readonly onAppend?: (entry: TranscriptEntry) => void;

  constructor(options: GroupTranscriptBufferOptions = {}) {
    this.defaultWindowSize = Math.max(
      1,
      options.defaultWindowSize ?? DEFAULT_SLIDING_WINDOW_SIZE,
    );
    this.maxConversations = Math.max(1, options.maxConversations ?? 500);
    this.onChange = options.onChange;
    this.onAppend = options.onAppend;
  }

  public configure(conversationId: string, windowSize: number): void {
    const size = Math.max(1, Math.floor(windowSize));
    this.windows.set(conversationId, size);
    const list = this.entries.get(conversationId);
    if (list && list.length > size) {
      list.splice(0, list.length - size);
    }
    this.onChange?.(conversationId);
  }

  public windowSize(conversationId: string): number {
    return this.windows.get(conversationId) ?? this.defaultWindowSize;
  }

  /**
   * 全量消息入池（@ 与非 @ 都写）。同一条 messageId 只保留一次。
   * @returns 是否新写入
   */
  public append(entry: TranscriptEntry): boolean {
    const list = this.entries.get(entry.conversationId) ?? [];
    if (list.some((item) => item.messageId === entry.messageId)) {
      // 重复投递时刷新内容，但不改变原有位置
      const index = list.findIndex(
        (item) => item.messageId === entry.messageId,
      );
      list[index] = { ...entry };
      return false;
    }

    list.push({ ...entry });
    const size = this.windowSize(entry.conversationId);
    if (list.length > size) {
      list.splice(0, list.length - size);
    }
    this.entries.set(entry.conversationId, list);
    this.evictIfNeeded(entry.conversationId);
    this.onChange?.(entry.conversationId);
    this.onAppend?.({ ...entry });
    return true;
  }

  public recent(conversationId: string, limit?: number): TranscriptEntry[] {
    const list = this.entries.get(conversationId) ?? [];
    if (limit === undefined) return list.map((item) => ({ ...item }));
    const size = Math.max(0, Math.floor(limit));
    return list.slice(-size).map((item) => ({ ...item }));
  }

  public format(
    conversationId: string,
    options: FormattedTranscriptOptions = {},
  ): string {
    const entries = this.recent(conversationId, options.limit).filter(
      (entry) =>
        entry.messageId !== options.excludeMessageId &&
        entry.text.trim() !== '',
    );
    const perEntryLimit = Math.max(
      1,
      options.perEntryCharLimit ?? DEFAULT_TRANSCRIPT_ENTRY_CHARS,
    );
    const budget = Math.max(1, options.charBudget ?? DEFAULT_TRANSCRIPT_CHAR_BUDGET);
    const lines: string[] = [];
    let used = 0;
    // 从最新一侧累加，超出预算即停止，确保保留最近上下文
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const text = normalizeText(entry.text);
      const clipped =
        text.length > perEntryLimit ? `${text.slice(0, perEntryLimit)}…` : text;
      const line = `[${formatClock(entry.timestamp)}] ${entry.senderNick}: ${clipped}`;
      const cost = line.length + 1;
      if (lines.length > 0 && used + cost > budget) break;
      lines.push(line);
      used += cost;
    }
    return lines.reverse().join('\n');
  }

  /** 在指定时间之后、由其他群成员发出的消息（用于防抢答判断） */
  public entriesSince(
    conversationId: string,
    timestamp: number,
    excludeMessageId?: string,
  ): TranscriptEntry[] {
    return (this.entries.get(conversationId) ?? []).filter(
      (entry) =>
        entry.timestamp > timestamp &&
        entry.messageId !== excludeMessageId &&
        !entry.isAtBot,
    );
  }

  public clear(conversationId: string): void {
    this.entries.delete(conversationId);
    this.windows.delete(conversationId);
    this.onChange?.(conversationId);
  }

  /** 供多实例共享状态导出/恢复最近窗口 */
  public snapshot(conversationId: string): GroupTranscriptSnapshot {
    return {
      entries: this.recent(conversationId),
      windowSize: this.windowSize(conversationId),
    };
  }

  public restore(
    conversationId: string,
    snapshot: GroupTranscriptSnapshot,
  ): void {
    this.windows.set(
      conversationId,
      Math.max(1, Math.floor(snapshot.windowSize)),
    );
    const list = snapshot.entries.map((entry) => ({ ...entry }));
    const size = this.windowSize(conversationId);
    if (list.length > size) list.splice(0, list.length - size);
    this.entries.set(conversationId, list);
  }

  public get conversationCount(): number {
    return this.entries.size;
  }

  private evictIfNeeded(current: string): void {
    if (this.entries.size <= this.maxConversations) return;
    for (const conversationId of this.entries.keys()) {
      if (conversationId === current) continue;
      this.entries.delete(conversationId);
      this.windows.delete(conversationId);
      if (this.entries.size <= this.maxConversations) return;
    }
  }
}
