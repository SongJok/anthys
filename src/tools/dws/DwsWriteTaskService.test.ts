import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../../types/core.js';
import type {
  DwsWriteTask,
  DwsWriteTaskStore,
} from '../../types/dws-write-task.js';
import type { DwsIdentityService } from './DwsIdentityService.js';
import { DwsWriteTaskService } from './DwsWriteTaskService.js';

class MemoryTaskStore implements DwsWriteTaskStore {
  public readonly tasks = new Map<string, DwsWriteTask>();

  async save(task: DwsWriteTask): Promise<DwsWriteTask> {
    this.tasks.set(task.conversationId, { ...task });
    return { ...task };
  }

  async getByConversation(conversationId: string): Promise<DwsWriteTask | null> {
    return this.tasks.get(conversationId) ?? null;
  }

  async listWaiting(nowMs: number): Promise<DwsWriteTask[]> {
    return [...this.tasks.values()].filter(
      (task) => task.state === 'waiting_auth' && task.expiresAt > nowMs,
    );
  }

  async claim(id: string, nowMs: number): Promise<DwsWriteTask | null> {
    for (const [key, task] of this.tasks) {
      if (task.id !== id || task.state !== 'waiting_auth') continue;
      const claimed: DwsWriteTask = {
        ...task,
        state: 'resuming',
        attempts: task.attempts + 1,
        updatedAt: nowMs,
      };
      this.tasks.set(key, claimed);
      return claimed;
    }
    return null;
  }

  async update(task: DwsWriteTask): Promise<void> {
    this.tasks.set(task.conversationId, { ...task });
  }

  async remove(conversationId: string): Promise<void> {
    this.tasks.delete(conversationId);
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '帮我建一个明天十点的评审日程',
    rawPayload: {},
    timestamp: 1,
    ...overrides,
  };
}

function fakeIdentity(
  states: Array<'authenticated' | 'unbound' | 'expired'>,
): {
  identity: Pick<DwsIdentityService, 'status'>;
  calls: number;
} {
  const queue = [...states];
  const result = {
    calls: 0,
    identity: {
      status: async () => {
        result.calls += 1;
        const state = queue.length > 1 ? queue.shift()! : queue[0]!;
        return {
          state,
          record: null,
          token: null,
          checkedAt: Date.now(),
        };
      },
    } as Pick<DwsIdentityService, 'status'>,
  };
  return result;
}

