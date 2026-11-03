import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { PersonalMemoryService } from '../../personal/PersonalMemoryService.js';
import { formatShanghaiDateTime } from '../../time/shanghaiTime.js';

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function formatMemoryList(
  records: Awaited<ReturnType<PersonalMemoryService['list']>>,
  searched: boolean,
): string {
  if (records.length === 0) {
    return searched
      ? '没有找到匹配的个人记忆。'
      : '你还没有个人记忆。';
  }
  return [
    searched ? '匹配的个人记忆：' : '个人记忆：',
    ...records.map(
      (record) =>
        `- ${record.id.slice(0, 8)} · ${record.content}（${record.shareableInGroup ? '群聊可用' : '仅本人'} · 更新 ${formatShanghaiDateTime(record.updatedAt)}）`,
    ),
  ].join('\n');
}

/**
 * 单聊中的个人记忆自助操作。群聊不注册这些工具，
 * 避免个人记忆在群里被读取或写入。
 */
export class PersonalMemoryToolProvider implements IToolProvider {
  public readonly providerName = 'personal-memory';
  private readonly service: PersonalMemoryService;

  constructor(options: { service: PersonalMemoryService }) {
    this.service = options.service;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (ctx.conversationType !== '1') return [];
    const personKey = ctx.personKey?.trim();
    if (!personKey) return [];
    return [
      {
        name: 'personal_memory_list',
        description:
          '查看或检索当前用户自己的个人记忆。用户问“你记得我什么”“我之前说过什么”时使用。只返回本人的条目。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词（可选）' },
            limit: { type: 'number', description: '返回条数，默认 20' },
          },
          additionalProperties: false,
        },
        risk: 'read',
        source: 'personal-memory',
        execute: async (args) => {
          const query = optionalString(args, 'query');
          const limit = optionalNumber(args, 'limit');
          const records = await this.service.list(personKey, {
            ...(query ? { query } : {}),
            limit: limit === undefined ? 20 : Math.round(limit),
          });
          return formatMemoryList(records, Boolean(query));
        },
      },
      {
        name: 'personal_memory_save',
        description:
          '保存一条关于当前用户的长期个人记忆（偏好、职责、长期约定）。用户明确说“记住这件事”时使用。默认仅本人可见，除非用户同意在群聊中使用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要记住的内容' },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: '检索关键词（可选）',
            },
            shareableInGroup: {
              type: 'boolean',
              description: '是否允许在群聊中召回，默认 false',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'personal-memory',
        execute: async (args) => {
          const content = optionalString(args, 'content');
          if (!content) return '缺少要记住的内容。';
          const keywords = optionalStringArray(args, 'keywords');
          return this.service.add({
            personKey,
            conversationId: ctx.conversationId,
            ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
            content: [
              content,
              ...(keywords && keywords.length > 0
                ? [`关键词：${keywords.join('、')}`]
                : []),
            ].join('\n'),
            shareableInGroup: args.shareableInGroup === true,
          });
        },
      },
      {
        name: 'personal_memory_set_sharing',
        description:
          '设置某条个人记忆是否允许在群聊中召回。memoryId 支持 ID 前缀。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            memoryId: { type: 'string', description: '个人记忆 ID 或前缀' },
            shareableInGroup: { type: 'boolean', description: '是否允许群聊使用' },
          },
          required: ['memoryId', 'shareableInGroup'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'personal-memory',
        execute: async (args) => {
          const memoryId = optionalString(args, 'memoryId');
          if (!memoryId) return '缺少个人记忆 ID。';
          return this.service.setShareable(
            personKey,
            memoryId,
            args.shareableInGroup === true,
          );
        },
      },
      {
        name: 'personal_memory_forget',
        description:
          '删除一条当前用户的个人记忆。memoryId 支持 ID 前缀。用户要求忘记某件事时使用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            memoryId: { type: 'string', description: '个人记忆 ID 或前缀' },
          },
          required: ['memoryId'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'personal-memory',
        execute: async (args) => {
          const memoryId = optionalString(args, 'memoryId');
          if (!memoryId) return '缺少个人记忆 ID。';
          return this.service.forget(personKey, memoryId);
        },
      },
    ];
  }
}
