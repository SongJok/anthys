import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { PersonSettingsService } from '../../personal/PersonSettingsService.js';
import {
  isGroupMemorySharing,
  isPreferenceLanguage,
  isReplyLength,
  type GroupMemorySharing,
} from '../../types/personal-settings.js';

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
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

/**
 * 个人偏好只允许在单聊中读写：群聊里的其他成员不应看到、
 * 也不应受影响于某个人的私有表达设定。
 */
export class PersonSettingsToolProvider implements IToolProvider {
  public readonly providerName = 'person-settings';
  private readonly service: PersonSettingsService;

  constructor(options: { service: PersonSettingsService }) {
    this.service = options.service;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (ctx.conversationType !== '1') return [];
    const personKey = ctx.personKey?.trim();
    if (!personKey) return [];
    return [
      {
        name: 'personal_preference_get',
        description:
          '查看当前员工的个人偏好（回答长度、语言、称呼、补充要求）。仅在单聊可用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        risk: 'read',
        source: 'person-settings',
        execute: async () => {
          const preferences = await this.service.getPreferences(personKey);
          return [
            `个人偏好（${preferences.enabled ? '已启用' : '已停用'}）：`,
            `- 回答长度：${preferences.replyLength}`,
            `- 回答语言：${preferences.language}`,
            `- 称呼：${preferences.addressAs || '未设置'}`,
            `- 补充要求：${preferences.extraInstructions || '无'}`,
          ].join('\n');
        },
      },
      {
        name: 'personal_preference_set',
        description:
          '更新当前员工的个人偏好。员工说“以后回答简短点”“叫我老张”时使用，只能改自己的偏好。仅在单聊可用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            replyLength: {
              type: 'string',
              enum: ['concise', 'balanced', 'detailed'],
              description: '回答长度偏好',
            },
            language: {
              type: 'string',
              enum: ['auto', 'zh', 'en'],
              description: '回答语言偏好',
            },
            addressAs: {
              type: 'string',
              description: '希望被如何称呼，空字符串表示清除',
            },
            extraInstructions: {
              type: 'string',
              description: '额外的回答要求，空字符串表示清除',
            },
            enabled: { type: 'boolean', description: '是否启用个人偏好' },
          },
          additionalProperties: false,
        },
        risk: 'write',
        source: 'person-settings',
        execute: async (args) => {
          const replyLength = optionalString(args, 'replyLength');
          if (replyLength && !isReplyLength(replyLength)) {
            return `未知回答长度：${replyLength}`;
          }
          const language = optionalString(args, 'language');
          if (language && !isPreferenceLanguage(language)) {
            return `未知回答语言：${language}`;
          }
          const addressAs =
            typeof args.addressAs === 'string' ? args.addressAs : undefined;
          const extraInstructions =
            typeof args.extraInstructions === 'string'
              ? args.extraInstructions
              : undefined;
          const enabled = optionalBoolean(args, 'enabled');
          if (
            replyLength === undefined &&
            language === undefined &&
            addressAs === undefined &&
            extraInstructions === undefined &&
            enabled === undefined
          ) {
            return '没有要更新的偏好字段。';
          }
          await this.service.updatePreferences(
            personKey,
            {
              ...(replyLength && isReplyLength(replyLength)
                ? { replyLength }
                : {}),
              ...(language && isPreferenceLanguage(language)
                ? { language }
                : {}),
              ...(addressAs !== undefined ? { addressAs } : {}),
              ...(extraInstructions !== undefined ? { extraInstructions } : {}),
              ...(enabled !== undefined ? { enabled } : {}),
            },
            personKey,
          );
          return '个人偏好已更新，下一条单聊消息生效。';
        },
      },
      {
        name: 'personal_memory_consent_get',
        description:
          '查看当前员工的跨群记忆授权（个人记忆在群聊中的使用范围与生效群白名单）。仅在单聊可用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        risk: 'read',
        source: 'person-settings',
        execute: async () => {
          const consent = await this.service.getConsent(personKey);
          return [
            '跨群记忆授权：',
            `- 群聊使用档位：${consent.groupSharing}`,
            `- 生效群白名单：${
              consent.allowedConversationIds.length > 0
                ? consent.allowedConversationIds.join('、')
                : '全部群'
            }`,
          ].join('\n');
        },
      },
      {
        name: 'personal_memory_consent_set',
        description:
          '更新当前员工的跨群记忆授权。员工说“别在群里用我的记忆”“只在某个群用”时使用。仅在单聊可用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            groupSharing: {
              type: 'string',
              enum: ['off', 'shareable', 'all'],
              description:
                'off 不在任何群使用；shareable 只用标记可共享的条目；all 使用全部非敏感记忆',
            },
            allowedConversationIds: {
              type: 'array',
              items: { type: 'string' },
              description: '非空时只在这些群会话内生效',
            },
          },
          additionalProperties: false,
        },
        risk: 'write',
        source: 'person-settings',
        execute: async (args) => {
          const groupSharing = optionalString(args, 'groupSharing');
          if (groupSharing && !isGroupMemorySharing(groupSharing)) {
            return `未知分享档位：${groupSharing}`;
          }
          const allowed = optionalStringArray(args, 'allowedConversationIds');
          if (!groupSharing && allowed === undefined) {
            return '没有要更新的授权字段。';
          }
          await this.service.updateConsent(
            personKey,
            {
              ...(groupSharing
                ? { groupSharing: groupSharing as GroupMemorySharing }
                : {}),
              ...(allowed !== undefined ? { allowedConversationIds: allowed } : {}),
            },
            personKey,
          );
          return '跨群记忆授权已更新。';
        },
      },
    ];
  }
}
