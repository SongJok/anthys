import { describe, expect, it } from 'vitest';
import {
  hashToolArgs,
  stableStringify,
  ToolExecutionLedger,
  writeLedgerKey,
  type LedgerStatus,
  type ToolExecutionLedgerPersistence,
} from './ToolExecutionLedger.js';

interface FakeRow {
  status: LedgerStatus;
  result?: string;
  error?: string;
}

function memoryPersistence(): ToolExecutionLedgerPersistence & {
  rows: Map<string, FakeRow>;
} {
  const rows = new Map<string, FakeRow>();
  return {
    rows,
    async insertExecuting(entry) {
      if (rows.has(entry.idempotencyKey)) return false;
      rows.set(entry.idempotencyKey, { status: 'executing' });
      return true;
    },
    async get(key) {
      const row = rows.get(key);
      if (!row) return null;
      return {
        idempotencyKey: key,
        toolName: 'send_mail',
        argsHash: 'hash',
        createdAt: 0,
        ...row,
      };
    },
    async reclaimFailed(key) {
      const row = rows.get(key);
      if (!row || row.status !== 'failed') return false;
      row.status = 'executing';
      row.error = undefined;
      return true;
    },
    async settle(key, status, detail) {
      const row = rows.get(key);
      if (!row) return;
      row.status = status;
      if (status === 'failed') row.error = detail;
      else row.result = detail;
    },
    async purgeSettled() {
      return 0;
    },
  };
}

const meta = { toolName: 'send_mail', argsHash: 'hash' };

describe('stableStringify / hashToolArgs', () => {
  it('键序与嵌套顺序无关，相同参数得到同一哈希', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashToolArgs({ a: 1, b: { y: 2, x: 1 } })).toBe(
      hashToolArgs({ b: { x: 1, y: 2 }, a: 1 }),
    );
    expect(hashToolArgs({ a: 1 })).not.toBe(hashToolArgs({ a: 2 }));
  });

  it('writeLedgerKey 含作用域、工具名与参数哈希', () => {
    const key = writeLedgerKey('job:j1', 'send_mail', { to: 'a@b.c' });
    expect(key.startsWith('job:j1:send_mail:')).toBe(true);
    expect(key).toBe(writeLedgerKey('job:j1', 'send_mail', { to: 'a@b.c' }));
    expect(key).not.toBe(writeLedgerKey('job:j2', 'send_mail', { to: 'a@b.c' }));
  });
});

describe('ToolExecutionLedger', () => {
  it('首次登记 claimed，成功后重放结果不再执行', async () => {
    const persistence = memoryPersistence();
    const ledger = new ToolExecutionLedger({ persistence });
    expect(await ledger.begin('k1', meta)).toEqual({ outcome: 'claimed' });
    await ledger.settle('k1', 'succeeded', '邮件已发送');
    expect(await ledger.begin('k1', meta)).toEqual({
      outcome: 'replay',
      result: '邮件已发送',
    });
  });

  it('executing（进程中断 / 仍在执行）阻止重复执行', async () => {
    const persistence = memoryPersistence();
    const ledger = new ToolExecutionLedger({ persistence });
    await ledger.begin('k1', meta);
    const second = await ledger.begin('k1', meta);
    expect(second.outcome).toBe('blocked');
    if (second.outcome === 'blocked') {
      expect(second.reason).toContain('结果未知');
    }
  });

  it('失败后允许重试（CAS failed→executing），并发重试被阻止', async () => {
    const persistence = memoryPersistence();
    const ledger = new ToolExecutionLedger({ persistence });
    await ledger.begin('k1', meta);
    await ledger.settle('k1', 'failed', '网络错误');
    expect(await ledger.begin('k1', meta)).toEqual({ outcome: 'claimed' });
    // 已被重新登记为 executing，另一个进程不能再抢
    const concurrent = await ledger.begin('k1', meta);
    expect(concurrent.outcome).toBe('blocked');
  });

  it('登记失败直接抛错，由调用方 fail-closed 阻止执行', async () => {
    const persistence = memoryPersistence();
    persistence.insertExecuting = async () => {
      throw new Error('db down');
    };
    const ledger = new ToolExecutionLedger({ persistence });
    await expect(ledger.begin('k1', meta)).rejects.toThrow('db down');
  });

  it('settle 失败只告警不抛错', async () => {
    const persistence = memoryPersistence();
    persistence.settle = async () => {
      throw new Error('db down');
    };
    const warnings: string[] = [];
    const ledger = new ToolExecutionLedger({
      persistence,
      logger: { warn: (_obj, msg) => warnings.push(msg) },
    });
    await ledger.begin('k1', meta);
    expect(await ledger.settle('k1', 'succeeded', 'ok')).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('无持久层时直接放行（开发 / 单测模式）', async () => {
    const ledger = new ToolExecutionLedger();
    expect(await ledger.begin('k1', meta)).toEqual({ outcome: 'claimed' });
    expect(await ledger.settle('k1', 'succeeded', 'ok')).toBe(true);
  });
});