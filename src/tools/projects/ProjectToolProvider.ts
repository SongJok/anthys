import type {
  ExecutionContext,
  IToolProvider,
  StreamCitation,
  ToolDefinition,
} from '../../types/core.js';
import type { ProjectService } from '../../projects/ProjectService.js';
import type { ProjectMemberContextInput } from '../../types/skills-plugins-projects.js';

export interface ProjectToolProviderOptions {
  service: ProjectService;
  isAdmin: (staffId: string) => boolean;
  enabled?: boolean;
}

const SEARCH_OUTPUT_BUDGET = 2_500;
const READ_OUTPUT_BUDGET = 6_000;

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

function readBoolean(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function dateOf(ms: number | undefined): string {
  if (!ms) return '未同步';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function memberOf(
  options: ProjectToolProviderOptions,
  ctx: ExecutionContext,
): ProjectMemberContextInput {
  return {
    senderStaffId: ctx.senderStaffId,
    isAdmin: options.isAdmin(ctx.senderStaffId),
    conversationType: ctx.conversationType,
  };
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

export class ProjectToolProvider implements IToolProvider {
  public readonly providerName = 'projects';

  constructor(private readonly options: ProjectToolProviderOptions) {}

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (this.options.enabled === false) return [];
    const member = memberOf(this.options, ctx);
    return [
      {
        name: 'project_list',
        description:
          '列出当前用户可见的项目、来源、索引 commit、手册版本和索引是否过期。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            includeUnavailable: {
              type: 'boolean',
              default: false,
              description: '管理员可包含未启用或同步失败的项目',
            },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const entries = await this.options.service.listProjects(
            member,
            readBoolean(args, 'includeUnavailable', false),
          );
          if (entries.length === 0) return '当前没有可见的项目。';
          return entries
            .map((entry) => {
              const parts = [`- ${entry.project.id}（${entry.project.name}）`];
              if (entry.project.isDefault) parts.push('[默认]');
              parts.push(`[${entry.project.visibility}]`);
              if (!entry.project.enabled) parts.push('[未启用]');
              parts.push(
                entry.snapshot
                  ? `commit ${entry.snapshot.commitSha.slice(0, 12)}${entry.stale ? '（仓库有新提交，索引可能过期）' : ''}`
                  : '未建立索引',
              );
              const source =
                entry.project.source.type === 'github'
                  ? `github:${entry.project.source.repo}`
                  : entry.project.source.type === 'local'
                    ? `local:${entry.project.source.path}`
                    : 'manual';
              const lines = [
                `${parts.join(' ')}`,
                `  来源：${source}；最后同步：${dateOf(entry.project.lastSyncedAt)}；手册：v${entry.project.handbookVersion}`,
              ];
              if (entry.project.aliases.length > 0) {
                lines.push(`  别名：${entry.project.aliases.join('、')}`);
              }
              return lines.join('\n');
            })
            .join('\n');
        },
      },
      {
        name: 'project_handbook',
        description:
          '读取项目手册的固定章节（架构、部署、运维、决策等）和人工条目；返回带来源与 commit。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: '项目 ID 或别名' },
            section: {
              type: 'string',
              enum: [
                'overview',
                'architecture',
                'modules',
                'data_model',
                'config',
                'deploy',
                'operations',
                'conventions',
                'testing',
                'decisions',
                'faq',
                'risks',
              ],
            },
            format: {
              type: 'string',
              enum: ['summary', 'full'],
              default: 'summary',
            },
          },
          required: ['project'],
          additionalProperties: false,
        },
        executeStructured: async (args) => {
          const result = await this.options.service.getHandbook({
            projectRef: readString(args, 'project'),
            ...(readString(args, 'section')
              ? { section: readString(args, 'section') }
              : {}),
            format: readString(args, 'format') === 'full' ? 'full' : 'summary',
            member,
          });
          const citations: StreamCitation[] = [];
          const lines = [
            `[project:${result.projectId} @ ${result.commit ? result.commit.slice(0, 12) : '未索引'}] ${result.project.name} 手册 v${result.version}${result.stale ? '（stale：手册 commit 与当前索引不一致）' : ''}`,
          ];
          if (result.content.sections.length === 0) {
            lines.push(
              '尚未发布结构化手册章节；管理员可先维护人工条目，或使用 project_map / project_search 查询代码。',
            );
          }
          const full = readString(args, 'format') === 'full';
          for (const section of result.content.sections) {
            lines.push(
              '',
              `## ${section.title}（${section.key} / ${section.origin}）`,
            );
            lines.push(full ? section.markdown : clip(section.markdown, 1_200));
            for (const source of section.sources.slice(0, 3)) {
              if (source.path) {
                citations.push(
                  citation(
                    citations.length + 1,
                    `${section.title} 来源 ${source.path}`,
                    `project:${result.projectId}@${source.commit ?? result.commit}`,
                  ),
                );
              }
            }
          }
          if (result.manualEntries.length > 0) {
            lines.push('', '## 人工条目');
            for (const entry of result.manualEntries.slice(0, 20)) {
              lines.push(`- [${entry.section}] ${entry.title}：${clip(entry.markdown, full ? 1_500 : 300)}`);
            }
          }
          if (result.content.sections.length === 0 && result.manualEntries.length === 0) {
            lines.push('提示：项目手册内容为空，可请管理员补充 manual 条目。');
          }
          return {
            text: lines.join('\n'),
            ...(citations.length > 0 ? { citations } : {}),
          };
        },
        execute: async () => {
          throw new Error('project_handbook 需要结构化输出');
        },
      },
      {
        name: 'project_map',
        description:
          '返回按目录组织的仓库地图和关键符号（path:line），用于建立项目全局结构。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            path: { type: 'string', description: '可选子目录' },
            maxTokens: {
              type: 'integer',
              minimum: 500,
              maximum: 2_500,
              default: 1_500,
            },
          },
          required: ['project'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const result = await this.options.service.mapProject({
            projectRef: readString(args, 'project'),
            ...(readString(args, 'path') ? { path: readString(args, 'path') } : {}),
            maxTokens: readNumber(args, 'maxTokens', 1_500, 500, 2_500),
            member,
          });
          return [
            `[project:${result.projectId} @ ${result.commit.slice(0, 12)}] 仓库地图（${result.totalFiles} 个文件）${result.stale ? ' [stale]' : ''}`,
            result.text,
            ...(result.truncated ? ['（地图已按 maxTokens 截断，可指定 path 缩小范围）'] : []),
          ].join('\n');
        },
      },
      {
        name: 'project_search',
        description:
          '在项目快照中做混合检索（关键词、路径、符号、可选向量），返回 path:line 与片段。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            query: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['all', 'code', 'doc', 'symbol'],
              default: 'all',
            },
            pathGlob: { type: 'string', description: '例如 src/**/*.ts' },
            language: { type: 'string' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              default: 8,
            },
          },
          required: ['project', 'query'],
          additionalProperties: false,
        },
        executeStructured: async (args) => {
          const result = await this.options.service.searchProject({
            projectRef: readString(args, 'project'),
            query: readString(args, 'query'),
            ...(readString(args, 'kind')
              ? {
                  kind: readString(args, 'kind') as
                    | 'all'
                    | 'code'
                    | 'doc'
                    | 'symbol',
                }
              : {}),
            ...(readString(args, 'pathGlob')
              ? { pathGlob: readString(args, 'pathGlob') }
              : {}),
            ...(readString(args, 'language')
              ? { language: readString(args, 'language') }
              : {}),
            limit: readNumber(args, 'limit', 8, 1, 20),
            member,
          });
          const header = `[project:${result.projectId} @ ${result.commit.slice(0, 12)}] 检索「${readString(args, 'query')}」命中 ${result.total} 条${result.stale ? ' [stale]' : ''}`;
          if (result.hits.length === 0) {
            return {
              text: [header, result.warning ?? '没有命中；可尝试更短的关键词或去掉过滤条件。'].join('\n'),
            };
          }
          const citations: StreamCitation[] = [];
          const lines = [header];
          let budget = SEARCH_OUTPUT_BUDGET - header.length;
          result.hits.forEach((hit, index) => {
            const title = `${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine}${hit.symbol ? ` (${hit.symbol})` : ''} [${hit.match}] score=${hit.score.toFixed(2)}`;
            const snippet = hit.content
              .split('\n')
              .slice(0, 8)
              .map((line) => line.slice(0, 180))
              .join('\n');
            const block = `${title}\n${snippet}`;
            if (block.length > budget) return;
            lines.push(block);
            budget -= block.length + 1;
            if (citations.length < 6) {
              citations.push(
                citation(
                  citations.length + 1,
                  `${result.project.name} ${hit.path}:${hit.startLine}`,
                  `project:${result.projectId}@${result.commit}`,
                  snippet,
                ),
              );
            }
          });
          if (result.warning) lines.push(`注意：${result.warning}`);
          if (result.truncated || lines.length < result.hits.length + 1) {
            lines.push('（输出已截断，可缩小查询范围或使用 project_read 查看完整片段）');
          }
          return {
            text: lines.join('\n'),
            ...(citations.length > 0 ? { citations } : {}),
          };
        },
        execute: async () => {
          throw new Error('project_search 需要结构化输出');
        },
      },
      {
        name: 'project_read',
        description:
          '按行范围读取项目快照中的文件内容，输出带行号；敏感文件不会进入索引。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            path: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
            maxLines: {
              type: 'integer',
              minimum: 1,
              maximum: 300,
              default: 200,
            },
          },
          required: ['project', 'path'],
          additionalProperties: false,
        },
        executeStructured: async (args) => {
          const result = await this.options.service.readProject({
            projectRef: readString(args, 'project'),
            path: readString(args, 'path'),
            ...(typeof args.startLine === 'number'
              ? { startLine: args.startLine }
              : {}),
            ...(typeof args.endLine === 'number' ? { endLine: args.endLine } : {}),
            maxLines: readNumber(args, 'maxLines', 200, 1, 300),
            member,
          });
          const allLines = result.content.split('\n');
          const rendered: string[] = [];
          let used = 0;
          let shownEnd = result.startLine - 1;
          for (let index = 0; index < allLines.length; index += 1) {
            const lineNo = result.startLine + index;
            const renderedLine = `${lineNo}| ${allLines[index] ?? ''}`;
            if (used + renderedLine.length + 1 > READ_OUTPUT_BUDGET) break;
            rendered.push(renderedLine);
            used += renderedLine.length + 1;
            shownEnd = lineNo;
          }
          const nextStart = shownEnd < result.totalLines ? shownEnd + 1 : undefined;
          const header = `[project:${result.projectId} @ ${result.commit.slice(0, 12)}] ${result.path} L${result.startLine}-L${shownEnd} / ${result.totalLines}${result.stale ? ' [stale]' : ''}`;
          const lines = [header, ...rendered];
          if (nextStart !== undefined) {
            lines.push(
              `（已截断：使用 startLine=${nextStart} 继续读取，或缩小 endLine）`,
            );
          }
          return {
            text: lines.join('\n'),
            citations: [
              citation(
                1,
                `${result.projectId} ${result.path}:${result.startLine}`,
                `project:${result.projectId}@${result.commit}`,
                rendered.slice(0, 3).join('\n'),
              ),
            ],
          };
        },
        execute: async () => {
          throw new Error('project_read 需要结构化输出');
        },
      },
      {
        name: 'project_symbol',
        description:
          '按名称查找符号定义与少量 best-effort 引用位置，返回 path:line、签名和所属文件。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            name: { type: 'string' },
            kind: { type: 'string' },
            pathGlob: { type: 'string' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              default: 8,
            },
          },
          required: ['project', 'name'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const result = await this.options.service.symbolProject({
            projectRef: readString(args, 'project'),
            name: readString(args, 'name'),
            ...(readString(args, 'kind') ? { kind: readString(args, 'kind') } : {}),
            ...(readString(args, 'pathGlob')
              ? { pathGlob: readString(args, 'pathGlob') }
              : {}),
            limit: readNumber(args, 'limit', 8, 1, 20),
            member,
          });
          const lines = [
            `[project:${result.projectId} @ ${result.commit.slice(0, 12)}] 符号「${result.symbol}」定义 ${result.definitions.length} 条`,
          ];
          for (const definition of result.definitions) {
            lines.push(
              `- ${definition.path}:${definition.startLine}-${definition.endLine} ${definition.kind} ${definition.parent ? `${definition.parent}.` : ''}${definition.name}${definition.exported ? ' [exported]' : ''}`,
              `  ${definition.signature}`,
            );
          }
          if (result.note) lines.push(result.note);
          if (result.references.length > 0) {
            lines.push('引用（best-effort，同名字符串出现位置）：');
            for (const reference of result.references) {
              lines.push(`- ${reference.path}:${reference.line} ${reference.snippet}`);
            }
          }
          return lines.join('\n');
        },
      },
      {
        name: 'project_history',
        description:
          '查看项目的 Git 提交历史（可按路径过滤）；blame/issues/prs 依赖额外能力。',
        risk: 'read',
        source: 'projects',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            path: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['commits', 'blame', 'issues', 'prs'],
              default: 'commits',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 30,
              default: 10,
            },
          },
          required: ['project'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const result = await this.options.service.historyProject({
            projectRef: readString(args, 'project'),
            ...(readString(args, 'path') ? { path: readString(args, 'path') } : {}),
            ...(readString(args, 'kind')
              ? {
                  kind: readString(args, 'kind') as
                    | 'commits'
                    | 'blame'
                    | 'issues'
                    | 'prs',
                }
              : {}),
            limit: readNumber(args, 'limit', 10, 1, 30),
            member,
          });
          const lines = [
            `[project:${result.projectId} @ ${result.commit ? result.commit.slice(0, 12) : '未索引'}] ${result.kind}`,
          ];
          for (const commit of result.commits) {
            lines.push(`- ${commit.sha} ${commit.date} ${commit.author}：${commit.subject}`);
          }
          if (result.note) lines.push(`说明：${result.note}`);
          if (result.commits.length === 0 && !result.note) {
            lines.push('没有提交记录。');
          }
          return lines.join('\n');
        },
      },
    ];
  }
}
