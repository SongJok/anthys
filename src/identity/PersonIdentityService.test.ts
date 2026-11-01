import { describe, expect, it } from 'vitest';
import { PersonIdentityService } from './PersonIdentityService.js';
import type { InboundMessage } from '../types/core.js';
import type {
  PersonIdentityAliasRecord,
  PersonIdentityAliasSource,
  PersonIdentityRecord,
  PersonIdentityStore,
  PersonaProfileStore,
} from '../types/persona-and-identity.js';
import type { SemanticMemoryAdminPort } from '../types/bystander-and-memory.js';

const NOW = new Date('2026-11-01T10:00:00Z').getTime();

class FakeIdentityStore implements PersonIdentityStore {
  public readonly people = new Map<string, PersonIdentityRecord>();
  public readonly aliases = new Map<string, PersonIdentityAliasRecord>();

  public async findPersonByAlias(alias: string): Promise<{
    personKey: string;
    displayName: string;
    mergedInto: string | null;
  } | null> {
    const row = this.aliases.get(alias);
    if (!row) return null;
    const person = this.people.get(row.personKey);
    return {
      personKey: row.personKey,
      displayName: person?.displayName || row.displayName,
      mergedInto: person?.mergedInto ?? null,
    };
  }

  public async ensurePerson(input: {
    personKey: string;
    displayName?: string;
  }): Promise<void> {
    const existing = this.people.get(input.personKey);
    if (!existing) {
      this.people.set(input.personKey, {
        personKey: input.personKey,
        displayName: input.displayName?.trim() ?? '',
        aliases: [],
        mergedInto: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      return;
    }
    if (!existing.displayName && input.displayName?.trim()) {
      existing.displayName = input.displayName.trim();
      existing.updatedAt = NOW;
    }
  }

  public async upsertAlias(input: {
    alias: string;
    personKey: string;
    source: PersonIdentityAliasSource;
    displayName?: string;
  }): Promise<void> {
    await this.ensurePerson({
      personKey: input.personKey,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    const existing = this.aliases.get(input.alias);
    if (!existing) {
      this.aliases.set(input.alias, {
        alias: input.alias,
        personKey: input.personKey,
        source: input.source,
        displayName: input.displayName?.trim() ?? '',
        updatedAt: NOW,
      });
      return;
    }
    if (existing.personKey === input.personKey && input.displayName?.trim()) {
      existing.displayName = input.displayName.trim();
      existing.updatedAt = NOW;
    }
  }

  public async getPerson(
    personKey: string,
  ): Promise<PersonIdentityRecord | null> {
    const person = this.people.get(personKey);
    if (!person) return null;
    return {
      ...person,
      aliases: [...this.aliases.values()].filter(
        (alias) => alias.personKey === personKey,
      ),
    };
  }

  public async listPeopleMergedInto(personKey: string): Promise<string[]> {
    return [...this.people.values()]
      .filter((person) => person.mergedInto === personKey)
      .map((person) => person.personKey);
  }

  public async listPeople(input: {
    query?: string;
    limit?: number;
  } = {}): Promise<PersonIdentityRecord[]> {
    const query = input.query?.trim().toLowerCase() ?? '';
    const records = [...this.people.keys()]
      .map((key) => this.people.get(key)!)
      .filter((person) => {
        if (!query) return true;
        return [person.personKey, person.displayName].some((value) =>
          value.toLowerCase().includes(query),
        );
      });
    return records
      .slice(0, input.limit ?? 200)
      .map((person) => ({ ...person }));
  }

  public async bindAlias(input: {
    alias: string;
    personKey: string;
    displayName?: string;
  }): Promise<{ previousPersonKey: string | null }> {
    await this.ensurePerson({
      personKey: input.personKey,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    const existing = this.aliases.get(input.alias);
    const previousPersonKey =
      existing && existing.personKey !== input.personKey
        ? existing.personKey
        : null;
    this.aliases.set(input.alias, {
      alias: input.alias,
      personKey: input.personKey,
      source: 'manual',
      displayName: input.displayName?.trim() ?? existing?.displayName ?? '',
      updatedAt: NOW,
    });
    if (previousPersonKey) {
      const previous = this.people.get(previousPersonKey);
      if (previous) previous.mergedInto = input.personKey;
    }
    return { previousPersonKey };
  }

  public addPerson(
    personKey: string,
    fields: {
      displayName?: string;
      mergedInto?: string | null;
      alias?: { alias: string; source: PersonIdentityAliasSource };
    } = {},
  ): void {
    this.people.set(personKey, {
      personKey,
      displayName: fields.displayName ?? '',
      aliases: [],
      mergedInto: fields.mergedInto ?? null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (fields.alias) {
      this.aliases.set(fields.alias.alias, {
        alias: fields.alias.alias,
        personKey,
        source: fields.alias.source,
        displayName: fields.displayName ?? '',
        updatedAt: NOW,
      });
    }
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `m-${Math.random().toString(16).slice(2)}`,
    conversationId: 'cid-group',
    conversationType: '2',
    senderStaffId: 'open-1',
    senderNick: '张三',
    isAtBot: false,
    text: '你好',
    rawPayload: {},
    timestamp: NOW,
    ...overrides,
  };
}

function createService(options: {
  store: FakeIdentityStore;
  memories?: Pick<SemanticMemoryAdminPort, 'reassignSubjectKey'>;
  personas?: Pick<PersonaProfileStore, 'reassignSubjectKey'>;
  onBind?: (input: { personKey: string; previousPersonKey: string | null }) => void;
}) {
  return new PersonIdentityService({
    store: options.store,
    ...(options.memories ? { memories: options.memories } : {}),
    ...(options.personas ? { personas: options.personas } : {}),
    ...(options.onBind ? { onBind: options.onBind } : {}),
    now: () => NOW,
    cacheTtlMs: 60_000,
    logger: { info() {}, warn() {} },
  });
}

describe('PersonIdentityService', () => {
  it('首次登记时把 staffId 与 openDingTalkId 归到同一个 personKey', async () => {
    const store = new FakeIdentityStore();
    const service = createService({ store });

    const first = await service.resolve(
      message({
        senderStaffId: 'staff-1',
        rawPayload: {
          senderStaffId: 'staff-1',
          senderOpenDingTalkId: 'open-1',
        },
      }),
    );
    expect(first).toMatchObject({
      personKey: 'staff:staff-1',
      alias: 'staff:staff-1',
      source: 'staff',
      bound: false,
      displayName: '张三',
    });
    expect(store.aliases.get('staff:staff-1')?.personKey).toBe('staff:staff-1');
    expect(store.aliases.get('open:open-1')?.personKey).toBe('staff:staff-1');

    const viaOpenId = await service.resolve(
      message({
        senderStaffId: 'open-1',
        rawPayload: { senderOpenDingTalkId: 'open-1' },
      }),
    );
    expect(viaOpenId).toMatchObject({
      personKey: 'staff:staff-1',
      alias: 'open:open-1',
      source: 'open',
      bound: true,
    });
  });

  it('首次解析时把旧版本原始 ID 归属的记忆迁到 personKey', async () => {
    const store = new FakeIdentityStore();
    const memoryMoves: Array<[string, string]> = [];
    const service = createService({
      store,
      memories: {
        async reassignSubjectKey(from, to) {
          memoryMoves.push([from, to]);
          return 1;
        },
      },
    });

    await service.resolve(
      message({
        senderStaffId: '0135',
        rawPayload: { senderStaffId: '0135' },
      }),
    );
    await service.resolve(
      message({
        senderStaffId: '0135',
        rawPayload: { senderStaffId: '0135' },
      }),
    );

    expect(memoryMoves).toEqual([['0135', 'staff:0135']]);
  });

  it('未绑定的 openDingTalkId 保持隔离，不会误并到其他员工', async () => {
    const store = new FakeIdentityStore();
    const service = createService({ store });

    const first = await service.resolve(
      message({
        senderStaffId: 'open-2',
        rawPayload: { senderOpenDingTalkId: 'open-2' },
      }),
    );
    expect(first).toMatchObject({
      personKey: 'external:open-2',
      source: 'open',
      bound: false,
    });

    const other = await service.resolve(
      message({
        senderStaffId: 'open-3',
        rawPayload: { senderOpenDingTalkId: 'open-3' },
      }),
    );
    expect(other.personKey).toBe('external:open-3');
    expect(store.aliases.get('open:open-2')?.personKey).toBe('external:open-2');
    expect(store.aliases.get('open:open-3')?.personKey).toBe('external:open-3');
  });

  it('绑定身份后迁移旧 personKey 下的记忆与人设，并清空解析缓存', async () => {
    const store = new FakeIdentityStore();
    const memoryMoves: Array<[string, string]> = [];
    const personaMoves: Array<[string, string, string]> = [];
    const bindEvents: Array<{ personKey: string; previousPersonKey: string | null }> = [];
    const service = createService({
      store,
      memories: {
        async reassignSubjectKey(from, to) {
          memoryMoves.push([from, to]);
          return 2;
        },
      },
      personas: {
        async reassignSubjectKey(scope, from, to) {
          personaMoves.push([scope, from, to]);
          return 1;
        },
      },
      onBind: (input) => bindEvents.push(input),
    });

    await service.resolve(
      message({
        senderStaffId: 'open-2',
        rawPayload: { senderOpenDingTalkId: 'open-2' },
      }),
    );
    memoryMoves.length = 0;
    const outcome = await service.bind({ alias: 'open:open-2', staffId: 'staff-2' });

    expect(outcome).toEqual({
      personKey: 'staff:staff-2',
      previousPersonKey: 'external:open-2',
      migratedMemories: 2,
      migratedPersonas: 1,
    });
    expect(memoryMoves).toEqual([['external:open-2', 'staff:staff-2']]);
    expect(personaMoves).toEqual([
      ['user', 'external:open-2', 'staff:staff-2'],
    ]);
    expect(bindEvents).toEqual([
      { personKey: 'staff:staff-2', previousPersonKey: 'external:open-2' },
    ]);
    expect(store.people.get('external:open-2')?.mergedInto).toBe('staff:staff-2');

    const afterBind = await service.resolve(
      message({
        senderStaffId: 'open-2',
        rawPayload: { senderOpenDingTalkId: 'open-2' },
      }),
    );
    expect(afterBind.personKey).toBe('staff:staff-2');
    expect(afterBind.bound).toBe(true);
  });

  it('mergeMemories=false 时只改别名归属，不迁移历史数据', async () => {
    const store = new FakeIdentityStore();
    const memoryMoves: string[] = [];
    const service = createService({
      store,
      memories: {
        async reassignSubjectKey(from) {
          memoryMoves.push(from);
          return 1;
        },
      },
    });

    await service.resolve(
      message({
        senderStaffId: 'open-6',
        rawPayload: { senderOpenDingTalkId: 'open-6' },
      }),
    );
    memoryMoves.length = 0;
    const outcome = await service.bind({
      alias: 'open:open-6',
      staffId: 'staff-6',
      mergeMemories: false,
    });

    expect(outcome.migratedMemories).toBe(0);
    expect(outcome.migratedPersonas).toBe(0);
    expect(memoryMoves).toEqual([]);
    expect(store.aliases.get('open:open-6')?.personKey).toBe('staff:staff-6');
  });

  it('绑定前先取多级合并链，避免 mergedInto 被改写后漏迁', async () => {
    const store = new FakeIdentityStore();
    store.addPerson('external:open-4', {
      displayName: '旧身份',
      mergedInto: 'external:open-5',
      alias: { alias: 'open:open-4', source: 'open' },
    });
    store.addPerson('external:open-5', {
      displayName: '更早身份',
      alias: { alias: 'open:open-5', source: 'open' },
    });
    const memoryMoves: string[] = [];
    const service = createService({
      store,
      memories: {
        async reassignSubjectKey(from) {
          memoryMoves.push(from);
          return 1;
        },
      },
    });

    const outcome = await service.bind({ alias: 'open:open-4', staffId: 'staff-4' });

    expect(outcome.previousPersonKey).toBe('external:open-4');
    expect(memoryMoves).toEqual(['external:open-4', 'external:open-5']);
    expect(store.people.get('external:open-4')?.mergedInto).toBe('staff:staff-4');
  });

  it('重新绑定旧身份时把已并入它的子孙记忆一并迁移', async () => {
    const store = new FakeIdentityStore();
    store.addPerson('external:leaf', {
      alias: { alias: 'open:leaf', source: 'open' },
      mergedInto: 'external:mid',
    });
    store.addPerson('external:mid', {
      alias: { alias: 'open:mid', source: 'open' },
    });
    const memoryMoves: string[] = [];
    const service = createService({
      store,
      memories: {
        async reassignSubjectKey(from) {
          memoryMoves.push(from);
          return 1;
        },
      },
    });

    const outcome = await service.bind({
      alias: 'open:mid',
      staffId: 'target',
    });

    expect(outcome.previousPersonKey).toBe('external:mid');
    expect(memoryMoves).toEqual(['external:mid', 'external:leaf']);
    expect(store.people.get('external:mid')?.mergedInto).toBe('staff:target');

    const resolved = await service.resolve(
      message({
        senderStaffId: 'leaf',
        rawPayload: { senderOpenDingTalkId: 'leaf' },
      }),
    );
    expect(resolved.personKey).toBe('staff:target');
  });

  it('解析时跟随多级 mergedInto，返回最终 personKey', async () => {
    const store = new FakeIdentityStore();
    store.addPerson('external:a', {
      alias: { alias: 'open:a', source: 'open' },
      mergedInto: 'external:b',
    });
    store.addPerson('external:b', { mergedInto: 'staff:c' });
    store.addPerson('staff:c', { displayName: '最终身份' });
    const service = createService({ store });

    const resolved = await service.resolve(
      message({
        senderStaffId: 'a',
        rawPayload: { senderOpenDingTalkId: 'a' },
      }),
    );
    expect(resolved.personKey).toBe('staff:c');
    expect(resolved.bound).toBe(true);
  });
});
