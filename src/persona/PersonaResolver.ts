import type {
  PersonaProfileFields,
  PersonaProfileRecord,
  PersonaProfileStore,
  PersonaScope,
  ResolvedPersona,
} from '../types/persona-and-identity.js';

interface CachedProfile {
  record: PersonaProfileRecord | null;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 人设优先级：
 * - 单聊：个人人设 > 系统默认；
 * - 群聊：群人设（职责/称呼）> 个人说话风格 > 系统默认。
 * 权限与安全约束不在人设覆盖范围内，由工具执行层与固定系统基底单独保证。
 */
export class PersonaResolver {
  private readonly store?: PersonaProfileStore;
  private readonly fallback: () => PersonaProfileFields;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedProfile>();

  constructor(options: {
    store?: PersonaProfileStore;
    fallback: () => PersonaProfileFields;
    cacheTtlMs?: number;
    now?: () => number;
  }) {
    this.store = options.store;
    this.fallback = options.fallback;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  public async resolve(input: {
    conversationType: '1' | '2';
    conversationId: string;
    personKey: string;
  }): Promise<ResolvedPersona> {
    const base = this.fallback();
    const group =
      input.conversationType === '2'
        ? await this.load('group', input.conversationId)
        : null;
    const user = input.personKey
      ? await this.load('user', input.personKey)
      : null;

    let name = nonEmpty(base.name) ?? '企业助手';
    let rolePrompt = base.rolePrompt ?? '';
    let speakingStyle = base.speakingStyle ?? '';
    let groupApplied = false;
    let userApplied = false;

    if (group) {
      const groupName = nonEmpty(group.name);
      const groupRole = nonEmpty(group.rolePrompt);
      const groupStyle = nonEmpty(group.speakingStyle);
      if (groupName) name = groupName;
      if (groupRole) rolePrompt = groupRole;
      if (groupStyle) speakingStyle = groupStyle;
      groupApplied = Boolean(groupName || groupRole || groupStyle);
    }

    if (user) {
      if (input.conversationType === '1') {
        const userName = nonEmpty(user.name);
        const userRole = nonEmpty(user.rolePrompt);
        const userStyle = nonEmpty(user.speakingStyle);
        if (userName) name = userName;
        if (userRole) rolePrompt = userRole;
        if (userStyle) speakingStyle = userStyle;
        userApplied = Boolean(userName || userRole || userStyle);
      } else {
        // 群聊里个人人设只影响表达方式，不覆盖群职责与名称
        const userStyle = nonEmpty(user.speakingStyle);
        if (userStyle) {
          speakingStyle = userStyle;
          userApplied = true;
        }
      }
    }

    return {
      name,
      rolePrompt,
      speakingStyle,
      source: groupApplied ? 'group' : userApplied ? 'user' : 'system',
      groupApplied,
      userApplied,
    };
  }

  public invalidate(scope?: PersonaScope, subjectKey?: string): void {
    if (!scope) {
      this.cache.clear();
      return;
    }
    if (subjectKey) {
      this.cache.delete(`${scope}:${subjectKey}`);
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${scope}:`)) this.cache.delete(key);
    }
  }

  private async load(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<PersonaProfileRecord | null> {
    if (!this.store) return null;
    const cacheKey = `${scope}:${subjectKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.record;
    const record = await this.store.get(scope, subjectKey);
    this.cache.set(cacheKey, {
      record: record?.enabled ? record : null,
      expiresAt: this.now() + this.cacheTtlMs,
    });
    return record?.enabled ? record : null;
  }
}
