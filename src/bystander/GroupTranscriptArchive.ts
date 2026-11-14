import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
  /** 单群归档文件字节上限，超出后旋转只保留最近条目，默认 8MB */
  maxFileBytes?: number;
  /** 旋转后保留的最近条目数，默认 5000 */
  maxRetainedEntries?: number;
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
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_ENTRIES = 5_000;
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
 * - 追加用 O_APPEND，单行完整写入，并发不会撕行；
 * - 单群文件超过 maxFileBytes 后旋转，只保留最近 maxRetainedEntries 条；
 * - read/loadSeen 只读尾部窗口，listGroups 流式统计，避免大文件整file入内存。
 */
export class GroupTranscriptArchive {
  private readonly dir: string;
  private readonly logger?: GroupTranscriptArchiveLogger;
  private readonly ignoreSenders: Set<string>;
  private readonly maxSeenConversations: number;
  private readonly maxSeenPerConversation: number;
  private readonly maxFileBytes: number;
  private readonly maxRetainedEntries: number;
  /** 每群已落盘的 messageId，按群 LRU 与单群 FIFO 有界缓存 */
  private readonly seen = new Map<string, Set<string>>();
  private readonly loading = new Map<string, Promise<Set<string>>>();
  /** 每群一个串行队列，保证「追加 + 旋转」不会与同群并发写互相撕档 */
  private readonly queues = new Map<string, Promise<unknown>>();

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
    this.maxFileBytes = Math.max(
      64 * 1024,
      Math.trunc(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
    );
    this.maxRetainedEntries = Math.max(
      1,
      Math.trunc(options.maxRetainedEntries ?? DEFAULT_MAX_RETAINED_ENTRIES),
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
      await this.serialize(entry.conversationId, async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o755 });
        await appendFile(
          this.filePathFor(entry.conversationId),
          `${JSON.stringify(entry)}\n`,
          'utf8',
        );
        await this.rotateIfNeeded(entry.conversationId);
      });
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

  /** 读取某群最近 N 条发言（按落盘顺序，即时间顺序），只读尾部窗口 */
  public async read(
    conversationId: string,
    options: GroupArchiveReadOptions = {},
  ): Promise<TranscriptEntry[]> {
    const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_READ_LIMIT));
    const filePath = this.filePathFor(conversationId);
    let window = Math.max(64 * 1024, limit * 1024);
    for (;;) {
      const { entries, start } = await this.readTail(filePath, window);
      if (entries.length >= limit || start === 0) return entries.slice(-limit);
      window *= 4;
    }
  }

  /** 列出已归档的群及其条数、最后发言时间（流式统计，不整file入内存） */
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
      const summary = await this.summarizeFile(path.join(this.dir, file));
      if (!summary) continue;
      summaries.push({ conversationId, ...summary });
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

  /** 从文件尾部读取至多 window 字节，丢弃被窗口切断的首行，返回完整条目 */
  private async readTail(
    filePath: string,
    window: number,
  ): Promise<{ entries: TranscriptEntry[]; start: number }> {
    let handle: import('node:fs/promises').FileHandle;
    try {
      handle = await open(filePath, 'r');
    } catch {
      return { entries: [], start: 0 };
    }
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - window);
      const length = size - start;
      if (length <= 0) return { entries: [], start };
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          length - offset,
          start + offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const lines = buffer.subarray(0, offset).toString('utf8').split('\n');
      // start>0 时首行可能被窗口切断，丢弃以免解析出半条
      if (start > 0) lines.shift();
      const entries: TranscriptEntry[] = [];
      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) entries.push(entry);
      }
      return { entries, start };
    } finally {
      await handle.close();
    }
  }

  /** 流式统计单群文件的条目数与最后发言时间，避免整file入内存 */
  private summarizeFile(
    filePath: string,
  ): Promise<{ entryCount: number; lastTimestamp: number } | null> {
    return new Promise((resolve) => {
      let entryCount = 0;
      let lastTimestamp = 0;
      let carry = '';
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const consume = (line: string): void => {
        const entry = parseLine(line);
        if (!entry) return;
        entryCount += 1;
        lastTimestamp = entry.timestamp;
      };
      stream.on('data', (chunk: string | Buffer) => {
        carry += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let index = carry.indexOf('\n');
        while (index >= 0) {
          consume(carry.slice(0, index));
          carry = carry.slice(index + 1);
          index = carry.indexOf('\n');
        }
      });
      stream.on('end', () => {
        consume(carry);
        resolve(entryCount > 0 ? { entryCount, lastTimestamp } : null);
      });
      stream.on('error', () => resolve(null));
    });
  }

  /** 文件超过字节上限时旋转：只保留最近 maxRetainedEntries 条，原子替换 */
  private async rotateIfNeeded(conversationId: string): Promise<void> {
    const filePath = this.filePathFor(conversationId);
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return;
    }
    if (size <= this.maxFileBytes) return;
    const entries = await this.readAll(conversationId);
    const retained = entries.slice(-this.maxRetainedEntries);
    const tmpPath = `${filePath}.tmp`;
    const payload = retained.map((entry) => JSON.stringify(entry)).join('\n');
    await writeFile(tmpPath, retained.length > 0 ? `${payload}\n` : '', 'utf8');
    await rename(tmpPath, filePath);
  }

  /** 同群磁盘操作串行化，避免追加与旋转互相覆盖 */
  private serialize<T>(
    conversationId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(conversationId, run);
    const cleanup = (): void => {
      if (this.queues.get(conversationId) === run) {
        this.queues.delete(conversationId);
      }
    };
    void run.then(cleanup, cleanup);
    return run;
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
      pending = this.loadSeenFromDisk(conversationId).then((set) => {
        this.touchSeen(conversationId, set);
        this.loading.delete(conversationId);
        return set;
      });
      this.loading.set(conversationId, pending);
    }
    return pending;
  }

  /** 跨重启去重：只读尾部窗口取最近 messageId，best-effort 覆盖近期重投 */
  private async loadSeenFromDisk(conversationId: string): Promise<Set<string>> {
    const window = Math.max(
      256 * 1024,
      this.maxSeenPerConversation * 512,
    );
    const { entries } = await this.readTail(
      this.filePathFor(conversationId),
      window,
    );
    const recent = entries.slice(-this.maxSeenPerConversation);
    return new Set(recent.map((entry) => entry.messageId));
  }
}