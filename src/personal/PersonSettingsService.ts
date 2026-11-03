import type { InboundMessage } from '../types/core.js';
import type {
  GroupMemorySharing,
  PersonMemoryConsent,
  PersonMemoryConsentInput,
  PersonMemoryConsentResolver,
  PersonMemoryConsentStore,
  PersonPreferences,
  PersonPreferencesInput,
  PersonPreferencesStore,
  PersonSettingsAdminPort,
  PersonSettingsReassignPort,
  PersonSettingsReassignResult,
  PreferenceLanguage,
  ReplyLength,
} from '../types/personal-settings.js';
import {
  isGroupMemorySharing,
  isPreferenceLanguage,
  isReplyLength,
} from '../types/personal-settings.js';

const ADDRESS_LIMIT = 40;
const INSTRUCTIONS_LIMIT = 1_000;
const ALLOWED_CONVERSATIONS_LIMIT = 50;

export interface PersonSettingsServiceOptions {
  preferences: PersonPreferencesStore;
  consents: PersonMemoryConsentStore;
  now?: () => number;
}

const PREFERENCE_USAGE = [
  '个人偏好用法（仅单聊）：',
  '- `/pref` 查看当前偏好',
  '- `/pref length concise|balanced|detailed` 回答长度',
  '- `/pref lang auto|zh|en` 回答语言',
  '- `/pref address <称呼>` 希望如何被称呼（空值清除）',
  '- `/pref extra <补充要求>` 额外的回答要求（空值清除）',
  '- `/pref on|off` / `/pref reset`',
].join('\n');

const PRIVACY_USAGE = [
  '跨群记忆授权用法（仅单聊）：',
  '- `/privacy` 查看当前授权',
  '- `/privacy groups off|shareable|all` 个人记忆在群聊中的使用范围',
  '- `/privacy allow <群会话ID>` / `/privacy deny <群会话ID>` 限定生效群',
  '- `/privacy clear` 清除群白名单（所有群按当前档位生效）',
  '',
  'off：任何群都不使用你的个人记忆；shareable：只使用显式标记可共享的条目；all：可使用全部非敏感个人记忆。标记为敏感的记忆在任何档位下都不会进入群聊。',
].join('\n');

function defaultPreferences(
  personKey: string,
  now: number,
): PersonPreferences {
  return {
    personKey,
    replyLength: 'balanced',
    language: 'auto',
    addressAs: '',
    extraInstructions: '',
    enabled: true,
    updatedBy: '',
    updatedAt: now,
  };
}

