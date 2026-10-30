import { describe, expect, it } from 'vitest';
import {
  MemorySharedStateStore,
  PgSharedStateStore,
  type SqlQueryable,
} from './SharedStateStore.js';

describe('MemorySharedStateStore', () => {
  it('claim 只成功一次并受 TTL 约束', async () => {
    let now = 1_000;
    const store = new MemorySharedStateStore(() => now);
    await expect(store.claim('msg-1', 10)).resolves.toBe(true);
    await expect(store.claim('msg-1', 10)).resolves.toBe(false);
    now = 12_000;
    await expect(store.claim('msg-1', 10)).resolves.toBe(true);
  });

  it('JSON 读写与删除', async () => {
    const store = new MemorySharedStateStore();
    await store.setJson('state', { a: 1 });
    await expect(store.getJson('state')).resolves.toEqual({ a: 1 });
    await store.delete('state');
    await expect(store.getJson('state')).resolves.toBeNull();
  });
});

describe('PgSharedStateStore', () => {
  it('claim 通过 ON CONFLICT 原子领取', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query<T>(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return {
          rows: (values?.[0] === 'taken' ? [] : [{ key: 'x' }]) as T[],
          rowCount: 1,
        };
      },
    } as SqlQueryable;
    const store = new PgSharedStateStore(db);
    await expect(store.claim('free', 60)).resolves.toBe(true);
    await expect(store.claim('taken', 60)).resolves.toBe(false);
    expect(calls[0]?.text).toContain('ON CONFLICT (key) DO UPDATE');
    expect(calls[0]?.values).toEqual(['free', 60]);
  });

  it('读取消过期的 key，写入支持 TTL', async () => {
    const queries: string[] = [];
    const db = {
      async query<T>(text: string) {
        queries.push(text);
        return { rows: [{ value: { ok: true } }] as T[], rowCount: 1 };
      },
    } as SqlQueryable;
    const store = new PgSharedStateStore(db);
    await expect(store.getJson('state')).resolves.toEqual({ ok: true });
    await store.setJson('state', { a: 1 }, 30);
    expect(queries[0]).toContain('expires_at > now()');
    expect(queries[1]).toContain('interval');
  });
});
