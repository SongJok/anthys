import type { InboundMessage } from './core.js';

/** 等待本人授权后自动续跑的 DWS 写操作 */
export type DwsWriteTaskState =
  | 'waiting_auth'
  | 'resuming'
  | 'resumed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type DwsWriteTaskRisk = 'write' | 'destructive';

export interface DwsWriteTask {
  id: string;
  conversationId: string;
  staffId: string;
  /** 原始问题快照：授权完成后按同一条消息重新执行 */
  message: InboundMessage;
  toolName: string;
  args: Record<string, unknown>;
  risk: DwsWriteTaskRisk;
  state: DwsWriteTaskState;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface DwsWriteTaskInput {
  message: InboundMessage;
  toolName: string;
  args: Record<string, unknown>;
  risk: DwsWriteTaskRisk;
}

export interface DwsWriteTaskStore {
  /** 同一会话只保留一个待授权写任务，新请求覆盖旧请求；返回数据库中的最终记录 */
  save(task: DwsWriteTask): Promise<DwsWriteTask>;
  getByConversation(conversationId: string): Promise<DwsWriteTask | null>;
  listWaiting(nowMs: number): Promise<DwsWriteTask[]>;
  /** 原子地把 waiting_auth 置为 resuming；返回 null 表示已被其他实例抢到 */
  claim(id: string, nowMs: number): Promise<DwsWriteTask | null>;
  update(task: DwsWriteTask): Promise<void>;
  remove(conversationId: string): Promise<void>;
}

export function isDwsWriteTaskRisk(value: unknown): value is DwsWriteTaskRisk {
  return value === 'write' || value === 'destructive';
}
