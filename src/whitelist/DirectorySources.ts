import { execFile } from 'node:child_process';
import type {
  DirectorySource,
  DirectoryUser,
} from '../types/whitelist.js';

export interface DirectoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

const OAPI_BASE = 'https://oapi.dingtalk.com';
const HTTP_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_DEPTS = 1_000;
const MAX_PAGES = 500;

class ContactApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function scopeHint(code: number): string {
  return code === 50004 || code === 60011
    ? '（应用通讯录权限范围未覆盖该部门：请在钉钉开发者后台把“通讯录权限范围”设置为全部员工，或使用 DWS 通讯录同步）'
    : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 应用 API 通讯录：topapi 部门树 + 部门成员，需要通讯录读权限与数据范围 */
export class DingTalkContactDirectorySource implements DirectorySource {
  public readonly name = 'dingtalk-api' as const;

  constructor(
    private readonly credentials: () => AppCredentials,
    private readonly logger?: DirectoryLogger,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async fetchUsers(): Promise<DirectoryUser[]> {
    const token = await this.getAccessToken();
    const users = new Map<string, DirectoryUser>();
    const visited = new Set<number>();
    const queue: Array<{ id: number; path: string }> = [{ id: 1, path: '' }];

    while (queue.length > 0) {
      if (visited.size > MAX_DEPTS) {
        throw new Error(`通讯录部门数量超过 ${MAX_DEPTS}，已中止同步`);
      }
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      for (const user of await this.listDepartmentUsers(token, current.id)) {
        if (!user.staffId) continue;
        if (!users.has(user.staffId)) {
          users.set(user.staffId, {
            staffId: user.staffId,
            name: user.name,
            deptPath: current.path,
          });
        }
      }

      const children = await this.listChildDepartments(token, current.id);
      for (const child of children) {
        if (visited.has(child.id)) continue;
        const name = child.name || `部门${child.id}`;
        queue.push({
          id: child.id,
          path: current.path ? `${current.path}/${name}` : name,
        });
      }
    }

    this.logger?.info(
      { departments: visited.size, users: users.size },
      'dingtalk contact directory fetched',
    );
    return [...users.values()];
  }

  private async getAccessToken(): Promise<string> {
    const { clientId, clientSecret } = this.credentials();
    if (!clientId || !clientSecret) {
      throw new Error('缺少钉钉应用 AppKey/AppSecret，无法读取通讯录');
    }
    const url = `${OAPI_BASE}/gettoken?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`;
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payload = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
    };
    const code = payload.errcode ?? -1;
    if (code !== 0 || !payload.access_token) {
      throw new Error(
        `获取通讯录 access_token 失败：${code} ${payload.errmsg ?? ''}${scopeHint(code)}`,
      );
    }
    return payload.access_token;
  }

