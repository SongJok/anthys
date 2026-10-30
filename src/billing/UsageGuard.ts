import type {
  UsageLedgerInput,
  UsageLedgerStore,
  UsagePolicy,
} from '../types/admin-and-console.js';

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

/** 以 Asia/Shanghai 自然日切分配额，避免服务器时区导致额度提前重置 */
export function startOfDayShanghai(epochMs: number): number {
  return (
    Math.floor((epochMs + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS -
    SHANGHAI_OFFSET_MS
  );
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly scope: 'user' | 'conversation',
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(
      scope === 'user'
        ? `今日个人 Token 配额已用尽（${used}/${limit}）`
        : `本群今日 Token 配额已用尽（${used}/${limit}）`,
    );
    this.name = 'QuotaExceededError';
  }
}

export interface UsageGuardOptions {
  ledger: UsageLedgerStore;
  policy: UsagePolicy | (() => UsagePolicy);
  now?: () => number;
}

export interface QuotaCheckInput {
  senderStaffId: string;
  conversationId: string;
  conversationType: '1' | '2';
}

export class UsageGuard {
  private readonly ledger: UsageLedgerStore;
  private readonly policySource: UsagePolicy | (() => UsagePolicy);
  private readonly now: () => number;

  constructor(options: UsageGuardOptions) {
    this.ledger = options.ledger;
    this.policySource = options.policy;
    this.now = options.now ?? Date.now;
  }

  private policy(): UsagePolicy {
    return typeof this.policySource === 'function'
      ? this.policySource()
      : this.policySource;
  }

  public async assertWithinQuota(input: QuotaCheckInput): Promise<void> {
    const policy = this.policy();
    if (!policy.enabled) return;
    const sinceMs = startOfDayShanghai(this.now());

    if (policy.dailyTokensPerUser > 0) {
      const used = await this.ledger.tokensSince({
        sinceMs,
        senderStaffId: input.senderStaffId,
      });
      if (used >= policy.dailyTokensPerUser) {
        throw new QuotaExceededError('user', used, policy.dailyTokensPerUser);
      }
    }

    if (
      input.conversationType === '2' &&
      policy.dailyTokensPerConversation > 0
    ) {
      const used = await this.ledger.tokensSince({
        sinceMs,
        conversationId: input.conversationId,
      });
      if (used >= policy.dailyTokensPerConversation) {
        throw new QuotaExceededError(
          'conversation',
          used,
          policy.dailyTokensPerConversation,
        );
      }
    }
  }

  public async record(input: UsageLedgerInput): Promise<void> {
    if (input.totalTokens <= 0) return;
    await this.ledger.append(input);
  }
}
