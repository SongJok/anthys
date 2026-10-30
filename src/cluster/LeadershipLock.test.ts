import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PgAdvisoryLeadership,
  advisoryLockKey,
  type LeadershipClient,
  type LeadershipPool,
} from './LeadershipLock.js';

interface FakeClient extends LeadershipClient {
  released: boolean;
  queries: string[];
  failHeartbeat: boolean;
}

function makeClient(acquireResult: boolean): FakeClient {
  const client: FakeClient = {
    released: false,
    queries: [],
    failHeartbeat: false,
    async query<T>(text: string) {
      client.queries.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ ok: acquireResult }] as T[] };
      }
      if (text.startsWith('SELECT 1') && client.failHeartbeat) {
        throw new Error('connection reset');
      }
      return { rows: [{}] as T[] };
    },
    release() {
      client.released = true;
    },
  };
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('advisoryLockKey', () => {
  it('字符串稳定映射到 int32，数字原样返回', () => {
    const first = advisoryLockKey('dingtalk-agent');
    expect(advisoryLockKey('dingtalk-agent')).toBe(first);
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(-2_147_483_648);
    expect(first).toBeLessThanOrEqual(2_147_483_647);
    expect(advisoryLockKey(42)).toBe(42);
  });
});

describe('PgAdvisoryLeadership', () => {
  it('无锁时保持备实例，重试后成为主实例', async () => {
    vi.useFakeTimers();
    const standby = makeClient(false);
    const primary = makeClient(true);
    const clients = [standby, primary];
    const pool: LeadershipPool = {
      connect: async () => clients.shift()!,
    };
    const onAcquired = vi.fn();
    const leadership = new PgAdvisoryLeadership({
      pool,
      key: 'agent',
      retryMs: 1_000,
      heartbeatMs: 5_000,
      onAcquired,
    });

    leadership.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(leadership.isLeader()).toBe(false);
    expect(standby.released).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(leadership.isLeader()).toBe(true);
    expect(onAcquired).toHaveBeenCalledTimes(1);

    await leadership.stop();
    expect(primary.queries.some((text) => text.includes('pg_advisory_unlock'))).toBe(
      true,
    );
    expect(primary.released).toBe(true);
    expect(leadership.isLeader()).toBe(false);
  });

  it('心跳失败时降级并触发 onLost', async () => {
    vi.useFakeTimers();
    const client = makeClient(true);
    let connects = 0;
    const pool: LeadershipPool = {
      connect: async () => {
        connects += 1;
        if (connects > 1) throw new Error('db unavailable');
        return client;
      },
    };
    const onLost = vi.fn();
    const leadership = new PgAdvisoryLeadership({
      pool,
      key: 'agent',
      retryMs: 1_000,
      heartbeatMs: 1_000,
      onLost,
    });

    leadership.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(leadership.isLeader()).toBe(true);

    client.failHeartbeat = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(leadership.isLeader()).toBe(false);
    expect(client.released).toBe(true);

    await leadership.stop();
  });
});
