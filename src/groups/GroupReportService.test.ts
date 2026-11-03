import { describe, expect, it } from 'vitest';
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskStore,
  ScheduledTaskUpdate,
} from '../types/admin-and-console.js';
import type { InboundMessage } from '../types/core.js';
import { GroupReportService } from './GroupReportService.js';

const NOW = 1_764_500_000_000;

class MemoryScheduledStore implements ScheduledTaskStore {
  public readonly tasks: ScheduledTask[] = [];
  private sequence = 0;

  public async list(): Promise<ScheduledTask[]> {
    return [...this.tasks];
  }

  public async listDue(): Promise<ScheduledTask[]> {
    return [];
  }

  public async create(
    input: ScheduledTaskInput,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    this.sequence += 1;
    const task: ScheduledTask = {
      id: `task-${String(this.sequence).padStart(4, '0')}`,
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      kind: input.kind ?? 'prompt',
      title: input.title,
      prompt: input.prompt,
      intervalSeconds: input.intervalSeconds ?? null,
      cron: input.cron ?? null,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt:
        nextRunAtMs === null ? null : new Date(nextRunAtMs).toISOString(),
      createdBy: input.createdBy ?? '',
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    };
    this.tasks.push(task);
    return task;
  }

  public async update(
    id: string,
    input: ScheduledTaskUpdate,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error('missing');
    Object.assign(task, input, {
      nextRunAt:
        nextRunAtMs === null ? null : new Date(nextRunAtMs).toISOString(),
    });
    return task;
  }

  public async remove(id: string): Promise<boolean> {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    this.tasks.splice(index, 1);
    return true;
  }

  public async markRun(): Promise<void> {}
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-group-1',
    conversationType: '2',
    senderStaffId: 'staff-admin',
    senderNick: '管理员',
    isAtBot: true,
    text: '',
    rawPayload: {},
    timestamp: NOW,
    ...overrides,
  };
}

function setup() {
  const store = new MemoryScheduledStore();
  const service = new GroupReportService({
    store,
    isAdmin: (staffId) => staffId === 'staff-admin',
    buildDigest: async () => '【群目标进度】SLA 达标 进度 60%',
  });
  return { store, service };
}

describe('GroupReportService', () => {
  it('仅管理员可创建播报，按 cron 计算下次运行', async () => {
    const { store, service } = setup();
    const denied = await service.handleCommand(
      message({ senderStaffId: 'staff-1' }),
      ['daily', '09:00'],
    );
    expect(denied).toContain('只有管理员');
    expect(store.tasks).toHaveLength(0);

    const created = await service.handleCommand(message(), ['daily', '09:00']);
    expect(created).toContain('已创建群目标播报');
    expect(store.tasks[0]).toMatchObject({
      conversationId: 'cid-group-1',
      conversationType: '2',
      kind: 'group_report',
      cron: '0 9 * * *',
      createdBy: 'staff-admin',
    });
    expect(store.tasks[0]!.nextRunAt).toBeTruthy();
  });

  it('默认列表与 preview 使用确定性摘要', async () => {
    const { store, service } = setup();
    const empty = await service.handleCommand(message(), []);
    expect(empty).toContain('本群还没有定时播报');

    const preview = await service.handleCommand(message(), ['preview']);
    expect(preview).toContain('SLA 达标');

    await service.handleCommand(message(), ['weekly', '周一', '09:00']);
    expect(store.tasks[0]!.cron).toBe('0 9 * * 1');
    const list = await service.handleCommand(message(), []);
    expect(list).toContain('每周一 09:00');
    expect(list).toContain(store.tasks[0]!.id.slice(0, 8));
  });

  it('创建人或管理员可按前缀取消播报', async () => {
    const { store, service } = setup();
    await service.create({
      conversationId: 'cid-group-1',
      actor: 'staff-1',
      spec: { frequency: 'daily', hour: 9, minute: 0 },
    });
    const task = store.tasks[0]!;

    const denied = await service.handleCommand(
      message({ senderStaffId: 'staff-2' }),
      ['cancel', task.id.slice(0, 8)],
    );
    expect(denied).toContain('只有创建人或管理员');

    const removed = await service.handleCommand(message(), [
      'cancel',
      task.id.slice(0, 8),
    ]);
    expect(removed).toContain('已取消群播报');
    expect(store.tasks).toHaveLength(0);
  });

  it('单聊不能创建群播报，且每群有数量上限', async () => {
    const { service } = setup();
    expect(
      await service.handleCommand(message({ conversationType: '1' }), [
        'daily',
        '09:00',
      ]),
    ).toContain('只能在群聊中设置');

    for (let index = 0; index < 4; index += 1) {
      await service.create({
        conversationId: 'cid-group-1',
        actor: 'staff:admin',
        spec: { frequency: 'daily', hour: 9 + index, minute: 0 },
      });
    }
    await expect(
      service.create({
        conversationId: 'cid-group-1',
        actor: 'staff:admin',
        spec: { frequency: 'daily', hour: 20, minute: 0 },
      }),
    ).rejects.toThrow('已达上限');
  });
});
