import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type { AgentJob } from '../types/jobs.js';
import type {
  AddAgentTaskLinkInput,
  AgentTask,
  AgentTaskLink,
  AgentTaskStore,
  AgentTaskSubscription,
  CreateAgentTaskInput,
  ListAgentTasksInput,
  UpdateAgentTaskInput,
} from '../types/tasks.js';
import { TaskService, taskIdFromJob } from './TaskService.js';

class MemoryTaskStore implements AgentTaskStore {
  public readonly tasks = new Map<string, AgentTask>();
  public readonly links: AgentTaskLink[] = [];
  public readonly subscriptions: AgentTaskSubscription[] = [];
  private seq = 0;
  private clock = 1_000;

  public async create(input: CreateAgentTaskInput): Promise<AgentTask> {
    this.seq += 1;
    const task: AgentTask = {
      id: `task-${String(this.seq).padStart(4, '0')}-0000-4000-8000-000000000000`,
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      ownerStaffId: input.ownerStaffId,
      ownerNick: input.ownerNick,
      title: input.title,
      prompt: input.prompt,
      status: 'active',
      summary: null,
      metadata: input.metadata ?? {},
      createdAt: this.clock,
      updatedAt: this.clock,
      closedAt: null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  public async get(id: string): Promise<AgentTask | null> {
    return this.tasks.get(id) ?? null;
  }

  public async list(input: ListAgentTasksInput = {}): Promise<AgentTask[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          (!input.conversationId ||
            task.conversationId === input.conversationId) &&
          (!input.ownerStaffId ||
            task.ownerStaffId === input.ownerStaffId) &&
          (!input.status ||
            input.status.length === 0 ||
            input.status.includes(task.status)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, input.limit ?? 20);
  }

  public async update(
    id: string,
    patch: UpdateAgentTaskInput,
  ): Promise<AgentTask | null> {
    const task = this.tasks.get(id);
    if (!task) return null;
    const next: AgentTask = {
      ...task,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      ...(patch.closedAt !== undefined ? { closedAt: patch.closedAt } : {}),
      updatedAt: this.clock + 1,
    };
    this.clock += 1;
    this.tasks.set(id, next);
    return next;
  }

  public async addLink(input: AddAgentTaskLinkInput): Promise<AgentTaskLink> {
    const existing = this.links.find(
      (link) =>
        link.taskId === input.taskId &&
        link.kind === input.kind &&
        link.ref === input.ref,
    );
    if (existing) return existing;
    const link: AgentTaskLink = {
      id: `link-${this.links.length + 1}`,
      taskId: input.taskId,
      kind: input.kind,
      ref: input.ref,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      createdAt: this.clock,
    };
    this.links.push(link);
    return link;
  }

  public async listLinks(taskId: string): Promise<AgentTaskLink[]> {
    return this.links.filter((link) => link.taskId === taskId);
  }

  public async subscribe(input: {
    taskId: string;
    staffId: string;
    nick: string;
  }): Promise<boolean> {
    const exists = this.subscriptions.some(
      (item) =>
        item.taskId === input.taskId && item.staffId === input.staffId,
    );
    if (exists) return false;
    this.subscriptions.push({
      taskId: input.taskId,
      staffId: input.staffId,
      nick: input.nick,
      createdAt: this.clock,
    });
    return true;
  }

  public async unsubscribe(taskId: string, staffId: string): Promise<boolean> {
    const index = this.subscriptions.findIndex(
      (item) => item.taskId === taskId && item.staffId === staffId,
    );
    if (index < 0) return false;
    this.subscriptions.splice(index, 1);
    return true;
  }

  public async listSubscribers(
    taskId: string,
  ): Promise<AgentTaskSubscription[]> {
    return this.subscriptions.filter((item) => item.taskId === taskId);
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '/task new 整理本周客户反馈',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

function job(taskId: string, id = 'job-0001'): AgentJob {
  return {
    id,
    conversationId: 'cid-1',
    conversationType: '2',
    messageId: 'job-msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    kind: 'task',
    status: 'running',
    prompt: '整理本周客户反馈',
    metadata: { taskId },
    result: null,
    error: null,
    priority: 0,
    attempts: 1,
    maxAttempts: 2,
    leaseOwner: 'runner',
    leaseExpiresAt: 0,
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    finishedAt: null,
  };
}

function createService(
  options: {
    isAdmin?: (staffId: string) => boolean;
    enqueue?: TaskServiceOptionsEnqueue;
  } = {},
) {
  const store = new MemoryTaskStore();
  const enqueued: Array<{ messageId: string; prompt: string; taskId: string }> = [];
  const service = new TaskService({
    store,
    now: () => 5_000,
    isAdmin: options.isAdmin ?? (() => false),
    enqueue:
      options.enqueue ??
      (async (inbound, prompt, taskId) => {
        enqueued.push({
          messageId: inbound.messageId,
          prompt,
          taskId,
        });
        return job(taskId);
      }),
  });
  return { store, service, enqueued };
}

type TaskServiceOptionsEnqueue = ConstructorParameters<typeof TaskService>[0]['enqueue'];

describe('TaskService', () => {
  it('/task new 创建线程、自动订阅并关联消息/会话/后台任务', async () => {
    const { store, service, enqueued } = createService();
    const reply = await service.handleCommand(message(), [
      'new',
      '整理本周客户反馈',
    ]);
    expect(reply).toContain('已创建任务线程');
    expect(reply).toContain('后台任务 job-0001 已入队');
    expect(enqueued).toEqual([
      { messageId: 'msg-1', prompt: '整理本周客户反馈', taskId: expect.any(String) },
    ]);

    const task = [...store.tasks.values()][0];
    expect(task).toMatchObject({
      title: '整理本周客户反馈',
      status: 'active',
      ownerStaffId: 'staff-1',
      conversationType: '2',
    });
    expect(store.links.map((link) => [link.kind, link.ref])).toEqual([
      ['message', 'msg-1'],
      ['conversation', 'cid-1'],
      ['job', 'job-0001'],
    ]);
    expect(store.subscriptions).toEqual([
      expect.objectContaining({ taskId: task?.id, staffId: 'staff-1' }),
    ]);
  });

  it('/task list 与 /task show 展示线程、关联与订阅者', async () => {
    const { service } = createService();
    await service.handleCommand(message(), ['new', '整理本周客户反馈']);
    await service.handleCommand(message(), [
      'subscribe',
      'task-0001',
    ]);

    const list = await service.handleCommand(message(), ['list']);
    expect(list).toContain('本会话最近的任务线程');
    expect(list).toContain('整理本周客户反馈');
    expect(list).toContain('1 人订阅');

    const detail = await service.handleCommand(message(), [
      'show',
      'task-0001',
    ]);
    expect(detail).toContain('任务 task-000 · 进行中');
    expect(detail).toContain('关联：');
    expect(detail).toContain('后台任务:job-0001');
    expect(detail).toContain('订阅：1 人（张三）');
  });

  it('关联外部实体需要发起人或管理员，重复关联幂等', async () => {
    const { service, store } = createService();
    await service.handleCommand(message(), ['new', '整理本周客户反馈']);

    const denied = await service.handleCommand(
      message({ senderStaffId: 'staff-2', senderNick: '李四' }),
      ['link', 'task-0001', 'url', 'https://doc.example.com'],
    );
    expect(denied).toContain('只有任务发起人或管理员');

    const linked = await service.handleCommand(message(), [
      'link',
      'task-0001',
      'url',
      'https://doc.example.com',
      '需求文档',
    ]);
    expect(linked).toContain('已关联链接');
    const again = await service.handleCommand(message(), [
      'link',
      'task-0001',
      'url',
      'https://doc.example.com',
    ]);
    expect(again).toContain('已关联链接');
    const urls = store.links.filter((link) => link.kind === 'url');
    expect(urls).toHaveLength(1);
    expect(urls[0]?.label).toBe('需求文档');
  });

  it('订阅与取消订阅对群成员开放', async () => {
    const { service } = createService();
    await service.handleCommand(message(), ['new', '整理本周客户反馈']);
    const other = message({ senderStaffId: 'staff-2', senderNick: '李四' });

    expect(
      await service.handleCommand(other, ['subscribe', 'task-0001']),
    ).toContain('已订阅任务');
    expect(
      await service.handleCommand(other, ['subscribe', 'task-0001']),
    ).toContain('你已订阅任务');
    expect(
      await service.handleCommand(other, ['unsubscribe', 'task-0001']),
    ).toContain('已取消订阅');
    expect(
      await service.handleCommand(other, ['unsubscribe', 'task-0001']),
    ).toContain('你尚未订阅');
  });

  it('关闭线程只更新线程状态，不取消后台任务', async () => {
    const { service, store } = createService();
    await service.handleCommand(message(), ['new', '整理本周客户反馈']);
    const reply = await service.handleCommand(message(), [
      'close',
      'task-0001',
    ]);
    expect(reply).toContain('已关闭任务线程');
    expect(reply).toContain('/job-cancel');
    expect(store.tasks.get('task-0001-0000-4000-8000-000000000000')).toMatchObject({
      status: 'closed',
      closedAt: 5_000,
    });

    const denied = await service.handleCommand(
      message({ senderStaffId: 'staff-2', senderNick: '李四' }),
      ['close', 'task-0001'],
    );
    expect(denied).toContain('只有任务发起人或管理员');
  });

  it('后台任务完成后同步线程摘要，已关闭线程不被改写', async () => {
    const { service, store } = createService();
    await service.handleCommand(message(), ['new', '整理本周客户反馈']);
    const taskId = [...store.tasks.keys()][0]!;

    const updated = await service.completeForJob(
      job(taskId),
      'completed',
      '共整理 12 条反馈，重点是登录失败。',
    );
    expect(updated).toMatchObject({
      status: 'completed',
      summary: '共整理 12 条反馈，重点是登录失败。',
    });

    await service.handleCommand(message(), ['close', taskId]);
    const closed = await service.completeForJob(
      job(taskId),
      'failed',
      '不应覆盖',
    );
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed?.summary).toBe('共整理 12 条反馈，重点是登录失败。');
  });
});
