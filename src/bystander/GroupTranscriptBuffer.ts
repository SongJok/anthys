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
}

export interface FormattedTranscriptOptions {
  limit?: number;
  /** 排除指定 messageId（通常是当前正在处理的 @ 消息） */
  excludeMessageId?: string;
}

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

  constructor(options: GroupTranscriptBufferOptions = {}) {
    this.defaultWindowSize = Math.max(
      1,
      options.defaultWindowSize ?? DEFAULT_SLIDING_WINDOW_SIZE,
    );
    this.maxConversations = Math.max(1, options.maxConversations ?? 500);
  }

  public configure(conversationId: string, windowSize: number): void {
    const size = Math.max(1, Math.floor(windowSize));
    this.windows.set(conversationId, size);
    const list = this.entries.get(conversationId);
    if (list && list.length > size) {
      list.splice(0, list.length - size);
    }
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
      (entry) => entry.messageId !== options.excludeMessageId,
    );
    return entries
      .map(
        (entry) =>
          `[${formatClock(entry.timestamp)}] ${entry.senderNick}: ${normalizeText(entry.text)}`,
      )
      .join('\n');
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
