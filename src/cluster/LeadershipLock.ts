export interface LeadershipClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

export interface LeadershipPool {
  connect(): Promise<LeadershipClient>;
}

export interface LeadershipLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface LeadershipOptions {
  pool: LeadershipPool;
  /** 锁标识：字符串会哈希成 int32，数字直接截断 */
  key: string | number;
  /** 备实例抢占间隔，默认 5s */
  retryMs?: number;
  /** 主实例心跳间隔，默认 10s */
  heartbeatMs?: number;
  logger?: LeadershipLogger;
  onAcquired?: () => void | Promise<void>;
  onLost?: () => void | Promise<void>;
}

/** FNV-1a 32bit：把任意字符串稳定映射到 PostgreSQL advisory lock 的 bigint 范围 */
export function advisoryLockKey(key: string | number): number {
  if (typeof key === 'number' && Number.isFinite(key)) return Math.trunc(key);
  const text = String(key);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * O3 主备选主：通过 PostgreSQL session 级 advisory lock 保证同一时刻只有一个实例
 * 连接钉钉 Stream。持有连接即持有锁，连接断开（实例崩溃）锁自动释放，备实例在
 * retryMs 内接管；心跳失败视为失锁，主动降级。
 */
export class PgAdvisoryLeadership {
  private readonly lockKey: number;
  private readonly retryMs: number;
  private readonly heartbeatMs: number;
  private client: LeadershipClient | null = null;
  private leader = false;
  private stopped = false;
  private runner: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: LeadershipOptions) {
    this.lockKey = advisoryLockKey(options.key);
    this.retryMs = Math.max(100, options.retryMs ?? 5_000);
    this.heartbeatMs = Math.max(100, options.heartbeatMs ?? 10_000);
  }

  public start(): void {
    if (this.runner) return;
    this.stopped = false;
    this.runner = this.loop().finally(() => {
      this.runner = null;
    });
  }

  public isLeader(): boolean {
    return this.leader;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.runner?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (!client) {
      this.leader = false;
      return;
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [this.lockKey]);
    } catch (error) {
      this.options.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'failed to release leadership lock',
      );
    }
    client.release();
    this.leader = false;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (!this.client) {
        await this.tryAcquire();
        if (!this.leader) await this.wait(this.retryMs);
        continue;
      }
      await this.wait(this.heartbeatMs);
      if (this.stopped) break;
      try {
        await this.client.query('SELECT 1');
      } catch (error) {
        this.options.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'leadership heartbeat failed, stepping down',
        );
        await this.loseLeadership();
        this.releaseClient();
      }
    }
    if (!this.stopped) this.releaseClient();
  }

  private async tryAcquire(): Promise<void> {
    let client: LeadershipClient | null = null;
    try {
      client = await this.options.pool.connect();
      const result = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS ok',
        [this.lockKey],
      );
      if (result.rows[0]?.ok) {
        this.client = client;
        this.leader = true;
        this.options.logger?.info(
          { lockKey: this.lockKey },
          'leadership acquired, connecting stream',
        );
        try {
          await this.options.onAcquired?.();
        } catch (error) {
          this.options.logger?.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'leadership acquired handler failed',
          );
        }
        return;
      }
      client.release();
    } catch (error) {
      client?.release();
      this.options.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'leadership acquire failed, staying standby',
      );
    }
  }

  private async loseLeadership(): Promise<void> {
    if (!this.leader) return;
    this.leader = false;
    this.options.logger?.warn({ lockKey: this.lockKey }, 'leadership lost');
    try {
      await this.options.onLost?.();
    } catch (error) {
      this.options.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'leadership lost handler failed',
      );
    }
  }

  private releaseClient(): void {
    this.client?.release();
    this.client = null;
    this.leader = false;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
