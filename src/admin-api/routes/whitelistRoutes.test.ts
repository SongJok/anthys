import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  UserWhitelistAdminPort,
  WhitelistEntry,
  WhitelistPage,
  WhitelistStats,
} from '../../types/whitelist.js';
import { createWhitelistRoutes } from './whitelistRoutes.js';

const NOW = '2026-11-04T10:00:00.000Z';

function entry(status: WhitelistEntry['status'] = 'pending'): WhitelistEntry {
  return {
    staffId: 'staff-1',
    name: '张三',
    deptPath: '技术部/大数据组',
    status,
    source: 'directory',
    openDingTalkId: null,
    note: '',
    approvedBy: null,
    approvedAt: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stats(): WhitelistStats {
  return {
    total: 1,
    pending: 1,
    approved: 0,
    rejected: 0,
    syncedAt: NOW,
  };
}

function setup() {
  const recordAudit = vi.fn(async () => undefined);
  const page: WhitelistPage = {
    items: [entry()],
    total: 1,
    page: 1,
    pageSize: 20,
    stats: stats(),
  };
  const whitelist = {
    list: vi.fn(async () => page),
    stats: vi.fn(async () => stats()),
    sync: vi.fn(async () => ({
      source: 'dws' as const,
      scanned: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      warnings: [],
      syncedAt: NOW,
    })),
    setStatus: vi.fn(async (staffId: string, status: WhitelistEntry['status']) => ({
      ...entry(status),
      staffId,
    })),
    setStatusBatch: vi.fn(async () => 2),
  };
  const configCenter = { recordAudit } as unknown as DynamicConfigCenter;
  const app = createWhitelistRoutes({
    whitelist: whitelist as unknown as UserWhitelistAdminPort,
    configCenter,
  });
  return { app, whitelist, recordAudit };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('用户白名单管理接口', () => {
  it('GET /whitelist 返回分页与统计', async () => {
    const { app, whitelist } = setup();
    const response = await app.request('/whitelist?status=pending&query=张');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; total: number };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(whitelist.list).toHaveBeenCalledWith({
      status: 'pending',
      query: '张',
      page: 1,
      pageSize: 20,
    });
  });

  it('PUT /whitelist/:staffId 校验状态并记录审计', async () => {
    const { app, whitelist, recordAudit } = setup();
    const response = await app.request('/whitelist/staff-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-staff-id': 'admin-1' },
      body: JSON.stringify({ status: 'approved', note: '已确认' }),
    });
    expect(response.status).toBe(200);
    expect(whitelist.setStatus).toHaveBeenCalledWith(
      'staff-1',
      'approved',
      'admin-1',
      '已确认',
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'UPDATE_WHITELIST',
        adminStaffId: 'admin-1',
      }),
    );
  });

  it('PUT /whitelist/:staffId 拒绝非法状态', async () => {
    const { app, whitelist } = setup();
    const response = await app.request('/whitelist/staff-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'whatever' }),
    });
    expect(response.status).toBe(400);
    expect(whitelist.setStatus).not.toHaveBeenCalled();
  });

  it('POST /whitelist/sync 返回来源并记录审计', async () => {
    const { app, recordAudit } = setup();
    const response = await app.request('/whitelist/sync', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { source: string; scanned: number };
    };
    expect(body.result).toMatchObject({ source: 'dws', scanned: 2 });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'SYNC_WHITELIST' }),
    );
  });

  it('POST /whitelist/batch 批量审批', async () => {
    const { app, whitelist, recordAudit } = setup();
    const response = await app.request('/whitelist/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        staffIds: ['staff-1', 'staff-2'],
        status: 'approved',
      }),
    });
    expect(response.status).toBe(200);
    expect(whitelist.setStatusBatch).toHaveBeenCalledWith(
      ['staff-1', 'staff-2'],
      'approved',
      'web-console',
    );
    expect(recordAudit).toHaveBeenCalled();
  });

  it('POST /whitelist/batch 拒绝空列表', async () => {
    const { app } = setup();
    const response = await app.request('/whitelist/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffIds: [], status: 'approved' }),
    });
    expect(response.status).toBe(400);
  });
});
