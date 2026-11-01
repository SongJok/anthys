import { describe, expect, it } from 'vitest';
import { createAdminApp } from './server.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type {
  GroupDirectory,
  ReActTracePage,
  ReActTraceQuery,
  ReActTraceRecord,
  ReActTraceStore,
  TraceDailyStats,
} from '../types/admin-and-console.js';
import type {
  PersonIdentityAdminPort,
  PersonIdentityRecord,
  PersonaAdminPort,
  PersonaProfileInput,
  PersonaProfileRecord,
  PersonaScope,
} from '../types/persona-and-identity.js';
import type {
  SemanticMemoryAdminFilter,
  SemanticMemoryAdminPort,
  SemanticMemoryPatch,
  SemanticMemoryRecord,
} from '../types/bystander-and-memory.js';

const TOKEN = 'test-token';
const NOW = new Date('2026-11-01T10:00:00Z').getTime();

class FakeCenter {
  public readonly audits: Array<Record<string, unknown>> = [];
  public async recordAudit(input: Record<string, unknown>): Promise<void> {
    this.audits.push(input);
  }
}

class FakeTraces implements ReActTraceStore {
  public async append(_record: ReActTraceRecord): Promise<void> {}
  public async query(input: ReActTraceQuery): Promise<ReActTracePage> {
    return {
      items: [],
      total: 0,
      page: input.page,
      pageSize: input.pageSize,
    };
  }
  public async dailyStats(): Promise<TraceDailyStats> {
    return { totalTokens: 0, totalTurns: 0, byGroup: [] };
  }
}

const groups: GroupDirectory = {
  async listGroups() {
    return [];
  },
};

class FakePersonas implements PersonaAdminPort {
  public readonly records = new Map<string, PersonaProfileRecord>();

  public async list(scope?: PersonaScope): Promise<PersonaProfileRecord[]> {
    return [...this.records.values()].filter(
      (record) => !scope || record.scope === scope,
    );
  }

