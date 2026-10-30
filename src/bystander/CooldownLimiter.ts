export interface CooldownLimiterOptions {
  now?: () => number;
  /** 冷却状态变化回调，用于多实例共享状态持久化 */
  onChange?: (key: string) => void;
}

/**
 * 按会话维度记录机器人最近一次主动回复时间，防止群里刷屏。
 * 未触发过或冷却已结束时返回可回复。
 */
export class CooldownLimiter {
  private readonly lastRepliedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly onChange?: (key: string) => void;

  constructor(options: CooldownLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  public isCoolingDown(key: string, cooldownSeconds: number): boolean {
    return this.remainingSeconds(key, cooldownSeconds) > 0;
  }

  public remainingSeconds(key: string, cooldownSeconds: number): number {
    const last = this.lastRepliedAt.get(key);
    if (last === undefined) return 0;
    const elapsedSeconds = (this.now() - last) / 1000;
    const remaining = cooldownSeconds - elapsedSeconds;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  public markReplied(key: string, at: number = this.now()): void {
    this.lastRepliedAt.set(key, at);
    this.onChange?.(key);
  }

  public lastReplied(key: string): number | undefined {
    return this.lastRepliedAt.get(key);
  }

  public reset(key: string): void {
    this.lastRepliedAt.delete(key);
    this.onChange?.(key);
  }

  /** 多实例接管时恢复最近一次主动回复时间 */
  public restore(key: string, at: number): void {
    this.lastRepliedAt.set(key, at);
  }
}
