import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type {
  GroupGoalRecord,
  GroupTaskRecord,
  GroupWorkspaceRecord,
  GroupWorkspaceStore,
} from '../../types/group-workspace.js';
import {
  GroupWorkspaceService,
  type GroupWorkspaceMemoryNote,
} from '../../groups/GroupWorkspaceService.js';
import { GroupWorkspaceToolProvider } from './GroupWorkspaceToolProvider.js';

const NOW = 1_764_500_000_000;

class MemoryGroupStore implements GroupWorkspaceStore {
  public readonly workspaces = new Map<string, GroupWorkspaceRecord>();
  public readonly goals: GroupGoalRecord[] = [];
  public readonly tasks: GroupTaskRecord[] = [];
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(4, '0')}`;
  }

  public async getWorkspace(
    conversationId: string,
  ): Promise<GroupWorkspaceRecord | null> {
    return this.workspaces.get(conversationId) ?? null;
  }

  public async upsertWorkspace(
    workspace: GroupWorkspaceRecord,
  ): Promise<GroupWorkspaceRecord> {
    const saved = { ...workspace, updatedAt: NOW };
    this.workspaces.set(saved.conversationId, saved);
    return saved;
  }

  public async listGoals(
    conversationId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<GroupGoalRecord[]> {
    return this.goals.filter(
      (goal) =>
        goal.conversationId === conversationId &&
        (options.includeArchived || goal.status !== 'archived'),
    );
  }

  public async getGoal(id: string): Promise<GroupGoalRecord | null> {
    return this.goals.find((goal) => goal.id === id) ?? null;
  }

  public async createGoal(
    goal: Omit<GroupGoalRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GroupGoalRecord> {
    const saved = {
      ...goal,
      id: this.nextId('goal'),
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.goals.push(saved);
    return saved;
  }

  public async updateGoal(
    id: string,
    patch: Partial<
      Pick<
        GroupGoalRecord,
        'title' | 'detail' | 'status' | 'ownerPersonKey' | 'ownerName' | 'dueAt'
      >
    >,
  ): Promise<GroupGoalRecord | null> {
    const goal = this.goals.find((item) => item.id === id);
    if (!goal) return null;
    Object.assign(goal, patch, { updatedAt: NOW });
    return goal;
  }

  public async removeGoal(id: string): Promise<boolean> {
    const index = this.goals.findIndex((goal) => goal.id === id);
    if (index < 0) return false;
    this.goals.splice(index, 1);
    return true;
  }

  public async listTasks(
    conversationId: string,
    options: { includeDone?: boolean } = {},
  ): Promise<GroupTaskRecord[]> {
    return this.tasks.filter(
      (task) =>
        task.conversationId === conversationId &&
        (options.includeDone ||
          (task.status !== 'done' && task.status !== 'cancelled')),
    );
  }

  public async getTask(id: string): Promise<GroupTaskRecord | null> {
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  public async createTask(
    task: Omit<GroupTaskRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GroupTaskRecord> {
    const saved = {
      ...task,
      id: this.nextId('task'),
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.tasks.push(saved);
    return saved;
  }

  public async updateTask(
    id: string,
    patch: Partial<
      Pick<
        GroupTaskRecord,
        | 'title'
        | 'detail'
        | 'status'
        | 'assigneePersonKey'
        | 'assigneeName'
        | 'dueAt'
        | 'completedAt'
      >
    >,
  ): Promise<GroupTaskRecord | null> {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: NOW });
    return task;
  }

  public async removeTask(id: string): Promise<boolean> {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    this.tasks.splice(index, 1);
    return true;
  }
}

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-group-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '2',
    personKey: 'staff:1',
    deadlineAt: NOW + 60_000,
    now: () => NOW,
    ...overrides,
  };
}

function setup(options: { saveNote?: boolean } = {}) {
  const store = new MemoryGroupStore();
  const saved: GroupWorkspaceMemoryNote[] = [];
  const service = new GroupWorkspaceService({
    store,
    isAdmin: (staffId) => staffId === 'staff-admin',
    ...(options.saveNote
      ? {
          saveNote: async (note: GroupWorkspaceMemoryNote) => {
            saved.push(note);
          },
        }
      : {}),
    now: () => NOW,
  });
  const provider = new GroupWorkspaceToolProvider({ service });
  return { store, service, provider, saved };
}

async function toolsOf(
  provider: GroupWorkspaceToolProvider,
  ctx: ExecutionContext,
): Promise<Map<string, ToolDefinition>> {
  return new Map((await provider.getTools(ctx)).map((tool) => [tool.name, tool]));
}

describe('GroupWorkspaceToolProvider', () => {
  it('只在群聊暴露群工作区工具', async () => {
    const { provider } = setup();
    expect(await provider.getTools(context({ conversationType: '1' }))).toEqual(
      [],
    );
    const tools = await toolsOf(provider, context());
    expect([...tools.keys()]).toEqual([
      'group_workspace_view',
      'group_goal_create',
      'group_goal_update',
      'group_task_create',
      'group_task_update',
      'group_memory_save',
    ]);
  });

  it('查看工具在空工作区与已配置工作区返回不同内容', async () => {
    const { service, provider } = setup();
    const view = (await toolsOf(provider, context())).get(
      'group_workspace_view',
    )!;
    expect(await view.execute({}, context())).toContain('尚未配置工作区');

    await service.updateWorkspace(
      'cid-group-1',
      { purpose: '负责华东区售后', responsibilities: ['故障响应'] },
      'staff:1',
    );
    await service.createGoal(
      'cid-group-1',
      { title: 'SLA 达标', ownerName: '张三' },
      'staff:1',
    );
    const text = await view.execute({}, context());
    expect(text).toContain('群定位：负责华东区售后');
    expect(text).toContain('故障响应');
    expect(text).toContain('SLA 达标');
    expect(text).toContain('负责人 张三');
  });

  it('创建目标与任务时解析截止日期并按归一身份记账', async () => {
    const { store, provider } = setup();
    const tools = await toolsOf(provider, context());
    const goalReply = await tools
      .get('group_goal_create')!
      .execute(
        {
          title: '季度续约率 90%',
          detail: '按季度复盘',
          ownerName: ' 张三 ',
          due: '2026-11-30',
        },
        context(),
      );
    expect(goalReply).toContain('已创建群目标');
    expect(store.goals[0]).toMatchObject({
      title: '季度续约率 90%',
      detail: '按季度复盘',
      ownerName: '张三',
      dueAt: Date.parse('2026-11-30T23:59:59+08:00'),
      createdBy: 'staff:1',
    });

    const taskReply = await tools
      .get('group_task_create')!
      .execute({ title: '整理续约清单', assigneeName: '李四' }, context());
    expect(taskReply).toContain('已创建群任务');
    expect(store.tasks[0]).toMatchObject({
      title: '整理续约清单',
      assigneeName: '李四',
      status: 'todo',
      createdBy: 'staff:1',
    });
  });

  it('目标更新校验状态与归属，非创建人不可修改', async () => {
    const { service, provider, store } = setup();
    const goal = await service.createGoal(
      'cid-group-1',
      { title: 'SLA 达标' },
      'staff:1',
    );
    const update = (await toolsOf(provider, context())).get(
      'group_goal_update',
    )!;

    expect(
      await update.execute({ goalId: 'missing', status: 'achieved' }, context()),
    ).toContain('未找到群目标');
    expect(
      await update.execute({ goalId: goal.id, status: 'unknown' }, context()),
    ).toContain('未知目标状态');

    const outsider = context({
      senderStaffId: 'staff-2',
      personKey: 'staff:2',
    });
    const outsiderTools = await toolsOf(provider, outsider);
    const denied = await outsiderTools
      .get('group_goal_update')!
      .execute({ goalId: goal.id, status: 'achieved' }, outsider);
    expect(denied).toContain('只有创建人或管理员');
    expect(store.goals[0]!.status).toBe('active');

    const allowed = await update.execute(
      { goalId: goal.id.slice(0, 8), status: 'achieved' },
      context(),
    );
    expect(allowed).toContain('已更新');
    expect(store.goals[0]!.status).toBe('achieved');
  });

  it('任务更新允许管理员操作，完成时记录完成时间', async () => {
    const { service, provider, store } = setup();
    const task = await service.createTask(
      'cid-group-1',
      { title: '整理复盘' },
      'staff:1',
    );
    const update = (await toolsOf(provider, context())).get(
      'group_task_update',
    )!;

    const outsider = context({
      senderStaffId: 'staff-2',
      personKey: 'staff:2',
    });
    const outsiderTools = await toolsOf(provider, outsider);
    const denied = await outsiderTools
      .get('group_task_update')!
      .execute({ taskId: task.id, status: 'done' }, outsider);
    expect(denied).toContain('只有创建人或管理员');

    const admin = context({
      senderStaffId: 'staff-admin',
      personKey: 'staff:admin',
    });
    const adminTools = await toolsOf(provider, admin);
    const done = await adminTools
      .get('group_task_update')!
      .execute({ taskId: task.id, status: 'done' }, admin);
    expect(done).toContain('已更新');
    expect(store.tasks[0]).toMatchObject({ status: 'done', completedAt: NOW });

    expect(
      await update.execute({ taskId: task.id, status: 'unknown' }, context()),
    ).toContain('未知任务状态');
  });

  it('群记忆工具写入来源消息，未启用时明确提示', async () => {
    const { saved, provider } = setup({ saveNote: true });
    const enabled = (await toolsOf(provider, context())).get(
      'group_memory_save',
    )!;
    const reply = await enabled.execute(
      { content: '客户只在周五下午开评审会', keywords: ['评审会', ' 周五 '] },
      context(),
    );
    expect(reply).toContain('已写入群级语义记忆');
    expect(saved[0]).toMatchObject({
      conversationId: 'cid-group-1',
      content: '客户只在周五下午开评审会',
      keywords: ['评审会', '周五'],
      createdBy: 'staff:1',
      sourceMessageId: 'msg-1',
    });

    const disabled = (await toolsOf(setup().provider, context())).get(
      'group_memory_save',
    )!;
    expect(await disabled.execute({ content: '内容' }, context())).toContain(
      '群记忆写入未启用',
    );
  });
});