  public async get(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<PersonaProfileRecord | null> {
    return this.records.get(`${scope}:${subjectKey}`) ?? null;
  }

  public async upsert(
    scope: PersonaScope,
    subjectKey: string,
    input: PersonaProfileInput,
    actor: string,
  ): Promise<PersonaProfileRecord> {
    const before = this.records.get(`${scope}:${subjectKey}`);
    const record: PersonaProfileRecord = {
      scope,
      subjectKey,
      name: input.name ?? before?.name ?? '',
      rolePrompt: input.rolePrompt ?? before?.rolePrompt ?? '',
      speakingStyle: input.speakingStyle ?? before?.speakingStyle ?? '',
      enabled: input.enabled ?? before?.enabled ?? true,
      updatedBy: actor,
      createdAt: before?.createdAt ?? NOW,
      updatedAt: NOW,
    };
    this.records.set(`${scope}:${subjectKey}`, record);
    return record;
  }

  public async remove(
    scope: PersonaScope,
    subjectKey: string,
  ): Promise<boolean> {
    return this.records.delete(`${scope}:${subjectKey}`);
  }
}

class FakeIdentities implements PersonIdentityAdminPort {
  public readonly people: PersonIdentityRecord[] = [
    {
      personKey: 'staff:staff-1',
      displayName: '张三',
      aliases: [],
      mergedInto: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  public lastBind: Parameters<PersonIdentityAdminPort['bind']>[0] | null = null;

  public async list(query?: string): Promise<PersonIdentityRecord[]> {
    if (!query) return this.people;
    return this.people.filter((person) =>
      `${person.personKey}${person.displayName}`.includes(query),
    );
  }

  public async bind(
    input: Parameters<PersonIdentityAdminPort['bind']>[0],
  ): Promise<Awaited<ReturnType<PersonIdentityAdminPort['bind']>>> {
    this.lastBind = input;
    return {
      personKey: `staff:${input.staffId ?? 'unknown'}`,
      previousPersonKey: 'external:open-abc',
      migratedMemories: 2,
      migratedPersonas: 1,
    };
  }
}

function memoryRecord(
  overrides: Partial<SemanticMemoryRecord> = {},
): SemanticMemoryRecord {
  return {
    id: 'memory-1',
    scope: 'user',
    subjectKey: 'staff:staff-1',
    kind: 'profile',
    content: '张三负责支付网关研发',
    keywords: ['支付网关'],
    embedding: [0.1, 0.2],
    shareableInGroup: false,
    sensitivity: 'private',
    status: 'active',
    sourceConversationId: 'single:staff:staff-1',
    sourceConversationType: '1',
    sourceMessageId: 'm-1',
    confidence: 0.8,
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeMemories implements SemanticMemoryAdminPort {
  public readonly items: SemanticMemoryRecord[] = [
    memoryRecord(),
    memoryRecord({
      id: 'memory-2',
      scope: 'group',
      subjectKey: 'cid-1',
      kind: 'terminology',
      content: 'GMV 指商品交易总额',
      shareableInGroup: true,
      sensitivity: 'normal',
    }),
  ];
  public lastFilter: SemanticMemoryAdminFilter | null = null;

  public async list(filter: SemanticMemoryAdminFilter): Promise<{
    total: number;
    items: SemanticMemoryRecord[];
  }> {
    this.lastFilter = filter;
    const query = filter.query?.toLowerCase() ?? '';
    const filtered = this.items.filter((item) => {
      if (filter.scope && item.scope !== filter.scope) return false;
      if (filter.kind && item.kind !== filter.kind) return false;
      if (filter.status && item.status !== filter.status) return false;
      if (filter.subjectKey && item.subjectKey !== filter.subjectKey) return false;
      if (query && !item.content.toLowerCase().includes(query)) return false;
      return true;
    });
    const offset = filter.offset ?? 0;
    return {
      total: filtered.length,
      items: filtered.slice(offset, offset + (filter.limit ?? 50)),
    };
  }

  public async get(id: string): Promise<SemanticMemoryRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  public async update(
    id: string,
    patch: SemanticMemoryPatch,
  ): Promise<SemanticMemoryRecord> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('未找到语义记忆');
    const next = {
      ...this.items[index]!,
      ...patch,
      embedding: patch.content !== undefined ? null : this.items[index]!.embedding,
      updatedAt: NOW,
    };
    this.items[index] = next;
    return next;
  }

  public async remove(id: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  public async reassignSubjectKey(_from: string, _to: string): Promise<number> {
    return 0;
  }
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'x-admin-staff-id': 'admin-001',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(response: Response): Promise<any> {
  return await response.json();
}

function setup() {
  const center = new FakeCenter();
  const personas = new FakePersonas();
  const identities = new FakeIdentities();
  const memories = new FakeMemories();
  const app = createAdminApp({
    configCenter: center as unknown as DynamicConfigCenter,
    traces: new FakeTraces(),
    groups,
    mcp: {
      status: () => [],
      applyServers: async () => undefined,
    },
    authToken: TOKEN,
    personas,
    identities,
    memories,
    now: () => NOW,
  });
  return { app, center, personas, identities, memories };
}

describe('人设分层管理接口', () => {
  it('按作用域增删改查，个人 subjectKey 自动归一为 staff 别名', async () => {
    const { app, center, personas } = setup();

    const created = await app.request('/api/v1/admin/personas/group/cid-1', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        name: '支付群助手',
        rolePrompt: '只回答支付网关与结算问题',
        speakingStyle: '简洁',
      }),
    });
    expect(created.status).toBe(200);
    expect((await body(created)).profile).toMatchObject({
      scope: 'group',
      subjectKey: 'cid-1',
      name: '支付群助手',
      enabled: true,
      updatedBy: 'admin-001',
    });

    const user = await app.request('/api/v1/admin/personas/user/staff-1', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ name: '张三助手', speakingStyle: '轻松' }),
    });
    expect(user.status).toBe(200);
    expect((await body(user)).profile.subjectKey).toBe('staff:staff-1');
    expect(personas.records.has('user:staff:staff-1')).toBe(true);

    const listed = await app.request(
      '/api/v1/admin/personas?scope=group',
      { headers: headers() },
    );
    const listedBody = await body(listed);
    expect(listedBody.profiles).toHaveLength(1);
    expect(listedBody.profiles[0].subjectKey).toBe('cid-1');

    const empty = await app.request('/api/v1/admin/personas/group/cid-2', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(empty.status).toBe(400);

    const removed = await app.request('/api/v1/admin/personas/group/cid-1', {
      method: 'DELETE',
      headers: headers(),
    });
    expect(removed.status).toBe(200);
    expect((await body(removed)).removed).toBe(true);

    expect(
      center.audits.some((entry) => entry.actionType === 'UPDATE_PERSONA'),
    ).toBe(true);
    expect(
      center.audits.some((entry) => entry.actionType === 'DELETE_PERSONA'),
    ).toBe(true);
  });

  it('拒绝非法作用域', async () => {
    const { app } = setup();
    const response = await app.request('/api/v1/admin/personas/team/staff-1', {
      headers: headers(),
    });
    expect(response.status).toBe(400);
  });
});

describe('身份绑定管理接口', () => {
  it('绑定别名并返回迁移数量', async () => {
    const { app, center, identities } = setup();

    const listed = await app.request(
      '/api/v1/admin/identities?query=张三',
      { headers: headers() },
    );
    expect(listed.status).toBe(200);
    expect((await body(listed)).people).toHaveLength(1);

    const bind = await app.request('/api/v1/admin/identities/bind', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        alias: 'open:open-abc',
        staffId: 'staff-1',
        displayName: '张三',
        mergeMemories: false,
      }),
    });
    expect(bind.status).toBe(200);
    expect((await body(bind))).toMatchObject({
      personKey: 'staff:staff-1',
      previousPersonKey: 'external:open-abc',
      migratedMemories: 2,
      migratedPersonas: 1,
    });
    expect(identities.lastBind).toMatchObject({
      alias: 'open:open-abc',
      staffId: 'staff-1',
      displayName: '张三',
      mergeMemories: false,
    });
    expect(
      center.audits.some((entry) => entry.actionType === 'BIND_PERSON_IDENTITY'),
    ).toBe(true);
  });

  it('缺少目标员工或非法 source 时返回 400', async () => {
    const { app } = setup();
    const missingTarget = await app.request('/api/v1/admin/identities/bind', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ alias: 'open:open-abc' }),
    });
    expect(missingTarget.status).toBe(400);

    const invalidSource = await app.request('/api/v1/admin/identities/bind', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        alias: 'open:open-abc',
        staffId: 'staff-1',
        source: 'robot',
      }),
    });
    expect(invalidSource.status).toBe(400);
  });
});

