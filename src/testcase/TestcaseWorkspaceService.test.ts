import { describe, expect, it } from 'vitest';
import type { TestcaseActor } from './TestcaseWorkspaceService.js';
import {
  TestcaseWorkspaceAccessError,
  TestcaseWorkspaceService,
} from './TestcaseWorkspaceService.js';
import {
  InMemoryTestcaseWorkspaceStore,
  TestcaseRevisionConflictError,
} from './TestcaseWorkspaceStore.js';

const actor: TestcaseActor = {
  senderStaffId: 'staff_1',
  conversationId: 'conv_1',
  conversationType: '1',
};

describe('TestcaseWorkspaceService', () => {
  it('支持分批增量更新且只增加一次 revision', async () => {
    let now = 10;
    const store = new InMemoryTestcaseWorkspaceStore(() => now, () => 'ws_1');
    const service = new TestcaseWorkspaceService(store, () => now, () => 'ws_1');
    const created = await service.create(actor, { title: '订单测试' });
    expect(created.revision).toBe(1);

    now = 20;
    const first = await service.update(actor, created.id, 1, {
      requirements: {
        upsert: [
          {
            id: 'req_order',
            title: '创建订单',
            description: '创建有效订单',
            module: '订单',
            sourceRef: '用户消息 1',
            rules: [],
            constraints: [],
            status: 'active',
          },
        ],
      },
    });
    expect(first.revision).toBe(2);
    expect(first.state.requirements).toHaveLength(1);

    now = 30;
    const second = await service.update(actor, created.id, 2, {
      cases: {
        upsert: [
          {
            id: 'case_order_valid',
            module: '订单',
            title: '创建有效订单',
            preconditions: ['已登录'],
            steps: ['点击创建订单'],
            expectedResults: ['订单创建成功'],
            priority: '高',
            testMethod: '场景法',
            scenarioType: 'normal',
            requirementIds: ['req_order'],
            evidenceIds: [],
            assumptions: [],
            status: 'draft',
          },
        ],
      },
    });
    expect(second.revision).toBe(3);
    expect(second.state.requirements[0]?.id).toBe('req_order');
    expect(second.state.cases).toHaveLength(1);

    const unchanged = await service.update(actor, created.id, 3, {});
    expect(unchanged.revision).toBe(3);
  });

  it('拒绝过期 revision 和跨用户访问', async () => {
    const store = new InMemoryTestcaseWorkspaceStore(() => 1, () => 'ws_1');
    const service = new TestcaseWorkspaceService(store, () => 1, () => 'ws_1');
    const created = await service.create(actor, { title: '权限测试' });
    await service.update(actor, created.id, 1, { title: '权限测试 v2' });

    await expect(
      service.update(actor, created.id, 1, { title: '过期更新' }),
    ).rejects.toBeInstanceOf(TestcaseRevisionConflictError);
    await expect(
      service.get(
        { ...actor, senderStaffId: 'staff_2' },
        created.id,
      ),
    ).rejects.toBeInstanceOf(TestcaseWorkspaceAccessError);
  });

  it('编译生成版本并保留来源 revision', async () => {
    const store = new InMemoryTestcaseWorkspaceStore(() => 1, () => 'ws_1');
    const service = new TestcaseWorkspaceService(store, () => 1, () => 'ws_1');
    const created = await service.create(actor, { title: '空工作区' });
    const document = await service.compile(actor, {
      workspaceId: created.id,
      baseRevision: 1,
      label: '第一版',
      now: 100,
    });
    const versions = await service.versions(actor, created.id);

    expect(document.version).toBe(1);
    expect(document.sourceRevision).toBe(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      sourceRevision: 1,
      label: '第一版',
    });
    expect(service.buildPromptSummary(created)).toContain('workspaceId：ws_1');
  });
});
