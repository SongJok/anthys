import { execFile } from 'node:child_process';
import type { GroupBotEntry } from '../types/admin-and-console.js';

export interface GroupDirectoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DwsGroupDirectoryItem {
  conversationId: string;
  name: string;
  bots: GroupBotEntry[];
}

export type DwsCommandRunner = (
  binary: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

function defaultRunDws(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(
            new Error(
              error.killed
                ? `dws ${args.slice(0, 3).join(' ')} 超时（${timeoutMs}ms）`
                : `dws ${args.slice(0, 3).join(' ')} 失败：${detail}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]!);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export function parseDwsGroupListJson(
  stdout: string,
): Array<{ conversationId: string; name: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('dws 返回了非 JSON 输出，无法解析群列表');
  }
  const root = asRecord(parsed);
  const data = root ? (asRecord(root.data) ?? asRecord(root.result) ?? root) : null;
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(data?.groups)
      ? data.groups
      : Array.isArray(data?.items)
        ? data.items
        : [];
  const deduped = new Map<string, string>();
  for (const item of rawList) {
    const rec = asRecord(item);
    if (!rec) continue;
    const conversationId =
      asText(rec.openConversationId) ||
      asText(rec.conversationId) ||
      asText(rec.id);
    if (!conversationId) continue;
    const name = asText(rec.name) || asText(rec.title);
    const existing = deduped.get(conversationId);
    if (existing === undefined || (!existing && name)) {
      deduped.set(conversationId, name);
    }
  }
  return [...deduped.entries()].map(([conversationId, name]) => ({
    conversationId,
    name,
  }));
}

export function parseDwsGroupBotsJson(stdout: string): GroupBotEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  const data = root ? (asRecord(root.data) ?? asRecord(root.result) ?? root) : null;
  const rawBots = Array.isArray(parsed)
    ? parsed
    : Array.isArray(data?.bots)
      ? data.bots
      : Array.isArray(data?.items)
        ? data.items
        : [];
  const bots: GroupBotEntry[] = [];
  const seen = new Set<string>();
  for (const item of rawBots) {
    const rec = asRecord(item);
    if (!rec) continue;
    const name = asText(rec.name) || asText(rec.nick) || asText(rec.botName);
    const openBotId =
      asText(rec.openBotId) || asText(rec.botId) || asText(rec.id);
    if (!name && !openBotId) continue;
    const key = `${openBotId}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bots.push({ name, openBotId });
  }
  return bots;
}

/**
 * 通过 DWS CLI 内存同步群与群内机器人目录并直接写入数据库，
 * 避免在项目目录落地包含真实组织群与机器人的 JSON 文件。
 */
export class DwsGroupDirectorySource {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly runner: DwsCommandRunner;
  private readonly logger?: GroupDirectoryLogger;

  constructor(
    options: {
      binary?: string;
      timeoutMs?: number;
      concurrency?: number;
      runner?: DwsCommandRunner;
      logger?: GroupDirectoryLogger;
    } = {},
  ) {
    this.binary = options.binary ?? process.env.DWS_BINARY?.trim() ?? 'dws';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.concurrency = options.concurrency ?? 6;
    this.runner = options.runner ?? defaultRunDws;
    this.logger = options.logger;
  }

  public async fetchGroups(
    options: { includeBots?: boolean } = {},
  ): Promise<DwsGroupDirectoryItem[]> {
    const stdout = await this.runner(
      this.binary,
      [
        'chat',
        '+chat-list-all',
        '--limit',
        '200',
        '--page-all',
        '--page-limit',
        '50',
        '--format',
        'json',
      ],
      this.timeoutMs,
    );
    const groups = parseDwsGroupListJson(stdout);
    if (!options.includeBots) {
      return groups.map((group) => ({ ...group, bots: [] }));
    }

    const items = await mapLimit(groups, this.concurrency, async (group) => {
      try {
        const botsOut = await this.runner(
          this.binary,
          [
            'chat',
            '+chat-bots',
            '--group',
            group.conversationId,
            '--format',
            'json',
          ],
          this.timeoutMs,
        );
        return {
          ...group,
          bots: parseDwsGroupBotsJson(botsOut),
        };
      } catch (error) {
        this.logger?.warn(
          {
            conversationId: group.conversationId,
            error: error instanceof Error ? error.message : String(error),
          },
          'failed to fetch group bots via dws, keeping empty bots',
        );
        return { ...group, bots: [] };
      }
    });

    this.logger?.info(
      {
        groups: items.length,
        withBots: items.filter((item) => item.bots.length > 0).length,
      },
      'dws group directory fetched',
    );
    return items;
  }
}
