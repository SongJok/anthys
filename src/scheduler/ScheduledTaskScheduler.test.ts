import { describe, expect, it } from 'vitest';
import {
  ScheduledTaskScheduler,
  computeNextRun,
} from './ScheduledTaskScheduler.js';
import type {
  ScheduledTask,
  ScheduledTaskStore,
} from '../types/admin-and-console.js';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    conversationId: 'cid-dev',
    conversationType: '2',
    kind: 'prompt',
    title: '每日巡检',
    prompt: '汇总昨日错误日志',
    intervalSeconds: null,
    cron: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: new Date(0).toISOString(),
    createdBy: 'admin-1',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

class FakeStore implements ScheduledTaskStore {
  public readonly runs: Array<[string, number, number | null]> = [];
  public readonly updates: Array<[string, unknown, number | null]> = [];
  constructor(public due: ScheduledTask[]) {}

  async list(): Promise<ScheduledTask[]> {
    return this.due;
  }
  async listDue(): Promise<ScheduledTask[]> {
    return this.due;
  }
  async create(): Promise<ScheduledTask> {
    throw new Error('not used');
  }
  async update(
    id: string,
    input: unknown,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    this.updates.push([id, input, nextRunAtMs]);
    return this.due[0]!;
  }
  async remove(): Promise<boolean> {
    return true;
  }
  async markRun(
    id: string,
    lastRunAtMs: number,
    nextRunAtMs: number | null,
  ): Promise<void> {
    this.runs.push([id, lastRunAtMs, nextRunAtMs]);
  }
}

describe('computeNextRun', () => {
  it('优先使用 cron，其次固定间隔，停用返回 null', () => {
    const now = Date.UTC(2026, 9, 30, 2, 2, 0);
    expect(computeNextRun(task({ cron: '*/5 * * * *' }), now)).toBe(
      Date.UTC(2026, 9, 30, 2, 5, 0),
    );
    expect(computeNextRun(task({ intervalSeconds: 60 }), now)).toBe(
      now + 60_000,
    );
    expect(computeNextRun(task({ enabled: false }), now)).toBeNull();
  });

  it('未配置调度方式时抛错', () => {
    expect(() => computeNextRun(task(), Date.now())).toThrow('cron');
  });

  it('一次性提醒不推进下一次时间', () => {
    expect(
      computeNextRun(task({ kind: 'reminder' }), Date.now()),
    ).toBeNull();
  });
});

describe('ScheduledTaskScheduler', () => {
  it('执行到期任务并推进下一次时间', async () => {
    const store = new FakeStore([task({ intervalSeconds: 60 })]);
    const executed: string[] = [];
    const scheduler = new ScheduledTaskScheduler({
      store,
      execute: async (item) => {
        executed.push(item.id);
      },
      now: () => 10_000,
    });

    await scheduler.tick();
    expect(executed).toEqual(['task-1']);
    expect(store.runs).toEqual([['task-1', 10_000, 70_000]]);
  });

  it('一次性提醒执行后停用任务', async () => {
    const store = new FakeStore([task({ kind: 'reminder' })]);
    const scheduler = new ScheduledTaskScheduler({
      store,
      execute: async () => {},
      now: () => 10_000,
    });

    await scheduler.tick();
    expect(store.updates).toEqual([['task-1', { enabled: false }, null]]);
    expect(store.runs).toEqual([['task-1', 10_000, null]]);
  });

  it('单个任务失败仍推进调度，不影响其他任务', async () => {
    const store = new FakeStore([
      task({ id: 'bad', intervalSeconds: 60 }),
      task({ id: 'good', intervalSeconds: 60 }),
    ]);
    const executed: string[] = [];
    const scheduler = new ScheduledTaskScheduler({
      store,
      execute: async (item) => {
        executed.push(item.id);
        if (item.id === 'bad') throw new Error('推送失败');
      },
      now: () => 0,
    });

    await scheduler.tick();
    expect(executed).toEqual(['bad', 'good']);
    expect(store.runs.map(([id]) => id)).toEqual(['bad', 'good']);
  });

  it('重复 tick 复用进行中的执行，避免并发重复播报', async () => {
    const store = new FakeStore([task({ intervalSeconds: 60 })]);
    let release: (() => void) | undefined;
    const executed: string[] = [];
    const scheduler = new ScheduledTaskScheduler({
      store,
      execute: async (item) => {
        executed.push(item.id);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      now: () => 0,
    });

    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(first).toBe(second);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    await first;
    expect(executed).toEqual(['task-1']);
  });
});
