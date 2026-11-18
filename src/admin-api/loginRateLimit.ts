export interface LoginRateLimitOptions {
  /** 窗口内允许的最大失败次数，默认 10 */
  maxAttempts?: number;
  /** 计数窗口（毫秒），默认 15 分钟 */
  windowMs?: number;
  now?: () => number;
}

export interface LoginRateLimitState {
  allowed: boolean;
  retryAfterMs: number;
}

/** 按客户端 IP 统计登录失败次数的固定窗口限流器，抵御控制台 Token 暴力破解 */
export class LoginAttemptLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginRateLimitOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 10);
    this.windowMs = Math.max(1_000, options.windowMs ?? 15 * 60 * 1_000);
    this.now = options.now ?? Date.now;
  }

  public check(ip: string): LoginRateLimitState {
    this.prune();
    const bucket = this.buckets.get(ip);
    if (!bucket) return { allowed: true, retryAfterMs: 0 };
    if (bucket.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - this.now()) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  public recordFailure(ip: string): void {
    const t = this.now();
    const bucket = this.buckets.get(ip);
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.set(ip, { count: 1, resetAt: t + this.windowMs });
      return;
    }
    bucket.count += 1;
  }

  public recordSuccess(ip: string): void {
    this.buckets.delete(ip);
  }

  private prune(): void {
    const t = this.now();
    for (const [ip, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(ip);
    }
  }
}