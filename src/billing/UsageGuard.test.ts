import { describe, expect, it } from 'vitest';
import {
  QuotaExceededError,
  UsageGuard,
  startOfDayShanghai,
} from './UsageGuard.js';
import type {
  QuotaReservationInput,
  QuotaReservationResult,
  UsageLedgerInput,
  UsageLedgerStore,
  UsagePolicy,
  UsageSummary,
} from '../types/admin-and-console.js';
import { ModelPricing } from './ModelPricing.js';

class FakeLedger implements UsageLedgerStore {
  public readonly entries: UsageLedgerInput[] = [];
  public readonly queries: Array<Record<string, unknown>> = [];
  public tokens = 0;
  public cost = 0;

  async append(input: UsageLedgerInput): Promise<void> {
    this.entries.push(input);
  }

  async tokensSince(filter: {
    sinceMs: number;
    senderStaffId?: string;
    conversationId?: string;
  }): Promise<number> {
    this.queries.push(filter);
    return this.tokens;
  }

  async costSince(): Promise<number> {
    return this.cost;
  }

  async summarySince(): Promise<UsageSummary> {
    return {
      sinceMs: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTurns: 0,
      totalCostMicros: 0,
      pricedTurns: 0,
      byUser: [],
      byConversation: [],
      byModel: [],
      byWorker: [],
      byJobKind: [],
    };
  }

  async purgeBefore(): Promise<number> {
    return 0;
  }
}

const policy = (overrides: Partial<UsagePolicy> = {}): UsagePolicy => ({
  enabled: true,
  dailyTokensPerUser: 1_000,
  dailyTokensPerConversation: 5_000,
  dailyCostMicros: 0,
  ...overrides,
});

