import type { ReActCheckpointState, RunUsage } from './core.js';

export interface AgentJobCheckpoint extends ReActCheckpointState {
  jobId: string;
  updatedAt: number;
}

export type AgentJobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AgentJobKind = 'task' | 'scheduled' | 'worker' | 'investigation';

export interface AgentJobResult {
  answer: string;
  reasoning: string;
  model?: string;
  usage: RunUsage;
  metadata?: Record<string, unknown>;
}

export interface AgentJob {
  id: string;
  conversationId: string;
  conversationType: '1' | '2';
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  kind: AgentJobKind;
  status: AgentJobStatus;
  prompt: string;
  metadata: Record<string, unknown>;
  result: AgentJobResult | null;
  error: string | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  /** 每次领取 +1；心跳 / 落定必须携带，旧进程的过期租约无法再写状态 */
  fencingToken: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AgentJobEvent {
  jobId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface EnqueueAgentJobInput {
  conversationId: string;
  conversationType: '1' | '2';
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  kind: AgentJobKind;
  prompt: string;
  metadata?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}

export interface ClaimJobInput {
  owner: string;
  nowMs: number;
  leaseMs: number;
}

export interface ListJobsInput {
  conversationId?: string;
  status?: AgentJobStatus[];
  limit?: number;
}

/** 持久化任务队列：PG 用 SKIP LOCKED 原子领取，测试用内存实现 */
export interface AgentJobStore {
  enqueue(input: EnqueueAgentJobInput): Promise<AgentJob>;
  claimNext(input: ClaimJobInput): Promise<AgentJob | null>;
  heartbeat(
    jobId: string,
    owner: string,
    fencingToken: number,
    nowMs: number,
    leaseMs: number,
  ): Promise<boolean>;
  complete(
    jobId: string,
    owner: string,
    fencingToken: number,
    result: AgentJobResult,
  ): Promise<AgentJob | null>;
  fail(
    jobId: string,
    owner: string,
    fencingToken: number,
    error: string,
    retryable?: boolean,
  ): Promise<AgentJob | null>;
  /** 看门狗或人工暂停：保留任务与预算状态，等待 resume 后重新排队 */
  pause(
    jobId: string,
    owner: string,
    fencingToken: number,
    reason: string,
  ): Promise<AgentJob | null>;
  /** 恢复已暂停的任务；可追加补充要求后重新执行（带断点续跑时按 resumeGuidance 注入） */
  resume(
    jobId: string,
    patch?: { prompt?: string; resumeGuidance?: string },
  ): Promise<AgentJob | null>;
  cancel(jobId: string): Promise<AgentJob | null>;
  get(jobId: string): Promise<AgentJob | null>;
  list(input?: ListJobsInput): Promise<AgentJob[]>;
  appendEvent(input: {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  listEvents(jobId: string, limit?: number): Promise<AgentJobEvent[]>;
  /** 持久化或覆盖任务的最新只读步骤检查点 */
  saveCheckpoint?(checkpoint: AgentJobCheckpoint): Promise<void>;
  /** 读取任务的最新步骤检查点；不存在时返回 null */
  loadCheckpoint?(jobId: string): Promise<AgentJobCheckpoint | null>;
  /** 任务完成或取消后清理检查点 */
  deleteCheckpoint?(jobId: string): Promise<void>;
}
