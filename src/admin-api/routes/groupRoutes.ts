import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  GroupWorkspaceAdminPort,
} from '../../types/group-workspace.js';
import type { ThinkingMode } from '../../types/core.js';
import {
  isGroupGoalStatus,
  isGroupTaskStatus,
} from '../../types/group-workspace.js';
import { parseDueAt } from '../../groups/GroupWorkspaceService.js';
import type { GroupModelRouteService } from '../../groups/GroupModelRouteService.js';
import {
  readBoolean,
  readJsonBody,
  readNumber,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface GroupRouteDeps {
  configCenter: DynamicConfigCenter;
  workspace: GroupWorkspaceAdminPort;
  modelRoutes: GroupModelRouteService;
}

function readDueAt(body: Record<string, unknown>): number | null | undefined {
  const value = body.due ?? body.dueAt;
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HTTPException(400, { message: 'due 必须是日期字符串或时间戳' });
  }
  const parsed = parseDueAt(value);
  if (parsed === null) {
    throw new HTTPException(400, { message: 'due 无法解析，请用 YYYY-MM-DD 或 ISO 时间' });
  }
  return parsed;
}

function readStatus(body: Record<string, unknown>): string | undefined {
  const status = readString(body, 'status')?.trim();
  return status === '' ? undefined : status;
}

function readProgress(body: Record<string, unknown>): number | undefined {
  const progress = readNumber(body, 'progress');
  if (progress === undefined) return undefined;
  if (progress < 0 || progress > 100) {
    throw new HTTPException(400, { message: 'progress 必须在 0–100 之间' });
  }
  return Math.round(progress);
}

function readGoalId(body: Record<string, unknown>): string | null | undefined {
  const value = body.goalId ?? body.goal;
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new HTTPException(400, { message: 'goalId 必须是字符串' });
  }
  return value.trim() || null;
}

