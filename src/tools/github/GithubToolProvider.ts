import type {
  ExecutionContext,
  IToolProvider,
  StreamCitation,
  ToolDefinition,
} from '../../types/core.js';
import type { GithubClient } from '../../github/GithubClient.js';
import { GithubClientError } from '../../github/GithubClient.js';

const REPO_OUTPUT_BUDGET = 1_500;
const TREE_OUTPUT_BUDGET = 2_800;
const FILE_OUTPUT_BUDGET = 6_000;
const SEARCH_OUTPUT_BUDGET = 2_800;
const PR_OUTPUT_BUDGET = 3_500;

export interface GithubToolProviderOptions {
  client: GithubClient;
  /** 未显式传 repo 时使用的默认仓库（通常来自默认项目） */
  defaultRepo?: () => string | Promise<string>;
  /** 支持热开关；每次组装工具时求值 */
  enabled?: boolean | (() => boolean);
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function citation(
  index: number,
  title: string,
  source: string,
  snippet?: string,
): StreamCitation {
  return {
    index,
    title,
    source,
    ...(snippet ? { snippet: snippet.slice(0, 300) } : {}),
  };
}

export class GithubToolProvider implements IToolProvider {
  public readonly providerName = 'github';

  constructor(private readonly options: GithubToolProviderOptions) {}

