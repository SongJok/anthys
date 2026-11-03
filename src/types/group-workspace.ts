/** 群工作区：每个群自己的定位、职责、目标与任务。 */

import type { ThinkingMode } from './core.js';

export type GroupGoalStatus = 'active' | 'achieved' | 'paused' | 'archived';
export type GroupTaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';

export const GROUP_GOAL_STATUSES: readonly GroupGoalStatus[] = [
  'active',
  'achieved',
  'paused',
  'archived',
];
export const GROUP_TASK_STATUSES: readonly GroupTaskStatus[] = [
  'todo',
  'doing',
  'done',
  'cancelled',
];

export function isGroupGoalStatus(value: string): value is GroupGoalStatus {
  return (GROUP_GOAL_STATUSES as readonly string[]).includes(value);
}

export function isGroupTaskStatus(value: string): value is GroupTaskStatus {
  return (GROUP_TASK_STATUSES as readonly string[]).includes(value);
}

/** 群工作区基础信息；未配置时返回空默认值而不是报错 */
export interface GroupWorkspaceRecord {
  conversationId: string;
  title: string;
  /** 该群的长期目标与定位 */
  purpose: string;
  /** 该群负责的事项清单 */
  responsibilities: string[];
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupGoalRecord {
  id: string;
  conversationId: string;
  title: string;
  detail: string;
  status: GroupGoalStatus;
  /** 0–100；100 表示全部完成，不等同于已归档 */
  progress: number;
  ownerPersonKey: string | null;
  ownerName: string;
  /** epoch ms；null 表示不设截止时间 */
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupTaskRecord {
  id: string;
  conversationId: string;
  /** 关联的群目标；null 表示独立任务 */
  goalId: string | null;
  title: string;
  detail: string;
  status: GroupTaskStatus;
  assigneePersonKey: string | null;
  assigneeName: string;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface GroupWorkspaceSnapshot {
  workspace: GroupWorkspaceRecord;
  goals: GroupGoalRecord[];
  tasks: GroupTaskRecord[];
}

export interface GroupWorkspaceStore {
  getWorkspace(conversationId: string): Promise<GroupWorkspaceRecord | null>;
  upsertWorkspace(workspace: GroupWorkspaceRecord): Promise<GroupWorkspaceRecord>;
  listGoals(
    conversationId: string,
    options?: { includeArchived?: boolean },
  ): Promise<GroupGoalRecord[]>;
  getGoal(id: string): Promise<GroupGoalRecord | null>;
  createGoal(
    goal: Omit<GroupGoalRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GroupGoalRecord>;
  updateGoal(
    id: string,
    patch: Partial<
      Pick<
        GroupGoalRecord,
        | 'title'
        | 'detail'
        | 'status'
        | 'progress'
        | 'ownerPersonKey'
        | 'ownerName'
        | 'dueAt'
      >
    >,
  ): Promise<GroupGoalRecord | null>;
  removeGoal(id: string): Promise<boolean>;
  listTasks(
    conversationId: string,
    options?: { includeDone?: boolean },
  ): Promise<GroupTaskRecord[]>;
  getTask(id: string): Promise<GroupTaskRecord | null>;
  createTask(
    task: Omit<GroupTaskRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GroupTaskRecord>;
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        GroupTaskRecord,
        | 'title'
        | 'detail'
        | 'status'
        | 'goalId'
        | 'assigneePersonKey'
        | 'assigneeName'
        | 'dueAt'
        | 'completedAt'
      >
    >,
  ): Promise<GroupTaskRecord | null>;
  removeTask(id: string): Promise<boolean>;
}

export interface GroupWorkspaceAdminPort {
  snapshot(conversationId: string): Promise<GroupWorkspaceSnapshot>;
  updateWorkspace(
    conversationId: string,
    input: {
      title?: string;
      purpose?: string;
      responsibilities?: string[];
    },
    actor: string,
  ): Promise<GroupWorkspaceRecord>;
  createGoal(
    conversationId: string,
    input: {
      title: string;
      detail?: string;
      progress?: number;
      ownerName?: string;
      dueAt?: number | null;
    },
    actor: string,
  ): Promise<GroupGoalRecord>;
  updateGoal(
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
    actor: string,
  ): Promise<GroupGoalRecord>;
  removeGoal(conversationId: string, goalId: string): Promise<boolean>;
  createTask(
    conversationId: string,
    input: {
      title: string;
      detail?: string;
      goalId?: string | null;
      assigneeName?: string;
      dueAt?: number | null;
    },
    actor: string,
  ): Promise<GroupTaskRecord>;
  updateTask(
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
    actor: string,
  ): Promise<GroupTaskRecord>;
  removeTask(conversationId: string, taskId: string): Promise<boolean>;
}

/** 按群模型路由：留空字段沿用默认角色的模型档案 */
export interface GroupModelRoute {
  conversationId: string;
  enabled: boolean;
  provider: 'openai-compatible' | 'anthropic' | '';
  baseUrl: string;
  /** API Key 从该环境变量读取，避免把密钥写进数据库 */
  apiKeyEnv: string;
  model: string;
  temperature: number | null;
  thinking: ThinkingMode | '';
  maxTokens: number | null;
  updatedBy: string;
  updatedAt: number;
}

export interface GroupModelRouteInput {
  enabled?: boolean;
  provider?: 'openai-compatible' | 'anthropic' | '';
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  temperature?: number | null;
  thinking?: ThinkingMode | '';
  maxTokens?: number | null;
}

export interface GroupModelRouteStore {
  get(conversationId: string): Promise<GroupModelRoute | null>;
  list(): Promise<GroupModelRoute[]>;
  upsert(route: GroupModelRoute): Promise<GroupModelRoute>;
  remove(conversationId: string): Promise<boolean>;
}
