export type AgentTaskStatus = 'active' | 'completed' | 'failed' | 'closed';

export const AGENT_TASK_STATUSES: readonly AgentTaskStatus[] = [
  'active',
  'completed',
  'failed',
  'closed',
];

export type AgentTaskLinkKind =
  | 'message'
  | 'conversation'
  | 'job'
  | 'url'
  | 'doc'
  | 'issue'
  | 'card'
  | 'other';

export const AGENT_TASK_LINK_KINDS: readonly AgentTaskLinkKind[] = [
  'message',
  'conversation',
  'job',
  'url',
  'doc',
  'issue',
  'card',
  'other',
];

export interface AgentTask {
  id: string;
  conversationId: string;
  conversationType: '1' | '2';
  ownerStaffId: string;
  ownerNick: string;
  title: string;
  prompt: string;
  status: AgentTaskStatus;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface AgentTaskLink {
  id: string;
  taskId: string;
  kind: AgentTaskLinkKind;
  ref: string;
  label: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AgentTaskSubscription {
  taskId: string;
  staffId: string;
  nick: string;
  createdAt: number;
}

export interface CreateAgentTaskInput {
  conversationId: string;
  conversationType: '1' | '2';
  ownerStaffId: string;
  ownerNick: string;
  title: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface ListAgentTasksInput {
  conversationId?: string;
  ownerStaffId?: string;
  status?: AgentTaskStatus[];
  limit?: number;
}

export interface UpdateAgentTaskInput {
  status?: AgentTaskStatus;
  summary?: string | null;
  metadata?: Record<string, unknown>;
  closedAt?: number | null;
}

export interface AddAgentTaskLinkInput {
  taskId: string;
  kind: AgentTaskLinkKind;
  ref: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskStore {
  create(input: CreateAgentTaskInput): Promise<AgentTask>;
  get(id: string): Promise<AgentTask | null>;
  list(input?: ListAgentTasksInput): Promise<AgentTask[]>;
  update(id: string, patch: UpdateAgentTaskInput): Promise<AgentTask | null>;
  addLink(input: AddAgentTaskLinkInput): Promise<AgentTaskLink>;
  listLinks(taskId: string): Promise<AgentTaskLink[]>;
  subscribe(input: {
    taskId: string;
    staffId: string;
    nick: string;
  }): Promise<boolean>;
  unsubscribe(taskId: string, staffId: string): Promise<boolean>;
  listSubscribers(taskId: string): Promise<AgentTaskSubscription[]>;
}
