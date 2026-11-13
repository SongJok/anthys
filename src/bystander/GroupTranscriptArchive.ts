import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';

export interface GroupTranscriptArchiveLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GroupTranscriptArchiveOptions {
  /** 归档根目录（服务器固定位置），每个群一个 JSONL 文件 */
  dir: string;
  logger?: GroupTranscriptArchiveLogger;
  /** 不归档这些发送人（系统播报/机器人），默认排除 scheduler */
  ignoreSenders?: string[];
  /** 内存中最多缓存多少个群的去重集合（LRU 淘汰），默认 200 */
  maxSeenConversations?: number;
  /** 每个群在内存中最多保留多少条近期 messageId 用于快速去重，默认 5000 */
  maxSeenPerConversation?: number;
}

export interface GroupArchiveSummary {
  conversationId: string;
  entryCount: number;
  lastTimestamp: number;
}

export interface GroupArchiveReadOptions {
  /** 最多返回最近多少条，默认 200 */
  limit?: number;
}

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_MAX_SEEN_CONVERSATIONS = 200;
const DEFAULT_MAX_SEEN_PER_CONVERSATION = 5_000;
const FILE_SUFFIX = '.jsonl';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** conversationId 可能含 base64 的 / + =，编码后才能安全做文件名 */
function fileNameFor(conversationId: string): string {
  return `${encodeURIComponent(conversationId)}${FILE_SUFFIX}`;
}

function conversationIdFromFile(fileName: string): string | null {
  if (!fileName.endsWith(FILE_SUFFIX)) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -FILE_SUFFIX.length));
  } catch {
    return null;
  }
}

function parseLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<TranscriptEntry>;
    if (
      typeof parsed.conversationId !== 'string' ||
      typeof parsed.messageId !== 'string' ||
      typeof parsed.text !== 'string'
    ) {
      return null;
    }
    return {
      conversationId: parsed.conversationId,
      messageId: parsed.messageId,
      senderStaffId: parsed.senderStaffId ?? '',
      senderNick: parsed.senderNick ?? '',
      text: parsed.text,
      isAtBot: parsed.isAtBot === true,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 群发言持久化归档：把群内所有成员的发言按群追加到服务器固定目录的 JSONL 文件，
 * 与内存旁听缓冲（只保留最近窗口）解耦，供黑话生成等技能离线读取。
 *
 * - 同一 messageId 只落盘一次（跨重启也去重）；
 * - 系统播报（scheduler）与空文本不归档；
 * - 追加用 O_APPEND，单行完整写入，并发不会撕行。
 */
export class GroupTranscriptArchive {
  private readonly dir: string;
  private readonly logger?: GroupTranscriptArchiveLogger;
  private readonly ignoreSenders: Set<string>;
  private readonly maxSeenConversations: number;
  private readonly maxSeenPerConversation: number;
  /** 每群已落盘的 messageId，按群 LRU 与单群 FIFO 有界缓存 */
  private readonly seen = new Map<string, Set<string>>();
  private readonly loading = new Map<string, Promise<Set<string>>>();

  constructor(options: GroupTranscriptArchiveOptions) {
    this.dir = path.resolve(options.dir);
    this.logger = options.logger;
    this.ignoreSenders = new Set(options.ignoreSenders ?? ['scheduler']);
    this.maxSeenConversations = Math.max(
      1,
      Math.trunc(
        options.maxSeenConversations ?? DEFAULT_MAX_SEEN_CONVERSATIONS,
      ),
    );
    this.maxSeenPerConversation = Math.max(
      1,
      Math.trunc(
        options.maxSeenPerConversation ?? DEFAULT_MAX_SEEN_PER_CONVERSATION,
      ),
    );
  }

  public get root(): string {
    return this.dir;
  }

  public filePathFor(conversationId: string): string {
    return path.join(this.dir, fileNameFor(conversationId));
  }

  /** 追加一条群发言；返回是否新写入（重复/被忽略返回 false） */
  public async append(entry: TranscriptEntry): Promise<boolean> {
    if (this.ignoreSenders.has(entry.senderStaffId)) return false;
    if (!entry.text.trim()) return false;
    const seen = await this.loadSeen(entry.conversationId);
    if (seen.has(entry.messageId)) return false;
    // has/add 之间没有 await，单线程下不会被同群并发打断
    this.addSeenId(seen, entry.messageId);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o755 });
      await appendFile(
        this.filePathFor(entry.conversationId),
        `${JSON.stringify(entry)}\n`,
        'utf8',
      );
      return true;
    } catch (error) {
      // 落盘失败时回滚去重标记，允许下次重试
      seen.delete(entry.messageId);
      this.logger?.warn(
        {
          conversationId: entry.conversationId,
          messageId: entry.messageId,
          error: errorMessage(error),
        },
        'failed to append group transcript archive',
      );
      return false;
    }
  }

  /** 读取某群最近 N 条发言（按落盘顺序，即时间顺序） */
  public async read(
    conversationId: string,
    options: GroupArchiveReadOptions = {},
  ): Promise<TranscriptEntry[]> {
    const entries = await this.readAll(conversationId);
    const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_READ_LIMIT));
    return entries.slice(-limit);
  }

  /** 列出已归档的群及其条数、最后发言时间 */
  public async listGroups(): Promise<GroupArchiveSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const summaries: GroupArchiveSummary[] = [];
    for (const file of files) {
      const conversationId = conversationIdFromFile(file);
      if (conversationId === null) continue;
      const entries = await this.readAll(conversationId);
      if (entries.length === 0) continue;
      summaries.push({
        conversationId,
        entryCount: entries.length,
        lastTimestamp: entries[entries.length - 1]?.timestamp ?? 0,
      });
    }
    return summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  /** 清理 mtime 早于 cutoffMs 的过期群归档文件，返回过期/已清理文件数 */
  public async pruneOlderThan(
    cutoffMs: number,
    options: { dryRun?: boolean } = {},
  ): Promise<number> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const file of files) {
      const conversationId = conversationIdFromFile(file);
      if (conversationId === null) continue;
      const fullPath = path.join(this.dir, file);
      try {
        const info = await stat(fullPath);
        if (info.mtimeMs >= cutoffMs) continue;
        count += 1;
        if (!options.dryRun) {
          await rm(fullPath, { force: true });
          this.seen.delete(conversationId);
        }
      } catch {
        continue;
      }
    }
    return count;
  }

  private async readAll(conversationId: string): Promise<TranscriptEntry[]> {
    let content: string;
    try {
      content = await readFile(this.filePathFor(conversationId), 'utf8');
    } catch {
      return [];
    }
    const entries: TranscriptEntry[] = [];
    for (const line of content.split('\n')) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private touchSeen(conversationId: string, set: Set<string>): void {
    this.seen.delete(conversationId);
    this.seen.set(conversationId, set);
    while (this.seen.size > this.maxSeenConversations) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey === undefined) break;
      this.seen.delete(oldestKey);
    }
  }

  private addSeenId(set: Set<string>, messageId: string): void {
    if (set.has(messageId)) set.delete(messageId);
    set.add(messageId);
    while (set.size > this.maxSeenPerConversation) {
      const oldestId = set.values().next().value;
      if (oldestId === undefined) break;
      set.delete(oldestId);
    }
  }

  private loadSeen(conversationId: string): Promise<Set<string>> {
    const cached = this.seen.get(conversationId);
    if (cached) {
      this.touchSeen(conversationId, cached);
      return Promise.resolve(cached);
    }
    let pending = this.loading.get(conversationId);
    if (!pending) {
      pending = this.readAll(conversationId).then((entries) => {
        const recent = entries.slice(-this.maxSeenPerConversation);
        const set = new Set(recent.map((entry) => entry.messageId));
        this.touchSeen(conversationId, set);
        this.loading.delete(conversationId);
        return set;
      });
      this.loading.set(conversationId, pending);
    }
    return pending;
  }
}