import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type { GroupModelRouteService } from '../../groups/GroupModelRouteService.js';
import type {
  GroupGoalRecord,
  GroupModelRoute,
  GroupTaskRecord,
  GroupWorkspaceAdminPort,
  GroupWorkspaceRecord,
  GroupWorkspaceSnapshot,
} from '../../types/group-workspace.js';
import { createGroupRoutes } from './groupRoutes.js';

const NOW = new Date('2026-11-01T10:00:00Z').getTime();

function workspaceRecord(
  conversationId: string,
): GroupWorkspaceRecord {
  return {
    conversationId,
    title: '',
    purpose: '',
    responsibilities: [],
    updatedBy: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function goalRecord(conversationId: string): GroupGoalRecord {
  return {
    id: 'goal-0001',
    conversationId,
    title: '季度续约率 90%',
    detail: '',
    status: 'active',
    ownerPersonKey: null,
    ownerName: '',
    dueAt: null,
    createdBy: 'admin-1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function taskRecord(conversationId: string): GroupTaskRecord {
  return {
    id: 'task-0001',
    conversationId,
    title: '整理续约清单',
    detail: '',
    status: 'todo',
    assigneePersonKey: null,
    assigneeName: '',
    dueAt: null,
    createdBy: 'admin-1',
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

function routeRecord(conversationId: string): GroupModelRoute {
  return {
    conversationId,
    enabled: true,
    provider: '',
    baseUrl: '',
    apiKeyEnv: '',
    model: 'qwen-max',
    temperature: null,
    thinking: '',
    maxTokens: null,
    updatedBy: 'admin-1',
    updatedAt: NOW,
  };
}

function setup() {
  const recordAudit = vi.fn(async () => ({}));
  const configCenter = { recordAudit } as unknown as DynamicConfigCenter;
  const workspace = {
    snapshot: vi.fn(
      async (conversationId: string): Promise<GroupWorkspaceSnapshot> => ({
        workspace: workspaceRecord(conversationId),
        goals: [goalRecord(conversationId)],
        tasks: [taskRecord(conversationId)],
      }),
    ),
    updateWorkspace: vi.fn(
      async (conversationId: string, input, actor: string) => ({
        ...workspaceRecord(conversationId),
        ...input,
        updatedBy: actor,
      }),
    ),
    createGoal: vi.fn(async (conversationId: string, input, actor: string) => ({
      ...goalRecord(conversationId),
      ...input,
      createdBy: actor,
    })),
    updateGoal: vi.fn(
      async (conversationId: string, _goalId: string, input, _actor: string) => ({
        ...goalRecord(conversationId),
        ...input,
      }),
    ),
    removeGoal: vi.fn(async () => true),
    createTask: vi.fn(async (conversationId: string, input, actor: string) => ({
      ...taskRecord(conversationId),
      ...input,
      createdBy: actor,
    })),
    updateTask: vi.fn(
      async (conversationId: string, _taskId: string, input, _actor: string) => ({
        ...taskRecord(conversationId),
        ...input,
      }),
    ),
    removeTask: vi.fn(async () => true),
  };
  const modelRoutes = {
    list: vi.fn(async () => [routeRecord('cid-group-1')]),
    get: vi.fn(async (_conversationId: string) => null as GroupModelRoute | null),
    update: vi.fn(
      async (conversationId: string, input, actor: string) => ({
        ...routeRecord(conversationId),
        ...input,
        updatedBy: actor,
      }),
    ),
    remove: vi.fn(async () => true),
  };
  const app = new Hono().route(
    '/api/v1/admin',
    createGroupRoutes({
      configCenter,
      workspace: workspace as unknown as GroupWorkspaceAdminPort,
      modelRoutes: modelRoutes as unknown as GroupModelRouteService,
    }),
  );
  return { app, workspace, modelRoutes, recordAudit };
}

afterEach(() => {
  delete process.env.GROUP_ROUTE_TEST_KEY;
});

describe('群工作区管理接口', () => {
  it('GET workspace 返回快照', async () => {
    const { app, workspace } = setup();
    const response = await app.request(
      '/api/v1/admin/groups/cid-group-1/workspace',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as GroupWorkspaceSnapshot & {
      ok: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.workspace.conversationId).toBe('cid-group-1');
    expect(workspace.snapshot).toHaveBeenCalledWith('cid-group-1');
  });

  it('PUT workspace 透传字段并写审计', async () => {
    const { app, workspace, recordAudit } = setup();
    const response = await app.request(
      '/api/v1/admin/groups/cid-group-1/workspace',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-admin-staff-id': 'admin-1',
        },
        body: JSON.stringify({
          title: '售前群',
          purpose: '承接华东区售前咨询',
          responsibilities: ['答疑', '方案支持'],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(workspace.updateWorkspace).toHaveBeenCalledWith(
      'cid-group-1',
      {
        title: '售前群',
        purpose: '承接华东区售前咨询',
        responsibilities: ['答疑', '方案支持'],
      },
      'admin-1',
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminStaffId: 'admin-1',
        actionType: 'UPDATE_GROUP_WORKSPACE',
      }),
    );
  });

  it('POST goals 解析 due 日期，非法日期返回 400', async () => {
    const { app, workspace } = setup();
    const ok = await app.request(
      '/api/v1/admin/groups/cid-group-1/goals',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '季度续约率 90%',
          detail: '重点客户',
          due: '2026-11-30',
        }),
      },
    );
    expect(ok.status).toBe(200);
    expect(workspace.createGoal).toHaveBeenCalledWith(
      'cid-group-1',
      expect.objectContaining({
        title: '季度续约率 90%',
        detail: '重点客户',
        dueAt: Date.parse('2026-11-30T23:59:59+08:00'),
      }),
      expect.any(String),
    );

    const bad = await app.request(
      '/api/v1/admin/groups/cid-group-1/goals',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '目标', due: 'not-a-date' }),
      },
    );
    expect(bad.status).toBe(400);
    expect(workspace.createGoal).toHaveBeenCalledTimes(1);
  });

  it('PUT goals 拒绝空白标题', async () => {
    const { app, workspace } = setup();
    const response = await app.request(
      '/api/v1/admin/groups/cid-group-1/goals/goal-0001',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   ' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('目标标题不能为空');
    expect(workspace.updateGoal).not.toHaveBeenCalled();
  });

  it('PUT goals 拒绝未知状态，DELETE 记录审计', async () => {
    const { app, workspace, recordAudit } = setup();
    const bad = await app.request(
      '/api/v1/admin/groups/cid-group-1/goals/goal-0001',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'unknown' }),
      },
    );
    expect(bad.status).toBe(400);
    expect(workspace.updateGoal).not.toHaveBeenCalled();

    const ok = await app.request(
      '/api/v1/admin/groups/cid-group-1/goals/goal-0001',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'achieved', ownerName: '李四' }),
      },
    );
    expect(ok.status).toBe(200);
    expect(workspace.updateGoal).toHaveBeenCalledWith(
      'cid-group-1',
      'goal-0001',
      { status: 'achieved', ownerName: '李四' },
      expect.any(String),
    );

    const removed = await app.request(
      '/api/v1/admin/groups/cid-group-1/goals/goal-0001',
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(workspace.removeGoal).toHaveBeenCalledWith(
      'cid-group-1',
      'goal-0001',
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'DELETE_GROUP_GOAL' }),
    );
  });

  it('PUT tasks 拒绝空白标题', async () => {
    const { app, workspace } = setup();
    const response = await app.request(
      '/api/v1/admin/groups/cid-group-1/tasks/task-0001',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('任务标题不能为空');
    expect(workspace.updateTask).not.toHaveBeenCalled();
  });

  it('任务接口支持创建、完成与删除', async () => {
    const { app, workspace, recordAudit } = setup();
    const created = await app.request(
      '/api/v1/admin/groups/cid-group-1/tasks',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: '整理续约清单',
          assigneeName: '张三',
          dueAt: NOW,
        }),
      },
    );
    expect(created.status).toBe(200);
    expect(workspace.createTask).toHaveBeenCalledWith(
      'cid-group-1',
      {
        title: '整理续约清单',
        assigneeName: '张三',
        dueAt: NOW,
      },
      expect.any(String),
    );

    const done = await app.request(
      '/api/v1/admin/groups/cid-group-1/tasks/task-0001',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      },
    );
    expect(done.status).toBe(200);
    expect(workspace.updateTask).toHaveBeenCalledWith(
      'cid-group-1',
      'task-0001',
      { status: 'done' },
      expect.any(String),
    );

    await app.request(
      '/api/v1/admin/groups/cid-group-1/tasks/task-0001',
      { method: 'DELETE' },
    );
    expect(workspace.removeTask).toHaveBeenCalledWith(
      'cid-group-1',
      'task-0001',
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'DELETE_GROUP_TASK' }),
    );
  });
});

