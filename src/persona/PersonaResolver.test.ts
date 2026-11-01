import { describe, expect, it } from 'vitest';
import { PersonaResolver } from './PersonaResolver.js';
import type {
  PersonaProfileRecord,
  PersonaProfileStore,
  PersonaScope,
} from '../types/persona-and-identity.js';

const NOW = new Date('2026-11-01T10:00:00Z').getTime();

class MemoryPersonaStore implements PersonaProfileStore {
  public readonly records = new Map<string, PersonaProfileRecord>();

  public async list(scope?: PersonaScope): Promise<PersonaProfileRecord[]> {
    return [...this.records.values()]
      .filter((record) => !scope || record.scope === scope)
      .map((record) => ({ ...record }));
  }

  public async get(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<PersonaProfileRecord | null> {
    const record = this.records.get(`${scope}:${subjectKey}`);
    return record ? { ...record } : null;
  }

  public async upsert(
    profile: PersonaProfileRecord,
  ): Promise<PersonaProfileRecord> {
    this.records.set(`${profile.scope}:${profile.subjectKey}`, { ...profile });
    return { ...profile };
  }

  public async remove(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<boolean> {
    return this.records.delete(`${scope}:${subjectKey}`);
  }

  public async reassignSubjectKey(
    scope: PersonaScope,
    from: string,
    to: string,
  ): Promise<number> {
    const source = this.records.get(`${scope}:${from}`);
    if (!source) return 0;
    if (this.records.has(`${scope}:${to}`)) {
      this.records.delete(`${scope}:${from}`);
      return 1;
    }
    this.records.delete(`${scope}:${from}`);
    this.records.set(`${scope}:${to}`, { ...source, subjectKey: to });
    return 1;
  }

  public put(
    scope: PersonaScope,
    subjectKey: string,
    fields: Partial<
      Pick<
        PersonaProfileRecord,
        'name' | 'rolePrompt' | 'speakingStyle' | 'enabled'
      >
    > = {},
  ): PersonaProfileRecord {
    const record: PersonaProfileRecord = {
      scope,
      subjectKey,
      name: fields.name ?? '',
      rolePrompt: fields.rolePrompt ?? '',
      speakingStyle: fields.speakingStyle ?? '',
      enabled: fields.enabled ?? true,
      updatedBy: 'admin',
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.records.set(`${scope}:${subjectKey}`, record);
    return record;
  }
}

function fallback(overrides: Partial<{
  name: string;
  rolePrompt: string;
  speakingStyle: string;
}> = {}) {
  return {
    name: '企业助手',
    rolePrompt: '通用企业问答',
    speakingStyle: '专业',
    ...overrides,
  };
}

describe('PersonaResolver', () => {
  it('没有覆盖配置时使用系统默认人设', async () => {
    const store = new MemoryPersonaStore();
    const resolver = new PersonaResolver({ store, fallback: () => fallback() });

    const result = await resolver.resolve({
      conversationType: '2',
      conversationId: 'cid-1',
      personKey: 'staff:1',
    });

    expect(result).toEqual({
      name: '企业助手',
      rolePrompt: '通用企业问答',
      speakingStyle: '专业',
      source: 'system',
      groupApplied: false,
      userApplied: false,
    });
  });

  it('群聊中群人设覆盖职责，个人人设只调整表达风格', async () => {
    const store = new MemoryPersonaStore();
    store.put('group', 'cid-1', {
      name: '支付群助手',
      rolePrompt: '只回答支付网关与结算问题',
      speakingStyle: '简洁',
    });
    store.put('user', 'staff:1', {
      name: '小王助手',
      rolePrompt: '个人事务助手',
      speakingStyle: '幽默',
    });
    const resolver = new PersonaResolver({ store, fallback: () => fallback() });

    const result = await resolver.resolve({
      conversationType: '2',
      conversationId: 'cid-1',
      personKey: 'staff:1',
    });

    expect(result.name).toBe('支付群助手');
    expect(result.rolePrompt).toBe('只回答支付网关与结算问题');
    expect(result.speakingStyle).toBe('幽默');
    expect(result.source).toBe('group');
    expect(result.groupApplied).toBe(true);
    expect(result.userApplied).toBe(true);
  });

  it('单聊中个人人设整体覆盖系统默认配置', async () => {
    const store = new MemoryPersonaStore();
    store.put('user', 'staff:1', {
      name: '小王助手',
      rolePrompt: '只处理我的个人事务',
      speakingStyle: '轻松',
    });
    const resolver = new PersonaResolver({ store, fallback: () => fallback() });

    const result = await resolver.resolve({
      conversationType: '1',
      conversationId: 'single:staff:1',
      personKey: 'staff:1',
    });

    expect(result).toMatchObject({
      name: '小王助手',
      rolePrompt: '只处理我的个人事务',
      speakingStyle: '轻松',
      source: 'user',
      groupApplied: false,
      userApplied: true,
    });
  });

  it('禁用的人设不生效，空字段回退上一层', async () => {
    const store = new MemoryPersonaStore();
    store.put('group', 'cid-1', {
      rolePrompt: '支付群职责',
      enabled: false,
    });
    store.put('user', 'staff:1', {
      speakingStyle: '幽默',
    });
    const resolver = new PersonaResolver({ store, fallback: () => fallback() });

    const result = await resolver.resolve({
      conversationType: '2',
      conversationId: 'cid-1',
      personKey: 'staff:1',
    });

    expect(result.name).toBe('企业助手');
    expect(result.rolePrompt).toBe('通用企业问答');
    expect(result.speakingStyle).toBe('幽默');
    expect(result.groupApplied).toBe(false);
    expect(result.userApplied).toBe(true);
  });

  it('缓存未失效时沿用旧值，invalidate 后立即读取新配置', async () => {
    const store = new MemoryPersonaStore();
    store.put('group', 'cid-1', { name: '旧名称' });
    const resolver = new PersonaResolver({
      store,
      fallback: () => fallback(),
      cacheTtlMs: 60_000,
      now: () => NOW,
    });

    const first = await resolver.resolve({
      conversationType: '2',
      conversationId: 'cid-1',
      personKey: 'staff:1',
    });
    expect(first.name).toBe('旧名称');

    store.put('group', 'cid-1', { name: '新名称' });
    const cached = await resolver.resolve({
      conversationType: '2',
      conversationId: 'cid-1',
      personKey: 'staff:1',
    });
    expect(cached.name).toBe('旧名称');

    resolver.invalidate('group', 'cid-1');
    const refreshed = await resolver.resolve({
      conversationType: '2',
      conversationId: 'cid-1',
      personKey: 'staff:1',
    });
    expect(refreshed.name).toBe('新名称');
  });

  it('全局默认人设热更新无需失效缓存', async () => {
    const store = new MemoryPersonaStore();
    let current = fallback({ name: '默认一代' });
    const resolver = new PersonaResolver({ store, fallback: () => current });

    expect(
      (
        await resolver.resolve({
          conversationType: '1',
          conversationId: 'single:staff:1',
          personKey: 'staff:1',
        })
      ).name,
    ).toBe('默认一代');

    current = fallback({ name: '默认二代' });
    expect(
      (
        await resolver.resolve({
          conversationType: '1',
          conversationId: 'single:staff:1',
          personKey: 'staff:1',
        })
      ).name,
    ).toBe('默认二代');
  });
});
