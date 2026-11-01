export const WORKER_NAMES = ['research', 'ops', 'report'] as const;

export type WorkerName = (typeof WORKER_NAMES)[number];

export function isWorkerName(value: unknown): value is WorkerName {
  return (
    typeof value === 'string' &&
    (WORKER_NAMES as readonly string[]).includes(value)
  );
}

export type WorkerRunStatus = 'completed' | 'partial' | 'blocked';

/** Worker 可见工具范围：只读优先，其次允许/拒绝名单（支持结尾 * 前缀匹配） */
export interface WorkerToolScope {
  readOnly: boolean;
  allow?: string[];
  deny?: string[];
}

export interface WorkerFinding {
  claim: string;
  source?: string;
}

export interface WorkerAction {
  action: string;
  result?: string;
}

/** Worker 的结构化交付物：摘要给人看，其余字段供任务详情与后续编排使用 */
export interface WorkerOutput {
  status: WorkerRunStatus;
  summary: string;
  findings: WorkerFinding[];
  actions: WorkerAction[];
  sources: string[];
  openQuestions: string[];
}
