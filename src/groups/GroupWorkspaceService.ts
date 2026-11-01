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
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const TITLE_LIMIT = 80;
const PURPOSE_LIMIT = 2_000;
const GOAL_TITLE_LIMIT = 120;
const TASK_TITLE_LIMIT = 120;
const DETAIL_LIMIT = 4_000;
const RESPONSIBILITY_LIMIT = 200;
const BRIEF_LIMIT = 1_600;

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
  '- `/group goal add <标题> [--due 2026-11-30]` 新建群目标',
  '- `/group goal list` / `/group goal done|pause|resume|archive <ID>`',
  '- `/group task add <标题> [--due 2026-11-30]` 新建群任务',
  '- `/group task list` / `/group task start|done|cancel <ID>`',
  '- `/group note <内容>` 手动沉淀一条群记忆',
].join('\n');

export interface GroupWorkspaceMemoryNote {
  conversationId: string;
  content: string;
  keywords: string[];
  createdBy: string;
  sourceMessageId?: string;
}

export interface GroupWorkspaceServiceOptions {
  store: GroupWorkspaceStore;
  isAdmin: (staffId: string) => boolean;
  /** 手动群记忆沉淀；未配置时 /group note 只返回不可用提示 */
  saveNote?: (note: GroupWorkspaceMemoryNote) => Promise<void>;
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
  private readonly now: () => number;

  constructor(options: GroupWorkspaceServiceOptions) {
    this.store = options.store;
    this.isAdmin = options.isAdmin;
    this.saveNote = options.saveNote;
    this.now = options.now ?? Date.now;
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
    const updated = await this.store.updateGoal(goal.id, {
      ...(title !== undefined ? { title } : {}),
      ...(input.detail !== undefined
        ? { detail: clip(input.detail, DETAIL_LIMIT) }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
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
      assigneeName?: string;
      dueAt?: number | null;
    },
    actor: string,
  ): Promise<GroupTaskRecord> {
    const title = clip(input.title, TASK_TITLE_LIMIT);
    if (!title) throw new Error('群任务标题不能为空');
    return this.store.createTask({
      conversationId,
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

  /** 注入系统提示的群工作区简报；没有任何配置时返回空串 */
  public async buildBrief(
    conversationId: string,
    maxChars = BRIEF_LIMIT,
  ): Promise<string> {
    const [workspace, goals, tasks] = await Promise.all([
      this.store.getWorkspace(conversationId),
      this.store.listGoals(conversationId),
      this.store.listTasks(conversationId),
    ]);
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
        const meta = [
          GOAL_STATUS_LABELS[goal.status],
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
    lines.push(
      '以上是本群长期上下文；回答时保持与群目标一致，成员可用 /group 维护。',
    );
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
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
        const { text, dueAt } = extractDue(rest);
        if (!text) {
          return '用法：`/group goal add <标题> [--due 2026-11-30]`。';
        }
        const goal = await this.createGoal(
          conversationId,
          { title: text, dueAt },
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
        await this.store.updateGoal(goal.goal.id, { status });
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
        const { text, dueAt } = extractDue(rest);
        if (!text) {
          return '用法：`/group task add <标题> [--due 2026-11-30]`。';
        }
        const task = await this.createTask(
          conversationId,
          { title: text, dueAt },
          personKey,
        );
        return `已创建群任务 ${shortId(task.id)}：${task.title}`;
      }
      case 'list': {
        const tasks = await this.store.listTasks(conversationId, {
          includeDone: true,
        });
        return this.formatTasks(tasks);
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
    sections.push(this.formatTasks(tasks));
    sections.push(
      '维护：`/group purpose ...`、`/group goal add ...`、`/group task add ...`、`/group note ...`。',
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
          ownerLabel(goal.ownerName),
          dueLabel(goal.dueAt),
        ].filter(Boolean);
        return `- ${shortId(goal.id)} · ${goal.title}（${meta.join(' · ')}）`;
      }),
    ].join('\n');
  }

  private formatTasks(tasks: GroupTaskRecord[]): string {
    if (tasks.length === 0) return '群任务：暂无。';
    return [
      '群任务：',
      ...tasks.map((task) => {
        const meta = [
          TASK_STATUS_LABELS[task.status],
          ownerLabel(task.assigneeName),
          dueLabel(task.dueAt),
        ].filter(Boolean);
        return `- ${shortId(task.id)} · ${task.title}（${meta.join(' · ')}）`;
      }),
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

function extractDue(parts: string[]): { text: string; dueAt: number | null } {
  const textParts: string[] = [];
  let dueAt: number | null = null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (part === '--due') {
      dueAt = parseDueAt(parts[index + 1]);
      index += 1;
      continue;
    }
    if (part.startsWith('--due=')) {
      dueAt = parseDueAt(part.slice('--due='.length));
      continue;
    }
    textParts.push(part);
  }
  return { text: clip(textParts.join(' '), GOAL_TITLE_LIMIT), dueAt };
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
