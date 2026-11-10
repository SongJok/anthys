import { isStaffUserId } from '../dingtalk/userIds.js';
import type {
  DirectorySource,
  DirectoryUser,
  UserWhitelistAdminPort,
  WhitelistEntry,
  WhitelistPage,
  WhitelistQuery,
  WhitelistStats,
  WhitelistStatus,
  WhitelistStore,
  WhitelistSyncResult,
} from '../types/whitelist.js';

export interface WhitelistLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface WhitelistServiceOptions {
  store: WhitelistStore;
  configCenter: { isAdmin(staffId: string): boolean };
  /** 按优先级尝试的通讯录来源 */
  directorySources: DirectorySource[];
  /** 把 DWS 群事件的 openDingTalkId 反查为员工 staffId */
  resolveOpenId?: (
    openDingTalkId: string,
    senderName?: string,
  ) => Promise<{ staffId: string; name: string } | null>;
  logger?: WhitelistLogger;
  now?: () => number;
  /** staffId 授权状态缓存，默认 30 秒 */
  cacheTtlMs?: number;
  /** openDingTalkId 反查失败缓存，默认 10 分钟 */
  negativeOpenIdTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * 用户白名单：管理员免审；外部人员（`$:`）一律拒绝；
 * 未登记的内部员工在首次发消息时自动进入待授权列表。
 */
export class WhitelistService implements UserWhitelistAdminPort {
  private readonly store: WhitelistStore;
  private readonly configCenter: { isAdmin(staffId: string): boolean };
  private readonly directorySources: DirectorySource[];
  private readonly resolveOpenId?: WhitelistServiceOptions['resolveOpenId'];
  private readonly logger?: WhitelistLogger;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly negativeOpenIdTtlMs: number;
  private readonly staffCache = new Map<string, CacheEntry<boolean>>();
  private readonly openIdCache = new Map<
    string,
    CacheEntry<{ staffId: string; name: string } | null>
  >();
  private syncing: Promise<WhitelistSyncResult> | null = null;

  constructor(options: WhitelistServiceOptions) {
    this.store = options.store;
    this.configCenter = options.configCenter;
    this.directorySources = options.directorySources;
    this.resolveOpenId = options.resolveOpenId;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.negativeOpenIdTtlMs = options.negativeOpenIdTtlMs ?? 10 * 60_000;
  }

  /** Stream/卡片链路：内部员工 staffId 是否已授权 */
  public async isStaffAllowed(
    staffId: string,
    senderNick?: string,
  ): Promise<boolean> {
    const id = staffId?.trim() ?? '';
    if (!id || !isStaffUserId(id)) return false;
    if (this.configCenter.isAdmin(id)) return true;

    const cached = this.staffCache.get(id);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    let entry: WhitelistEntry | null;
    try {
      entry = await this.store.get(id);
    } catch (error) {
      this.logger?.warn(
        { staffId: id, error: errorText(error) },
        'whitelist lookup failed, denying sender',
      );
      return false;
    }

    if (!entry) {
      try {
        await this.store.registerPending(id, senderNick ?? '');
      } catch (error) {
        this.logger?.warn(
          { staffId: id, error: errorText(error) },
          'failed to register pending whitelist user',
        );
      }
      this.rememberStaff(id, false);
      return false;
    }

    const allowed = entry.status === 'approved';
    this.rememberStaff(id, allowed);
    return allowed;
  }

  /** DWS 群旁听链路：只有 openDingTalkId，解析到员工后再判定 */
  public async isOpenIdAllowed(
    openDingTalkId: string,
    senderName?: string,
  ): Promise<boolean> {
    const openId = openDingTalkId?.trim() ?? '';
    if (!openId) return false;

    const cached = this.openIdCache.get(openId);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value
        ? this.isStaffAllowed(cached.value.staffId, cached.value.name)
        : false;
    }

    let entry: WhitelistEntry | null;
    try {
      entry = await this.store.findByOpenId(openId);
    } catch (error) {
      this.logger?.warn(
        { openId, error: errorText(error) },
        'whitelist openId lookup failed, denying sender',
      );
      return false;
    }
    if (entry) {
      this.openIdCache.set(openId, {
        value: { staffId: entry.staffId, name: entry.name },
        expiresAt: this.now() + this.cacheTtlMs,
      });
      return this.isStaffAllowed(entry.staffId, entry.name);
    }

    if (!this.resolveOpenId) {
      this.rememberOpenId(openId, null);
      return false;
    }
    const resolved = await this.resolveOpenId(openId, senderName);
    if (!resolved) {
      this.rememberOpenId(openId, null);
      return false;
    }