export function createGroupRoutes(deps: GroupRouteDeps): Hono {
  const app = new Hono();
  const actorOf = (c: Parameters<typeof webActor>[0]): string => webActor(c);

  app.get('/groups/:conversationId/workspace', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    if (!conversationId) {
      throw new HTTPException(400, { message: 'conversationId 不能为空' });
    }
    return c.json({
      ok: true,
      ...(await deps.workspace.snapshot(conversationId)),
    });
  });

  app.put('/groups/:conversationId/workspace', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const body = await readJsonBody(c);
    const before = await deps.workspace.snapshot(conversationId);
    const workspace = await deps.workspace.updateWorkspace(
      conversationId,
      {
        ...(readString(body, 'title') !== undefined
          ? { title: readString(body, 'title')! }
          : {}),
        ...(readString(body, 'purpose') !== undefined
          ? { purpose: readString(body, 'purpose')! }
          : {}),
        ...(readStringArray(body, 'responsibilities') !== undefined
          ? { responsibilities: readStringArray(body, 'responsibilities')! }
          : {}),
      },
      actorOf(c),
    );
    await recordWebAudit(
      deps.configCenter,
      actorOf(c),
      'UPDATE_GROUP_WORKSPACE',
      { ...before.workspace },
      { ...workspace },
    );
    return c.json({ ok: true, workspace });
  });

  app.post('/groups/:conversationId/goals', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const body = await readJsonBody(c);
    const title = readString(body, 'title', { required: true })?.trim();
    if (!title) {
      throw new HTTPException(400, { message: '目标标题不能为空' });
    }
    const dueAt = readDueAt(body);
    const progress = readProgress(body);
    const goal = await deps.workspace.createGoal(
      conversationId,
      {
        title,
        ...(readString(body, 'detail') !== undefined
          ? { detail: readString(body, 'detail')! }
          : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(readString(body, 'ownerName') !== undefined
          ? { ownerName: readString(body, 'ownerName')! }
          : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
      },
      actorOf(c),
    );
    await recordWebAudit(
      deps.configCenter,
      actorOf(c),
      'UPDATE_GROUP_GOAL',
      {},
      { ...goal },
    );
    return c.json({ ok: true, goal });
  });

  app.put('/groups/:conversationId/goals/:goalId', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const goalId = c.req.param('goalId').trim();
    const body = await readJsonBody(c);
    const status = readStatus(body);
    if (status && !isGroupGoalStatus(status)) {
      throw new HTTPException(400, { message: `未知目标状态：${status}` });
    }
    const title = readString(body, 'title');
    if (title !== undefined && !title.trim()) {
      throw new HTTPException(400, { message: '目标标题不能为空' });
    }
    const dueAt = readDueAt(body);
    const progress = readProgress(body);
    const before = (await deps.workspace.snapshot(conversationId)).goals.find(
      (goal) => goal.id === goalId,
    );
    const goal = await deps.workspace.updateGoal(
      conversationId,
      goalId,
      {
        ...(title !== undefined ? { title } : {}),
        ...(readString(body, 'detail') !== undefined
          ? { detail: readString(body, 'detail')! }
          : {}),
        ...(status && isGroupGoalStatus(status) ? { status } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(readString(body, 'ownerName') !== undefined
          ? { ownerName: readString(body, 'ownerName')! }
          : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
      },
      actorOf(c),
    );
    await recordWebAudit(
      deps.configCenter,
      actorOf(c),
      'UPDATE_GROUP_GOAL',
      before ? { ...before } : {},
      { ...goal },
    );
    return c.json({ ok: true, goal });
  });

  app.delete('/groups/:conversationId/goals/:goalId', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const goalId = c.req.param('goalId').trim();
    const removed = await deps.workspace.removeGoal(conversationId, goalId);
    if (removed) {
      await recordWebAudit(
        deps.configCenter,
        actorOf(c),
        'DELETE_GROUP_GOAL',
        { conversationId, goalId },
        {},
      );
    }
    return c.json({ ok: true, removed });
  });

  app.post('/groups/:conversationId/tasks', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const body = await readJsonBody(c);
    const title = readString(body, 'title', { required: true })?.trim();
    if (!title) {
      throw new HTTPException(400, { message: '任务标题不能为空' });
    }
    const dueAt = readDueAt(body);
    const goalId = readGoalId(body);
    const task = await deps.workspace.createTask(
      conversationId,
      {
        title,
        ...(readString(body, 'detail') !== undefined
          ? { detail: readString(body, 'detail')! }
          : {}),
        ...(goalId !== undefined ? { goalId } : {}),
        ...(readString(body, 'assigneeName') !== undefined
          ? { assigneeName: readString(body, 'assigneeName')! }
          : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
      },
      actorOf(c),
    );
    await recordWebAudit(
      deps.configCenter,
      actorOf(c),
      'UPDATE_GROUP_TASK',
      {},
      { ...task },
    );
    return c.json({ ok: true, task });
  });

  app.put('/groups/:conversationId/tasks/:taskId', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const taskId = c.req.param('taskId').trim();
    const body = await readJsonBody(c);
    const status = readStatus(body);
    if (status && !isGroupTaskStatus(status)) {
      throw new HTTPException(400, { message: `未知任务状态：${status}` });
    }
    const title = readString(body, 'title');
    if (title !== undefined && !title.trim()) {
      throw new HTTPException(400, { message: '任务标题不能为空' });
    }
    const dueAt = readDueAt(body);
    const goalId = readGoalId(body);
    const before = (await deps.workspace.snapshot(conversationId)).tasks.find(
      (task) => task.id === taskId,
    );
    const task = await deps.workspace.updateTask(
      conversationId,
      taskId,
      {
        ...(title !== undefined ? { title } : {}),
        ...(readString(body, 'detail') !== undefined
          ? { detail: readString(body, 'detail')! }
          : {}),
        ...(status && isGroupTaskStatus(status) ? { status } : {}),
        ...(goalId !== undefined ? { goalId } : {}),
        ...(readString(body, 'assigneeName') !== undefined
          ? { assigneeName: readString(body, 'assigneeName')! }
          : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
      },
      actorOf(c),
    );
    await recordWebAudit(
      deps.configCenter,
      actorOf(c),
      'UPDATE_GROUP_TASK',
      before ? { ...before } : {},
      { ...task },
    );
    return c.json({ ok: true, task });
  });

  app.delete('/groups/:conversationId/tasks/:taskId', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const taskId = c.req.param('taskId').trim();
    const removed = await deps.workspace.removeTask(conversationId, taskId);
    if (removed) {
      await recordWebAudit(
        deps.configCenter,
        actorOf(c),
        'DELETE_GROUP_TASK',
        { conversationId, taskId },
        {},
      );
    }
    return c.json({ ok: true, removed });
  });

  app.get('/group-model-routes', async (c) => {
    const routes = await deps.modelRoutes.list();
    return c.json({ ok: true, routes });
  });

  app.get('/groups/:conversationId/model-route', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const route = await deps.modelRoutes.get(conversationId);
    if (!route) return c.json({ ok: true, route: null });
    return c.json({
      ok: true,
      route,
      apiKeyConfigured: route.apiKeyEnv
        ? Boolean(process.env[route.apiKeyEnv]?.trim())
        : false,
    });
  });

  app.put('/groups/:conversationId/model-route', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const body = await readJsonBody(c);
    const provider = readString(body, 'provider');
    if (
      provider !== undefined &&
      provider !== '' &&
      provider !== 'openai-compatible' &&
      provider !== 'anthropic'
    ) {
      throw new HTTPException(400, {
        message: 'provider 必须是 openai-compatible 或 anthropic',
      });
    }
    const thinking = readString(body, 'thinking');
    const temperature =
      body.temperature === null
        ? null
        : readNumber(body, 'temperature');
    const maxTokens =
      body.maxTokens === null ? null : readNumber(body, 'maxTokens');
    const enabled = readBoolean(body, 'enabled');
    const before = await deps.modelRoutes.get(conversationId);
    let route;
    try {
      route = await deps.modelRoutes.update(
        conversationId,
        {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(provider !== undefined
            ? { provider: provider as 'openai-compatible' | 'anthropic' | '' }
            : {}),
          ...(readString(body, 'baseUrl') !== undefined
            ? { baseUrl: readString(body, 'baseUrl')! }
            : {}),
          ...(readString(body, 'apiKeyEnv') !== undefined
            ? { apiKeyEnv: readString(body, 'apiKeyEnv')! }
            : {}),
          ...(readString(body, 'model') !== undefined
            ? { model: readString(body, 'model')! }
            : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(thinking !== undefined
            ? { thinking: thinking as ThinkingMode | '' }
            : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        },
        actorOf(c),
      );
    } catch (error) {
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await recordWebAudit(
      deps.configCenter,
      actorOf(c),
      'UPDATE_GROUP_MODEL_ROUTE',
      before ? { ...before } : {},
      { ...route },
    );
    return c.json({
      ok: true,
      route,
      apiKeyConfigured: route.apiKeyEnv
        ? Boolean(process.env[route.apiKeyEnv]?.trim())
        : false,
    });
  });

  app.delete('/groups/:conversationId/model-route', async (c) => {
    const conversationId = c.req.param('conversationId').trim();
    const removed = await deps.modelRoutes.remove(conversationId);
    if (removed) {
      await recordWebAudit(
        deps.configCenter,
        actorOf(c),
        'DELETE_GROUP_MODEL_ROUTE',
        { conversationId },
        {},
      );
    }
    return c.json({ ok: true, removed });
  });

  return app;
}
