import type { InboundMessage } from '../types/core.js';
import type {
  PersonIdentityAliasSource,
  PersonIdentityAdminPort,
  PersonIdentityRecord,
  PersonIdentityResolver,
  PersonIdentityStore,
  PersonaProfileStore,
  ResolvedPersonIdentity,
} from '../types/persona-and-identity.js';
import { isStaffUserId } from '../dingtalk/userIds.js';
import type { SemanticMemoryAdminPort } from '../types/bystander-and-memory.js';

export interface PersonIdentityLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface Candidate {
  alias: string;
  source: PersonIdentityAliasSource;
  displayName: string;
}

interface CachedAlias {
  personKey: string;
  displayName: string;
  mergedInto: string | null;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;

export function staffAlias(staffId: string): string {
  return `staff:${staffId.trim()}`;
}

export function openAlias(openDingTalkId: string): string {
  return `open:${openDingTalkId.trim()}`;
}

export function externalAlias(id: string): string {
  return `external:${id.trim()}`;
}

export function normalizeIdentityAlias(value: string): {
  alias: string;
  source: PersonIdentityAliasSource;
} | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^staff:/u.test(trimmed)) {
    return { alias: trimmed, source: 'staff' };
  }
  if (/^open:/u.test(trimmed)) {
    return { alias: trimmed, source: 'open' };
  }
  if (/^external:/u.test(trimmed)) {
    return { alias: trimmed, source: 'external' };
  }
  if (trimmed.startsWith('$:')) {
    return { alias: externalAlias(trimmed), source: 'external' };
  }
  return { alias: staffAlias(trimmed), source: 'staff' };
}

/** 未接入身份库时的安全回退：员工按 staffId 隔离，外部 ID 按 external 隔离 */
export function defaultPersonKeyFor(message: InboundMessage): string {
  return isStaffUserId(message.senderStaffId)
    ? staffAlias(message.senderStaffId)
    : externalAlias(message.senderStaffId);
}

