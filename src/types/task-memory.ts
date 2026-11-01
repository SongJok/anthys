import type { AgentJobKind } from './jobs.js';

/** 已完成后台任务的精简结果，供后续会话按需检索 */
export interface TaskResultRecord {
  id: string;
  jobId: string;
  conversationId: string;
  conversationType: '1' | '2';
  taskId: string | null;
  senderStaffId: string;
  senderNick: string;
  kind: AgentJobKind;
  worker: string | null;
  question: string;
  answer: string;
  keywords: string[];
  totalTokens: number;
  /** epoch ms */
  completedAt: number;
  createdAt: number;
}

export interface SaveTaskResultInput {
  jobId: string;
  conversationId: string;
  conversationType: '1' | '2';
  taskId?: string | null;
  senderStaffId: string;
  senderNick: string;
  kind: AgentJobKind;
  worker?: string | null;
  question: string;
  answer: string;
  keywords: string[];
  totalTokens: number;
  completedAt: number;
}

export interface TaskResultSearchQuery {
  /** 只检索同一会话，避免跨群/跨人泄露 */
  conversationId: string;
  query?: string;
  sinceMs?: number;
  limit?: number;
}

export interface TaskResultStore {
  save(input: SaveTaskResultInput): Promise<TaskResultRecord>;
  search(query: TaskResultSearchQuery): Promise<TaskResultRecord[]>;
  /** 每个会话只保留最近 N 条，控制长期占用 */
  prune(conversationId: string, keep: number): Promise<number>;
}
