/** 人设分层与员工身份归一的公共契约。 */

import type { InboundMessage } from './core.js';

export interface PersonaProfileFields {
  name: string;
  rolePrompt: string;
  speakingStyle: string;
}

export type PersonaScope = 'group' | 'user';

export interface PersonaProfileRecord extends PersonaProfileFields {
  scope: PersonaScope;
  /** 群会话 ID 或 canonical personKey */
  subjectKey: string;
  enabled: boolean;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaProfileInput {
  name?: string;
  rolePrompt?: string;
  speakingStyle?: string;
  enabled?: boolean;
}

export interface ResolvedPersona extends PersonaProfileFields {
  source: 'system' | 'group' | 'user';
  groupApplied: boolean;
  userApplied: boolean;
}

export interface PersonaProfileStore {
  list(scope?: PersonaScope): Promise<PersonaProfileRecord[]>;
  get(scope: PersonaScope, subjectKey: string): Promise<PersonaProfileRecord | null>;
  upsert(profile: PersonaProfileRecord): Promise<PersonaProfileRecord>;
  remove(scope: PersonaScope, subjectKey: string): Promise<boolean>;
  reassignSubjectKey(
    scope: PersonaScope,
    from: string,
    to: string,
  ): Promise<number>;
}

export interface PersonaAdminPort {
  list(scope?: PersonaScope): Promise<PersonaProfileRecord[]>;
  get(scope: PersonaScope, subjectKey: string): Promise<PersonaProfileRecord | null>;
  upsert(
    scope: PersonaScope,
    subjectKey: string,
    input: PersonaProfileInput,
    actor: string,
  ): Promise<PersonaProfileRecord>;
  remove(scope: PersonaScope, subjectKey: string): Promise<boolean>;
}

export type PersonIdentityAliasSource = 'staff' | 'open' | 'external' | 'manual';

export interface PersonIdentityAliasRecord {
  alias: string;
  personKey: string;
  source: PersonIdentityAliasSource;
  displayName: string;
  updatedAt: number;
}

export interface PersonIdentityRecord {
  personKey: string;
  displayName: string;
  aliases: PersonIdentityAliasRecord[];
  mergedInto: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedPersonIdentity {
  personKey: string;
  displayName: string;
  /** 本轮消息命中的主别名 */
  alias: string;
  source: PersonIdentityAliasSource;
  /** 是否命中已有绑定（false 表示首次登记，可能需要管理员绑定其他 ID） */
  bound: boolean;
}

export interface PersonIdentityStore {
  findPersonByAlias(alias: string): Promise<{
    personKey: string;
    displayName: string;
    mergedInto: string | null;
  } | null>;
  ensurePerson(input: {
    personKey: string;
    displayName?: string;
  }): Promise<void>;
  upsertAlias(input: {
    alias: string;
    personKey: string;
    source: PersonIdentityAliasSource;
    displayName?: string;
  }): Promise<void>;
  getPerson(personKey: string): Promise<PersonIdentityRecord | null>;
  /** 已被并入该 personKey 的旧身份，用于多级合并时追溯子孙记录 */
  listPeopleMergedInto(personKey: string): Promise<string[]>;
  listPeople(input?: {
    query?: string;
    limit?: number;
  }): Promise<PersonIdentityRecord[]>;
  bindAlias(input: {
    alias: string;
    personKey: string;
    displayName?: string;
  }): Promise<{ previousPersonKey: string | null }>;
}

export interface PersonIdentityAdminPort {
  list(query?: string): Promise<PersonIdentityRecord[]>;
  bind(input: {
    alias: string;
    source?: PersonIdentityAliasSource;
    personKey?: string;
    staffId?: string;
    displayName?: string;
    mergeMemories?: boolean;
  }): Promise<{
    personKey: string;
    previousPersonKey: string | null;
    migratedMemories: number;
    migratedPersonas: number;
  }>;
}

export interface PersonIdentityResolver {
  resolve(message: InboundMessage): Promise<ResolvedPersonIdentity>;
}
