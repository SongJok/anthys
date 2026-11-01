import { describe, expect, it } from 'vitest';
import {
  TaskMemoryToolProvider,
  type TaskResultMemoryPort,
} from './TaskMemoryToolProvider.js';
import type { ExecutionContext } from '../../types/core.js';
import type { TaskResultSearchInput } from '../../memory/TaskResultMemory.js';
import type { TaskResultRecord } from '../../types/task-memory.js';

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'm-1',
    senderStaffId: 'u-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: () => Date.now(),
    ...overrides,
  };
}

function record(): TaskResultRecord {
  return {
    id: 'tr-1',
    jobId: '11111111-2222-4333-8444-555555555555',
    conversationId: 'cid-1',
    conversationType: '1',
    taskId: null,
    senderStaffId: 'u-1',
    senderNick: '张三',
    kind: 'task',
    worker: null,
    question: '检查发布失败原因',
    answer: '数据库迁移未执行。',
    keywords: [],
    totalTokens: 100,
    completedAt: Date.UTC(2026, 10, 1, 10, 0),
    createdAt: Date.UTC(2026, 10, 1, 10, 0),
  };
}

class FakeMemory implements TaskResultMemoryPort {
  public calls: TaskResultSearchInput[] = [];
  public records: TaskResultRecord[] = [];

  public async search(input: TaskResultSearchInput): Promise<TaskResultRecord[]> {
    this.calls.push(input);
    return this.records;
  }
}

describe('TaskMemoryToolProvider', () => {
  it('注册任务结果检索工具并按当前会话检索', async () => {
    const memory = new FakeMemory();
    memory.records = [record()];
    const provider = new TaskMemoryToolProvider({ memory });
    const tools = await provider.getTools(context());

    expect(tools.map((tool) => tool.name)).toEqual(['task_result_search']);
    expect(tools[0]?.risk).toBe('read');

    const text = await tools[0]!.execute(
      { query: '发布失败', days: 7, limit: 3 },
      context(),
    );
    expect(memory.calls[0]).toEqual({
      conversationId: 'cid-1',
      query: '发布失败',
      days: 7,
      limit: 3,
    });
    expect(text).toContain('数据库迁移未执行');
  });

  it('开关关闭时不挂载工具，空查询仍可列出最近结果', async () => {
    const memory = new FakeMemory();
    const disabled = new TaskMemoryToolProvider({
      memory,
      enabled: () => false,
    });
    expect(await disabled.getTools(context())).toEqual([]);

    const enabled = new TaskMemoryToolProvider({ memory });
    const [tool] = await enabled.getTools(context());
    await tool!.execute({}, context());
    expect(memory.calls[0]).toEqual({ conversationId: 'cid-1' });
  });
});
