import type { SkillService } from '../../skills/SkillService.js';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
  ToolExecutionOutput,
} from '../../types/core.js';

export interface SkillToolProviderOptions {
  service: SkillService;
  isAdmin: (staffId: string) => boolean;
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

export class SkillToolProvider implements IToolProvider {
  public readonly providerName = 'skills';

  constructor(private readonly options: SkillToolProviderOptions) {}

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const isAdmin = this.options.isAdmin(ctx.senderStaffId);
    return [
      {
        name: 'skill_search',
        description:
          '在技能库中按任务关键词搜索可用技能，只返回名称、描述和适用场景，不返回正文。',
        risk: 'read',
        source: 'skills',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '任务或关键词' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              default: 5,
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const result = await this.options.service.search({
            query: readString(args, 'query'),
            limit: readNumber(args, 'limit', 5, 1, 10),
            isAdmin,
            conversationId: ctx.conversationId,
            senderStaffId: ctx.senderStaffId,
          });
          return result.matches.length > 0
            ? result.matches
                .map(
                  (match) =>
                    `- ${match.name}（${match.source}）：${match.description}\n  适用：${match.whenToUse}`,
                )
                .join('\n')
            : '没有匹配的技能。';
        },
      },
      {
        name: 'use_skill',
        description:
          '加载指定技能的完整操作步骤。任务匹配技能目录时先调用本工具，不要凭名称猜测步骤。',
        risk: 'read',
        source: 'skills',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '技能名称，例如 repo-review',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        execute: async () => {
          throw new Error('use_skill 需要结构化输出');
        },
        executeStructured: async (args): Promise<ToolExecutionOutput> => {
          const name = readString(args, 'name');
          if (!name) throw new Error('name 不能为空');
          const result = await this.options.service.load({
            name,
            conversationId: ctx.conversationId,
            senderStaffId: ctx.senderStaffId,
            isAdmin,
          });
          const skill = result.skill;
          const resourceHint =
            result.resources.length > 0
              ? `\n参考资源：${result.resources
                  .slice(0, 20)
                  .map((resource) => resource.path)
                  .join(', ')}`
              : '';
          if (result.truncated || !result.instructions) {
            return {
              text: result.outline,
              summary: `技能 ${skill.name} 正文较长，已返回分段读取指引`,
            };
          }
          return {
            text: `已加载技能 ${skill.name}（${skill.source}，v${skill.version}）。${resourceHint}`,
            summary: `已加载技能 ${skill.name}`,
            instructions: [
              {
                text: result.instructions,
                source: skill.source === 'plugin' ? 'plugin-skill' : 'skill',
                id: skill.id,
                trust: skill.source === 'plugin' ? 'plugin' : 'admin',
              },
            ],
          };
        },
      },
      {
        name: 'skill_read',
        description:
          '分页读取技能目录内的参考文件，例如 references/checklist.md 或 SKILL.md；单次最多 500 行 / 4000 字符。',
        risk: 'read',
        source: 'skills',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: {
              type: 'string',
              description: '技能目录内的相对路径，例如 references/checklist.md',
            },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
          },
          required: ['name', 'path'],
          additionalProperties: false,
        },
        execute: async (args) => {
          const name = readString(args, 'name');
          const resourcePath = readString(args, 'path');
          if (!name || !resourcePath) {
            throw new Error('name 和 path 不能为空');
          }
          const result = await this.options.service.readResource({
            name,
            path: resourcePath,
            isAdmin,
            conversationId: ctx.conversationId,
            senderStaffId: ctx.senderStaffId,
            ...(args.startLine !== undefined
              ? { startLine: readNumber(args, 'startLine', 1, 1, 1_000_000) }
              : {}),
            ...(args.endLine !== undefined
              ? { endLine: readNumber(args, 'endLine', 1, 1, 1_000_000) }
              : {}),
          });
          const next =
            result.nextStartLine !== undefined
              ? `\n（内容未结束，从第 ${result.nextStartLine} 行继续）`
              : '';
          return [
            `[skill:${result.skillId} ${result.path} L${result.startLine}-L${result.endLine} / ${result.totalLines}]`,
            result.content,
            next,
          ]
            .filter(Boolean)
            .join('\n');
        },
      },
    ];
  }
}
