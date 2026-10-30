/** 跨实例共享状态：消息去重、旁听缓冲与冷却在故障接管后仍需生效 */

export interface SqlQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface SqlQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<SqlQueryResult<T>>;
}

export interface SharedStateStore {
  /** 原子领取一个 key；已存在且未过期时返回 false（用于跨实例消息去重） */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

const TABLE = 'cluster_shared_state';

/**
 * 基于 PostgreSQL 的共享状态表。
 * claim 使用 INSERT ... ON CONFLICT ... WHERE 保证多实例只有一个能拿到 key。
 */
export class PgSharedStateStore implements SharedStateStore {
  constructor(private readonly db: SqlQueryable) {}

  public async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.db.query<{ key: string }>(
      `INSERT INTO ${TABLE} (key, value, expires_at)
       VALUES ($1, '{}'::jsonb, now() + ($2::numeric * interval '1 second'))
       ON CONFLICT (key) DO UPDATE
         SET value = '{}'::jsonb,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()
         WHERE ${TABLE}.expires_at IS NULL
            OR ${TABLE}.expires_at <= now()
       RETURNING key`,
      [key, ttlSeconds],
    );
    return result.rows.length > 0;
  }

  public async getJson<T>(key: string): Promise<T | null> {
    const result = await this.db.query<{ value: T }>(
      `SELECT value FROM ${TABLE}
       WHERE key = $1
         AND (expires_at IS NULL OR expires_at > now())`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  public async setJson(
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ${TABLE} (key, value, expires_at)
       VALUES (
         $1,
         $2::jsonb,
         CASE WHEN $3::double precision IS NULL THEN NULL
              ELSE now() + ($3::double precision * interval '1 second') END
       )
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [key, JSON.stringify(value), ttlSeconds ?? null],
    );
  }

  public async delete(key: string): Promise<void> {
    await this.db.query(`DELETE FROM ${TABLE} WHERE key = $1`, [key]);
  }
}

/** 单实例或测试用的内存实现，行为与 PG 版保持一致 */
export class MemorySharedStateStore implements SharedStateStore {
  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number | null }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  public async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const current = this.read(key);
    if (current) return false;
    this.entries.set(key, {
      value: {},
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return true;
  }

  public async getJson<T>(key: string): Promise<T | null> {
    return (this.read(key)?.value as T | undefined) ?? null;
  }

  public async setJson(
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds ? this.now() + ttlSeconds * 1000 : null,
    });
  }

  public async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private read(
    key: string,
  ): { value: unknown; expiresAt: number | null } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
