import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type {
  GroupGoalRecord,
  GroupGoalStatus,
  GroupTaskRecord,
  GroupTaskStatus,
  GroupWorkspaceRecord,
  GroupWorkspaceStore,
} from '../types/group-workspace.js';
import {
  GroupWorkspaceService,
  parseDueAt,
} from './GroupWorkspaceService.js';
import type { GroupWorkspaceMemoryNote } from './GroupWorkspaceService.js';

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

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-group-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '',
    rawPayload: {},
    timestamp: NOW,
    ...overrides,
  };
}

function makeService(
  options: { saveNote?: (note: GroupWorkspaceMemoryNote) => Promise<void> } = {},
) {
  const store = new MemoryGroupStore();
  const service = new GroupWorkspaceService({
    store,
    isAdmin: (staffId) => staffId === 'staff-admin',
    ...(options.saveNote ? { saveNote: options.saveNote } : {}),
    now: () => NOW,
  });
  return { store, service };
}

describe('parseDueAt', () => {
  it('日期按上海当天 23:59:59 解析，非法值返回 null', () => {
    expect(parseDueAt('2026-11-30')).toBe(
      Date.parse('2026-11-30T23:59:59+08:00'),
    );
    expect(parseDueAt(NOW)).toBe(NOW);
    expect(parseDueAt('')).toBeNull();
    expect(parseDueAt('not-a-date')).toBeNull();
    expect(parseDueAt(-1)).toBeNull();
  });
});

