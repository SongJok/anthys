import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubClient, GithubClientError } from './GithubClient.js';

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>, options = {}) {
  return new GithubClient({
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...options,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GithubClient', () => {
  it('拒绝带路径穿越的仓库名与文件路径', async () => {
    const fetchMock = vi.fn(async () => json({}));
    const client = clientWith(fetchMock);
    expect(() => client.parseRepo('../user')).toThrow(/owner\/name/u);
    expect(() => client.parseRepo('a/..')).toThrow(/owner\/name/u);
    await expect(client.file('a/b', 'src/../secret')).rejects.toThrow(/非法/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝非 HTTPS 或非白名单的 API 地址', () => {
    expect(
      () => new GithubClient({ apiBase: 'http://api.github.com' }),
    ).toThrow(GithubClientError);
    expect(
      () => new GithubClient({ apiBase: 'https://evil.example' }),
    ).toThrow(/白名单/u);
    expect(
      () =>
        new GithubClient({
          apiBase: 'https://ghe.example.com',
          allowedHosts: ['ghe.example.com'],
        }),
    ).not.toThrow();
  });

  it('映射仓库元数据并按 token 决定是否携带 Authorization', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json({
        owner: { login: 'SongJok' },
        name: 'anthys',
        full_name: 'SongJok/anthys',
        description: '钉钉智能体',
        default_branch: 'main',
        private: true,
        html_url: 'https://github.com/SongJok/anthys',
        stargazers_count: 12,
        updated_at: '2026-10-01T00:00:00Z',
        topics: ['dingtalk'],
        language: 'TypeScript',
        license: { spdx_id: 'MIT' },
      }),
    );
    const anonymous = clientWith(fetchMock);
    const info = await anonymous.repo('SongJok/anthys');
    expect(info).toMatchObject({
      owner: 'SongJok',
      name: 'anthys',
      fullName: 'SongJok/anthys',
      defaultBranch: 'main',
      stars: 12,
      topics: ['dingtalk'],
      license: 'MIT',
    });
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ??
      {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('application/vnd.github+json');

    const withToken = new GithubClient({
      token: 'secret-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await withToken.repo('SongJok/anthys');
    const tokenHeaders = (fetchMock.mock.calls[1]?.[1]?.headers ??
      {}) as Record<string, string>;
    expect(tokenHeaders['Authorization']).toBe('Bearer secret-token');
  });

  it('按行范围读取文件并返回 nextStartLine', async () => {
    const text = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json({
        type: 'file',
        path: 'src/app.ts',
        sha: 'abc',
        size: text.length,
        content: Buffer.from(text).toString('base64'),
      }),
    );
    const client = clientWith(fetchMock);
    const result = await client.file('SongJok/anthys', 'src/app.ts', {
      startLine: 2,
      maxLines: 2,
    });
    expect(result).toMatchObject({
      path: 'src/app.ts',
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      nextStartLine: 4,
      truncated: true,
    });
    expect(result.content).toBe('line2\nline3');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/repos/SongJok/anthys/contents/src/app.ts');
  });

  it('拒绝超过 1MB 的文件与不是文件的路径', async () => {
    const fetchMock = vi.fn(async () =>
      json({ type: 'file', size: 2_000_000, content: 'YQ==' }),
    );
    const client = clientWith(fetchMock);
    await expect(client.file('a/b', 'big.bin')).rejects.toThrow(/超过/u);

    const dirMock = vi.fn(async () => json({ type: 'dir' }));
    await expect(
      clientWith(dirMock).file('a/b', 'src'),
    ).rejects.toThrow(/不是文件/u);
  });

  it('代码搜索需要 token，Issue/PR 搜索拼接 repo 与类型限定', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json({
        total_count: 1,
        items: [
          {
            number: 7,
            title: '修复卡片刷新',
            state: 'open',
            user: { login: 'joony' },
            labels: [{ name: 'bug' }],
            html_url: 'https://github.com/SongJok/anthys/issues/7',
            body: '详情',
            created_at: '2026-10-01T00:00:00Z',
            updated_at: '2026-10-02T00:00:00Z',
          },
        ],
      }),
    );
    const anonymous = clientWith(fetchMock);
    await expect(
      anonymous.search('SongJok/anthys', 'card'),
    ).rejects.toThrow(/GITHUB_TOKEN/u);
    expect(fetchMock).not.toHaveBeenCalled();

    const client = new GithubClient({
      token: 'token',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await client.search('SongJok/anthys', '卡片', {
      kind: 'issues',
      limit: 5,
    });
    expect('kind' in result && result.kind).toBe('issues');
    if ('kind' in result) {
      expect(result.items[0]).toMatchObject({
        number: 7,
        title: '修复卡片刷新',
        labels: ['bug'],
      });
    }
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/search/issues');
    expect(url.searchParams.get('q')).toBe('repo:SongJok/anthys is:issue 卡片');
    expect(url.searchParams.get('per_page')).toBe('5');
  });

  it('映射 PR 元数据与文件 diff 摘要', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          number: 12,
          title: '增加 GitHub 工具',
          state: 'open',
          draft: false,
          merged: false,
          mergeable: true,
          mergeable_state: 'clean',
          user: { login: 'joony' },
          head: { ref: 'feat/github' },
          base: { ref: 'main' },
          html_url: 'https://github.com/SongJok/anthys/pull/12',
          body: '新增只读工具',
          comments: 3,
          review_comments: 5,
          commits: 4,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          additions: 120,
          deletions: 8,
          changed_files: 2,
        }),
      )
      .mockResolvedValueOnce(
        json([
          {
            filename: 'src/github/GithubClient.ts',
            status: 'added',
            additions: 100,
            deletions: 0,
            changes: 100,
            patch: '@@ -0,0 +1 @@\n+export class GithubClient {}',
          },
        ]),
      );
    const result = await clientWith(fetchMock).pull('SongJok/anthys', 12);
    expect(result.info).toMatchObject({
      number: 12,
      title: '增加 GitHub 工具',
      head: 'feat/github',
      base: 'main',
      merged: false,
      mergeable: true,
      mergeableState: 'clean',
      comments: 3,
      reviewComments: 5,
      commits: 4,
    });
    expect(result).toMatchObject({ additions: 120, deletions: 8, changedFiles: 2 });
    expect(result.files[0]?.filename).toBe('src/github/GithubClient.ts');
    expect(result.files[0]?.patch).toContain('export class GithubClient');
  });

  it('识别限流、重定向与 API 错误', async () => {
    const rateLimited = clientWith(
      vi.fn(async () =>
        new Response('', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1700000000',
          },
        }),
      ),
    );
    await expect(rateLimited.repo('a/b')).rejects.toMatchObject({
      status: 403,
      rateLimited: true,
    });

    const redirect = clientWith(
      vi.fn(async () => new Response(null, { status: 301 })),
    );
    await expect(redirect.repo('a/b')).rejects.toThrow(/重定向/u);

    const notFound = clientWith(
      vi.fn(async () => json({ message: 'Not Found' }, 404)),
    );
    await expect(notFound.repo('a/b')).rejects.toThrow(/404：Not Found/u);
  });

  it('ETag 缓存过期后用 304 复用旧数据', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ full_name: 'a/b', default_branch: 'main' }, 200, {
          etag: 'W/"1"',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const client = clientWith(fetchMock, { cacheTtlMs: 1_000 });
    const first = await client.repo('a/b');
    vi.advanceTimersByTime(2_000);
    const second = await client.repo('a/b');
    expect(second).toEqual(first);
    const secondHeaders = (fetchMock.mock.calls[1]?.[1]?.headers ??
      {}) as Record<string, string>;
    expect(secondHeaders['If-None-Match']).toBe('W/"1"');
  });

  it('fresh 选项绕过 TTL 缓存强制访问网络', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ full_name: 'a/b', default_branch: 'main' }, 200, {
          etag: 'W/"1"',
        }),
      )
      .mockResolvedValueOnce(
        json({ full_name: 'a/b', default_branch: 'dev' }, 200, {
          etag: 'W/"2"',
        }),
      );
    const client = clientWith(fetchMock, { cacheTtlMs: 60_000 });
    await client.repo('a/b');
    const fresh = await client.repo('a/b', { fresh: true });
    expect(fresh.defaultBranch).toBe('dev');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = (fetchMock.mock.calls[1]?.[1]?.headers ??
      {}) as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();
  });
});
