import type { AgentJob } from '../types/jobs.js';
import type {
  TaskResultRecord,
  TaskResultStore,
} from '../types/task-memory.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

export interface TaskResultMemoryLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TaskResultMemoryOptions {
  store: TaskResultStore;
  logger?: TaskResultMemoryLogger;
  /** 每个会话保留的最近结果数，默认 300 */
  keepPerConversation?: number;
  now?: () => number;
}

const LATIN_TERM = /[A-Za-z][A-Za-z0-9_.:-]{1,31}/gu;
const SEGMENT_SPLIT = /[\s,，。;；、/|:：()（）[\]【】"'“”‘’!?！？]+/u;

/** 轻量关键词：技术标识 + 短中文词组，不引入分词依赖 */
export function extractTaskKeywords(
  question: string,
  answer: string,
): string[] {
  const text = `${question}\n${answer.slice(0, 2_000)}`;
  const latin = text.match(LATIN_TERM) ?? [];
  const chinese = text
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.replace(/[^\u4e00-\u9fa5]/gu, ''))
    .filter((segment) => segment.length >= 2 && segment.length <= 8);
  return [
    ...new Set(
      [...latin, ...chinese]
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0),
    ),
  ].slice(0, 20);
}

export interface TaskResultSearchInput {
  conversationId: string;
  query?: string;
  /** 回看天数，默认 90，最大 365 */
  days?: number;
  limit?: number;
}

/**
 * 任务结果记忆：把已完成的后台任务结果沉淀为可检索快照。
 * 只按会话隔离检索，群聊结果不会跨群或跨人返回。
 */
export class TaskResultMemory {
  private readonly store: TaskResultStore;
  private readonly logger?: TaskResultMemoryLogger;
  private readonly keepPerConversation: number;
  private readonly now: () => number;

  constructor(options: TaskResultMemoryOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.keepPerConversation = Math.max(
      10,
      options.keepPerConversation ?? 300,
    );
    this.now = options.now ?? Date.now;
  }

  /** 定时播报是周期性消息，已进入会话记录，不再重复沉淀 */
  public static shouldRemember(job: AgentJob): boolean {
    return (
      job.status === 'succeeded' &&
      job.kind !== 'scheduled' &&
      Boolean(job.result?.answer.trim())
    );
  }

  public async rememberJob(job: AgentJob): Promise<TaskResultRecord | null> {
    if (!TaskResultMemory.shouldRemember(job) || !job.result) return null;
    const answer = job.result.answer.trim();
    const question = job.prompt.trim();
    if (!question || !answer) return null;
    const taskId =
      typeof job.metadata.taskId === 'string' && job.metadata.taskId.trim()
        ? job.metadata.taskId.trim()
        : null;
    const worker =
      typeof job.metadata.worker === 'string' && job.metadata.worker.trim()
        ? job.metadata.worker.trim()
        : null;
    const completedAt = job.finishedAt ?? this.now();
    const record = await this.store.save({
      jobId: job.id,
      conversationId: job.conversationId,
      conversationType: job.conversationType,
      taskId,
      senderStaffId: job.senderStaffId,
      senderNick: job.senderNick,
      kind: job.kind,
      worker,
      question: question.slice(0, 2_000),
      answer: answer.slice(0, 12_000),
      keywords: extractTaskKeywords(question, answer),
      totalTokens: job.result.usage.totalTokens,
      completedAt,
    });
    try {
      await this.store.prune(
        job.conversationId,
        this.keepPerConversation,
      );
    } catch (error) {
      this.logger?.warn(
        {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'task result memory prune failed',
      );
    }
    return record;
  }

  public async search(
    input: TaskResultSearchInput,
  ): Promise<TaskResultRecord[]> {
    const days = Math.min(365, Math.max(1, Math.trunc(input.days ?? 90)));
    return this.store.search({
      conversationId: input.conversationId,
      query: input.query?.trim() ?? '',
      sinceMs: this.now() - days * 86_400_000,
      limit: Math.min(10, Math.max(1, Math.trunc(input.limit ?? 5))),
    });
  }
}

function kindLabel(kind: TaskResultRecord['kind']): string {
  switch (kind) {
    case 'worker':
      return 'Worker 任务';
    case 'investigation':
      return '静默调查';
    case 'scheduled':
      return '定时播报';
    default:
      return '后台任务';
  }
}

export function formatTaskResultMemory(
  records: TaskResultRecord[],
): string {
  if (records.length === 0) {
    return '当前会话没有匹配的后台任务结果。可以换关键词或放宽时间范围，也可以先用 /job-status 查看任务 ID。';
  }
  const blocks = records.map((record, index) => {
    const worker = record.worker ? ` · ${record.worker}` : '';
    return [
      `${index + 1}. ${kindLabel(record.kind)} ${record.jobId.slice(0, 8)}${worker} · ${formatShanghaiDateTime(record.completedAt)}`,
      `需求：${record.question.replace(/\s+/gu, ' ').slice(0, 300)}`,
      `结果：${record.answer.replace(/\s+/gu, ' ').slice(0, 800)}${record.answer.length > 800 ? '…' : ''}`,
    ].join('\n');
  });
  return [
    `找到 ${records.length} 条当前会话的后台任务结果（按完成时间倒序）：`,
    ...blocks,
    '需要完整内容时可让用户执行 `/job-status <任务 ID 前缀>` 查看。',
  ].join('\n\n');
}