  private async resolveRepo(args: Record<string, unknown>): Promise<string> {
    const repo = readString(args, 'repo');
    if (repo) return repo;
    const fallback = this.options.defaultRepo
      ? (await this.options.defaultRepo()).trim()
      : '';
    if (!fallback) {
      throw new GithubClientError('缺少 repo 参数（格式 owner/name）');
    }
    return fallback;
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const enabled = this.options.enabled;
    if (
      enabled !== undefined &&
      (typeof enabled === 'function' ? !enabled() : !enabled)
    ) {
      return [];
    }
    return [
      {
        name: 'github_repo',
        description:
          '查看 GitHub 仓库元数据：描述、默认分支、语言、Star、License、最近更新和主页地址。',
        risk: 'read',
        source: 'github',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name，省略时使用默认项目仓库' },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const repo = await this.resolveRepo(args);
          const info = await this.options.client.repo(repo);
          const lines = [
            `[github:${info.fullName}] ${info.name}${info.private ? ' [private]' : ''}`,
            `描述：${info.description || '无'}`,
            `语言：${info.language || '未知'}；Star：${info.stars}；默认分支：${info.defaultBranch}`,
            `License：${info.license || '未声明'}`,
            `最近更新：${info.updatedAt}`,
            ...(info.topics.length > 0 ? [`Topics：${info.topics.join('、')}`] : []),
            `主页：${info.htmlUrl}`,
          ];
          return clip(lines.join('\n'), REPO_OUTPUT_BUDGET);
        },
      },
      {
        name: 'github_tree',
        description:
          '列出 GitHub 仓库指定 ref 与目录的树结构（目录优先，深度与条数受限），用于快速了解仓库布局。',
        risk: 'read',
        source: 'github',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name，省略时使用默认项目仓库' },
            ref: { type: 'string', description: '分支、tag 或 commit，默认仓库默认分支' },
            path: { type: 'string', description: '可选的子目录前缀' },
            depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const repo = await this.resolveRepo(args);
          const result = await this.options.client.tree(repo, {
            ...(readString(args, 'ref') ? { ref: readString(args, 'ref') } : {}),
            ...(readString(args, 'path') ? { path: readString(args, 'path') } : {}),
            depth: readNumber(args, 'depth', 2, 1, 10),
            limit: readNumber(args, 'limit', 200, 1, 500),
          });
          const header = `[github:${repo}@${result.ref}] ${result.entries.length} 个条目${result.truncated ? '（已截断）' : ''}`;
          const lines = [header];
          let budget = TREE_OUTPUT_BUDGET - header.length;
          for (const entry of result.entries) {
            const label = `${entry.type === 'tree' ? 'd' : '-'} ${entry.path}${entry.size ? ` (${entry.size} B)` : ''}`;
            if (label.length + 1 > budget) {
              lines.push('（输出已截断，可缩小 path 或降低 depth）');
              break;
            }
            lines.push(label);
            budget -= label.length + 1;
          }
          return lines.join('\n');
        },
      },
      {
        name: 'github_file',
        description:
          '读取 GitHub 仓库文件的行范围，输出带行号内容；不能读取超过 1MB 的文件。',
        risk: 'read',
        source: 'github',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name，省略时使用默认项目仓库' },
            path: { type: 'string', description: '仓库内文件路径' },
            ref: { type: 'string', description: '分支、tag 或 commit' },
            startLine: { type: 'integer', minimum: 1, default: 1 },
            endLine: { type: 'integer', minimum: 1 },
            maxLines: { type: 'integer', minimum: 1, maximum: 300, default: 200 },
          },
          required: ['path'],
          additionalProperties: false,
        },
        executeStructured: async (args) => {
          const repo = await this.resolveRepo(args);
          const filePath = readString(args, 'path');
          if (!filePath) throw new GithubClientError('缺少 path 参数');
          const result = await this.options.client.file(repo, filePath, {
            ...(readString(args, 'ref') ? { ref: readString(args, 'ref') } : {}),
            ...(typeof args.startLine === 'number'
              ? { startLine: args.startLine }
              : {}),
            ...(typeof args.endLine === 'number' ? { endLine: args.endLine } : {}),
            maxLines: readNumber(args, 'maxLines', 200, 1, 300),
          });
          const header = `[github:${repo}] ${result.path} L${result.startLine}-L${result.endLine} / ${result.totalLines}`;
          const rendered: string[] = [header];
          let budget = FILE_OUTPUT_BUDGET - header.length;
          const lines = result.content.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = `${result.startLine + index}| ${lines[index] ?? ''}`;
            if (line.length + 1 > budget) break;
            rendered.push(line);
            budget -= line.length + 1;
          }
          if (result.nextStartLine !== undefined) {
            rendered.push(
              `（已截断：使用 startLine=${result.nextStartLine} 继续读取）`,
            );
          }
          return {
            text: rendered.join('\n'),
            citations: [
              citation(
                1,
                `${repo} ${result.path}:${result.startLine}`,
                `github:${repo}/${result.path}`,
                lines.slice(0, 3).join('\n'),
              ),
            ],
          };
        },
        execute: async () => {
          throw new Error('github_file 需要结构化输出');
        },
      },
      {
        name: 'github_search',
        description:
          '在 GitHub 仓库内搜索代码（需要 GITHUB_TOKEN）、Issue 或 PR；返回路径、编号、状态与摘要。',
        risk: 'read',
        source: 'github',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name，省略时使用默认项目仓库' },
            query: { type: 'string', description: '关键词；issues/prs 可留空看最近条目' },
            kind: {
              type: 'string',
              enum: ['code', 'issues', 'prs'],
              default: 'code',
            },
            limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const repo = await this.resolveRepo(args);
          const kindRaw = readString(args, 'kind');
          const kind =
            kindRaw === 'issues' || kindRaw === 'prs' ? kindRaw : 'code';
          const result = await this.options.client.search(
            repo,
            readString(args, 'query'),
            {
              kind,
              limit: readNumber(args, 'limit', 10, 1, 30),
            },
          );
          if ('kind' in result) {
            const lines = [
              `[github:${repo}] ${result.kind} 命中 ${result.total} 条`,
            ];
            let budget = SEARCH_OUTPUT_BUDGET - lines[0].length;
            for (const item of result.items) {
              const block = `- #${item.number} [${item.state}] ${item.title}（${item.author}）${item.labels.length > 0 ? ` ${item.labels.join(',')}` : ''}\n  ${item.htmlUrl}`;
              if (block.length + 1 > budget) break;
              lines.push(block);
              budget -= block.length + 1;
            }
            return lines.join('\n');
          }
          const lines = [`[github:${repo}] 代码命中 ${result.total} 条`];
          let budget = SEARCH_OUTPUT_BUDGET - lines[0].length;
          for (const item of result.items) {
            const matches = item.textMatches
              .map((fragment) => clip(fragment.replace(/\s+/gu, ' '), 160))
              .join(' … ');
            const block = `- ${item.path}${matches ? `\n  ${matches}` : ''}`;
            if (block.length + 1 > budget) break;
            lines.push(block);
            budget -= block.length + 1;
          }
          return lines.join('\n');
        },
      },
      {
        name: 'github_pr',
        description:
          '查看 GitHub Pull Request 的元数据、变更统计和前若干文件的 diff 摘要。',
        risk: 'read',
        source: 'github',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name，省略时使用默认项目仓库' },
            number: { type: 'integer', minimum: 1 },
          },
          required: ['number'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const repo = await this.resolveRepo(args);
          const number = readNumber(args, 'number', 0, 1, Number.MAX_SAFE_INTEGER);
          const result = await this.options.client.pull(repo, number);
          const info = result.info;
          const mergeable =
            info.mergeable === null
              ? '未知'
              : info.mergeable
                ? '是'
                : '否';
          const lines = [
            `[github:${repo}] PR #${info.number} ${info.title}`,
            `状态：${info.state}${info.merged ? '（已合并）' : ''}${info.draft ? '（draft）' : ''}；作者：${info.author}；${info.head} → ${info.base}`,
            `可合并：${mergeable}${info.mergeableState ? `（${info.mergeableState}）` : ''}`,
            `变更：${result.changedFiles} 个文件，+${result.additions}/-${result.deletions}；提交：${info.commits}；评论：${info.comments} / 评审 ${info.reviewComments}`,
            `链接：${info.htmlUrl}`,
            ...(info.body.trim()
              ? ['', '描述摘要：', clip(info.body.trim(), 600)]
              : []),
            '',
            '文件变更：',
          ];
          let budget = PR_OUTPUT_BUDGET - lines.join('\n').length;
          for (const file of result.files.slice(0, 30)) {
            const block = `- ${file.filename} [${file.status}] +${file.additions}/-${file.deletions}`;
            if (block.length + 1 > budget) {
              lines.push('（文件列表已截断）');
              break;
            }
            lines.push(block);
            budget -= block.length + 1;
            if (file.patch) {
              const snippet = clip(file.patch.replace(/\r/gu, ''), 240);
              if (snippet.length + 3 > budget) break;
              lines.push('```diff', snippet, '```');
              budget -= snippet.length + 10;
            }
          }
          return lines.join('\n');
        },
      },
    ];
  }
}
