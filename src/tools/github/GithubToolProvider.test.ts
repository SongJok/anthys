import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type { GithubClient } from '../../github/GithubClient.js';
import type {
  GithubFileResult,
  GithubPullRequestResult,
  GithubRepoInfo,
} from '../../types/skills-plugins-projects.js';
import { GithubToolProvider } from './GithubToolProvider.js';

function context(): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: Date.now() + 10_000,
    now: Date.now,
  };
}

function repoInfo(): GithubRepoInfo {
  return {
    owner: 'SongJok',
    name: 'anthys',
    fullName: 'SongJok/anthys',
    description: '钉钉智能体',
    defaultBranch: 'main',
    private: true,
    htmlUrl: 'https://github.com/SongJok/anthys',
    stars: 12,
    updatedAt: '2026-11-01T00:00:00Z',
    topics: ['dingtalk'],
    language: 'TypeScript',
    license: 'MIT',
  };
}

function fileResult(): GithubFileResult {
  return {
    path: 'src/app.ts',
    sha: 'abc',
    size: 120,
    encoding: 'utf8',
    content: 'line1\nline2\nline3',
    truncated: false,
    startLine: 1,
    endLine: 3,
    totalLines: 3,
  };
}

function pullResult(): GithubPullRequestResult {
  return {
    info: {
      number: 12,
      title: '增加 GitHub 工具',
      state: 'closed',
      draft: false,
      merged: true,
      mergeable: true,
      mergeableState: 'clean',
      author: 'joony',
      head: 'feat/github',
      base: 'main',
      htmlUrl: 'https://github.com/SongJok/anthys/pull/12',
      body: '新增只读工具',
      comments: 3,
      reviewComments: 5,
      commits: 4,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
    },
    files: [
      {
        filename: 'src/github/GithubClient.ts',
        status: 'added',
        additions: 120,
        deletions: 0,
        changes: 120,
        patch: '@@ +export class GithubClient {}',
      },
    ],
    additions: 120,
    deletions: 0,
    changedFiles: 1,
  };
}

function fakeClient(overrides: Record<string, unknown> = {}): GithubClient {
  return {
    hasToken: true,
    parseRepo: (value: string) => {
      const [owner, repo] = value.split('/');
      return { owner, repo };
    },
    repo: vi.fn(async () => repoInfo()),
    tree: vi.fn(async () => ({ entries: [], truncated: false, ref: 'main' })),
    file: vi.fn(async () => fileResult()),
    search: vi.fn(async () => ({ items: [], total: 0, truncated: false })),
    pull: vi.fn(async () => pullResult()),
    ...overrides,
  } as unknown as GithubClient;
}

async function toolMap(
  client: GithubClient,
  options: { enabled?: boolean; defaultRepo?: () => string | Promise<string> } = {},
): Promise<Map<string, ToolDefinition>> {
  const provider = new GithubToolProvider({ client, ...options });
  const tools = await provider.getTools(context());
  return new Map(tools.map((tool) => [tool.name, tool]));
}

describe('GithubToolProvider', () => {
  it('扩展项目关闭时不暴露任何 GitHub 工具', async () => {
    const provider = new GithubToolProvider({
      client: fakeClient(),
      enabled: () => false,
    });
    expect(await provider.getTools(context())).toEqual([]);
  });

  it('github_repo 输出 License，并在省略 repo 时使用默认仓库', async () => {
    const client = fakeClient();
    const tools = await toolMap(client, {
      defaultRepo: () => 'SongJok/anthys',
    });
    const text = await tools.get('github_repo')!.execute({}, context());
    expect(text).toContain('License：MIT');
    expect(text).toContain('默认分支：main');
    expect(client.repo).toHaveBeenCalledWith('SongJok/anthys');
  });

  it('github_file 返回带行号内容与引用', async () => {
    const tools = await toolMap(fakeClient());
    const output = await tools
      .get('github_file')!
      .executeStructured!(
        { repo: 'SongJok/anthys', path: 'src/app.ts', startLine: 2 },
        context(),
      );
    expect(output.text).toContain('2| line2');
    expect(output.citations?.[0]).toMatchObject({
      title: 'SongJok/anthys src/app.ts:1',
      source: 'github:SongJok/anthys/src/app.ts',
    });
  });

  it('github_pr 输出合并状态、可合并性与讨论统计', async () => {
    const tools = await toolMap(fakeClient());
    const text = await tools.get('github_pr')!.execute(
      { repo: 'SongJok/anthys', number: 12 },
      context(),
    );
    expect(text).toContain('已合并');
    expect(text).toContain('可合并：是（clean）');
    expect(text).toContain('提交：4');
    expect(text).toContain('评论：3 / 评审 5');
  });

  it('github_search 不暴露无效的 ref 参数', async () => {
    const tools = await toolMap(fakeClient());
    const schema = tools.get('github_search')!.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties['ref']).toBeUndefined();
  });

  it('缺少 repo 且没有默认仓库时给出明确错误', async () => {
    const tools = await toolMap(fakeClient());
    await expect(
      tools.get('github_tree')!.execute({}, context()),
    ).rejects.toThrow(/缺少 repo 参数/u);
  });
});
