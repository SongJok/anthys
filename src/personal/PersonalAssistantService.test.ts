import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskStore,
  ScheduledTaskUpdate,
} from '../types/admin-and-console.js';
import type { PersonalReportBuilder } from './PersonalReportBuilder.js';
import {
  PersonalAssistantService,
  buildReportCron,
  parseReminderArgs,
  parseReportSpec,
} from './PersonalAssistantService.js';

const NOW = Date.UTC(2026, 9, 31, 2, 0, 0);

function shanghai(iso: string): number {
  return Date.parse(iso);
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-dm',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '/report',
    rawPayload: {},
    timestamp: NOW,
    ...overrides,
  };
}

class MemoryTaskStore implements ScheduledTaskStore {
  public tasks: ScheduledTask[] = [];
  private seq = 0;

  async list(): Promise<ScheduledTask[]> {
    return [...this.tasks];
  }
  async listDue(): Promise<ScheduledTask[]> {
    return [];
  }
  async create(
    input: ScheduledTaskInput,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: `task-${++this.seq}`,
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
  async update(
    id: string,
    input: ScheduledTaskUpdate,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask> {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error('missing');
    Object.assign(task, input);
    if (nextRunAtMs !== null) {
      task.nextRunAt = new Date(nextRunAtMs).toISOString();
    }
    return task;
  }
  async remove(id: string): Promise<boolean> {
    const index = this.tasks.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.tasks.splice(index, 1);
    return true;
  }
  async markRun(): Promise<void> {}
}

function service(overrides: {
  store?: MemoryTaskStore;
  report?: PersonalReportBuilder;
  now?: () => number;
  maxActiveTasksPerUser?: number;
  maxReportsPerUser?: number;
} = {}): { assistant: PersonalAssistantService; store: MemoryTaskStore } {
  const store = overrides.store ?? new MemoryTaskStore();
  const report =
    overrides.report ??
    ({
      build: async (request: { kind: string }) => ({
        text: `REPORT ${request.kind}`,
        ok: true,
        errors: [],
      }),
    } as unknown as PersonalReportBuilder);
  return {
    store,
    assistant: new PersonalAssistantService({
      store,
      report,
      now: overrides.now ?? (() => NOW),
      ...(overrides.maxActiveTasksPerUser
        ? { maxActiveTasksPerUser: overrides.maxActiveTasksPerUser }
        : {}),
      ...(overrides.maxReportsPerUser
        ? { maxReportsPerUser: overrides.maxReportsPerUser }
        : {}),
    }),
  };
}

describe('parseReminderArgs', () => {
  it('解析相对时间', () => {
    expect(parseReminderArgs('25分钟后 开会', NOW)).toEqual({
      atMs: NOW + 25 * 60_000,
      text: '开会',
    });
    expect(parseReminderArgs('2小时后 看日志', NOW)).toEqual({
      atMs: NOW + 2 * 3_600_000,
      text: '看日志',
    });
    expect(parseReminderArgs('3天后 复盘', NOW)).toEqual({
      atMs: NOW + 3 * 86_400_000,
      text: '复盘',
    });
    expect(parseReminderArgs('25分钟后开会', NOW)).toEqual({
      atMs: NOW + 25 * 60_000,
      text: '开会',
    });
  });

  it('解析明天/绝对时间与仅时间', () => {
    expect(parseReminderArgs('明天9点 提交周报', NOW)).toEqual({
      atMs: shanghai('2026-11-01T09:00:00+08:00'),
      text: '提交周报',
    });
    expect(parseReminderArgs('今天18:30 下班', NOW)).toEqual({
      atMs: shanghai('2026-10-31T18:30:00+08:00'),
      text: '下班',
    });
    expect(parseReminderArgs('2026-11-01 09:00 复盘', NOW)).toEqual({
      atMs: shanghai('2026-11-01T09:00:00+08:00'),
      text: '复盘',
    });
    expect(parseReminderArgs('11月1日 9点半 对接', NOW)).toEqual({
      atMs: shanghai('2026-11-01T09:30:00+08:00'),
      text: '对接',
    });
    expect(parseReminderArgs('9:00 开会', NOW)).toEqual({
      atMs: shanghai('2026-11-01T09:00:00+08:00'),
      text: '开会',
    });
  });

  it('拒绝缺少内容或时间过近', () => {
    expect(parseReminderArgs('', NOW)).toContain('请补充');
    expect(parseReminderArgs('25分钟后', NOW)).toContain('请补充');
    expect(parseReminderArgs('今天9:00 开会', NOW)).toContain('至少要在 30 秒之后');
    expect(parseReminderArgs('中午开会', NOW)).toContain('无法识别时间');
  });
});

describe('parseReportSpec', () => {
  it('解析日/周/月并生成 cron', () => {
    const daily = parseReportSpec('daily 09:00');
    expect(typeof daily).not.toBe('string');
    if (typeof daily !== 'string') {
      expect(buildReportCron(daily)).toBe('0 9 * * *');
    }

    const weekly = parseReportSpec('weekly 周一 09:30');
    expect(typeof weekly).not.toBe('string');
    if (typeof weekly !== 'string') {
      expect(weekly.weekday).toBe(1);
      expect(buildReportCron(weekly)).toBe('30 9 * * 1');
    }

    const sunday = parseReportSpec('weekly 周日 9点');
    expect(typeof sunday).not.toBe('string');
    if (typeof sunday !== 'string') {
      expect(buildReportCron(sunday)).toBe('0 9 * * 7');
    }

    const monthly = parseReportSpec('monthly 每月1日 08:00');
    expect(typeof monthly).not.toBe('string');
    if (typeof monthly !== 'string') {
      expect(buildReportCron(monthly)).toBe('0 8 1 * *');
    }
  });

  it('拒绝非法输入', () => {
    expect(parseReportSpec('')).toContain('用法');
    expect(parseReportSpec('monthly 31 08:00')).toContain('1–28');
    expect(parseReportSpec('weekly 周八 08:00')).toContain('无法识别');
  });
});

describe('PersonalAssistantService', () => {
  it('创建提醒并校验单聊、配额与取消归属', async () => {
    const { assistant, store } = service({ maxActiveTasksPerUser: 2 });
    const task = await assistant.createReminderFromText({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      raw: '25分钟后 开会',
    });
    expect(task.kind).toBe('reminder');
    expect(task.conversationType).toBe('1');
    expect(task.prompt).toBe('开会');
    expect(task.nextRunAt).toBe(new Date(NOW + 25 * 60_000).toISOString());

    await assistant.createReminderFromText({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      raw: '明天9点 提交周报',
    });
    await expect(
      assistant.createReminderFromText({
        staffId: 'staff-1',
        conversationId: 'cid-dm',
        raw: '3天后 复盘',
      }),
    ).rejects.toThrow('上限');

    expect(await assistant.cancelOwn('staff-2', task.id)).toBeNull();
    const cancelled = await assistant.cancelOwn('staff-1', task.id.slice(0, 8));
    expect(cancelled?.id).toBe(task.id);
    expect(store.tasks).toHaveLength(1);
  });

  it('创建定时报告并限制数量', async () => {
    const { assistant } = service({ maxReportsPerUser: 1 });
    const spec = parseReportSpec('daily 09:00');
    if (typeof spec === 'string') throw new Error(spec);
    const task = await assistant.createReport({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      spec,
    });
    expect(task.kind).toBe('daily_report');
    expect(task.cron).toBe('0 9 * * *');
    expect(task.nextRunAt).toBe(
      new Date(shanghai('2026-11-01T09:00:00+08:00')).toISOString(),
    );

    const weekly = parseReportSpec('weekly 周一 09:30');
    if (typeof weekly === 'string') throw new Error(weekly);
    await expect(
      assistant.createReport({
        staffId: 'staff-1',
        conversationId: 'cid-dm',
        spec: weekly,
      }),
    ).rejects.toThrow('定时报告已达上限');
  });

  it('列表只显示本人且排除 prompt 任务', async () => {
    const { assistant, store } = service();
    store.tasks.push(
      {
        id: 'task-other',
        conversationId: 'cid-2',
        conversationType: '1',
        kind: 'reminder',
        title: '别人',
        prompt: '别人',
        intervalSeconds: null,
        cron: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: new Date(NOW + 60_000).toISOString(),
        createdBy: 'staff-2',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'task-prompt',
        conversationId: 'cid-dm',
        conversationType: '1',
        kind: 'prompt',
        title: '播报',
        prompt: '播报',
        intervalSeconds: 60,
        cron: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: new Date(NOW + 60_000).toISOString(),
        createdBy: 'staff-1',
        createdAt: '',
        updatedAt: '',
      },
    );

    const task = await assistant.createReminderFromText({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      raw: '25分钟后 开会',
    });
    expect((await assistant.listOwn('staff-1')).map((item) => item.id)).toEqual([
      task.id,
    ]);
  });

  it('命令在群里拒绝，在单聊创建并返回提示', async () => {
    const { assistant } = service();
    const group = await assistant.handleRemindCommand(
      message({ conversationType: '2' }),
      ['25分钟后', '开会'],
    );
    expect(group).toContain('单聊');

    const created = await assistant.handleRemindCommand(message(), [
      '25分钟后',
      '开会',
    ]);
    expect(created).toContain('已设置提醒');
    expect(created).toContain('2026-10-31 10:25');

    const list = await assistant.handleRemindCommand(message(), ['list']);
    expect(list).toContain('一次性提醒');
    expect(list).toContain('ID task-1');
  });

  it('报告命令支持预览与列表', async () => {
    const { assistant } = service();
    const preview = await assistant.handleReportCommand(message(), [
      'preview',
      'weekly',
    ]);
    expect(preview).toBe('REPORT weekly_report');

    const help = await assistant.handleReportCommand(message(), []);
    expect(help).toContain('/report daily 09:00');
    expect(help).toContain('当前没有定时报告');
  });

  it('定时投递文案', async () => {
    const { assistant } = service();
    const reminder = await assistant.createReminderFromText({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      raw: '25分钟后 开会',
    });
    expect(assistant.reminderDeliveryText(reminder)).toBe('⏰ 提醒：开会');

    const spec = parseReportSpec('daily 09:00');
    if (typeof spec === 'string') throw new Error(spec);
    const report = await assistant.createReport({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      spec,
    });
    expect(await assistant.reportDeliveryText(report)).toBe(
      'REPORT daily_report',
    );
  });
});
