import { describe, expect, it } from 'vitest';
import {
  TaskResultMemory,
  extractTaskKeywords,
  formatTaskResultMemory,
} from './TaskResultMemory.js';
import type { AgentJob } from '../types/jobs.js';
import type {
  SaveTaskResultInput,
  TaskResultRecord,
  TaskResultSearchQuery,
  TaskResultStore,
} from '../types/task-memory.js';

class FakeTaskResultStore implements TaskResultStore {
  public saved: SaveTaskResultInput[] = [];
  public pruned: Array<{ conversationId: string; keep: number }> = [];
  public lastQuery: TaskResultSearchQuery | null = null;
  public records: TaskResultRecord[] = [];

  public async save(input: SaveTaskResultInput): Promise<TaskResultRecord> {
    this.saved.push(input);
    const record: TaskResultRecord = {
      ...input,
      id: `tr-${this.saved.length}`,
      taskId: input.taskId ?? null,
      worker: input.worker ?? null,
      createdAt: input.completedAt,
    };
    this.records = [record, ...this.records];
    return record;
  }

  public async search(
    query: TaskResultSearchQuery,
  ): Promise<TaskResultRecord[]> {
    this.lastQuery = query;
    return this.records;
  }

  public async prune(conversationId: string, keep: number): Promise<number> {
    this.pruned.push({ conversationId, keep });
    return 0;
  }
}

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    conversationId: 'cid-1',
    conversationType: '2',
    messageId: 'm-1',
    senderStaffId: 'u-1',
    senderNick: '张三',
    kind: 'task',
    status: 'succeeded',
    prompt: '帮我检查 pnpm typecheck 为什么失败',
    metadata: { taskId: 'task-1', worker: 'research' },
    result: {
      answer: 'pnpm typecheck 因类型错误失败，已修复。',
      reasoning: '',
      usage: { totalTokens: 1_200, steps: 4, durationMs: 5_000 },
    },
    error: null,
    priority: 0,
    attempts: 1,
    maxAttempts: 2,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_100,
    finishedAt: 2_000,
    ...overrides,
  };
}

describe('TaskResultMemory', () => {
  it('任务完成后沉淀结果并限制每会话保留条数', async () => {
    const store = new FakeTaskResultStore();
    const memory = new TaskResultMemory({ store, keepPerConversation: 50 });
    const saved = await memory.rememberJob(job());

    expect(saved).not.toBeNull();
    expect(store.saved[0]).toMatchObject({
      jobId: '11111111-2222-4333-8444-555555555555',
      conversationId: 'cid-1',
      conversationType: '2',
      taskId: 'task-1',
      worker: 'research',
      kind: 'task',
      totalTokens: 1_200,
      completedAt: 2_000,
    });
    expect(store.saved[0]?.keywords).toContain('pnpm');
    expect(store.pruned).toEqual([{ conversationId: 'cid-1', keep: 50 }]);
  });

  it('跳过定时播报、失败任务与空回答', async () => {
    const store = new FakeTaskResultStore();
    const memory = new TaskResultMemory({ store });

    expect(await memory.rememberJob(job({ kind: 'scheduled' }))).toBeNull();
    expect(await memory.rememberJob(job({ status: 'failed' }))).toBeNull();
    expect(
      await memory.rememberJob(
        job({
          result: {
            answer: '   ',
            reasoning: '',
            usage: { totalTokens: 1, steps: 1, durationMs: 1 },
          },
        }),
      ),
    ).toBeNull();
    expect(store.saved).toEqual([]);
  });

  it('按会话与回看天数检索并夹紧条数', async () => {
    const store = new FakeTaskResultStore();
    const memory = new TaskResultMemory({ store, now: () => 1_000_000_000 });
    await memory.search({ conversationId: 'cid-1', query: ' 报错 ', days: 7, limit: 99 });

    expect(store.lastQuery).toEqual({
      conversationId: 'cid-1',
      query: '报错',
      sinceMs: 1_000_000_000 - 7 * 86_400_000,
      limit: 10,
    });
    await memory.search({ conversationId: 'cid-1', days: 0, limit: 0 });
    expect(store.lastQuery?.sinceMs).toBe(1_000_000_000 - 86_400_000);
    expect(store.lastQuery?.limit).toBe(1);
  });

  it('抽取技术标识与短中文词组', () => {
    expect(
      extractTaskKeywords('发布 pnpm typecheck', '执行发布手册并检查 systemd 服务'),
    ).toEqual(expect.arrayContaining(['pnpm', 'typecheck', 'systemd', '发布', '服务']));
    expect(extractTaskKeywords('   ', '')).toEqual([]);
  });

  it('格式化结果包含绝对时间、需求与结果', () => {
    const text = formatTaskResultMemory([
      {
        id: 'tr-1',
        jobId: '11111111-2222-4333-8444-555555555555',
        conversationId: 'cid-1',
        conversationType: '2',
        taskId: null,
        senderStaffId: 'u-1',
        senderNick: '张三',
        kind: 'worker',
        worker: 'research',
        question: '检查发布失败原因',
        answer: '根因是数据库迁移未执行。',
        keywords: [],
        totalTokens: 100,
        completedAt: Date.UTC(2026, 10, 1, 10, 0),
        createdAt: Date.UTC(2026, 10, 1, 10, 0),
      },
    ]);
    expect(text).toContain('Worker 任务 11111111');
    expect(text).toContain('2026-11-01 18:00');
    expect(text).toContain('检查发布失败原因');
    expect(text).toContain('根因是数据库迁移未执行');
    expect(formatTaskResultMemory([])).toContain('没有匹配');
  });
});