describe('UsageGuard', () => {
  it('按 Asia/Shanghai 自然日切分', () => {
    expect(startOfDayShanghai(Date.UTC(2026, 9, 30, 2, 0, 0))).toBe(
      Date.UTC(2026, 9, 29, 16, 0, 0),
    );
    expect(startOfDayShanghai(Date.UTC(2026, 9, 29, 16, 0, 1))).toBe(
      Date.UTC(2026, 9, 29, 16, 0, 0),
    );
  });

  it('配额关闭时不查询账本', async () => {
    const ledger = new FakeLedger();
    const guard = new UsageGuard({ ledger, policy: policy({ enabled: false }) });
    await guard.assertWithinQuota({
      senderStaffId: 'u-1',
      conversationId: 'cid',
      conversationType: '2',
    });
    expect(ledger.queries).toHaveLength(0);
  });

  it('个人配额用尽时拒绝新的运行', async () => {
    const ledger = new FakeLedger();
    ledger.tokens = 1_000;
    const guard = new UsageGuard({
      ledger,
      policy: policy(),
      now: () => Date.UTC(2026, 9, 30, 2),
    });
    await expect(
      guard.assertWithinQuota({
        senderStaffId: 'u-1',
        conversationId: 'cid',
        conversationType: '1',
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(ledger.queries[0]).toMatchObject({
      senderStaffId: 'u-1',
      sinceMs: Date.UTC(2026, 9, 29, 16),
    });
  });

  it('群配额只对群聊生效', async () => {
    const ledger = new FakeLedger();
    ledger.tokens = 5_000;
    const guard = new UsageGuard({
      ledger,
      policy: policy({ dailyTokensPerUser: 0 }),
    });
    await expect(
      guard.assertWithinQuota({
        senderStaffId: 'u-1',
        conversationId: 'cid-group',
        conversationType: '2',
      }),
    ).rejects.toMatchObject({ scope: 'conversation' });

    await expect(
      guard.assertWithinQuota({
        senderStaffId: 'u-1',
        conversationId: 'cid-single',
        conversationType: '1',
      }),
    ).resolves.toBeNull();
  });

  it('记录用量时跳过零 Token 的空结果', async () => {
    const ledger = new FakeLedger();
    const guard = new UsageGuard({ ledger, policy: policy() });
    const base = {
      conversationId: 'cid',
      conversationType: '1' as const,
      senderStaffId: 'u-1',
      senderNick: '张三',
      model: 'deepseek-chat',
      steps: 1,
      durationMs: 10,
      proactive: false,
    };
    await guard.record({ ...base, totalTokens: 0 });
    expect(ledger.entries).toHaveLength(0);
    await guard.record({ ...base, totalTokens: 42 });
    expect(ledger.entries).toEqual([{ ...base, totalTokens: 42 }]);
  });

  it('配置单价后写入成本 micros，未知模型保持未定价', async () => {
    const ledger = new FakeLedger();
    const guard = new UsageGuard({
      ledger,
      policy: policy(),
      pricing: new ModelPricing({
        models: { 'deepseek-chat': { input: 1, output: 2 } },
      }),
    });
    const base = {
      conversationId: 'cid',
      conversationType: '1' as const,
      senderStaffId: 'u-1',
      senderNick: '张三',
      steps: 1,
      durationMs: 10,
      proactive: false,
    };
    await guard.record({
      ...base,
      model: 'deepseek-chat',
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
    });
    await guard.record({
      ...base,
      model: 'unknown-model',
      totalTokens: 50,
      inputTokens: 40,
      outputTokens: 10,
    });
    expect(ledger.entries[0]).toMatchObject({
      costMicros: 400,
      priced: true,
    });
    expect(ledger.entries[1]?.priced).toBeUndefined();
  });
});

class ReservingLedger extends FakeLedger {
  public readonly reservations = new Map<
    string,
    { tokens: number; settled: boolean }
  >();
  public reserveResult: QuotaReservationResult = {
    ok: true,
    reservationId: 'r-1',
  };
  public settleCalls = 0;
  public releaseCalls = 0;
  public settleFailures = 0;
  private seq = 0;

  async reserveQuota(
    input: QuotaReservationInput,
  ): Promise<QuotaReservationResult> {
    this.queries.push({ reserve: input });
    if (!this.reserveResult.ok) return this.reserveResult;
    this.seq += 1;
    const id = `r-${this.seq}`;
    this.reservations.set(id, { tokens: input.reserveTokens, settled: false });
    return { ok: true, reservationId: id };
  }

  async settleReservation(
    id: string,
    input: UsageLedgerInput,
  ): Promise<void> {
    this.settleCalls += 1;
    if (this.settleFailures > 0) {
      this.settleFailures -= 1;
      throw new Error('db down');
    }
    const row = this.reservations.get(id);
    if (row) {
      row.settled = true;
      row.tokens = input.totalTokens;
    }
    this.entries.push(input);
  }

  async releaseReservation(id: string): Promise<void> {
    this.releaseCalls += 1;
    this.reservations.delete(id);
  }
}

const recordBase = {
  conversationId: 'cid',
  conversationType: '1' as const,
  senderStaffId: 'u-1',
  senderNick: '张三',
  model: 'deepseek-chat',
  steps: 1,
  durationMs: 10,
  proactive: false,
};

const quotaInput = {
  senderStaffId: 'u-1',
  conversationId: 'cid',
  conversationType: '1' as const,
};

describe('UsageGuard 事务预留与防丢账', () => {
  it('支持预留时返回凭证，记录用量走结算而非追加', async () => {
    const ledger = new ReservingLedger();
    const guard = new UsageGuard({ ledger, policy: policy() });
    const reservation = await guard.assertWithinQuota(quotaInput, {
      reserveTokens: 500,
    });
    expect(reservation).not.toBeNull();
    expect(ledger.reservations.get(reservation!.id)?.tokens).toBe(500);

    await guard.record({ ...recordBase, totalTokens: 42 }, reservation);
    expect(ledger.settleCalls).toBe(1);
    expect(ledger.reservations.get(reservation!.id)?.settled).toBe(true);
    expect(ledger.entries).toHaveLength(1);
  });

  it('成本预算用尽时拒绝且 scope=cost', async () => {
    const ledger = new ReservingLedger();
    ledger.reserveResult = {
      ok: false,
      scope: 'cost',
      used: 2_000_000,
      limit: 1_000_000,
    };
    const guard = new UsageGuard({
      ledger,
      policy: policy({ dailyCostMicros: 1_000_000 }),
    });
    await expect(
      guard.assertWithinQuota(quotaInput, { reserveTokens: 500 }),
    ).rejects.toMatchObject({ scope: 'cost' });
  });

  it('零 Token 运行释放预留且不落账', async () => {
    const ledger = new ReservingLedger();
    const guard = new UsageGuard({ ledger, policy: policy() });
    const reservation = await guard.assertWithinQuota(quotaInput, {
      reserveTokens: 500,
    });
    await guard.record({ ...recordBase, totalTokens: 0 }, reservation);
    expect(ledger.releaseCalls).toBe(1);
    expect(ledger.reservations.size).toBe(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it('结算失败重试一次后成功则不告警', async () => {
    const ledger = new ReservingLedger();
    ledger.settleFailures = 1;
    let failures = 0;
    const guard = new UsageGuard({
      ledger,
      policy: policy(),
      onRecordFailure: () => {
        failures += 1;
      },
    });
    const reservation = await guard.assertWithinQuota(quotaInput, {
      reserveTokens: 500,
    });
    await guard.record({ ...recordBase, totalTokens: 42 }, reservation);
    expect(ledger.settleCalls).toBe(2);
    expect(failures).toBe(0);
    expect(ledger.entries).toHaveLength(1);
  });

  it('结算重试仍失败时上报告警且保守保留预留', async () => {
    const ledger = new ReservingLedger();
    ledger.settleFailures = 5;
    let failures = 0;
    const guard = new UsageGuard({
      ledger,
      policy: policy(),
      onRecordFailure: () => {
        failures += 1;
      },
    });
    const reservation = await guard.assertWithinQuota(quotaInput, {
      reserveTokens: 500,
    });
    await guard.record({ ...recordBase, totalTokens: 42 }, reservation);
    expect(ledger.settleCalls).toBe(2);
    expect(failures).toBe(1);
    expect(ledger.releaseCalls).toBe(0);
    expect(ledger.reservations.has(reservation!.id)).toBe(true);
    expect(ledger.entries).toHaveLength(0);
  });

  it('无预留能力时按成本上限降级判定', async () => {
    const ledger = new FakeLedger();
    ledger.cost = 1_000_000;
    const guard = new UsageGuard({
      ledger,
      policy: policy({ dailyTokensPerUser: 0, dailyCostMicros: 1_000_000 }),
    });
    await expect(
      guard.assertWithinQuota(quotaInput),
    ).rejects.toMatchObject({ scope: 'cost' });
  });
});