function readRawString(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function collectCandidates(message: InboundMessage): Candidate[] {
  const raw = message.rawPayload ?? {};
  const rawStaffId = readRawString(raw, ['senderStaffId', 'sender_staff_id']);
  const openDingTalkId = readRawString(raw, [
    'senderOpenDingTalkId',
    'sender_open_dingtalk_id',
    'sender_open_id',
  ]);
  // DWS 事件把 openDingTalkId 塞进 senderStaffId，不能当作真实员工 ID
  const senderLooksLikeOpenId =
    Boolean(openDingTalkId) && message.senderStaffId === openDingTalkId;
  const staffId = rawStaffId && isStaffUserId(rawStaffId)
    ? rawStaffId
    : !senderLooksLikeOpenId && isStaffUserId(message.senderStaffId)
      ? message.senderStaffId
      : undefined;
  const candidates: Candidate[] = [];
  if (staffId) {
    candidates.push({
      alias: staffAlias(staffId),
      source: 'staff',
      displayName: message.senderNick,
    });
  }
  if (openDingTalkId) {
    candidates.push({
      alias: openAlias(openDingTalkId),
      source: 'open',
      displayName: message.senderNick,
    });
  }
  if (candidates.length === 0) {
    candidates.push({
      alias: externalAlias(message.senderStaffId || `message:${message.messageId}`),
      source: 'external',
      displayName: message.senderNick,
    });
  }
  return candidates;
}

/**
 * 把机器人回调的 staffId、DWS 的 openDingTalkId 与外部加密 ID
 * 统一映射为稳定的 personKey。未绑定的 ID 保持隔离，等待管理员绑定。
 */
export class PersonIdentityService
  implements PersonIdentityResolver, PersonIdentityAdminPort
{
  private readonly store: PersonIdentityStore;
  private readonly memories?: Pick<SemanticMemoryAdminPort, 'reassignSubjectKey'>;
  private readonly personas?: Pick<PersonaProfileStore, 'reassignSubjectKey'>;
  private readonly logger?: PersonIdentityLogger;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly onBind?: (input: {
    personKey: string;
    previousPersonKey: string | null;
  }) => void;
  private readonly cache = new Map<string, CachedAlias>();

  constructor(options: {
    store: PersonIdentityStore;
    memories?: Pick<SemanticMemoryAdminPort, 'reassignSubjectKey'>;
    personas?: Pick<PersonaProfileStore, 'reassignSubjectKey'>;
    logger?: PersonIdentityLogger;
    now?: () => number;
    cacheTtlMs?: number;
    onBind?: (input: {
      personKey: string;
      previousPersonKey: string | null;
    }) => void;
  }) {
    this.store = options.store;
    this.memories = options.memories;
    this.personas = options.personas;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.onBind = options.onBind;
  }

  public async resolve(
    message: InboundMessage,
  ): Promise<ResolvedPersonIdentity> {
    const candidates = collectCandidates(message);
    for (const candidate of candidates) {
      const found = await this.lookup(candidate.alias);
      if (!found) continue;
      const personKey = await this.followMerge(found.personKey, found.mergedInto);
      return {
        personKey,
        displayName: found.displayName || candidate.displayName,
        alias: candidate.alias,
        source: candidate.source,
        bound: true,
      };
    }

    const primary = candidates[0]!;
    const personKey =
      primary.source === 'staff'
        ? staffAlias(primary.alias.slice('staff:'.length))
        : externalAlias(primary.alias.replace(/^[^:]+:/u, ''));
    for (const candidate of candidates) {
      await this.store.upsertAlias({
        alias: candidate.alias,
        personKey,
        source: candidate.source,
        ...(candidate.displayName
          ? { displayName: candidate.displayName }
          : {}),
      });
    }
    this.rememberInCache(primary.alias, {
      personKey,
      displayName: primary.displayName,
      mergedInto: null,
    });
    this.logger?.info(
      {
        personKey,
        alias: primary.alias,
        source: primary.source,
        conversationId: message.conversationId,
      },
      'person identity registered',
    );
    return {
      personKey,
      displayName: primary.displayName,
      alias: primary.alias,
      source: primary.source,
      bound: false,
    };
  }

  public async list(query?: string): Promise<PersonIdentityRecord[]> {
    return this.store.listPeople({
      ...(query ? { query } : {}),
      limit: 200,
    });
  }

  public async bind(input: {
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
  }> {
    const normalized = input.source
      ? { alias: input.alias.trim(), source: input.source }
      : normalizeIdentityAlias(input.alias);
    if (!normalized) throw new Error('alias 不能为空');
    const targetPersonKey = input.staffId?.trim()
      ? staffAlias(input.staffId)
      : input.personKey?.trim();
    if (!targetPersonKey) throw new Error('缺少 personKey 或 staffId');
    if (!/^(staff|external):/u.test(targetPersonKey)) {
      throw new Error('personKey 必须以 staff: 或 external: 开头');
    }

    // bindAlias 会把旧身份的 mergedInto 改指向目标，因此必须先取合并链
    const existing = await this.store.findPersonByAlias(normalized.alias);
    const mergeChain =
      existing && existing.personKey !== targetPersonKey && input.mergeMemories !== false
        ? await this.collectMergeChain(existing.personKey)
        : [];

    const outcome = await this.store.bindAlias({
      alias: normalized.alias,
      personKey: targetPersonKey,
      ...(input.displayName?.trim()
        ? { displayName: input.displayName.trim() }
        : {}),
    });
    this.cache.clear();

    let migratedMemories = 0;
    let migratedPersonas = 0;
    if (outcome.previousPersonKey && input.mergeMemories !== false) {
      const keys =
        mergeChain.length > 0
          ? mergeChain
          : [outcome.previousPersonKey];
      for (const oldKey of keys) {
        if (oldKey === targetPersonKey) continue;
        migratedMemories +=
          (await this.memories?.reassignSubjectKey(oldKey, targetPersonKey)) ?? 0;
        migratedPersonas +=
          (await this.personas?.reassignSubjectKey(
            'user',
            oldKey,
            targetPersonKey,
          )) ?? 0;
      }
    }
    this.onBind?.({ personKey: targetPersonKey, previousPersonKey: outcome.previousPersonKey });

    this.logger?.info(
      {
        alias: normalized.alias,
        source: normalized.source,
        personKey: targetPersonKey,
        previousPersonKey: outcome.previousPersonKey,
        migratedMemories,
        migratedPersonas,
      },
      'person identity bound',
    );
    return {
      personKey: targetPersonKey,
      previousPersonKey: outcome.previousPersonKey,
      migratedMemories,
      migratedPersonas,
    };
  }

  private async followMerge(
    personKey: string,
    mergedInto: string | null,
  ): Promise<string> {
    let current = personKey;
    let next = mergedInto;
    for (let hop = 0; next && hop < 5 && next !== current; hop += 1) {
      current = next;
      const person = await this.store.getPerson(current);
      next = person?.mergedInto ?? null;
    }
    return current;
  }

  private async collectMergeChain(start: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = start;
    while (current && chain.length < 5 && !chain.includes(current)) {
      chain.push(current);
      const person = await this.store.getPerson(current);
      current = person?.mergedInto ?? null;
    }
    return chain;
  }

  private async lookup(alias: string): Promise<CachedAlias | null> {
    const cached = this.cache.get(alias);
    if (cached && cached.expiresAt > this.now()) return cached;
    if (cached) this.cache.delete(alias);
    const person = await this.store.findPersonByAlias(alias);
    if (!person) return null;
    return this.rememberInCache(alias, {
      personKey: person.personKey,
      displayName: person.displayName,
      mergedInto: person.mergedInto,
    });
  }

  private rememberInCache(alias: string, value: Omit<CachedAlias, 'expiresAt'>): CachedAlias {
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    const record = {
      ...value,
      expiresAt: this.now() + this.cacheTtlMs,
    };
    this.cache.set(alias, record);
    return record;
  }
}