  private async post(
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | unknown[]> {
    const response = await this.fetcher(
      `${OAPI_BASE}${path}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    const payload = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      result?: Record<string, unknown> | unknown[];
    };
    const code = payload.errcode ?? -1;
    if (code !== 0) {
      throw new ContactApiError(
        path,
        code,
        `钉钉通讯录接口 ${path} 失败：${code} ${payload.errmsg ?? ''}${scopeHint(code)}`,
      );
    }
    return payload.result ?? {};
  }

  private async listChildDepartments(
    token: string,
    deptId: number,
  ): Promise<Array<{ id: number; name: string }>> {
    const result = await this.post('/topapi/v2/department/listsub', token, {
      id: deptId,
    });
    // v2 接口直接返回部门数组，旧接口才是 { dept_id_list: [...] }
    const raw = Array.isArray(result) ? result : result.dept_id_list;
    if (!Array.isArray(raw)) return [];
    const children: Array<{ id: number; name: string }> = [];
    for (const item of raw) {
      if (typeof item === 'number') {
        children.push({ id: item, name: await this.getDepartmentName(token, item) });
        continue;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const id =
          asNumber(record.dept_id) ?? asNumber(record.deptId) ?? asNumber(record.id);
        if (id === null) continue;
        const name =
          asText(record.name) ||
          asText(record.dept_name) ||
          (await this.getDepartmentName(token, id));
        children.push({ id, name });
      }
    }
    return children;
  }

  private async getDepartmentName(
    token: string,
    deptId: number,
  ): Promise<string> {
    try {
      const result = await this.post('/topapi/v2/department/get', token, {
        dept_id: deptId,
      });
      return Array.isArray(result) ? '' : asText(result.name);
    } catch (error) {
      this.logger?.warn(
        { deptId, error: error instanceof Error ? error.message : String(error) },
        'failed to read department name',
      );
      return '';
    }
  }

  private async listDepartmentUsers(
    token: string,
    deptId: number,
  ): Promise<DirectoryUser[]> {
    const users: DirectoryUser[] = [];
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.post('/topapi/v2/user/list', token, {
        dept_id: deptId,
        cursor,
        size: PAGE_SIZE,
      });
      if (Array.isArray(result)) return users;
      const list = Array.isArray(result.list) ? result.list : [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const staffId = asText(record.userid) || asText(record.user_id);
        if (!staffId) continue;
        // active=false 表示该员工已离职或停用
        if (record.active === false) continue;
        users.push({
          staffId,
          name: asText(record.name) || staffId,
          deptPath: '',
        });
      }
      const hasMore = result.has_more === true;
      const next = asNumber(result.next_cursor);
      if (!hasMore || next === null || next === cursor) break;
      cursor = next;
    }
    return users;
  }
}

function runDws(
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
        maxBuffer: 8 * 1024 * 1024,
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

function parseDwsJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error('dws 返回了非 JSON 输出，无法解析通讯录');
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
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

/**
 * DWS 个人通讯录：使用当前登录的管理员会话遍历部门树，
 * 作为应用通讯录数据范围不足时的兜底来源，也可用于 openDingTalkId 反查。
 */
export class DwsContactDirectorySource implements DirectorySource {
  public readonly name = 'dws' as const;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(
    options: {
      binary?: string;
      timeoutMs?: number;
      logger?: DirectoryLogger;
    } = {},
  ) {
    this.binary = options.binary ?? process.env.DWS_BINARY?.trim() ?? 'dws';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger;
  }

  private readonly logger?: DirectoryLogger;

  public async fetchUsers(): Promise<DirectoryUser[]> {
    const users = new Map<string, DirectoryUser>();
    const visited = new Set<number>();
    let level: Array<{ id: number; path: string }> = [{ id: 1, path: '' }];

    while (level.length > 0) {
      if (visited.size > MAX_DEPTS) {
        throw new Error(`通讯录部门数量超过 ${MAX_DEPTS}，已中止同步`);
      }
      for (const dept of level) visited.add(dept.id);

      const memberLists = await mapLimit(level, 4, (dept) =>
        this.listMembers(dept.id),
      );
      level.forEach((dept, index) => {
        for (const member of memberLists[index] ?? []) {
          if (!member.staffId || users.has(member.staffId)) continue;
          users.set(member.staffId, {
            staffId: member.staffId,
            name: member.name,
            deptPath: dept.path,
          });
        }
      });

      const childLists = await mapLimit(level, 4, (dept) =>
        this.listChildren(dept.id),
      );
      const next: Array<{ id: number; path: string }> = [];
      level.forEach((dept, index) => {
        for (const child of childLists[index] ?? []) {
          if (visited.has(child.id)) continue;
          const name = child.name || `部门${child.id}`;
          next.push({
            id: child.id,
            path: dept.path ? `${dept.path}/${name}` : name,
          });
        }
      });
      level = next;
    }

    this.logger?.info(
      { departments: visited.size, users: users.size },
      'dws contact directory fetched',
    );
    return [...users.values()];
  }

  /** 用姓名搜索结果把 openDingTalkId 精确匹配回员工 staffId */
  public async resolveOpenId(
    openDingTalkId: string,
    senderName?: string,
  ): Promise<{ staffId: string; name: string } | null> {
    const name = senderName?.trim();
    if (!openDingTalkId || !name) return null;
    try {
      const stdout = await runDws(
        this.binary,
        ['contact', 'user', 'search', '--query', name, '--format', 'json'],
        this.timeoutMs,
      );
      const payload = parseDwsJson<{
        result?: Array<Record<string, unknown>>;
      }>(stdout);
      for (const item of payload.result ?? []) {
        if (asText(item.openDingTalkId) !== openDingTalkId) continue;
        const staffId = asText(item.userId);
        if (!staffId) return null;
        return { staffId, name: asText(item.name) || name };
      }
      return null;
    } catch (error) {
      this.logger?.warn(
        {
          senderName: name,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to resolve openDingTalkId',
      );
      return null;
    }
  }

  private async listChildren(
    deptId: number,
  ): Promise<Array<{ id: number; name: string }>> {
    const stdout = await runDws(
      this.binary,
      [
        'contact',
        'dept',
        'list-children',
        '--id',
        String(deptId),
        '--format',
        'json',
      ],
      this.timeoutMs,
    );
    const payload = parseDwsJson<{
      result?: Array<Record<string, unknown>> | null;
    }>(stdout);
    return (payload.result ?? []).flatMap((item) => {
      const id = asNumber(item.deptId) ?? asNumber(item.dept_id) ?? asNumber(item.id);
      return id === null
        ? []
        : [{ id, name: asText(item.deptName) || asText(item.name) }];
    });
  }

  private async listMembers(
    deptId: number,
  ): Promise<Array<{ staffId: string; name: string }>> {
    const stdout = await runDws(
      this.binary,
      [
        'contact',
        'dept',
        'list-members',
        '--depts',
        String(deptId),
        '--format',
        'json',
      ],
      this.timeoutMs,
    );
    const payload = parseDwsJson<{
      deptUserList?: Array<{ userInfo?: Record<string, unknown> }> | null;
    }>(stdout);
    return (payload.deptUserList ?? []).flatMap((item) => {
      const info = item.userInfo ?? {};
      const staffId =
        asText(info.userId) || asText(info.userid) || asText(info.staffId);
      if (!staffId) return [];
      return [{ staffId, name: asText(info.name) || staffId }];
    });
  }
}