describe('按群模型路由接口', () => {
  it('GET 路由列表与单群路由', async () => {
    const { app, modelRoutes } = setup();
    const list = await app.request('/api/v1/admin/group-model-routes');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      ok: boolean;
      routes: GroupModelRoute[];
    };
    expect(listBody.routes).toHaveLength(1);

    const missing = await app.request(
      '/api/v1/admin/groups/cid-missing/model-route',
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true, route: null });

    modelRoutes.get.mockResolvedValueOnce(routeRecord('cid-group-1'));
    const found = await app.request(
      '/api/v1/admin/groups/cid-group-1/model-route',
    );
    const foundBody = (await found.json()) as {
      ok: boolean;
      route: GroupModelRoute;
      apiKeyConfigured: boolean;
    };
    expect(foundBody.route.model).toBe('qwen-max');
    expect(foundBody.apiKeyConfigured).toBe(false);
  });

  it('PUT 校验 provider 并把非法模型翻译为 400', async () => {
    const { app, modelRoutes } = setup();
    const badProvider = await app.request(
      '/api/v1/admin/groups/cid-group-1/model-route',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', model: 'm' }),
      },
    );
    expect(badProvider.status).toBe(400);
    expect(modelRoutes.update).not.toHaveBeenCalled();

    modelRoutes.update.mockRejectedValueOnce(
      new Error('model 不能为空；群路由必须显式指定模型'),
    );
    const badModel = await app.request(
      '/api/v1/admin/groups/cid-group-1/model-route',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: '  ' }),
      },
    );
    expect(badModel.status).toBe(400);
    expect(await badModel.text()).toContain('model 不能为空');
  });

  it('PUT 正常保存并回显密钥是否已在环境变量中配置', async () => {
    const { app, modelRoutes, recordAudit } = setup();
    process.env.GROUP_ROUTE_TEST_KEY = 'sk-test';
    const response = await app.request(
      '/api/v1/admin/groups/cid-group-1/model-route',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-admin-staff-id': 'admin-1',
        },
        body: JSON.stringify({
          provider: 'openai-compatible',
          model: 'qwen-max',
          baseUrl: 'https://example.com/v1',
          apiKeyEnv: 'GROUP_ROUTE_TEST_KEY',
          temperature: 0.3,
          thinking: 'low',
          maxTokens: 4096,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      route: GroupModelRoute;
      apiKeyConfigured: boolean;
    };
    expect(body.apiKeyConfigured).toBe(true);
    expect(body.route).toMatchObject({
      provider: 'openai-compatible',
      model: 'qwen-max',
      apiKeyEnv: 'GROUP_ROUTE_TEST_KEY',
      temperature: 0.3,
      thinking: 'low',
      maxTokens: 4096,
    });
    expect(modelRoutes.update).toHaveBeenCalledWith(
      'cid-group-1',
      {
        provider: 'openai-compatible',
        baseUrl: 'https://example.com/v1',
        apiKeyEnv: 'GROUP_ROUTE_TEST_KEY',
        model: 'qwen-max',
        temperature: 0.3,
        thinking: 'low',
        maxTokens: 4096,
      },
      'admin-1',
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'UPDATE_GROUP_MODEL_ROUTE' }),
    );

    const removed = await app.request(
      '/api/v1/admin/groups/cid-group-1/model-route',
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'DELETE_GROUP_MODEL_ROUTE' }),
    );
  });
});
