import type { InboundMessage } from '../types/core.js';
import type {
  GroupGoalRecord,
  GroupGoalStatus,
  GroupTaskRecord,
  GroupTaskStatus,
  GroupWorkspaceAdminPort,
  GroupWorkspaceRecord,
  GroupWorkspaceSnapshot,
  GroupWorkspaceStore,
} from '../types/group-workspace.js';
import {
  groupMemberSubjectKey,
  type SemanticMemoryAdminPort,
  type SemanticMemoryRecord,
} from '../types/bystander-and-memory.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const TITLE_LIMIT = 80;
const PURPOSE_LIMIT = 2_000;
const GOAL_TITLE_LIMIT = 120;
const TASK_TITLE_LIMIT = 120;
const DETAIL_LIMIT = 4_000;
const RESPONSIBILITY_LIMIT = 200;
const BRIEF_LIMIT = 2_000;
const BRIEF_MEMORY_LIMIT = 5;

const GOAL_STATUS_LABELS: Record<GroupGoalStatus, string> = {
  active: '进行中',
  achieved: '已达成',
  paused: '已暂停',
  archived: '已归档',
};

const TASK_STATUS_LABELS: Record<GroupTaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};

const USAGE = [
  '群工作区用法：',
  '- `/group` 查看本群定位、目标与任务',
  '- `/group purpose <内容>` 设置本群长期目标/定位',
  '- `/group responsibility add <内容>` / `remove <内容>` 维护群职责',
  '- `/group goal add <标题> [--due 2026-11-30] [--owner 姓名]` 新建群目标',
  '- `/group goal list` / `/group goal done|pause|resume|archive <ID>`',
  '- `/group goal progress <ID> <0-100|+10|-10>` 更新目标进度',
  '- `/group goal owner|due <ID> <姓名|日期>` 调整负责人或截止时间',
  '- `/group task add <标题> [--goal <目标ID>] [--owner 姓名] [--due 2026-11-30]` 新建群任务',
  '- `/group task list` / `/group task start|done|cancel <ID>`',
  '- `/group task assign|due|link|unlink <ID> ...` 调整负责人、截止时间或关联目标',
  '- `/group note <内容>` 手动沉淀一条群记忆',
  '- `/group memory list|search|forget ...` 查看、检索或删除群记忆（删除需管理员）',
  '- `/group my-memory list|search|add|forget ...` 查看、检索、添加或删除你在本群的专属记忆',
  '- `/group digest` 生成本群目标与任务进度摘要',
  '- `/group report daily 09:00` 定期播报群目标进度（管理员）',
].join('\n');

export interface GroupWorkspaceMemoryNote {
  conversationId: string;
  content: string;
  keywords: string[];
  createdBy: string;
  sourceMessageId?: string;
}

export interface GroupWorkspaceMemberMemoryNote {
  conversationId: string;
  personKey: string;
  speakerNick?: string;
  content: string;
  keywords: string[];
  sourceMessageId?: string;
}

export interface GroupWorkspaceServiceOptions {
  store: GroupWorkspaceStore;
  isAdmin: (staffId: string) => boolean;
  /** 手动群记忆沉淀；未配置时 /group note 只返回不可用提示 */
  saveNote?: (note: GroupWorkspaceMemoryNote) => Promise<void>;
  /** 手动沉淀群内成员在本群的专属记忆（scope = group_member，按群+人隔离） */
  saveMemberNote?: (note: GroupWorkspaceMemberMemoryNote) => Promise<void>;
  /** 群记忆查看与删除；未配置时 /group memory 只返回不可用提示 */
  memories?: SemanticMemoryAdminPort;
  now?: () => number;
}

export function defaultGroupWorkspace(
  conversationId: string,
  now = Date.now(),
): GroupWorkspaceRecord {
  return {
    conversationId,
    title: '',
    purpose: '',
    responsibilities: [],
    updatedBy: '',
    createdAt: now,
    updatedAt: now,
  };
}

