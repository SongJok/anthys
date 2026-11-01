import type {
  GithubCodeSearchItem,
  GithubCodeSearchResult,
  GithubFileResult,
  GithubIssueInfo,
  GithubIssueSearchResult,
  GithubPullRequestFile,
  GithubPullRequestInfo,
  GithubPullRequestResult,
  GithubRepoInfo,
  GithubRepoRef,
  GithubTreeEntry,
  GithubTreeResult,
} from '../types/skills-plugins-projects.js';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;
const MAX_FILE_BYTES = 1_000_000;

export class GithubClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'GithubClientError';
  }
}

export interface GithubClientLogger {
  warn(obj: Record<string, unknown>, message: string): void;
}

export interface GithubClientOptions {
  token?: string;
  /** 默认 https://api.github.com；只允许 HTTPS 的 github 域或显式白名单 */
  apiBase?: string;
  allowedHosts?: string[];
  userAgent?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  logger?: GithubClientLogger;
}

export interface GithubTreeOptions {
  ref?: string;
  path?: string;
  depth?: number;
  limit?: number;
}

export interface GithubFileOptions {
  ref?: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
}

export interface GithubSearchOptions {
  ref?: string;
  kind?: 'code' | 'issues' | 'prs';
  limit?: number;
}

interface CacheEntry {
  etag: string;
  data: unknown;
  fetchedAt: number;
}

function encodePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\/+/u, '');
  const segments = normalized.split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new GithubClientError(`非法仓库路径：${path}`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

export class GithubClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: GithubClientLogger;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: GithubClientOptions = {}) {
    this.token = (options.token ?? '').trim();
    const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, '');
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new GithubClientError(`GITHUB_API_BASE 不是合法 URL：${base}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new GithubClientError('GITHUB_API_BASE 必须使用 HTTPS');
    }
    const allowed =
      parsed.hostname === 'api.github.com' ||
      parsed.hostname.endsWith('.github.com') ||
      (options.allowedHosts ?? []).includes(parsed.hostname);
    if (!allowed) {
      throw new GithubClientError(
        `GITHUB_API_BASE 主机不在白名单内：${parsed.hostname}`,
      );
    }
    this.apiBase = base;
    this.userAgent = options.userAgent ?? 'anthys-dingtalk-agent';
    this.timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
      60_000,
    );
    this.cacheTtlMs = Math.min(
      Math.max(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 0),
      5 * 60_000,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  public get hasToken(): boolean {
    return this.token.length > 0;
  }

  public parseRepo(value: string): GithubRepoRef {
    const repo = value.trim();
    if (!REPO_PATTERN.test(repo)) {
      throw new GithubClientError(`GitHub 仓库格式应为 owner/name：${repo}`);
    }
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new GithubClientError(`GitHub 仓库格式应为 owner/name：${repo}`);
    }
    return { owner, repo: name };
  }

  public async repo(repoRef: string): Promise<GithubRepoInfo> {
    const repo = this.parseRepo(repoRef);
    const data = await this.request<Record<string, unknown>>(
      `/repos/${repo.owner}/${repo.repo}`,
    );
    return {
      owner: String((data['owner'] as Record<string, unknown> | undefined)?.['login'] ?? repo.owner),
      name: String(data['name'] ?? repo.repo),
      fullName: String(data['full_name'] ?? `${repo.owner}/${repo.repo}`),
      description: String(data['description'] ?? ''),
      defaultBranch: String(data['default_branch'] ?? 'main'),
      private: Boolean(data['private']),
      htmlUrl: String(data['html_url'] ?? ''),
      stars: Number(data['stargazers_count'] ?? 0),
      updatedAt: String(data['updated_at'] ?? ''),
      topics: Array.isArray(data['topics'])
        ? (data['topics'] as unknown[]).filter(
            (topic): topic is string => typeof topic === 'string',
          )
        : [],
      language: String(data['language'] ?? ''),
    };
  }

  public async tree(
    repoRef: string,
    options: GithubTreeOptions = {},
  ): Promise<GithubTreeResult> {
    const repo = this.parseRepo(repoRef);
    const ref = (options.ref ?? '').trim() || (await this.repo(repoRef)).defaultBranch;
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500);
    const prefix = (options.path ?? '')
      .replace(/\\/gu, '/')
      .replace(/^\/+|\/+$/gu, '');
    const depth = Math.min(Math.max(Math.trunc(options.depth ?? 2), 1), 10);
    const data = await this.request<Record<string, unknown>>(
      `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}`,
      new URLSearchParams({ recursive: '1' }),
    );
    const rawTree = Array.isArray(data['tree']) ? data['tree'] : [];
    const prefixDepth = prefix ? prefix.split('/').length : 0;
    const entries: GithubTreeEntry[] = [];
    let truncated = Boolean(data['truncated']) || rawTree.length > limit;
    for (const item of rawTree) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const path = String(record['path'] ?? '');
      if (!path) continue;
      if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
      const relative = prefix && path !== prefix ? path.slice(prefix.length + 1) : path;
      if (relative.split('/').length > depth) continue;
      const size = Number(record['size'] ?? 0);
      entries.push({
        path,
        type: record['type'] === 'tree' ? 'tree' : 'blob',
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
        sha: String(record['sha'] ?? ''),
      });
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
    }
    const ordered = [
      ...entries.filter((entry) => entry.type === 'tree'),
      ...entries.filter((entry) => entry.type === 'blob'),
    ];
    return { entries: ordered, truncated, ref };
  }

  public async file(
    repoRef: string,
    filePath: string,
    options: GithubFileOptions = {},
  ): Promise<GithubFileResult> {
    const repo = this.parseRepo(repoRef);
    const encoded = encodePath(filePath);
    if (!encoded) throw new GithubClientError('缺少文件路径');
    const ref = (options.ref ?? '').trim();
    const data = await this.request<Record<string, unknown>>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encoded}`,
      ref ? new URLSearchParams({ ref }) : undefined,
    );
    const type = String(data['type'] ?? '');
    if (type !== 'file') {
      throw new GithubClientError(`路径不是文件：${filePath}`);
    }
    const size = Number(data['size'] ?? 0);
    if (size > MAX_FILE_BYTES) {
      throw new GithubClientError(
        `文件 ${filePath} 超过 ${MAX_FILE_BYTES} 字节，请使用 github_tree 或缩小范围`,
      );
    }
    const encodedContent = String(data['content'] ?? '').replace(/\s+/gu, '');
    if (!encodedContent) {
      throw new GithubClientError(`无法读取文件内容：${filePath}`);
    }
    const text = Buffer.from(encodedContent, 'base64').toString('utf8');
    const lines = text.split('\n');
    const totalLines = lines.length;
    const startLine = Math.min(
      Math.max(Math.trunc(options.startLine ?? 1), 1),
      Math.max(totalLines, 1),
    );
    const maxLines = Math.min(Math.max(Math.trunc(options.maxLines ?? 200), 1), 300);
    const requestedEnd = options.endLine
      ? Math.max(Math.trunc(options.endLine), startLine)
      : startLine + maxLines - 1;
    const endLine = Math.min(requestedEnd, totalLines, startLine + maxLines - 1);
    const content = lines.slice(startLine - 1, endLine).join('\n');
    const nextStartLine = endLine < totalLines ? endLine + 1 : undefined;
    return {
      path: String(data['path'] ?? filePath),
      sha: String(data['sha'] ?? ''),
      size,
      encoding: 'utf8',
      content,
      truncated: endLine < totalLines,
      startLine,
      endLine,
      totalLines,
      ...(nextStartLine !== undefined ? { nextStartLine } : {}),
    };
  }

  public async search(
    repoRef: string,
    query: string,
    options: GithubSearchOptions = {},
  ): Promise<GithubCodeSearchResult | GithubIssueSearchResult> {
    const kind = options.kind ?? 'code';
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 30);
    const repo = this.parseRepo(repoRef);
    const fullName = `${repo.owner}/${repo.repo}`;
    if (kind === 'code') {
      if (!this.token) {
        throw new GithubClientError(
          'GitHub 代码搜索需要 GITHUB_TOKEN；未配置时只能读取仓库元数据和文件',
          401,
        );
      }
      const q = `${query.trim()} repo:${fullName}`.trim();
      const data = await this.request<Record<string, unknown>>(
        '/search/code',
        new URLSearchParams({ q, per_page: String(limit) }),
      );
      const items = Array.isArray(data['items']) ? data['items'] : [];
      const mapped: GithubCodeSearchItem[] = items.map((item) => {
        const record = (item && typeof item === 'object' ? item : {}) as Record<
          string,
          unknown
        >;
        const fragments = Array.isArray(record['text_matches'])
          ? (record['text_matches'] as Array<Record<string, unknown>>)
          : [];
        return {
          path: String(record['path'] ?? ''),
          name: String(record['name'] ?? ''),
          htmlUrl: String(record['html_url'] ?? ''),
          textMatches: fragments
            .map((fragment) => String(fragment['fragment'] ?? '').trim())
            .filter(Boolean)
            .slice(0, 3),
        };
      });
      const total = Number(data['total_count'] ?? mapped.length);
      return {
        items: mapped,
        total,
        truncated: total > mapped.length,
      };
    }
    const qualifiers = [`repo:${fullName}`, kind === 'prs' ? 'is:pr' : 'is:issue'];
    const trimmed = query.trim();
    if (trimmed) qualifiers.push(trimmed);
    const data = await this.request<Record<string, unknown>>(
      '/search/issues',
      new URLSearchParams({
        q: qualifiers.join(' '),
        per_page: String(limit),
        sort: 'updated',
        order: 'desc',
      }),
    );
    const rawItems = Array.isArray(data['items']) ? data['items'] : [];
    const items: GithubIssueInfo[] = rawItems.map((item) => {
      const record = (item && typeof item === 'object' ? item : {}) as Record<
        string,
        unknown
      >;
      const labels = Array.isArray(record['labels'])
        ? (record['labels'] as Array<Record<string, unknown>>)
            .map((label) => String(label['name'] ?? ''))
            .filter(Boolean)
        : [];
      return {
        number: Number(record['number'] ?? 0),
        title: String(record['title'] ?? ''),
        state: String(record['state'] ?? ''),
        author: String(
          (record['user'] as Record<string, unknown> | undefined)?.['login'] ?? '',
        ),
        labels,
        htmlUrl: String(record['html_url'] ?? ''),
        body: String(record['body'] ?? ''),
        createdAt: String(record['created_at'] ?? ''),
        updatedAt: String(record['updated_at'] ?? ''),
      };
    });
    return {
      kind,
      items,
      total: Number(data['total_count'] ?? items.length),
    };
  }

  public async pull(
    repoRef: string,
    number: number,
  ): Promise<GithubPullRequestResult> {
    const repo = this.parseRepo(repoRef);
    const pullNumber = Math.trunc(number);
    if (!Number.isFinite(pullNumber) || pullNumber <= 0) {
      throw new GithubClientError(`PR 编号不合法：${number}`);
    }
    const data = await this.request<Record<string, unknown>>(
      `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}`,
    );
    const info: GithubPullRequestInfo = {
      number: Number(data['number'] ?? pullNumber),
      title: String(data['title'] ?? ''),
      state: String(data['state'] ?? ''),
      draft: Boolean(data['draft']),
      author: String(
        (data['user'] as Record<string, unknown> | undefined)?.['login'] ?? '',
      ),
      head: String(
        (data['head'] as Record<string, unknown> | undefined)?.['ref'] ?? '',
      ),
      base: String(
        (data['base'] as Record<string, unknown> | undefined)?.['ref'] ?? '',
      ),
      htmlUrl: String(data['html_url'] ?? ''),
      body: String(data['body'] ?? ''),
      createdAt: String(data['created_at'] ?? ''),
      updatedAt: String(data['updated_at'] ?? ''),
    };
    const filesData = await this.request<unknown>(
      `/repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/files`,
      new URLSearchParams({ per_page: '100' }),
    );
    const rawFiles = Array.isArray(filesData) ? filesData : [];
    const files: GithubPullRequestFile[] = rawFiles.map((item) => {
      const record = (item && typeof item === 'object' ? item : {}) as Record<
        string,
        unknown
      >;
      const patch = typeof record['patch'] === 'string' ? record['patch'] : undefined;
      return {
        filename: String(record['filename'] ?? ''),
        status: String(record['status'] ?? ''),
        additions: Number(record['additions'] ?? 0),
        deletions: Number(record['deletions'] ?? 0),
        changes: Number(record['changes'] ?? 0),
        ...(patch ? { patch } : {}),
      };
    });
    return {
      info,
      files,
      additions: Number(data['additions'] ?? 0),
      deletions: Number(data['deletions'] ?? 0),
      changedFiles: Number(data['changed_files'] ?? files.length),
    };
  }

  private async request<T>(
    path: string,
    params?: URLSearchParams,
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    if (params) {
      for (const [key, value] of params) url.searchParams.set(key, value);
    }
    if (url.origin !== new URL(this.apiBase).origin) {
      throw new GithubClientError('GitHub 请求地址越界');
    }
    const key = url.toString();
    const cached = this.cache.get(key);
    const now = Date.now();
    if (
      cached &&
      this.cacheTtlMs > 0 &&
      now - cached.fetchedAt <= this.cacheTtlMs
    ) {
      return cached.data as T;
    }
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ error: message, path }, 'github request failed');
      throw new GithubClientError(`GitHub 请求失败：${message}`);
    }
    if (response.status === 304 && cached) {
      return cached.data as T;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new GithubClientError(
        `GitHub API 返回重定向（${response.status}），已拒绝跟随`,
        response.status,
      );
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      if (remaining === '0' || response.status === 429) {
        const resetAt = reset
          ? new Date(Number(reset) * 1000).toISOString()
          : '未知时间';
        throw new GithubClientError(
          `GitHub API 触发限流，恢复时间：${resetAt}`,
          response.status,
          true,
        );
      }
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // 保留原始文本
      }
      throw new GithubClientError(
        `GitHub API ${response.status}：${message || response.statusText}`,
        response.status,
      );
    }
    const data = (await response.json()) as T;
    const etag = response.headers.get('etag');
    if (etag && this.cacheTtlMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
      this.cache.set(key, { etag, data, fetchedAt: now });
    }
    return data;
  }
}
