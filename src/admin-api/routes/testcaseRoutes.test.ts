import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import { extractDocument } from '../../documents/DocumentExtractor.js';
import { TestcaseWorkspaceService } from '../../testcase/TestcaseWorkspaceService.js';
import { InMemoryTestcaseWorkspaceStore } from '../../testcase/TestcaseWorkspaceStore.js';
import { createAdminApp } from '../server.js';
import { bindAdminRequestSecurityContext } from './configRoutes.js';
import { createTestcaseRoutes } from './testcaseRoutes.js';

function setup() {
  let seq = 0;
  let now = 1_000;
  const store = new InMemoryTestcaseWorkspaceStore(
    () => (now += 100),
    () => `ws-${++seq}`,
  );
  const service = new TestcaseWorkspaceService(store, () => now, () => 'id');
  const recordAudit = vi.fn(async () => ({}));
  const configCenter = { recordAudit } as unknown as DynamicConfigCenter;
  const app = new Hono();
  app.use('*', async (c, next) => {
    bindAdminRequestSecurityContext(c.req.raw, {
      role: 'admin',
      trustActorHeader: false,
    });
    await next();
  });
  app.route('/', createTestcaseRoutes({ configCenter, workspaces: service }));
  return { app, service, recordAudit };
}

async function seedWorkspace(service: TestcaseWorkspaceService) {
  const actor = {
    senderStaffId: 'staff-1',
    conversationId: 'conv-order',
    conversationType: '1' as const,
  };
  const ws = await service.create(actor, { title: '订单模块测试用例', projectId: 'proj-order' });
  await service.update(actor, ws.id, 1, {
    requirements: {
      upsert: [
        {
          id: 'req-create',
          title: '创建订单',
          description: '支持有效商品下单',
          module: '订单',
          sourceRef: 'PRD 2.1',
          rules: ['校验库存'],
          constraints: [],
          status: 'active',
        },
      ],
    },
    cases: {
      upsert: [
        {
          id: 'case-create-ok',
          module: '订单',
          title: '有效商品下单成功',
          preconditions: ['账号 {{DATA: 买家账号}} 已登录'],
          steps: ['选择商品', '点击提交订单'],
          expectedResults: ['创建订单成功'],
          priority: '高',
          testMethod: '需求分析法+场景法',
          scenarioType: 'normal',
          requirementIds: ['req-create'],
          evidenceIds: [],
          assumptions: [],
          status: 'ready',
        },
      ],
    },
  });
  return ws.id;
}

describe('testcaseRoutes', () => {
  it('supports listing, previewing, updating, compiling, exporting and deleting workspaces', async () => {
    const { app, service, recordAudit } = setup();
    const id = await seedWorkspace(service);

    const listRes = await app.request('/testcases/workspaces?query=订单');
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      items: Array<{ id: string; caseCount: number }>;
    };
    expect(listJson.items).toHaveLength(1);
    expect(listJson.items[0]?.caseCount).toBe(1);

    const detailRes = await app.request(`/testcases/workspaces/${id}`);
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      preview: { cases: Array<{ caseNumber: string }>; statistics: { total: number } };
    };
    expect(detailJson.preview.statistics.total).toBe(1);
    expect(detailJson.preview.cases[0]?.caseNumber).toBe('TC_订单_001');

    const compileRes = await app.request(`/testcases/workspaces/${id}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '基线版' }),
    });
    expect(compileRes.status).toBe(200);
    const compileJson = (await compileRes.json()) as {
      document: { version: number };
    };
    expect(compileJson.document.version).toBe(1);

    const xlsxRes = await app.request(`/testcases/workspaces/${id}/export?format=xlsx&version=1`);
    expect(xlsxRes.status).toBe(200);
    expect(xlsxRes.headers.get('content-disposition')).toContain('attachment;');
    const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
    const parsedXlsx = extractDocument(xlsxBuf, '订单.xlsx');
    expect(parsedXlsx.text).toContain('TC_订单_001');
    expect(parsedXlsx.text).toContain('需求覆盖追溯');

    const docxRes = await app.request(`/testcases/workspaces/${id}/export?format=docx`);
    expect(docxRes.status).toBe(200);
    const parsedDocx = extractDocument(Buffer.from(await docxRes.arrayBuffer()), '订单.docx');
    expect(parsedDocx.text).toContain('有效商品下单成功');

    const csvRes = await app.request(`/testcases/workspaces/${id}/export?format=csv`);
    expect(csvRes.status).toBe(200);
    expect(await csvRes.text()).toContain('TC_订单_001');

    const mdRes = await app.request(`/testcases/workspaces/${id}/export?format=md`);
    expect(mdRes.status).toBe(200);
    expect(await mdRes.text()).toContain('## 订单');

    const patchRes = await app.request(`/testcases/workspaces/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true, title: '订单模块测试用例（已归档）' }),
    });
    expect(patchRes.status).toBe(200);

    const activeOnly = await app.request('/testcases/workspaces?includeArchived=false');
    expect(((await activeOnly.json()) as { items: unknown[] }).items).toHaveLength(0);

    const delRes = await app.request(`/testcases/workspaces/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledTimes(3);
  });

  it('blocks viewerToken on mutating testcase endpoints via admin server RBAC', async () => {
    const store = new InMemoryTestcaseWorkspaceStore(() => 100, () => 'ws-rbac');
    const service = new TestcaseWorkspaceService(store, () => 100, () => 'id');
    const id = await seedWorkspace(service);
    const app = createAdminApp({
      authToken: 'admin-secret',
      viewerToken: 'viewer-secret',
      configCenter: {
        getSystemConfig: () => ({}),
        listGroupPolicies: async () => [],
        recordAudit: vi.fn(async () => ({})),
      } as unknown as DynamicConfigCenter,
      traces: { query: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) } as never,
      groups: { list: async () => [] } as never,
      mcp: { status: () => [], applyServers: async () => [] },
      testcaseWorkspaces: service,
    });

    const getRes = await app.request('/api/v1/admin/testcases/workspaces', {
      headers: { authorization: 'Bearer viewer-secret' },
    });
    expect(getRes.status).toBe(200);

    const compileDenied = await app.request(
      `/api/v1/admin/testcases/workspaces/${id}/compile`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer viewer-secret',
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(compileDenied.status).toBe(403);
  });
});