function service(
  store: MemoryTaskStore,
  identity: Pick<DwsIdentityService, 'status'>,
  options: {
    resume?: (task: DwsWriteTask) => Promise<void>;
    notify?: (message: InboundMessage, text: string) => Promise<void>;
    now?: () => number;
  } = {},
): {
  service: DwsWriteTaskService;
  resumed: DwsWriteTask[];
  notices: string[];
} {
  const resumed: DwsWriteTask[] = [];
  const notices: string[] = [];
  const instance = new DwsWriteTaskService({
    store,
    identity,
    resume:
      options.resume ??
      (async (task) => {
        resumed.push(task);
      }),
    notify:
      options.notify ??
      (async (_msg, text) => {
        notices.push(text);
      }),
    ...(options.now ? { now: options.now } : {}),
    pollDelaysMs: [5_000],
    pollIntervalMs: 5_000,
  });
  return { service: instance, resumed, notices };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DwsWriteTaskService', () => {
  it('授权成功事件到达后立即抢锁并恢复原始消息', async () => {
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['authenticated']);
    const { service: tasks, resumed, notices } = service(store, identity);
    const original = message();
    await tasks.create({
      message: original,
      toolName: 'dws_calendar_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    const claimed = await tasks.resumeForStaff('staff-1');

    expect(claimed).toEqual(['conv-1']);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.message).toEqual(original);
    expect(resumed[0]?.toolName).toBe('dws_calendar_manage');
    expect(resumed[0]?.args).toEqual({ action: 'create' });
    expect(notices[0]).toContain('正在自动继续');
    expect(await store.getByConversation('conv-1')).toBeNull();
    tasks.dispose();
  });

  it('未收到登录事件时轮询授权状态，确认后自动恢复且只执行一次', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['unbound', 'unbound', 'authenticated']);
    const { service: tasks, resumed } = service(store, identity, {
      now: () => now,
    });
    await tasks.start();
    await tasks.create({
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resumed).toHaveLength(0);
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resumed).toHaveLength(1);

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resumed).toHaveLength(1);
    tasks.dispose();
  });

  it('多实例并发恢复时只有一个实例抢到任务', async () => {
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['authenticated']);
    const first = service(store, identity);
    const second = service(store, identity);
    await first.service.create({
      message: message(),
      toolName: 'dws_calendar_manage',
      args: { action: 'create' },
      risk: 'write',
    });
    await second.service.start();

    const [a, b] = await Promise.all([
      first.service.resumeForStaff('staff-1'),
      second.service.resumeForStaff('staff-1'),
    ]);

    expect(a.length + b.length).toBe(1);
    expect(first.resumed.length + second.resumed.length).toBe(1);
    first.service.dispose();
    second.service.dispose();
  });

  it('登录失败时结束等待并提示写操作没有执行', async () => {
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['unbound']);
    const { service: tasks, notices } = service(store, identity);
    await tasks.create({
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    const failed = await tasks.failForStaff('staff-1', '授权进程退出');

    expect(failed).toEqual(['conv-1']);
    expect(notices[0]).toContain('刚才的写操作没有执行');
    expect(store.tasks.get('conv-1')?.state).toBe('failed');
    tasks.dispose();
  });

  it('超时后结束等待并提示重新发起', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['unbound']);
    const { service: tasks, resumed, notices } = service(store, identity, {
      now: () => now,
    });
    await tasks.start();
    await tasks.create({
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    now += 20 * 60_000;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resumed).toHaveLength(0);
    expect(notices.at(-1)).toContain('授权链接已超时');
    expect(store.tasks.get('conv-1')?.state).toBe('expired');
    tasks.dispose();
  });

  it('取消后不再自动执行', async () => {
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['authenticated']);
    const { service: tasks, resumed, notices } = service(store, identity);
    await tasks.create({
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    expect(await tasks.cancelByConversation('conv-1')).toBe(true);
    expect(await tasks.resumeForStaff('staff-1')).toEqual([]);
    expect(resumed).toHaveLength(0);
    expect(notices[0]).toContain('已取消');
    tasks.dispose();
  });

  it('重启后从持久层恢复未过期的等待任务', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const store = new MemoryTaskStore();
    await store.save({
      id: 'task-1',
      conversationId: 'conv-1',
      staffId: 'staff-1',
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
      state: 'waiting_auth',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 10 * 60_000,
    });
    const { identity } = fakeIdentity(['authenticated']);
    const { service: tasks, resumed } = service(store, identity, {
      now: () => now,
    });
    await tasks.start();

    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.message.conversationId).toBe('conv-1');
    tasks.dispose();
  });

  it('自动执行失败时保留失败记录并提示可以重新发起', async () => {
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['authenticated']);
    const { service: tasks, notices } = service(store, identity, {
      resume: async () => {
        throw new Error('DWS 命令执行失败');
      },
    });
    await tasks.create({
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    await tasks.resumeForStaff('staff-1');

    expect(store.tasks.get('conv-1')?.state).toBe('failed');
    expect(store.tasks.get('conv-1')?.lastError).toContain('DWS 命令执行失败');
    expect(notices.at(-1)).toContain('自动继续执行写操作失败');
    tasks.dispose();
  });

  it('登录事件落在没有内存任务的实例上时从持久层同步', async () => {
    const store = new MemoryTaskStore();
    const { identity } = fakeIdentity(['authenticated']);
    await store.save({
      id: 'task-db',
      conversationId: 'conv-1',
      staffId: 'staff-1',
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
      state: 'waiting_auth',
      attempts: 0,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const { service: tasks, resumed } = service(store, identity);

    const claimed = await tasks.resumeForStaff('staff-1');

    expect(claimed).toEqual(['conv-1']);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.id).toBe('task-db');
    tasks.dispose();
  });

  it('同一会话覆盖任务时以数据库返回的原 id 继续执行', async () => {
    class UpsertStore extends MemoryTaskStore {
      private seq = 0;
      override async save(task: DwsWriteTask): Promise<DwsWriteTask> {
        const existing = this.tasks.get(task.conversationId);
        const persisted: DwsWriteTask = existing
          ? { ...task, id: existing.id }
          : { ...task, id: `db-${++this.seq}` };
        this.tasks.set(task.conversationId, persisted);
        return { ...persisted };
      }
    }
    const store = new UpsertStore();
    const { identity } = fakeIdentity(['authenticated']);
    const { service: tasks, resumed } = service(store, identity);
    const first = await tasks.create({
      message: message(),
      toolName: 'dws_todo_manage',
      args: { action: 'create' },
      risk: 'write',
    });
    const second = await tasks.create({
      message: message({ messageId: 'msg-2' }),
      toolName: 'dws_calendar_manage',
      args: { action: 'create' },
      risk: 'write',
    });

    expect(first.id).toBe('db-1');
    expect(second.id).toBe('db-1');
    await tasks.resumeForStaff('staff-1');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.id).toBe('db-1');
    expect(resumed[0]?.message.messageId).toBe('msg-2');
    expect(await store.getByConversation('conv-1')).toBeNull();
    tasks.dispose();
  });
});
