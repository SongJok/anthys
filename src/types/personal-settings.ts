/** 员工个人偏好与跨群记忆授权。 */

export type ReplyLength = 'concise' | 'balanced' | 'detailed';
export type PreferenceLanguage = 'auto' | 'zh' | 'en';

export const REPLY_LENGTHS: readonly ReplyLength[] = [
  'concise',
  'balanced',
  'detailed',
];
export const PREFERENCE_LANGUAGES: readonly PreferenceLanguage[] = [
  'auto',
  'zh',
  'en',
];

/** 用户级记忆在群聊中的共享档位 */
export type GroupMemorySharing = 'off' | 'shareable' | 'all';

export const GROUP_MEMORY_SHARING_MODES: readonly GroupMemorySharing[] = [
  'off',
  'shareable',
  'all',
];

export function isReplyLength(value: string): value is ReplyLength {
  return (REPLY_LENGTHS as readonly string[]).includes(value);
}

export function isPreferenceLanguage(
  value: string,
): value is PreferenceLanguage {
  return (PREFERENCE_LANGUAGES as readonly string[]).includes(value);
}

export function isGroupMemorySharing(
  value: string,
): value is GroupMemorySharing {
  return (GROUP_MEMORY_SHARING_MODES as readonly string[]).includes(value);
}

export interface PersonPreferences {
  personKey: string;
  replyLength: ReplyLength;
  language: PreferenceLanguage;
  /** 单聊中希望机器人如何称呼自己 */
  addressAs: string;
  /** 单聊中额外的回答要求 */
  extraInstructions: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: number;
}

export interface PersonPreferencesInput {
  replyLength?: ReplyLength;
  language?: PreferenceLanguage;
  addressAs?: string;
  extraInstructions?: string;
  enabled?: boolean;
}

export interface PersonMemoryConsent {
  personKey: string;
  /**
   * off：任何群聊都不召回个人语义记忆；
   * shareable：只召回显式标记可共享的条目（默认）；
   * all：召回全部非敏感个人记忆。
   */
  groupSharing: GroupMemorySharing;
  /** 非空时只在这些群会话内生效 */
  allowedConversationIds: string[];
  updatedBy: string;
  updatedAt: number;
}

export interface PersonMemoryConsentInput {
  groupSharing?: GroupMemorySharing;
  allowedConversationIds?: string[];
}

export interface PersonPreferencesStore {
  get(personKey: string): Promise<PersonPreferences | null>;
  list(): Promise<PersonPreferences[]>;
  upsert(preferences: PersonPreferences): Promise<PersonPreferences>;
  remove(personKey: string): Promise<void>;
}

export interface PersonMemoryConsentStore {
  get(personKey: string): Promise<PersonMemoryConsent | null>;
  list(): Promise<PersonMemoryConsent[]>;
  upsert(consent: PersonMemoryConsent): Promise<PersonMemoryConsent>;
  remove(personKey: string): Promise<void>;
}

export interface PersonSettingsReassignResult {
  migratedPreferences: number;
  migratedConsents: number;
}

/** 身份合并时把个人偏好与记忆授权迁到新的 personKey */
export interface PersonSettingsReassignPort {
  reassignPersonKey(
    fromPersonKey: string,
    toPersonKey: string,
  ): Promise<PersonSettingsReassignResult>;
}

/** AgentHarness 在群聊召回个人记忆前解析授权档位 */
export interface PersonMemoryConsentResolver {
  resolveGroupMode(
    personKey: string,
    conversationId: string,
  ): Promise<GroupMemorySharing>;
}

export interface PersonSettingsAdminPort {
  listPreferences(): Promise<PersonPreferences[]>;
  getPreferences(personKey: string): Promise<PersonPreferences>;
  updatePreferences(
    personKey: string,
    input: PersonPreferencesInput,
    actor: string,
  ): Promise<PersonPreferences>;
  listConsents(): Promise<PersonMemoryConsent[]>;
  getConsent(personKey: string): Promise<PersonMemoryConsent>;
  updateConsent(
    personKey: string,
    input: PersonMemoryConsentInput,
    actor: string,
  ): Promise<PersonMemoryConsent>;
}
