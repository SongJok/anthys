import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/core.js';
import { InMemoryTestcaseWorkspaceStore } from '../../testcase/TestcaseWorkspaceStore.js';
import { TestcaseWorkspaceService } from '../../testcase/TestcaseWorkspaceService.js';
import { TestcaseWorkspaceToolProvider } from './TestcaseWorkspaceToolProvider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '测试员工',
    conversationType: '1',
    deadlineAt: 10_000,
    now: () => 1_000,
    ...overrides,
  };
}

function setup() {
  const store = new InMemoryTestcaseWorkspaceStore(() => 1_000, () => 'ws-1');
  const service = new TestcaseWorkspaceService(store, () => 1_000, () => 'ws-1');
  const provider = new TestcaseWorkspaceToolProvider({
    service,
    isAdmin: (staffId) => staffId === 'admin',
  });
  return { provider, service };
}

async function tool(
  provider: TestcaseWorkspaceToolProvider,
  ctx: ExecutionContext,
  name: string,
  args: Record<string, unknown>,
) {
  const definition = (await provider.getTools(ctx)).find((item) => item.name === name);
  if (!definition) throw new Error(`missing tool ${name}`);
  return definition.execute(args, ctx);
}

describe('TestcaseWorkspaceToolProvider', () => {
  it('creates, incrementally updates, reads and compiles a workspace', async () => {
    const { provider } = setup();
    const binding = { current: null as { workspaceId: string; baseRevision: number } | null };
    const ctx = context({ testcaseWorkspaceBinding: binding });
    const tools = await provider.getTools(ctx);
    expect(tools.map((item) => item.name)).toEqual([
      'testcase_workspace_list',
      'testcase_workspace_get',
      'testcase_workspace_select',
      'testcase_workspace_create',
      'testcase_workspace_update',
      'testcase_compile',
    ]);
    expect(tools.find((item) => item.name === 'testcase_workspace_update')).toMatchObject({
      risk: 'write',
      internalWrite: true,
    });

    const created = JSON.parse(
      await tool(provider, ctx, 'testcase_workspace_create', { title: '订单模块' }),
    );
    expect(created.id).toBe('ws-1');
    expect(binding.current).toEqual({ workspaceId: 'ws-1', baseRevision: 1 });

    const updated = await tool(provider, ctx, 'testcase_workspace_update', {
      workspaceId: 'ws-1',
      baseRevision: 1,
      patch: {
        requirements: {
          upsert: [
            {
              id: 'req-order',
              title: '创建订单',
              description: '有效商品可以创建订单',
              module: '订单',
              sourceRef: '用户需求',
              rules: ['1. 商品有效'],
              constraints: [],
              status: 'active',
            },
          ],
        },
        cases: {
          upsert: [
            {
              id: 'draft-order-1',
              module: '订单',
              title: '使用有效商品创建订单',
              preconditions: ['1. 已登录'],
              steps: ['1. 选择有效商品'],
              expectedResults: ['1. 订单创建成功'],
              priority: '高',
              testMethod: '场景法',
              scenarioType: 'normal',
              requirementIds: ['req-order'],
              evidenceIds: [],
              assumptions: [],
              status: 'ready',
            },
          ],
        },
      },
    });
    expect(updated).toContain('revision：2');
    expect(binding.current).toEqual({ workspaceId: 'ws-1', baseRevision: 2 });

    const detail = JSON.parse(
      await tool(provider, ctx, 'testcase_workspace_get', {
        workspaceId: 'ws-1',
        section: 'cases',
      }),
    );
    expect(detail.items).toHaveLength(1);

    const markdown = await tool(provider, ctx, 'testcase_compile', {
      workspaceId: 'ws-1',
      baseRevision: 2,
      format: 'md',
    });
    expect(markdown).toContain('TC_订单_001');
    expect(markdown).toContain('使用有效商品创建订单');
  });

  it('enforces workspace ownership and the active run binding', async () => {
    const { provider, service } = setup();
    await service.create(context(), { title: '私有用例' });
    await expect(
      tool(provider, context({ senderStaffId: 'staff-2' }), 'testcase_workspace_get', {
        workspaceId: 'ws-1',
      }),
    ).rejects.toThrow('无权访问');

    await expect(
      tool(
        provider,
        context({ workspaceId: 'ws-other' }),
        'testcase_workspace_get',
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('不能切换');
  });

  it('supports explicit selection of an older accessible workspace', async () => {
    let nextId = 0;
    const store = new InMemoryTestcaseWorkspaceStore(
      () => 1_000,
      () => `ws-${++nextId}`,
    );
    const service = new TestcaseWorkspaceService(store, () => 1_000, () => 'unused');
    const provider = new TestcaseWorkspaceToolProvider({
      service,
      isAdmin: (staffId) => staffId === 'admin',
    });
    await service.create(context(), { title: '旧工作区' });
    await service.create(context(), { title: '新工作区' });
    const binding = { current: { workspaceId: 'ws-2', baseRevision: 1 } };
    const ctx = context({ workspaceId: 'ws-2', testcaseWorkspaceBinding: binding });

    await expect(
      tool(provider, ctx, 'testcase_workspace_get', { workspaceId: 'ws-1' }),
    ).rejects.toThrow('不能切换');
    await tool(provider, ctx, 'testcase_workspace_select', { workspaceId: 'ws-1' });
    expect(binding.current).toEqual({ workspaceId: 'ws-1', baseRevision: 1 });
    expect(
      await tool(provider, ctx, 'testcase_workspace_get', { workspaceId: 'ws-1' }),
    ).toContain('旧工作区');

    const adminBinding = { current: { workspaceId: 'ws-2', baseRevision: 1 } };
    const adminCtx = context({
      senderStaffId: 'admin',
      workspaceId: 'ws-2',
      testcaseWorkspaceBinding: adminBinding,
    });
    await tool(provider, adminCtx, 'testcase_workspace_select', { workspaceId: 'ws-1' });
    expect(adminBinding.current.workspaceId).toBe('ws-1');

    const jobBinding = { current: { workspaceId: 'ws-1', baseRevision: 1 } };
    await expect(
      tool(
        provider,
        context({ jobId: 'job-1', testcaseWorkspaceBinding: jobBinding }),
        'testcase_workspace_select',
        { workspaceId: 'ws-2' },
      ),
    ).rejects.toThrow('后台任务不能切换');
  });

  it('generates and delivers an artifact only when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthys-testcase-'));
    tempDirs.push(root);
    const sent: string[] = [];
    const store = new InMemoryTestcaseWorkspaceStore(() => 1_000, () => 'ws-1');
    const service = new TestcaseWorkspaceService(store, () => 1_000, () => 'ws-1');
    await service.create(context(), { title: '导出测试' });
    const provider = new TestcaseWorkspaceToolProvider({
      service,
      isAdmin: () => false,
      artifact: {
        allowedRoots: [root],
        sender: {
          send: async (input) => {
            const fileName = input.fileName ?? '用例.md';
            sent.push(fileName);
            return { ok: true, fileName, fileSize: 10 };
          },
        },
      },
    });

    const generated = JSON.parse(
      await tool(provider, context(), 'testcase_compile', {
        workspaceId: 'ws-1',
        baseRevision: 1,
        format: 'md',
        fileName: '用例.md',
      }),
    );
    expect(generated.delivered).toBe(false);
    expect(sent).toEqual([]);
    expect(await readFile(join(root, generated.path), 'utf8')).toContain('功能测试用例');

    const delivered = JSON.parse(
      await tool(provider, context(), 'testcase_compile', {
        workspaceId: 'ws-1',
        baseRevision: 1,
        format: 'md',
        fileName: '用例.md',
        deliver: true,
      }),
    );
    expect(delivered.delivered).toBe(true);
    expect(sent).toEqual(['用例.md']);
  });
});
