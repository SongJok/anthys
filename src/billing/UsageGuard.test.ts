import { describe, expect, it } from 'vitest';
import {
  QuotaExceededError,
  UsageGuard,
  startOfDayShanghai,
} from './UsageGuard.js';
import type {
  UsageLedgerInput,
  UsageLedgerStore,
  UsagePolicy,
  UsageSummary,
} from '../types/admin-and-console.js';

class FakeLedger implements UsageLedgerStore {
  public readonly entries: UsageLedgerInput[] = [];
  public readonly queries: Array<Record<string, unknown>> = [];
  public tokens = 0;

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

  async summarySince(): Promise<UsageSummary> {
    return {
      sinceMs: 0,
      totalTokens: 0,
      totalTurns: 0,
      byUser: [],
      byConversation: [],
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
    ).resolves.toBeUndefined();
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
});