/** 支持 YYYY-MM-DD 或 epoch 毫秒；日期按 Asia/Shanghai 当天 23:59:59 计 */
export function parseDueAt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{13}$/u.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (dateOnly) {
    const parsed = Date.parse(
      `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T23:59:59+08:00`,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('群目标进度必须是 0–100 的数字');
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseProgressInput(current: number, raw: string): number | string {
  const text = raw.trim().replace(/%$/u, '');
  const relative = /^([+-])\s*(\d{1,3})$/u.exec(text);
  if (relative) {
    const delta = Number(relative[2]) * (relative[1] === '-' ? -1 : 1);
    return clampProgress(current + delta);
  }
  if (!/^\d{1,3}$/u.test(text)) {
    return '用法：`/group goal progress <ID> <0-100|+10|-10>`。';
  }
  const value = Number(text);
  if (value < 0 || value > 100) {
    return '群目标进度需在 0–100 之间。';
  }
  return value;
}

function dueLabel(dueAt: number | null): string {
  return dueAt ? `截止 ${formatShanghaiDateTime(dueAt)}` : '';
}

function ownerLabel(name: string): string {
  return name.trim() ? `负责人 ${name.trim()}` : '';
}

/**
 * 群工作区：把「这个群负责什么、要达成什么、还有哪些事要做」
 * 变成可维护、可注入提示、可由群成员在对话里直接操作的实体。
 */
export class GroupWorkspaceService implements GroupWorkspaceAdminPort {
  private readonly store: GroupWorkspaceStore;
  private readonly isAdmin: (staffId: string) => boolean;
  private readonly saveNote?: GroupWorkspaceServiceOptions['saveNote'];
  private readonly saveMemberNote?: GroupWorkspaceServiceOptions['saveMemberNote'];
  private readonly memories?: SemanticMemoryAdminPort;
  private readonly now: () => number;

  constructor(options: GroupWorkspaceServiceOptions) {
    this.store = options.store;
    this.isAdmin = options.isAdmin;
    this.saveNote = options.saveNote;
    this.saveMemberNote = options.saveMemberNote;
    this.memories = options.memories;
    this.now = options.now ?? Date.now;
  }

  public hasMemberMemorySupport(): boolean {
    return Boolean(this.saveMemberNote || this.memories);
  }

  public usage(): string {
    return USAGE;
  }

  public async snapshot(conversationId: string): Promise<GroupWorkspaceSnapshot> {
    const [workspace, goals, tasks] = await Promise.all([
      this.store.getWorkspace(conversationId),
      this.store.listGoals(conversationId, { includeArchived: true }),
      this.store.listTasks(conversationId, { includeDone: true }),
    ]);
    return {
      workspace:
        workspace ?? defaultGroupWorkspace(conversationId, this.now()),
      goals,
      tasks,
    };
  }

  public async updateWorkspace(
    conversationId: string,
    input: {
      title?: string;
      purpose?: string;
      responsibilities?: string[];
    },
    actor: string,
  ): Promise<GroupWorkspaceRecord> {
    const before =
      (await this.store.getWorkspace(conversationId)) ??
      defaultGroupWorkspace(conversationId, this.now());
    const responsibilities =
      input.responsibilities === undefined
        ? before.responsibilities
        : [
            ...new Set(
              input.responsibilities
                .map((item) => clip(item, RESPONSIBILITY_LIMIT))
                .filter(Boolean),
            ),
          ].slice(0, 30);
    return this.store.upsertWorkspace({
      ...before,
      ...(input.title !== undefined
        ? { title: clip(input.title, TITLE_LIMIT) }
        : {}),
      ...(input.purpose !== undefined
        ? { purpose: clip(input.purpose, PURPOSE_LIMIT) }
        : {}),
      responsibilities,
      updatedBy: actor,
    });
  }

  public async createGoal(
    conversationId: string,
    input: {
      title: string;
      detail?: string;
      progress?: number;
      ownerName?: string;
      dueAt?: number | null;
    },
    actor: string,
  ): Promise<GroupGoalRecord> {
    const title = clip(input.title, GOAL_TITLE_LIMIT);
    if (!title) throw new Error('群目标标题不能为空');
    return this.store.createGoal({
      conversationId,
      title,
      detail: clip(input.detail ?? '', DETAIL_LIMIT),
      status: 'active',
      progress: clampProgress(input.progress ?? 0),
      ownerPersonKey: null,
      ownerName: input.ownerName?.trim() ?? '',
      dueAt: input.dueAt ?? null,
      createdBy: actor,
    });
  }

  public async updateGoal(
    conversationId: string,
    goalId: string,
    input: {
      title?: string;
      detail?: string;
      status?: GroupGoalStatus;
      progress?: number;
      ownerName?: string;
      dueAt?: number | null;
    },
    _actor: string,
  ): Promise<GroupGoalRecord> {
    const goal = await this.requireGoal(conversationId, goalId);
    const title =
      input.title === undefined
        ? undefined
        : clip(input.title, GOAL_TITLE_LIMIT);
    if (title !== undefined && !title) throw new Error('群目标标题不能为空');
    const progress =
      input.progress !== undefined ? clampProgress(input.progress) : undefined;
    const updated = await this.store.updateGoal(goal.id, {
      ...(title !== undefined ? { title } : {}),
      ...(input.detail !== undefined
        ? { detail: clip(input.detail, DETAIL_LIMIT) }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(progress !== undefined
        ? { progress }
        : input.status === 'achieved'
          ? { progress: 100 }
          : {}),
      ...(input.ownerName !== undefined
        ? { ownerName: input.ownerName.trim() }
        : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    });
    if (!updated) throw new Error('群目标不存在或已被删除');
    return updated;
  }

  public async removeGoal(
    conversationId: string,
    goalId: string,
  ): Promise<boolean> {
    const goal = await this.requireGoal(conversationId, goalId);
    return this.store.removeGoal(goal.id);
  }

  public async createTask(
    conversationId: string,
    input: {
      title: string;
      detail?: string;
      goalId?: string | null;
      assigneeName?: string;
      dueAt?: number | null;
    },
    actor: string,
  ): Promise<GroupTaskRecord> {
    const title = clip(input.title, TASK_TITLE_LIMIT);
    if (!title) throw new Error('群任务标题不能为空');
    const goalId = await this.resolveGoalLink(conversationId, input.goalId);
    return this.store.createTask({
      conversationId,
      goalId: goalId ?? null,
      title,
      detail: clip(input.detail ?? '', DETAIL_LIMIT),
      status: 'todo',
      assigneePersonKey: null,
      assigneeName: input.assigneeName?.trim() ?? '',
      dueAt: input.dueAt ?? null,
      createdBy: actor,
      completedAt: null,
    });
  }

  public async updateTask(
    conversationId: string,
    taskId: string,
    input: {
      title?: string;
      detail?: string;
      status?: GroupTaskStatus;
      goalId?: string | null;
      assigneeName?: string;
      dueAt?: number | null;
    },
    _actor: string,
  ): Promise<GroupTaskRecord> {
    const task = await this.requireTask(conversationId, taskId);
    const title =
      input.title === undefined
        ? undefined
        : clip(input.title, TASK_TITLE_LIMIT);
    if (title !== undefined && !title) throw new Error('群任务标题不能为空');
    const goalId = await this.resolveGoalLink(conversationId, input.goalId);
    const completing =
      input.status === 'done' && task.status !== 'done'
        ? this.now()
        : input.status !== undefined && input.status !== 'done'
          ? null
          : undefined;
    const updated = await this.store.updateTask(task.id, {
      ...(title !== undefined ? { title } : {}),
      ...(input.detail !== undefined
        ? { detail: clip(input.detail, DETAIL_LIMIT) }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(goalId !== undefined ? { goalId } : {}),
      ...(input.assigneeName !== undefined
        ? { assigneeName: input.assigneeName.trim() }
        : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(completing !== undefined ? { completedAt: completing } : {}),
    });
    if (!updated) throw new Error('群任务不存在或已被删除');
    return updated;
  }

  public async removeTask(
    conversationId: string,
    taskId: string,
  ): Promise<boolean> {
    const task = await this.requireTask(conversationId, taskId);
    return this.store.removeTask(task.id);
  }

  /** 手动沉淀一条群记忆；未配置记忆落库端口时返回 false */
  public async rememberNote(note: GroupWorkspaceMemoryNote): Promise<boolean> {
    if (!this.saveNote) return false;
    await this.saveNote(note);
    return true;
  }

  /** 当前群的长期语义记忆，按最近更新排序 */
  public async listMemories(
    conversationId: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<SemanticMemoryRecord[]> {
    if (!this.memories) return [];
    const query = options.query?.trim();
    const result = await this.memories.list({
      scope: 'group',
      subjectKey: conversationId,
      status: 'active',
      ...(query ? { query } : {}),
      limit: Math.max(1, Math.min(200, options.limit ?? 20)),
      offset: 0,
    });
    return result.items.filter(
      (record) =>
        record.scope === 'group' &&
        record.subjectKey === conversationId &&
        record.status === 'active',
    );
  }

  /** 删除一条群记忆；仅管理员可操作，且只能删除本群条目 */
  public async forgetMemory(
    conversationId: string,
    idOrPrefix: string,
    staffId: string,
  ): Promise<string> {
    if (!this.memories) return '群记忆管理未启用。';
    if (!this.isAdmin(staffId)) return '只有管理员可以删除群记忆。';
    const records = await this.listMemories(conversationId, { limit: 200 });
    const resolved = resolveByPrefix(records, idOrPrefix, '群记忆');
    if ('error' in resolved) return resolved.error;
    const removed = await this.memories.remove(resolved.record.id);
    return removed
      ? `已删除群记忆：${clip(resolved.record.content, 80)}`
      : '删除失败，记忆可能已被移除。';
  }

  /** 手动沉淀一条当前成员在本群的专属记忆（scope = group_member，仅在本群对该成员召回） */
  public async rememberMemberNote(
    note: GroupWorkspaceMemberMemoryNote,
  ): Promise<boolean> {
    if (!this.saveMemberNote) return false;
    await this.saveMemberNote(note);
    return true;
  }

  /** 查看或检索当前成员在本群的专属记忆（严格按 conversationId::personKey 隔离） */
  public async listMemberMemories(
    conversationId: string,
    personKey: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<SemanticMemoryRecord[]> {
    if (!this.memories) return [];
    const subjectKey = groupMemberSubjectKey(conversationId, personKey);
    const query = options.query?.trim();
    const result = await this.memories.list({
      scope: 'group_member',
      subjectKey,
      status: 'active',
      ...(query ? { query } : {}),
      limit: Math.max(1, Math.min(200, options.limit ?? 20)),
      offset: 0,
    });
    return result.items.filter(
      (record) =>
        record.scope === 'group_member' &&
        record.subjectKey === subjectKey &&
        record.status === 'active',
    );
  }

  /** 删除当前成员在本群的一条专属记忆；仅能操作该成员在本群的条目 */
  public async forgetMemberMemory(
    conversationId: string,
    personKey: string,
    idOrPrefix: string,
  ): Promise<string> {
    if (!this.memories) return '群成员记忆管理未启用。';
    const records = await this.listMemberMemories(conversationId, personKey, {
      limit: 200,
    });
    const resolved = resolveByPrefix(records, idOrPrefix, '本群成员记忆');
    if ('error' in resolved) return resolved.error;
    const removed = await this.memories.remove(resolved.record.id);
    return removed
      ? `已删除你在本群的成员记忆：${clip(resolved.record.content, 80)}`
      : '删除失败，记忆可能已被移除。';
  }

  /** 注入系统提示的群工作区简报；没有任何配置时返回空串 */
  public async buildBrief(
    conversationId: string,
    maxChars = BRIEF_LIMIT,
  ): Promise<string> {
    const [workspace, goals, tasks] = await Promise.all([
      this.store.getWorkspace(conversationId),
      this.store.listGoals(conversationId),
      this.store.listTasks(conversationId, { includeDone: true }),
    ]);
    const taskStats = new Map<string, { done: number; total: number }>();
    for (const task of tasks) {
      if (!task.goalId || task.status === 'cancelled') continue;
      const stats = taskStats.get(task.goalId) ?? { done: 0, total: 0 };
      stats.total += 1;
      if (task.status === 'done') stats.done += 1;
      taskStats.set(task.goalId, stats);
    }
    const activeGoals = goals.filter(
      (goal) => goal.status === 'active' || goal.status === 'paused',
    );
    const openTasks = tasks.filter(
      (task) => task.status === 'todo' || task.status === 'doing',
    );
    if (
      !workspace &&
      activeGoals.length === 0 &&
      openTasks.length === 0
    ) {
      return '';
    }
    const lines = ['【本群工作区】'];
    if (workspace?.purpose.trim()) {
      lines.push(`群定位：${workspace.purpose.trim()}`);
    }
    if (workspace && workspace.responsibilities.length > 0) {
      lines.push(
        '群职责：',
        ...workspace.responsibilities.map((item) => `- ${item}`),
      );
    }
    if (activeGoals.length > 0) {
      lines.push('群目标：');
      for (const goal of activeGoals.slice(0, 8)) {
        const stats = taskStats.get(goal.id);
        const meta = [
          GOAL_STATUS_LABELS[goal.status],
          `进度 ${goal.progress}%${stats ? `（任务 ${stats.done}/${stats.total}）` : ''}`,
          ownerLabel(goal.ownerName),
          dueLabel(goal.dueAt),
        ].filter(Boolean);
        lines.push(
          `- [${meta.join(' · ')}] ${goal.title}${goal.detail ? `：${goal.detail}` : ''}`,
        );
      }
    }
    if (openTasks.length > 0) {
      lines.push('未完成的群任务：');
      for (const task of openTasks.slice(0, 10)) {
        const meta = [
          TASK_STATUS_LABELS[task.status],
          ownerLabel(task.assigneeName),
          dueLabel(task.dueAt),
        ].filter(Boolean);
        lines.push(
          `- [${meta.join(' · ')}] ${task.title}${task.detail ? `：${task.detail}` : ''}`,
        );
      }
    }
    try {
      const memories = await this.listMemories(conversationId, {
        limit: BRIEF_MEMORY_LIMIT,
      });
      if (memories.length > 0) {
        lines.push(
          '群记忆（长期约定）：',
          ...memories.map((record) => `- ${clip(record.content, 160)}`),
        );
      }
    } catch {
      // 记忆不可用时不阻塞群工作区简报
    }
    lines.push(
      '以上是本群长期上下文；回答时保持与群目标一致，成员可用 /group 维护。',
    );
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  /** 确定性的群目标摘要，不经过模型；用于 /group digest 与定期播报 */
  public async buildDigest(
    conversationId: string,
    now = this.now(),
  ): Promise<string> {
    const snapshot = await this.snapshot(conversationId);
    const goals = snapshot.goals.filter((goal) => goal.status !== 'archived');
    const tasks = snapshot.tasks.filter((task) => task.status !== 'cancelled');
    const openTasks = tasks.filter(
      (task) => task.status === 'todo' || task.status === 'doing',
    );
    const taskStats = new Map<string, { done: number; total: number }>();
    for (const task of tasks) {
      if (!task.goalId) continue;
      const stats = taskStats.get(task.goalId) ?? { done: 0, total: 0 };
      stats.total += 1;
      if (task.status === 'done') stats.done += 1;
      taskStats.set(task.goalId, stats);
    }
    const lines = [
      `【群目标进度】${formatShanghaiDateTime(now)}`,
    ];
    if (snapshot.workspace.purpose.trim()) {
      lines.push(`群定位：${snapshot.workspace.purpose.trim()}`);
    }
    if (goals.length === 0) {
      lines.push('群目标：暂无，可用 `/group goal add` 创建。');
    } else {
      lines.push('群目标：');
      for (const goal of goals.slice(0, 10)) {
        const stats = taskStats.get(goal.id);
        const meta = [
          GOAL_STATUS_LABELS[goal.status],
          `进度 ${goal.progress}%${stats ? `，任务 ${stats.done}/${stats.total}` : ''}`,
          ownerLabel(goal.ownerName),
          dueLabel(goal.dueAt),
          goal.dueAt !== null &&
          goal.dueAt < now &&
          goal.status !== 'achieved'
            ? '已逾期'
            : '',
        ].filter(Boolean);
        lines.push(`- ${goal.title}（${meta.join(' · ')}）`);
      }
    }
    const overdue = openTasks
      .filter((task) => task.dueAt !== null && task.dueAt < now)
      .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0));
    const dueSoon = openTasks
      .filter(
        (task) =>
          task.dueAt !== null &&
          task.dueAt >= now &&
          task.dueAt <= now + 3 * 24 * 60 * 60_000,
      )
      .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0));
    const doing = openTasks.filter((task) => task.status === 'doing');
    if (overdue.length > 0) {
      lines.push('逾期任务：');
      for (const task of overdue.slice(0, 8)) {
        lines.push(
          `- ${task.title}${ownerLabel(task.assigneeName) ? `（${ownerLabel(task.assigneeName)}）` : ''}`,
        );
      }
    }
    if (dueSoon.length > 0) {
      lines.push('3 天内到期：');
      for (const task of dueSoon.slice(0, 8)) {
        lines.push(
          `- ${task.title}（${dueLabel(task.dueAt)}${task.assigneeName ? ` · 负责人 ${task.assigneeName}` : ''}）`,
        );
      }
    }
    if (doing.length > 0) {
      lines.push('进行中：');
      for (const task of doing.slice(0, 8)) {
        lines.push(`- ${task.title}`);
      }
    }
    if (openTasks.length === 0) {
      lines.push('未完成群任务：暂无。');
    } else {
      lines.push(`未完成群任务共 ${openTasks.length} 项。`);
    }
    if (this.memories) {
      try {
        const result = await this.memories.list({
          scope: 'group',
          subjectKey: conversationId,
          status: 'active',
          limit: 1,
          offset: 0,
        });
        if (result.total > 0) {
          lines.push(`群记忆：${result.total} 条长期约定（/group memory list 查看）。`);
        }
      } catch {
        // 记忆不可用时不阻塞摘要
      }
    }
    return lines.join('\n');
  }

  public async handleCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    if (message.conversationType !== '2') {
      return '群工作区只能在群聊里使用；单聊请直接提出需求。';
    }
    const conversationId = message.conversationId;
    const [subcommand, ...rest] = args;
    switch (subcommand?.toLowerCase()) {
      case undefined:
      case 'show':
        return this.formatSnapshot(conversationId);
      case 'purpose': {
        const purpose = rest.join(' ').trim();
        if (!purpose) return '用法：`/group purpose <本群长期目标/定位>`。';
        await this.updateWorkspace(
          conversationId,
          { purpose },
          personKey,
        );
        return '已更新本群定位。';
      }
      case 'responsibility':
        return this.handleResponsibility(
          message,
          rest,
          personKey,
        );
      case 'goal':
        return this.handleGoalCommand(
          message,
          rest,
          personKey,
        );
      case 'task':
        return this.handleTaskCommand(
          message,
          rest,
          personKey,
        );
      case 'memory':
        return this.handleMemoryCommand(message, rest, personKey);
      case 'my-memory':
      case 'member-memory':
        return this.handleMemberMemoryCommand(message, rest, personKey);
      case 'digest':
        return this.buildDigest(conversationId);
      case 'note': {
        const content = rest.join(' ').trim();
        if (!content) return '用法：`/group note <要沉淀的群知识>`。';
        const saved = await this.rememberNote({
          conversationId,
          content: clip(content, 500),
          keywords: [],
          createdBy: personKey,
          sourceMessageId: message.messageId,
        });
        return saved
          ? '已沉淀为本群记忆，后续群聊会按语义召回。'
          : '手动群记忆未启用。';
      }
      default:
        return USAGE;
    }
  }

  private async handleResponsibility(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    const [action, ...rest] = args;
    const text = clip(rest.join(' ').trim(), RESPONSIBILITY_LIMIT);
    if (!text) {
      return '用法：`/group responsibility add <内容>` 或 `remove <内容>`。';
    }
    const workspace = await this.snapshot(message.conversationId);
    const current = workspace.workspace.responsibilities;
    if (action?.toLowerCase() === 'add') {
      if (current.includes(text)) return '该职责已存在。';
      await this.updateWorkspace(
        message.conversationId,
        { responsibilities: [...current, text] },
        personKey,
      );
      return `已加入群职责：${text}`;
    }
    if (action?.toLowerCase() === 'remove') {
      if (!current.includes(text)) return '未找到完全匹配的群职责。';
      await this.updateWorkspace(
        message.conversationId,
        { responsibilities: current.filter((item) => item !== text) },
        personKey,
      );
      return `已移除群职责：${text}`;
    }
    return '用法：`/group responsibility add <内容>` 或 `remove <内容>`。';
  }

  private async handleGoalCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    const [action, ...rest] = args;
    const conversationId = message.conversationId;
    switch (action?.toLowerCase()) {
      case 'add': {
        const { text, values } = extractFlags(rest, ['due', 'owner']);
        const dueAt = values.has('due') ? parseDueAt(values.get('due')) : null;
        if (!text) {
          return '用法：`/group goal add <标题> [--due 2026-11-30] [--owner 姓名]`。';
        }
        const goal = await this.createGoal(
          conversationId,
          {
            title: text,
            dueAt,
            ...(values.get('owner')?.trim()
              ? { ownerName: values.get('owner')!.trim() }
              : {}),
          },
          personKey,
        );
        return `已创建群目标 ${shortId(goal.id)}：${goal.title}`;
      }
      case 'list': {
        const goals = await this.store.listGoals(conversationId, {
          includeArchived: true,
        });
        return this.formatGoals(goals);
      }
      case 'progress': {
        const goal = await this.resolveGoal(conversationId, rest[0] ?? '');
        if ('error' in goal) return goal.error;
        if (!this.canManage(goal.goal, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以变更群目标进度。';
        }
        const raw = rest.slice(1).join(' ').trim();
        if (!raw) return '用法：`/group goal progress <ID> <0-100|+10|-10>`。';
        const value = parseProgressInput(goal.goal.progress, raw);
        if (typeof value === 'string') return value;
        await this.updateGoal(
          conversationId,
          goal.goal.id,
          { progress: value },
          personKey,
        );
        return `群目标 ${shortId(goal.goal.id)} 进度已更新为 ${value}%。`;
      }
      case 'owner': {
        const goal = await this.resolveGoal(conversationId, rest[0] ?? '');
        if ('error' in goal) return goal.error;
        if (!this.canManage(goal.goal, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以调整群目标负责人。';
        }
        const ownerName = rest.slice(1).join(' ').trim();
        if (!ownerName) {
          return '用法：`/group goal owner <ID> <负责人姓名>`，传 `-` 清除。';
        }
        await this.updateGoal(
          conversationId,
          goal.goal.id,
          { ownerName: ownerName === '-' ? '' : ownerName },
          personKey,
        );
        return ownerName === '-'
          ? `已清除群目标 ${shortId(goal.goal.id)} 的负责人。`
          : `群目标 ${shortId(goal.goal.id)} 负责人已设为 ${ownerName}。`;
      }
      case 'due': {
        const goal = await this.resolveGoal(conversationId, rest[0] ?? '');
        if ('error' in goal) return goal.error;
        if (!this.canManage(goal.goal, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以调整群目标截止时间。';
        }
        const raw = rest.slice(1).join(' ').trim();
        if (!raw) {
          return '用法：`/group goal due <ID> <YYYY-MM-DD>`，传 `-` 清除。';
        }
        const dueAt = raw === '-' ? null : parseDueAt(raw);
        if (raw !== '-' && dueAt === null) {
          return '无法识别截止时间，请用 `YYYY-MM-DD` 或 ISO 时间。';
        }
        await this.updateGoal(
          conversationId,
          goal.goal.id,
          { dueAt },
          personKey,
        );
        return dueAt === null
          ? `已清除群目标 ${shortId(goal.goal.id)} 的截止时间。`
          : `群目标 ${shortId(goal.goal.id)} 截止时间已更新为 ${formatShanghaiDateTime(dueAt)}。`;
      }
      case 'done':
      case 'pause':
      case 'resume':
      case 'archive': {
        const goal = await this.resolveGoal(conversationId, rest[0] ?? '');
        if ('error' in goal) return goal.error;
        if (!this.canManage(goal.goal, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以变更群目标状态。';
        }
        const status: GroupGoalStatus =
          action === 'done'
            ? 'achieved'
            : action === 'pause'
              ? 'paused'
              : action === 'resume'
                ? 'active'
                : 'archived';
        await this.updateGoal(
          conversationId,
          goal.goal.id,
          { status },
          personKey,
        );
        return `群目标 ${shortId(goal.goal.id)} 已更新为「${GOAL_STATUS_LABELS[status]}」。`;
      }
      default:
        return '用法：`/group goal add|list|done|pause|resume|archive ...`。';
    }
  }

  private async handleTaskCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    const [action, ...rest] = args;
    const conversationId = message.conversationId;
    switch (action?.toLowerCase()) {
      case 'add': {
        const { text, values } = extractFlags(rest, ['due', 'goal', 'owner']);
        const dueAt = values.has('due') ? parseDueAt(values.get('due')) : null;
        if (!text) {
          return '用法：`/group task add <标题> [--goal <目标ID>] [--owner 姓名] [--due 2026-11-30]`。';
        }
        const task = await this.createTask(
          conversationId,
          {
            title: text,
            dueAt,
            ...(values.get('goal')?.trim()
              ? { goalId: values.get('goal')!.trim() }
              : {}),
            ...(values.get('owner')?.trim()
              ? { assigneeName: values.get('owner')!.trim() }
              : {}),
          },
          personKey,
        );
        return `已创建群任务 ${shortId(task.id)}：${task.title}`;
      }
      case 'list': {
        const [tasks, goals] = await Promise.all([
          this.store.listTasks(conversationId, { includeDone: true }),
          this.store.listGoals(conversationId, { includeArchived: true }),
        ]);
        return this.formatTasks(tasks, goals);
      }
      case 'assign': {
        const task = await this.resolveTask(conversationId, rest[0] ?? '');
        if ('error' in task) return task.error;
        if (!this.canManage(task.task, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以调整群任务负责人。';
        }
        const assigneeName = rest.slice(1).join(' ').trim();
        if (!assigneeName) {
          return '用法：`/group task assign <ID> <负责人姓名>`，传 `-` 清除。';
        }
        await this.updateTask(
          conversationId,
          task.task.id,
          { assigneeName: assigneeName === '-' ? '' : assigneeName },
          personKey,
        );
        return assigneeName === '-'
          ? `已清除群任务 ${shortId(task.task.id)} 的负责人。`
          : `群任务 ${shortId(task.task.id)} 负责人已设为 ${assigneeName}。`;
      }
      case 'due': {
        const task = await this.resolveTask(conversationId, rest[0] ?? '');
        if ('error' in task) return task.error;
        if (!this.canManage(task.task, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以调整群任务截止时间。';
        }
        const raw = rest.slice(1).join(' ').trim();
        if (!raw) {
          return '用法：`/group task due <ID> <YYYY-MM-DD>`，传 `-` 清除。';
        }
        const dueAt = raw === '-' ? null : parseDueAt(raw);
        if (raw !== '-' && dueAt === null) {
          return '无法识别截止时间，请用 `YYYY-MM-DD` 或 ISO 时间。';
        }
        await this.updateTask(
          conversationId,
          task.task.id,
          { dueAt },
          personKey,
        );
        return dueAt === null
          ? `已清除群任务 ${shortId(task.task.id)} 的截止时间。`
          : `群任务 ${shortId(task.task.id)} 截止时间已更新为 ${formatShanghaiDateTime(dueAt)}。`;
      }
      case 'link':
      case 'unlink': {
        const task = await this.resolveTask(conversationId, rest[0] ?? '');
        if ('error' in task) return task.error;
        if (!this.canManage(task.task, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以调整群任务关联的目标。';
        }
        if (action === 'unlink') {
          await this.updateTask(
            conversationId,
            task.task.id,
            { goalId: null },
            personKey,
          );
          return `群任务 ${shortId(task.task.id)} 已取消目标关联。`;
        }
        const goalId = rest[1]?.trim();
        if (!goalId) {
          return '用法：`/group task link <任务ID> <目标ID>`。';
        }
        const goal = await this.resolveGoal(conversationId, goalId);
        if ('error' in goal) return goal.error;
        await this.updateTask(
          conversationId,
          task.task.id,
          { goalId: goal.goal.id },
          personKey,
        );
        return `群任务 ${shortId(task.task.id)} 已关联目标 ${shortId(goal.goal.id)}。`;
      }
      case 'start':
      case 'done':
      case 'cancel': {
        const task = await this.resolveTask(conversationId, rest[0] ?? '');
        if ('error' in task) return task.error;
        if (!this.canManage(task.task, message.senderStaffId, personKey)) {
          return '只有创建人或管理员可以变更群任务状态。';
        }
        const status: GroupTaskStatus =
          action === 'done'
            ? 'done'
            : action === 'cancel'
              ? 'cancelled'
              : 'doing';
        await this.updateTask(
          conversationId,
          task.task.id,
          { status },
          personKey,
        );
        return `群任务 ${shortId(task.task.id)} 已更新为「${TASK_STATUS_LABELS[status]}」。`;
      }
      default:
        return '用法：`/group task add|list|start|done|cancel ...`。';
    }
  }

  private async formatSnapshot(conversationId: string): Promise<string> {
    const snapshot = await this.snapshot(conversationId);
    const sections: string[] = ['【本群工作区】'];
    if (snapshot.workspace.purpose.trim()) {
      sections.push(`定位：${snapshot.workspace.purpose.trim()}`);
    }
    if (snapshot.workspace.responsibilities.length > 0) {
      sections.push(
        '职责：',
        ...snapshot.workspace.responsibilities.map((item) => `- ${item}`),
      );
    }
    const goals = snapshot.goals.filter((goal) => goal.status !== 'archived');
    sections.push(this.formatGoals(goals));
    const tasks = snapshot.tasks.filter(
      (task) => task.status !== 'cancelled',
    );
    sections.push(this.formatTasks(tasks, goals));
    if (this.memories) {
      try {
        const memories = await this.listMemories(conversationId, { limit: 200 });
        sections.push(
          `群记忆：${memories.length} 条长期约定（发送 \`/group memory list\` 查看）。`,
        );
      } catch {
        // 记忆不可用时不阻塞工作区查看
      }
    }
    sections.push(
      '维护：`/group purpose ...`、`/group goal add ...`、`/group task add ...`、`/group note ...`、`/group digest`。',
    );
    return sections.filter(Boolean).join('\n');
  }

  private formatGoals(goals: GroupGoalRecord[]): string {
    if (goals.length === 0) return '群目标：暂无。';
    return [
      '群目标：',
      ...goals.map((goal) => {
        const meta = [
          GOAL_STATUS_LABELS[goal.status],
          `进度 ${goal.progress}%`,
          ownerLabel(goal.ownerName),
          dueLabel(goal.dueAt),
        ].filter(Boolean);
        return `- ${shortId(goal.id)} · ${goal.title}（${meta.join(' · ')}）`;
      }),
    ].join('\n');
  }

  private formatTasks(
    tasks: GroupTaskRecord[],
    goals: GroupGoalRecord[] = [],
  ): string {
    if (tasks.length === 0) return '群任务：暂无。';
    const goalTitles = new Map(
      goals.map((goal) => [goal.id, goal.title] as const),
    );
    return [
      '群任务：',
      ...tasks.map((task) => {
        const goalTitle = task.goalId ? goalTitles.get(task.goalId) : undefined;
        const meta = [
          TASK_STATUS_LABELS[task.status],
          ownerLabel(task.assigneeName),
          dueLabel(task.dueAt),
          goalTitle ? `目标：${clip(goalTitle, 30)}` : '',
        ].filter(Boolean);
        return `- ${shortId(task.id)} · ${task.title}（${meta.join(' · ')}）`;
      }),
    ].join('\n');
  }

  private async handleMemoryCommand(
    message: InboundMessage,
    args: string[],
    _personKey: string,
  ): Promise<string> {
    const [action, ...rest] = args;
    const conversationId = message.conversationId;
    if (!this.memories) return '群记忆管理未启用。';
    switch (action?.toLowerCase()) {
      case undefined:
      case 'list': {
        const records = await this.listMemories(conversationId, { limit: 20 });
        return this.formatMemoryList(records, false);
      }
      case 'search': {
        const query = rest.join(' ').trim();
        if (!query) return '用法：`/group memory search <关键词>`。';
        const records = await this.listMemories(conversationId, {
          query,
          limit: 20,
        });
        return this.formatMemoryList(records, true);
      }
      case 'forget':
        return this.forgetMemory(
          conversationId,
          rest[0] ?? '',
          message.senderStaffId,
        );
      default:
        return '用法：`/group memory list|search <关键词>|forget <ID>`。';
    }
  }

  private formatMemoryList(
    records: SemanticMemoryRecord[],
    searched: boolean,
  ): string {
    if (records.length === 0) {
      return searched
        ? '没有找到匹配的群记忆。'
        : '本群还没有沉淀记忆；发送 `/group note <内容>` 添加。';
    }
    return [
      searched ? '匹配的群记忆：' : '【群记忆】',
      ...records.map(
        (record) =>
          `- ${shortId(record.id)} · ${clip(record.content, 160)}（更新 ${formatShanghaiDateTime(record.updatedAt)}）`,
      ),
      '删除：`/group memory forget <ID>`（仅管理员）。',
    ].join('\n');
  }

  private async handleMemberMemoryCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    const [action, ...rest] = args;
    const conversationId = message.conversationId;
    switch (action?.toLowerCase()) {
      case undefined:
      case 'list': {
        if (!this.memories) return '群成员记忆管理未启用。';
        const records = await this.listMemberMemories(
          conversationId,
          personKey,
          { limit: 20 },
        );
        return this.formatMemberMemoryList(records, false);
      }
      case 'search': {
        if (!this.memories) return '群成员记忆管理未启用。';
        const query = rest.join(' ').trim();
        if (!query) return '用法：`/group my-memory search <关键词>`。';
        const records = await this.listMemberMemories(
          conversationId,
          personKey,
          { query, limit: 20 },
        );
        return this.formatMemberMemoryList(records, true);
      }
      case 'add': {
        const content = rest.join(' ').trim();
        if (!content) return '用法：`/group my-memory add <你在本群的角色/偏好/分工>`。';
        const saved = await this.rememberMemberNote({
          conversationId,
          personKey,
          speakerNick: message.senderNick,
          content: clip(content, 500),
          keywords: [],
          sourceMessageId: message.messageId,
        });
        return saved
          ? '已保存你在本群的专属记忆（仅在本群对你生效，不会泄露到其他群或其他人）。'
          : '群成员记忆写入未启用。';
      }
      case 'forget':
        return this.forgetMemberMemory(
          conversationId,
          personKey,
          rest[0] ?? '',
        );
      default:
        return '用法：`/group my-memory list|search <关键词>|add <内容>|forget <ID>`。';
    }
  }

  private formatMemberMemoryList(
    records: SemanticMemoryRecord[],
    searched: boolean,
  ): string {
    if (records.length === 0) {
      return searched
        ? '没有找到匹配的本群成员记忆。'
        : '你在本群还没有专属成员记忆；发送 `/group my-memory add <内容>` 添加。';
    }
    return [
      searched ? '匹配的本群成员记忆：' : '【你在本群的专属记忆】',
      ...records.map(
        (record) =>
          `- ${shortId(record.id)} · ${clip(record.content, 160)}（更新 ${formatShanghaiDateTime(record.updatedAt)}）`,
      ),
      '删除：`/group my-memory forget <ID>`。',
    ].join('\n');
  }

  private async requireGoal(
    conversationId: string,
    goalId: string,
  ): Promise<GroupGoalRecord> {
    const goal = await this.resolveGoal(conversationId, goalId);
    if ('error' in goal) throw new Error(goal.error);
    return goal.goal;
  }

  private async resolveGoalLink(
    conversationId: string,
    goalId: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (goalId === undefined) return undefined;
    if (goalId === null || goalId.trim() === '') return null;
    const goal = await this.requireGoal(conversationId, goalId);
    return goal.id;
  }

  private async requireTask(
    conversationId: string,
    taskId: string,
  ): Promise<GroupTaskRecord> {
    const task = await this.resolveTask(conversationId, taskId);
    if ('error' in task) throw new Error(task.error);
    return task.task;
  }

  private async resolveGoal(
    conversationId: string,
    id: string,
  ): Promise<{ goal: GroupGoalRecord } | { error: string }> {
    const resolved = resolveByPrefix(
      await this.store.listGoals(conversationId, { includeArchived: true }),
      id,
      '群目标',
    );
    return 'error' in resolved ? resolved : { goal: resolved.record };
  }

  private async resolveTask(
    conversationId: string,
    id: string,
  ): Promise<{ task: GroupTaskRecord } | { error: string }> {
    const resolved = resolveByPrefix(
      await this.store.listTasks(conversationId, { includeDone: true }),
      id,
      '群任务',
    );
    return 'error' in resolved ? resolved : { task: resolved.record };
  }

  /** 群目标/任务的变更权限：创建人或管理员 */
  public canManage(
    record: { createdBy: string },
    senderStaffId: string,
    personKey: string,
  ): boolean {
    return (
      record.createdBy === personKey ||
      record.createdBy === senderStaffId ||
      this.isAdmin(senderStaffId)
    );
  }
}

/** 从命令参数中提取 `--name value` / `--name=value`，其余部分拼回标题 */
function extractFlags(
  parts: string[],
  names: string[],
): { text: string; values: Map<string, string> } {
  const allowed = new Set(names.map((name) => name.toLowerCase()));
  const values = new Map<string, string>();
  const textParts: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (!part.startsWith('--')) {
      textParts.push(part);
      continue;
    }
    const body = part.slice(2);
    const equals = body.indexOf('=');
    const name = (equals >= 0 ? body.slice(0, equals) : body).toLowerCase();
    if (!allowed.has(name)) {
      textParts.push(part);
      continue;
    }
    if (equals >= 0) {
      values.set(name, body.slice(equals + 1));
      continue;
    }
    const next = parts[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, '');
    }
  }
  return { text: textParts.join(' ').trim(), values };
}

function resolveByPrefix<T extends { id: string }>(
  records: T[],
  id: string,
  label: string,
): { record: T } | { error: string } {
  const needle = id.trim().toLowerCase();
  if (!needle) return { error: `请输入${label} ID 前缀。` };
  const exact = records.find((record) => record.id.toLowerCase() === needle);
  if (exact) return { record: exact };
  const matches = records.filter((record) =>
    record.id.toLowerCase().startsWith(needle),
  );
  if (matches.length === 1 && matches[0]) return { record: matches[0] };
  if (matches.length > 1) {
    return { error: `ID 前缀 ${id} 匹配到多个${label}，请多输入几位。` };
  }
  return { error: `未找到${label} ${id}。` };
}