    this.rememberOpenId(openId, resolved);
    try {
      await this.store.bindOpenId(resolved.staffId, openId);
    } catch (error) {
      this.logger?.warn(
        { openId, staffId: resolved.staffId, error: errorText(error) },
        'failed to bind openDingTalkId to whitelist entry',
      );
    }
    return this.isStaffAllowed(resolved.staffId, resolved.name);
  }

  public async list(query: WhitelistQuery): Promise<WhitelistPage> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));
    const [{ items, total }, stats] = await Promise.all([
      this.store.list({ ...query, page, pageSize }),
      this.store.stats(),
    ]);
    return { items, total, page, pageSize, stats };
  }

  public stats(): Promise<WhitelistStats> {
    return this.store.stats();
  }

  /** 同步通讯录：优先应用 API，授权范围不足或失败时自动回退 DWS */
  public sync(): Promise<WhitelistSyncResult> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(): Promise<WhitelistSyncResult> {
    const warnings: string[] = [];
    const candidates: Array<{
      source: DirectorySource;
      users: DirectoryUser[];
    }> = [];
    const tracked = await this.store.countTracked();
    for (const source of this.directorySources) {
      try {
        const users = await source.fetchUsers();
        if (users.length === 0) {
          throw new Error(
            '通讯录未返回任何员工（应用通讯录权限范围可能未覆盖组织，或登录态异常）',
          );
        }
        // 覆盖不到历史规模一半的快照说明该来源只能看到部分组织，不能用来判定离职
        if (tracked === 0 || users.length >= tracked * 0.5) {
          return await this.applySync(source, users, true, warnings);
        }
        candidates.push({ source, users });
        warnings.push(
          `${sourceLabel(source)}：仅覆盖 ${users.length} 人（历史 ${tracked} 人），疑似通讯录权限范围不足`,
        );
      } catch (error) {
        const message = `${sourceLabel(source)}：${errorText(error)}`;
        warnings.push(message);
        this.logger?.warn({ source: source.name }, `whitelist sync source failed：${message}`);
      }
    }
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) =>
        b.users.length > a.users.length ? b : a,
      );
      return await this.applySync(best.source, best.users, false, warnings);
    }
    throw new Error(`通讯录同步失败：${warnings.join('；')}`);
  }

  private async applySync(
    source: DirectorySource,
    users: DirectoryUser[],
    markAbsent: boolean,
    warnings: string[],
  ): Promise<WhitelistSyncResult> {
    const counts = await this.store.upsertDirectory(
      users,
      source.name === 'dingtalk-api' ? 'directory' : 'dws',
      { markAbsent },
    );
    if (counts.skipped > 0) {
      warnings.push(
        `本次通讯录未覆盖全部在职员工，${counts.skipped} 名员工的离职状态未判定`,
      );
    }
    const result: WhitelistSyncResult = {
      source: source.name,
      scanned: users.length,
      ...counts,
      warnings,
      syncedAt: new Date(this.now()).toISOString(),
    };
    this.logger?.info(
      {
        source: result.source,
        scanned: result.scanned,
        created: result.created,
        updated: result.updated,
        left: result.left,
        skipped: result.skipped,
        warnings: warnings.length,
      },
      'user whitelist directory synced',
    );
    return result;
  }

  public async setStatus(
    staffId: string,
    status: WhitelistStatus,
    actor: string,
    note?: string,
  ): Promise<WhitelistEntry | null> {
    const entry = await this.store.setStatus(staffId, status, actor, note);
    if (entry) this.invalidate(entry.staffId);
    return entry;
  }

  public async setStatusBatch(
    staffIds: string[],
    status: WhitelistStatus,
    actor: string,
  ): Promise<number> {
    const updated = await this.store.setStatusBatch(staffIds, status, actor);
    for (const id of staffIds) this.invalidate(id);
    return updated;
  }

  public invalidate(staffId: string): void {
    this.staffCache.delete(staffId.trim());
  }

  private rememberStaff(staffId: string, allowed: boolean): void {
    this.staffCache.set(staffId, {
      value: allowed,
      expiresAt: this.now() + this.cacheTtlMs,
    });
  }

  private rememberOpenId(
    openId: string,
    value: { staffId: string; name: string } | null,
  ): void {
    this.openIdCache.set(openId, {
      value,
      expiresAt:
        this.now() +
        (value === null ? this.negativeOpenIdTtlMs : this.cacheTtlMs),
    });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(source: DirectorySource): string {
  return source.name === 'dingtalk-api' ? '应用通讯录' : 'DWS 通讯录';
}
