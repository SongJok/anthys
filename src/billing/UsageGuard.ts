import type {
  UsageLedgerInput,
  UsageLedgerStore,
  UsagePolicy,
  UsageReservation,
} from '../types/admin-and-console.js';
import type { ModelPricing } from './ModelPricing.js';

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
    public readonly scope: 'user' | 'conversation' | 'cost',
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(
      scope === 'user'
        ? `今日个人 Token 配额已用尽（${used}/${limit}）`
        : scope === 'conversation'
          ? `本群今日 Token 配额已用尽（${used}/${limit}）`
          : `今日成本预算已用尽（¥${(used / 1e6).toFixed(2)}/¥${(limit / 1e6).toFixed(2)}）`,
    );
    this.name = 'QuotaExceededError';
  }
}

export interface UsageGuardOptions {
  ledger: UsageLedgerStore;
  policy: UsagePolicy | (() => UsagePolicy);
  /** 配置后为每条流水估算人民币成本；未配置时只记账 Token */
  pricing?: ModelPricing;
  now?: () => number;
  /** 记账重试仍失败时回调（用于告警指标）；预留行靠 TTL 自愈兜底 */
  onRecordFailure?: (error: unknown) => void;
}

export interface QuotaCheckInput {
  senderStaffId: string;
  conversationId: string;
  conversationType: '1' | '2';
}

export class UsageGuard {
  private readonly ledger: UsageLedgerStore;
  private readonly policySource: UsagePolicy | (() => UsagePolicy);
  private readonly pricing?: ModelPricing;
  private readonly now: () => number;
  private readonly onRecordFailure?: (error: unknown) => void;

  constructor(options: UsageGuardOptions) {
    this.ledger = options.ledger;
    this.policySource = options.policy;
    this.pricing = options.pricing;
    this.now = options.now ?? Date.now;
    this.onRecordFailure = options.onRecordFailure;
  }

  private policy(): UsagePolicy {
    return typeof this.policySource === 'function'
      ? this.policySource()
      : this.policySource;
  }

  /**
   * 准入判定。账本支持事务预留时写入估算预留行并返回凭证，运行结束后结算/释放；
   * 否则降级为检查式判定（无预留凭证）。配额关闭时返回 null。
   */
  public async assertWithinQuota(
    input: QuotaCheckInput,
    options: { reserveTokens?: number } = {},
  ): Promise<UsageReservation | null> {
    const policy = this.policy();
    if (!policy.enabled) return null;
    const sinceMs = startOfDayShanghai(this.now());
    const reserveTokens = Math.max(0, Math.round(options.reserveTokens ?? 0));

    if (this.ledger.reserveQuota && reserveTokens > 0) {
      const result = await this.ledger.reserveQuota({
        sinceMs,
        senderStaffId: input.senderStaffId,
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        reserveTokens,
        dailyTokensPerUser: policy.dailyTokensPerUser,
        dailyTokensPerConversation: policy.dailyTokensPerConversation,
        dailyCostMicros: policy.dailyCostMicros,
      });
      if (!result.ok) {
        throw new QuotaExceededError(result.scope, result.used, result.limit);
      }
      return { id: result.reservationId };
    }

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

    if (policy.dailyCostMicros > 0 && this.ledger.costSince) {
      const used = await this.ledger.costSince(sinceMs);
      if (used >= policy.dailyCostMicros) {
        throw new QuotaExceededError('cost', used, policy.dailyCostMicros);
      }
    }
    return null;
  }

  /** 释放准入后未运行的预留（零 Token 结果或中途放弃）；失败靠 TTL 自愈 */
  public async release(reservation: UsageReservation | null): Promise<void> {
    if (!reservation || !this.ledger.releaseReservation) return;
    try {
      await this.ledger.releaseReservation(reservation.id);
    } catch {
      // 释放失败时预留行仍占用估算额度，2 小时后自愈，不阻断主流程
    }
  }

  public async record(
    input: UsageLedgerInput,
    reservation?: UsageReservation | null,
  ): Promise<void> {
    if (input.totalTokens <= 0) {
      await this.release(reservation ?? null);
      return;
    }
    const estimate = this.pricing?.estimate({
      model: input.model,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cachedTokens !== undefined ? { cachedTokens: input.cachedTokens } : {}),
    });
    const priced = estimate
      ? { ...input, costMicros: estimate.costMicros, priced: true }
      : input;

    const write = async (): Promise<void> => {
      if (reservation && this.ledger.settleReservation) {
        await this.ledger.settleReservation(reservation.id, priced);
        return;
      }
      if (reservation) await this.release(reservation);
      await this.ledger.append(priced);
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await write();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    // 重试仍失败：不释放预留（保守占用估算额度），上报告警指标
    this.onRecordFailure?.(lastError);
  }
}