export function defaultMemoryConsent(
  personKey: string,
  now = Date.now(),
): PersonMemoryConsent {
  return {
    personKey,
    groupSharing: 'shareable',
    allowedConversationIds: [],
    updatedBy: '',
    updatedAt: now,
  };
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

const SHARING_RANK: Record<GroupMemorySharing, number> = {
  off: 0,
  shareable: 1,
  all: 2,
};

/** 偏好以最近一次修改为准，避免合并时被旧设置覆盖 */
function mergePreferences(
  target: PersonPreferences,
  source: PersonPreferences,
  personKey: string,
  now: number,
): PersonPreferences {
  const winner = target.updatedAt >= source.updatedAt ? target : source;
  return { ...winner, personKey, updatedAt: now };
}

/**
 * 授权合并只收紧不放松：共享档位取更严格的一档；
 * 白名单取交集，交集为空时取并集（空列表表示全部群，直接取交集会误放宽）。
 */
function mergeConsents(
  target: PersonMemoryConsent,
  source: PersonMemoryConsent,
  personKey: string,
  now: number,
): PersonMemoryConsent {
  const groupSharing =
    SHARING_RANK[target.groupSharing] <= SHARING_RANK[source.groupSharing]
      ? target.groupSharing
      : source.groupSharing;
  let allowedConversationIds: string[];
  if (target.allowedConversationIds.length === 0) {
    allowedConversationIds = [...source.allowedConversationIds];
  } else if (source.allowedConversationIds.length === 0) {
    allowedConversationIds = [...target.allowedConversationIds];
  } else {
    const intersection = target.allowedConversationIds.filter((id) =>
      source.allowedConversationIds.includes(id),
    );
    allowedConversationIds =
      intersection.length > 0
        ? intersection
        : [
            ...new Set([
              ...target.allowedConversationIds,
              ...source.allowedConversationIds,
            ]),
          ];
  }
  return {
    personKey,
    groupSharing,
    allowedConversationIds,
    updatedBy: target.updatedBy || source.updatedBy,
    updatedAt: now,
  };
}

function renderLength(length: ReplyLength): string {
  switch (length) {
    case 'concise':
      return '回答尽量简短：先给结论，控制在 3 段以内，省略非必要展开。';
    case 'detailed':
      return '回答可以充分展开：给出依据、步骤与边界情况，必要时附示例。';
    default:
      return '回答长度适中：先给结论，再按需补充关键依据。';
  }
}

function renderLanguage(language: PreferenceLanguage): string {
  switch (language) {
    case 'zh':
      return '使用中文回答。';
    case 'en':
      return 'Answer in English.';
    default:
      return '';
  }
}

/**
 * 个人偏好与跨群记忆授权：
 * - 偏好只影响单聊表达，不改变群职责或安全边界；
 * - 授权决定个人语义记忆能否在群聊中被召回。
 */
export class PersonSettingsService
  implements
    PersonSettingsAdminPort,
    PersonMemoryConsentResolver,
    PersonSettingsReassignPort
{
  private readonly preferences: PersonPreferencesStore;
  private readonly consents: PersonMemoryConsentStore;
  private readonly now: () => number;

  constructor(options: PersonSettingsServiceOptions) {
    this.preferences = options.preferences;
    this.consents = options.consents;
    this.now = options.now ?? Date.now;
  }

  public usage(): string {
    return PREFERENCE_USAGE;
  }

  public privacyUsage(): string {
    return PRIVACY_USAGE;
  }

  /**
   * 把旧身份的个人偏好与记忆授权迁到新 personKey。
   * 幂等：迁移后删除旧记录，重复调用不会再次改动目标设置。
   */
  public async reassignPersonKey(
    fromPersonKey: string,
    toPersonKey: string,
  ): Promise<PersonSettingsReassignResult> {
    const from = fromPersonKey.trim();
    const to = toPersonKey.trim();
    if (!from || !to || from === to) {
      return { migratedPreferences: 0, migratedConsents: 0 };
    }
    let migratedPreferences = 0;
    let migratedConsents = 0;

    const sourcePreferences = await this.preferences.get(from);
    if (sourcePreferences) {
      const targetPreferences = await this.preferences.get(to);
      await this.preferences.upsert(
        targetPreferences
          ? mergePreferences(targetPreferences, sourcePreferences, to, this.now())
          : { ...sourcePreferences, personKey: to },
      );
      await this.preferences.remove(from);
      migratedPreferences = 1;
    }

    const sourceConsent = await this.consents.get(from);
    if (sourceConsent) {
      const targetConsent = await this.consents.get(to);
      await this.consents.upsert(
        targetConsent
          ? mergeConsents(targetConsent, sourceConsent, to, this.now())
          : { ...sourceConsent, personKey: to },
      );
      await this.consents.remove(from);
      migratedConsents = 1;
    }

    return { migratedPreferences, migratedConsents };
  }

  public async getPreferences(personKey: string): Promise<PersonPreferences> {
    return (
      (await this.preferences.get(personKey)) ??
      defaultPreferences(personKey, this.now())
    );
  }

  public async listPreferences(): Promise<PersonPreferences[]> {
    return this.preferences.list();
  }

  public async updatePreferences(
    personKey: string,
    input: PersonPreferencesInput,
    actor: string,
  ): Promise<PersonPreferences> {
    const before = await this.getPreferences(personKey);
    return this.preferences.upsert({
      ...before,
      personKey,
      ...(input.replyLength !== undefined
        ? { replyLength: input.replyLength }
        : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.addressAs !== undefined
        ? { addressAs: clip(input.addressAs, ADDRESS_LIMIT) }
        : {}),
      ...(input.extraInstructions !== undefined
        ? {
            extraInstructions: clip(
              input.extraInstructions,
              INSTRUCTIONS_LIMIT,
            ),
          }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedBy: actor,
      updatedAt: this.now(),
    });
  }

  public async getConsent(personKey: string): Promise<PersonMemoryConsent> {
    return (
      (await this.consents.get(personKey)) ??
      defaultMemoryConsent(personKey, this.now())
    );
  }

  public async listConsents(): Promise<PersonMemoryConsent[]> {
    return this.consents.list();
  }

  public async updateConsent(
    personKey: string,
    input: PersonMemoryConsentInput,
    actor: string,
  ): Promise<PersonMemoryConsent> {
    const before = await this.getConsent(personKey);
    const allowed =
      input.allowedConversationIds === undefined
        ? before.allowedConversationIds
        : [
            ...new Set(
              input.allowedConversationIds
                .map((item) => item.trim())
                .filter(Boolean),
            ),
          ].slice(0, ALLOWED_CONVERSATIONS_LIMIT);
    return this.consents.upsert({
      ...before,
      personKey,
      ...(input.groupSharing !== undefined
        ? { groupSharing: input.groupSharing }
        : {}),
      allowedConversationIds: allowed,
      updatedBy: actor,
      updatedAt: this.now(),
    });
  }

  public async resolveGroupMode(
    personKey: string,
    conversationId: string,
  ): Promise<GroupMemorySharing> {
    if (!personKey.trim() || !conversationId.trim()) return 'off';
    const consent = await this.getConsent(personKey);
    if (consent.groupSharing === 'off') return 'off';
    if (
      consent.allowedConversationIds.length > 0 &&
      !consent.allowedConversationIds.includes(conversationId)
    ) {
      return 'off';
    }
    return consent.groupSharing;
  }

  /** 单聊系统提示中的个人偏好；群聊不注入，避免个人设定影响群职责 */
  public async buildPrompt(
    personKey: string,
    conversationType: '1' | '2',
  ): Promise<string | undefined> {
    if (conversationType !== '1' || !personKey.trim()) return undefined;
    const preferences = await this.getPreferences(personKey);
    if (!preferences.enabled) return undefined;
    const lines: string[] = [];
    if (preferences.replyLength !== 'balanced') {
      lines.push(`- ${renderLength(preferences.replyLength)}`);
    }
    const language = renderLanguage(preferences.language);
    if (language) lines.push(`- ${language}`);
    if (preferences.addressAs.trim()) {
      lines.push(`- 称呼这位员工为「${preferences.addressAs.trim()}」。`);
    }
    if (preferences.extraInstructions.trim()) {
      lines.push(`- 额外要求：${preferences.extraInstructions.trim()}`);
    }
    if (lines.length === 0) return undefined;
    return ['【员工个人偏好】', ...lines].join('\n');
  }

  public async handlePreferenceCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    if (message.conversationType !== '1') {
      return '个人偏好只能在单聊中设置，避免把个人设定带进群聊。';
    }
    const [action, ...rest] = args;
    const value = rest.join(' ').trim();
    switch (action?.toLowerCase()) {
      case undefined:
      case 'show':
        return this.formatPreferences(personKey);
      case 'length': {
        if (!isReplyLength(value)) return PREFERENCE_USAGE;
        await this.updatePreferences(personKey, { replyLength: value }, personKey);
        return `回答长度已设为「${value}」。`;
      }
      case 'lang': {
        if (!isPreferenceLanguage(value)) return PREFERENCE_USAGE;
        await this.updatePreferences(personKey, { language: value }, personKey);
        return `回答语言已设为「${value}」。`;
      }
      case 'address':
        await this.updatePreferences(
          personKey,
          { addressAs: value },
          personKey,
        );
        return value ? `已设置称呼：${value}` : '已清除称呼偏好。';
      case 'extra':
        await this.updatePreferences(
          personKey,
          { extraInstructions: value },
          personKey,
        );
        return value ? '已保存补充要求。' : '已清除补充要求。';
      case 'on':
        await this.updatePreferences(personKey, { enabled: true }, personKey);
        return '个人偏好已启用。';
      case 'off':
        await this.updatePreferences(personKey, { enabled: false }, personKey);
        return '个人偏好已停用。';
      case 'reset':
        await this.updatePreferences(
          personKey,
          {
            replyLength: 'balanced',
            language: 'auto',
            addressAs: '',
            extraInstructions: '',
            enabled: true,
          },
          personKey,
        );
        return '个人偏好已恢复默认。';
      default:
        return PREFERENCE_USAGE;
    }
  }

  public async handleConsentCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    if (message.conversationType !== '1') {
      return '跨群记忆授权只能在单聊中设置。';
    }
    const [action, value, ...rest] = args;
    switch (action?.toLowerCase()) {
      case undefined:
      case 'show':
        return this.formatConsent(personKey);
      case 'groups': {
        if (!isGroupMemorySharing(value ?? '')) return PRIVACY_USAGE;
        await this.updateConsent(
          personKey,
          { groupSharing: value as GroupMemorySharing },
          personKey,
        );
        return `群聊个人记忆使用范围已设为「${value}」。`;
      }
      case 'allow': {
        if (!value?.trim()) return PRIVACY_USAGE;
        const consent = await this.getConsent(personKey);
        if (consent.allowedConversationIds.includes(value.trim())) {
          return `群 ${value.trim()} 已在白名单中。`;
        }
        await this.updateConsent(
          personKey,
          {
            allowedConversationIds: [
              ...consent.allowedConversationIds,
              value.trim(),
            ],
          },
          personKey,
        );
        return `已加入白名单：${value.trim()}`;
      }
      case 'deny': {
        if (!value?.trim()) return PRIVACY_USAGE;
        const consent = await this.getConsent(personKey);
        await this.updateConsent(
          personKey,
          {
            allowedConversationIds: consent.allowedConversationIds.filter(
              (item) => item !== value.trim(),
            ),
          },
          personKey,
        );
        return `已移出白名单：${value.trim()}`;
      }
      case 'clear':
        await this.updateConsent(
          personKey,
          { allowedConversationIds: [] },
          personKey,
        );
        return '已清除群白名单，所有群按当前档位生效。';
      default:
        return [
          PRIVACY_USAGE,
          ...(rest.length > 0 ? ['', `未识别的参数：${rest.join(' ')}`] : []),
        ].join('\n');
    }
  }

  private async formatPreferences(personKey: string): Promise<string> {
    const preferences = await this.getPreferences(personKey);
    return [
      `个人偏好（${preferences.enabled ? '已启用' : '已停用'}）：`,
      `- 回答长度：${preferences.replyLength}`,
      `- 回答语言：${preferences.language}`,
      `- 称呼：${preferences.addressAs || '未设置'}`,
      `- 补充要求：${preferences.extraInstructions || '无'}`,
    ].join('\n');
  }

  private async formatConsent(personKey: string): Promise<string> {
    const consent = await this.getConsent(personKey);
    return [
      '跨群记忆授权：',
      `- 群聊使用档位：${consent.groupSharing}`,
      `- 生效群白名单：${
        consent.allowedConversationIds.length > 0
          ? consent.allowedConversationIds.join('、')
          : '全部群'
      }`,
    ].join('\n');
  }
}
