import { describe, expect, it, vi } from 'vitest';
import { WhitelistService } from './WhitelistService.js';
import type {
  DirectorySource,
  DirectoryUser,
  WhitelistEntry,
  WhitelistQuery,
  WhitelistSource,
  WhitelistStats,
  WhitelistStatus,
  WhitelistStore,
} from '../types/whitelist.js';

const NOW = new Date('2026-11-04T10:00:00Z').getTime();

class MemoryStore implements WhitelistStore {
  public readonly rows = new Map<string, WhitelistEntry>();

  public seed(
    staffId: string,
    status: WhitelistStatus,
    name = staffId,
    source: WhitelistSource = 'manual',
  ): void {
    this.rows.set(staffId, {
      staffId,
      name,
      deptPath: '',
      status,
      source,
      openDingTalkId: null,
      note: '',
      approvedBy: status === 'pending' ? null : 'admin',
      approvedAt: status === 'pending' ? null : new Date(NOW).toISOString(),
      lastSeenAt: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
  }

  public async get(staffId: string): Promise<WhitelistEntry | null> {
    return this.rows.get(staffId) ?? null;
  }

  public async findByOpenId(openId: string): Promise<WhitelistEntry | null> {
    for (const entry of this.rows.values()) {
      if (entry.openDingTalkId === openId) return entry;
    }
    return null;
  }

  public async list(
    query: WhitelistQuery,
  ): Promise<{ items: WhitelistEntry[]; total: number }> {
    let items = [...this.rows.values()];
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.query) {
      const keyword = query.query;
      items = items.filter(
        (item) =>
          item.staffId.includes(keyword) ||
          item.name.includes(keyword) ||
          item.deptPath.includes(keyword),
      );
    }
    return { items, total: items.length };
  }

  public async stats(): Promise<WhitelistStats> {
    const items = [...this.rows.values()];
    return {
      total: items.length,
      pending: items.filter((item) => item.status === 'pending').length,
      approved: items.filter((item) => item.status === 'approved').length,
      rejected: items.filter((item) => item.status === 'rejected').length,
      left: items.filter((item) => item.status === 'left').length,
      syncedAt:
        items
          .map((item) => item.lastSeenAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null,
    };
  }

  public async countTracked(): Promise<number> {
    return [...this.rows.values()].filter(
      (item) =>
        (item.source === 'directory' || item.source === 'dws') &&
        item.status !== 'left',
    ).length;
  }

  public async upsertDirectory(
    users: DirectoryUser[],
    source: WhitelistSource,
    options: { markAbsent: boolean },
  ): Promise<{
    created: number;
    updated: number;
    unchanged: number;
    left: number;
    skipped: number;
  }> {
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const synced = new Set(users.map((user) => user.staffId));
    for (const user of users) {
      const before = this.rows.get(user.staffId);
      if (!before) {
        created += 1;
        this.rows.set(user.staffId, {
          staffId: user.staffId,
          name: user.name,
          deptPath: user.deptPath,
          status: 'pending',
          source,
          openDingTalkId: null,
          note: '',
          approvedBy: null,
          approvedAt: null,
          lastSeenAt: new Date(NOW).toISOString(),
          createdAt: new Date(NOW).toISOString(),
          updatedAt: new Date(NOW).toISOString(),
        });
        continue;
      }
      if (before.status === 'left') {
        updated += 1;
        before.status = 'pending';
        before.approvedBy = null;
        before.approvedAt = null;
      } else if (before.name !== user.name || before.deptPath !== user.deptPath) {
        updated += 1;
      } else {
        unchanged += 1;
      }
      before.name = user.name;
      before.deptPath = user.deptPath;
      before.lastSeenAt = new Date(NOW).toISOString();
    }

    const tracked = [...this.rows.values()].filter(
      (item) =>
        (item.source === 'directory' || item.source === 'dws') &&
        item.status !== 'left',
    );
    const absent = tracked.filter((item) => !synced.has(item.staffId));
    if (!options.markAbsent || synced.size < tracked.length * 0.5) {
      return { created, updated, unchanged, left: 0, skipped: absent.length };
    }
    let left = 0;
    for (const item of absent) {
      item.status = 'left';
      if (!item.note) item.note = '通讯录同步未找到该员工（疑似离职）';
      item.updatedAt = new Date(NOW).toISOString();
      left += 1;
    }
    return { created, updated, unchanged, left, skipped: 0 };
  }

  public async registerPending(staffId: string, name: string): Promise<void> {
    if (this.rows.has(staffId)) return;
    this.rows.set(staffId, {
      staffId,
      name,
      deptPath: '',
      status: 'pending',
      source: 'auto',
      openDingTalkId: null,
      note: '',
      approvedBy: null,
      approvedAt: null,
      lastSeenAt: new Date(NOW).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
  }

  public async setStatus(
    staffId: string,
    status: WhitelistStatus,
    actor: string,
    note?: string,
  ): Promise<WhitelistEntry | null> {
    const entry = this.rows.get(staffId);
    if (!entry) return null;
    entry.status = status;
    entry.approvedBy = status === 'pending' ? null : actor;
    entry.approvedAt =
      status === 'pending' ? null : new Date(NOW).toISOString();
    if (note !== undefined) entry.note = note;
    entry.updatedAt = new Date(NOW).toISOString();
    return entry;
  }

  public async setStatusBatch(
    staffIds: string[],
    status: WhitelistStatus,
    actor: string,
  ): Promise<number> {
    let updated = 0;
    for (const staffId of staffIds) {
      if (await this.setStatus(staffId, status, actor)) updated += 1;
    }
    return updated;
  }

  public async bindOpenId(
    staffId: string,
    openDingTalkId: string,
  ): Promise<void> {
    const entry = this.rows.get(staffId);
    if (entry) entry.openDingTalkId = openDingTalkId;
  }
}

function service(
  store: MemoryStore,
  options: {
    admins?: string[];
    sources?: DirectorySource[];
    resolveOpenId?: (
      openId: string,
      name?: string,
    ) => Promise<{ staffId: string; name: string } | null>;
  } = {},
): WhitelistService {
  const admins = new Set(options.admins ?? ['admin-1']);
  return new WhitelistService({
    store,
    configCenter: { isAdmin: (staffId) => admins.has(staffId) },
    directorySources: options.sources ?? [],
    ...(options.resolveOpenId ? { resolveOpenId: options.resolveOpenId } : {}),
    now: () => NOW,
  });
}

describe('WhitelistService', () => {
  it('管理员免审，外部人员与未授权员工一律拒绝', async () => {
    const store = new MemoryStore();
    store.seed('staff-approved', 'approved');
    store.seed('staff-pending', 'pending');
    store.seed('staff-rejected', 'rejected');
    const whitelist = service(store);

    await expect(whitelist.isStaffAllowed('admin-1')).resolves.toBe(true);
    await expect(whitelist.isStaffAllowed('staff-approved')).resolves.toBe(true);
    await expect(whitelist.isStaffAllowed('staff-pending')).resolves.toBe(false);
    await expect(whitelist.isStaffAllowed('staff-rejected')).resolves.toBe(false);
    await expect(
      whitelist.isStaffAllowed('$:LWCP_v1:$external'),
    ).resolves.toBe(false);
    await expect(whitelist.isStaffAllowed('')).resolves.toBe(false);
  });

  it('未登记的内部员工首次发消息自动进入待授权', async () => {
    const store = new MemoryStore();
    const whitelist = service(store);

    await expect(
      whitelist.isStaffAllowed('staff-new', '新同事'),
    ).resolves.toBe(false);
    expect(store.rows.get('staff-new')).toMatchObject({
      name: '新同事',
      status: 'pending',
      source: 'auto',
    });
  });

  it('审批后立即放行，不等待缓存过期', async () => {
    const store = new MemoryStore();
    store.seed('staff-1', 'pending');
    const whitelist = service(store);

    await expect(whitelist.isStaffAllowed('staff-1')).resolves.toBe(false);
    await whitelist.setStatus('staff-1', 'approved', 'admin-1');
    await expect(whitelist.isStaffAllowed('staff-1')).resolves.toBe(true);
  });

  it('DWS openDingTalkId 解析到已授权员工后放行并绑定', async () => {
    const store = new MemoryStore();
    store.seed('staff-1', 'approved', '张三');
    const resolveOpenId = vi.fn(async () => ({
      staffId: 'staff-1',
      name: '张三',
    }));
    const whitelist = service(store, { resolveOpenId });

    await expect(
      whitelist.isOpenIdAllowed('open-1', '张三'),
    ).resolves.toBe(true);
    expect(store.rows.get('staff-1')?.openDingTalkId).toBe('open-1');

    await whitelist.isOpenIdAllowed('open-1', '张三');
    expect(resolveOpenId).toHaveBeenCalledTimes(1);
  });

  it('无法解析的 openDingTalkId 按拒绝处理', async () => {
    const store = new MemoryStore();
    store.seed('staff-1', 'approved');
    const whitelist = service(store, {
      resolveOpenId: async () => null,
    });

    await expect(
      whitelist.isOpenIdAllowed('open-unknown', '陌生人'),
    ).resolves.toBe(false);
  });

  it('应用通讯录失败时回退到 DWS 来源并保留已授权状态', async () => {
    const store = new MemoryStore();
    store.seed('staff-1', 'approved', '旧名字');
    const failing: DirectorySource = {
      name: 'dingtalk-api',
      fetchUsers: async () => {
        throw new Error('权限范围不足');
      },
    };
    const dws: DirectorySource = {
      name: 'dws',
      fetchUsers: async () => [
        { staffId: 'staff-1', name: '张三', deptPath: '技术部/大数据组' },
        { staffId: 'staff-2', name: '李四', deptPath: '技术部/后端组' },
      ],
    };
    const whitelist = service(store, { sources: [failing, dws] });

    const result = await whitelist.sync();
    expect(result).toMatchObject({
      source: 'dws',
      scanned: 2,
      created: 1,
      updated: 1,
      unchanged: 0,
    });
    expect(result.warnings[0]).toContain('权限范围不足');
    expect(store.rows.get('staff-1')?.status).toBe('approved');
    expect(store.rows.get('staff-2')?.status).toBe('pending');
  });

  it('所有通讯录来源失败时抛出汇总错误', async () => {
    const store = new MemoryStore();
    const whitelist = service(store, {
      sources: [
        {
          name: 'dingtalk-api',
          fetchUsers: async () => {
            throw new Error('A 失败');
          },
        },
        {
          name: 'dws',
          fetchUsers: async () => {
            throw new Error('B 失败');
          },
        },
      ],
    });

    await expect(whitelist.sync()).rejects.toThrow(
      /通讯录同步失败.*A 失败.*B 失败/s,
    );
  });

  it('通讯录返回 0 人时按来源失败处理并回退到下一个来源', async () => {
    const store = new MemoryStore();
    const empty: DirectorySource = {
      name: 'dingtalk-api',
      fetchUsers: async () => [],
    };
    const dws: DirectorySource = {
      name: 'dws',
      fetchUsers: async () => [
        { staffId: 'staff-1', name: '张三', deptPath: '技术部' },
      ],
    };
    const whitelist = service(store, { sources: [empty, dws] });

    const result = await whitelist.sync();
    expect(result.source).toBe('dws');
    expect(result.scanned).toBe(1);
    expect(result.warnings.join()).toContain('未返回任何员工');
  });

  it('通讯录中消失的员工被标记为已离职并停止放行', async () => {
    const store = new MemoryStore();
    store.seed('staff-1', 'approved', '张三', 'dws');
    store.seed('staff-2', 'approved', '李四', 'dws');
    const dws: DirectorySource = {
      name: 'dws',
      fetchUsers: async () => [
        { staffId: 'staff-1', name: '张三', deptPath: '技术部' },
      ],
    };
    const whitelist = service(store, { sources: [dws] });

    const result = await whitelist.sync();
    expect(result.left).toBe(1);
    expect(store.rows.get('staff-2')?.status).toBe('left');
    await expect(whitelist.isStaffAllowed('staff-2')).resolves.toBe(false);
    await expect(whitelist.isStaffAllowed('staff-1')).resolves.toBe(true);
  });

  it('离职员工重新出现在通讯录时回到待授权', async () => {
    const store = new MemoryStore();
    store.seed('staff-1', 'left', '张三', 'dws');
    const dws: DirectorySource = {
      name: 'dws',
      fetchUsers: async () => [
        { staffId: 'staff-1', name: '张三', deptPath: '技术部' },
      ],
    };
    const whitelist = service(store, { sources: [dws] });

    await whitelist.sync();
    expect(store.rows.get('staff-1')?.status).toBe('pending');
    await expect(whitelist.isStaffAllowed('staff-1')).resolves.toBe(false);
  });

  it('手动录入的条目不因通讯录缺失被标记为离职', async () => {
    const store = new MemoryStore();
    store.seed('staff-manual', 'approved', '手动录入');
    const dws: DirectorySource = {
      name: 'dws',
      fetchUsers: async () => [
        { staffId: 'staff-1', name: '张三', deptPath: '技术部' },
      ],
    };
    const whitelist = service(store, { sources: [dws] });

    await whitelist.sync();
    expect(store.rows.get('staff-manual')?.status).toBe('approved');
  });

  it('通讯录人数骤降时不做离职判定并给出告警', async () => {
    const store = new MemoryStore();
    for (const id of ['s1', 's2', 's3', 's4']) {
      store.seed(id, 'approved', id, 'dws');
    }
    const dws: DirectorySource = {
      name: 'dws',
      fetchUsers: async () => [{ staffId: 's1', name: 's1', deptPath: '技术部' }],
    };
    const whitelist = service(store, { sources: [dws] });

    const result = await whitelist.sync();
    expect(result.left).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.warnings.join()).toContain('离职状态未判定');
    expect(store.rows.get('s2')?.status).toBe('approved');
  });

  it('应用通讯录只覆盖部分部门时回退到覆盖完整的来源', async () => {
    const store = new MemoryStore();
    for (const id of ['s1', 's2', 's3', 's4']) {
      store.seed(id, 'approved', id, 'dws');
    }
    const partial: DirectorySource = {
      name: 'dingtalk-api',
      fetchUsers: async () => [{ staffId: 's1', name: 's1', deptPath: '技术部' }],
    };
    const full: DirectorySource = {
      name: 'dws',
      fetchUsers: async () =>
        ['s1', 's2', 's3', 's4'].map((id) => ({
          staffId: id,
          name: id,
          deptPath: '技术部',
        })),
    };
    const whitelist = service(store, { sources: [partial, full] });

    const result = await whitelist.sync();
    expect(result.source).toBe('dws');
    expect(result.scanned).toBe(4);
    expect(result.warnings.join()).toContain('权限范围不足');
    expect(store.rows.get('s4')?.status).toBe('approved');
  });
});