describe('语义记忆治理接口', () => {
  it('按作用域与关键词筛选，并修订治理字段', async () => {
    const { app, center, memories } = setup();

    const listed = await app.request(
      '/api/v1/admin/memories?scope=user&query=支付&limit=10',
      { headers: headers() },
    );
    expect(listed.status).toBe(200);
    const listedBody = await body(listed);
    expect(listedBody.total).toBe(1);
    expect(listedBody.items[0].id).toBe('memory-1');
    expect(memories.lastFilter).toMatchObject({
      scope: 'user',
      query: '支付',
      limit: 10,
      offset: 0,
    });

    const expiresAt = NOW + 86_400_000;
    const updated = await app.request('/api/v1/admin/memories/memory-1', {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        content: '张三负责支付网关与结算研发',
        shareableInGroup: true,
        sensitivity: 'normal',
        status: 'retired',
        confidence: 0.95,
        expiresAt,
      }),
    });
    expect(updated.status).toBe(200);
    expect((await body(updated)).memory).toMatchObject({
      content: '张三负责支付网关与结算研发',
      shareableInGroup: true,
      sensitivity: 'normal',
      status: 'retired',
      confidence: 0.95,
      expiresAt,
      embedding: null,
    });

    expect(
      center.audits.some(
        (entry) => entry.actionType === 'UPDATE_SEMANTIC_MEMORY',
      ),
    ).toBe(true);
  });

  it('非法枚举、置信度与缺失记忆被拒绝', async () => {
    const { app } = setup();

    const invalidScope = await app.request(
      '/api/v1/admin/memories?scope=org',
      { headers: headers() },
    );
    expect(invalidScope.status).toBe(400);

    const invalidSensitivity = await app.request(
      '/api/v1/admin/memories/memory-1',
      {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ sensitivity: 'secret' }),
      },
    );
    expect(invalidSensitivity.status).toBe(400);

    const invalidConfidence = await app.request(
      '/api/v1/admin/memories/memory-1',
      {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ confidence: 1.5 }),
      },
    );
    expect(invalidConfidence.status).toBe(400);

    const invalidExpiry = await app.request(
      '/api/v1/admin/memories/memory-1',
      {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ expiresAt: 'tomorrow' }),
      },
    );
    expect(invalidExpiry.status).toBe(400);

    const missing = await app.request('/api/v1/admin/memories/none', {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ status: 'retired' }),
    });
    expect(missing.status).toBe(404);
  });

  it('删除记忆并写入审计', async () => {
    const { app, center } = setup();
    const removed = await app.request('/api/v1/admin/memories/memory-2', {
      method: 'DELETE',
      headers: headers(),
    });
    expect(removed.status).toBe(200);
    expect((await body(removed)).removed).toBe(true);
    expect(
      center.audits.some(
        (entry) => entry.actionType === 'DELETE_SEMANTIC_MEMORY',
      ),
    ).toBe(true);
  });
});