describe('GroupWorkspaceService', () => {
  it('未配置时返回空工作区快照', async () => {
    const { service } = makeService();
    const snapshot = await service.snapshot('cid-group-1');
    expect(snapshot.workspace.conversationId).toBe('cid-group-1');
    expect(snapshot.workspace.purpose).toBe('');
    expect(snapshot.goals).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
  });

  it('更新工作区时去重职责并保留未提交字段', async () => {
    const { service } = makeService();
    await service.updateWorkspace(
      'cid-group-1',
      {
        title: '售前支持群',
        purpose: '承接华东区售前咨询',
        responsibilities: [' 答疑 ', '答疑', '方案支持', ''],
      },
      'staff:1',
    );
    const updated = await service.updateWorkspace(
      'cid-group-1',
      { purpose: '承接华东区售前咨询与 POC' },
      'staff:2',
    );
    expect(updated.title).toBe('售前支持群');
    expect(updated.responsibilities).toEqual(['答疑', '方案支持']);
    expect(updated.purpose).toBe('承接华东区售前咨询与 POC');
    expect(updated.updatedBy).toBe('staff:2');
  });

  it('单聊不可使用群工作区指令', async () => {
    const { service } = makeService();
    const reply = await service.handleCommand(
      message({ conversationType: '1' }),
      ['show'],
      'staff:1',
    );
    expect(reply).toContain('只能在群聊里使用');
  });

  it('通过 /group 指令维护群定位、目标与任务', async () => {
    const { service, store } = makeService();
    expect(
      await service.handleCommand(message(), ['purpose', '负责', '售后'], 'staff:1'),
    ).toBe('已更新本群定位。');

    expect(
      await service.handleCommand(
        message(),
        ['responsibility', 'add', '故障复盘'],
        'staff:1',
      ),
    ).toContain('已加入群职责');
    expect(
      await service.handleCommand(
        message(),
        ['responsibility', 'add', '故障复盘'],
        'staff:1',
      ),
    ).toBe('该职责已存在。');

    const goalReply = await service.handleCommand(
      message(),
      ['goal', 'add', '季度续约率', '达到', '90%', '--due', '2026-11-30'],
      'staff:1',
    );
    expect(goalReply).toContain('已创建群目标');
    const goal = store.goals[0]!;
    expect(goal.title).toBe('季度续约率 达到 90%');
    expect(goal.status).toBe('active');
    expect(goal.dueAt).toBe(Date.parse('2026-11-30T23:59:59+08:00'));

    const taskReply = await service.handleCommand(
      message(),
      ['task', 'add', '整理续约清单'],
      'staff:1',
    );
    expect(taskReply).toContain('已创建群任务');
    const task = store.tasks[0]!;
    expect(task.status).toBe('todo');

    expect(
      await service.handleCommand(
        message(),
        ['task', 'start', task.id.slice(0, 8)],
        'staff:1',
      ),
    ).toContain('进行中');
    const done = await service.handleCommand(
      message(),
      ['task', 'done', task.id],
      'staff:1',
    );
    expect(done).toContain('已完成');
    expect(store.tasks[0]!.completedAt).toBe(NOW);

    const view = await service.handleCommand(message(), [], 'staff:1');
    expect(view).toContain('定位：负责 售后');
    expect(view).toContain('故障复盘');
    expect(view).toContain('季度续约率 达到 90%');
  });

  it('非创建人非管理员不能变更目标或任务状态', async () => {
    const { service, store } = makeService();
    const goal = await service.createGoal(
      'cid-group-1',
      { title: '达成 SLA' },
      'staff:creator',
    );
    const denied = await service.handleCommand(
      message({ senderStaffId: 'staff-2' }),
      ['goal', 'done', goal.id],
      'staff:2',
    );
    expect(denied).toContain('只有创建人或管理员');
    expect(store.goals[0]!.status).toBe('active');

    const allowed = await service.handleCommand(
      message({ senderStaffId: 'staff-admin' }),
      ['goal', 'done', goal.id],
      'staff:admin',
    );
    expect(allowed).toContain('已达成');
    expect(store.goals[0]!.status).toBe('achieved');
  });

  it('/group note 未配置记忆端口时提示未启用，配置后写入群记忆', async () => {
    const { service: disabled } = makeService();
    expect(
      await disabled.handleCommand(message(), ['note', '客户偏好'], 'staff:1'),
    ).toBe('手动群记忆未启用。');

    const saveNote = vi.fn(async () => {});
    const { service } = makeService({ saveNote });
    const reply = await service.handleCommand(
      message({ messageId: 'msg-note' }),
      ['note', '客户只在周五下午开评审会'],
      'staff:1',
    );
    expect(reply).toContain('已沉淀为本群记忆');
    expect(saveNote).toHaveBeenCalledWith({
      conversationId: 'cid-group-1',
      content: '客户只在周五下午开评审会',
      keywords: [],
      createdBy: 'staff:1',
      sourceMessageId: 'msg-note',
    });
  });

  it('简报空配置返回空串，并只包含进行中的目标与待办任务', async () => {
    const { service, store } = makeService();
    expect(await service.buildBrief('cid-group-1')).toBe('');

    await service.updateWorkspace(
      'cid-group-1',
      {
        purpose: '负责华东区售后',
        responsibilities: ['故障响应'],
      },
      'staff:1',
    );
    await service.createGoal('cid-group-1', { title: 'SLA 达标' }, 'staff:1');
    const achieved = await service.createGoal(
      'cid-group-1',
      { title: '旧目标' },
      'staff:1',
    );
    await service.updateGoal(
      'cid-group-1',
      achieved.id,
      { status: 'achieved' as GroupGoalStatus },
      'staff:1',
    );
    await service.createTask('cid-group-1', { title: '整理复盘' }, 'staff:1');
    const doneTask = await service.createTask(
      'cid-group-1',
      { title: '已归档任务' },
      'staff:1',
    );
    Object.assign(store.tasks.find((task) => task.id === doneTask.id)!, {
      status: 'done' as GroupTaskStatus,
    });

    const brief = await service.buildBrief('cid-group-1');
    expect(brief).toContain('【本群工作区】');
    expect(brief).toContain('群定位：负责华东区售后');
    expect(brief).toContain('故障响应');
    expect(brief).toContain('SLA 达标');
    expect(brief).not.toContain('旧目标');
    expect(brief).toContain('整理复盘');
    expect(brief).not.toContain('已归档任务');

    const clipped = await service.buildBrief('cid-group-1', 30);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBe(31);
  });
});
