import type { InboundMessage } from '../types/core.js';
import type {
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskStore,
} from '../types/admin-and-console.js';
import { computeNextRun } from '../scheduler/ScheduledTaskScheduler.js';
import {
  PersonalReportBuilder,
  type PersonalReportKind,
} from './PersonalReportBuilder.js';

export type ReportFrequency = 'daily' | 'weekly' | 'monthly';

export interface PersonalAssistantServiceOptions {
  store: ScheduledTaskStore;
  report: PersonalReportBuilder;
  now?: () => number;
  /** 每个用户同时保留的个人定时任务上限 */
  maxActiveTasksPerUser?: number;
  /** 每个用户同时保留的定时报告上限 */
  maxReportsPerUser?: number;
}

export interface ParsedReminder {
  atMs: number;
  text: string;
}

export interface ReportSpec {
  frequency: ReportFrequency;
  hour: number;
  minute: number;
  weekday?: number;
  dayOfMonth?: number;
}

const SH_OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MIN_LEAD_MS = 30_000;
const MAX_LEAD_MS = 366 * DAY_MS;
const REPORT_KINDS: readonly ScheduledTaskKind[] = [
  'daily_report',
  'weekly_report',
  'monthly_report',
];
const REPORT_TITLES: Record<ReportFrequency, string> = {
  daily: '每日工作简报',
  weekly: '每周工作周报',
  monthly: '每月工作月报',
};
const KIND_LABELS: Record<ScheduledTaskKind, string> = {
  prompt: '主动播报',
  reminder: '一次性提醒',
  daily_report: '每日工作简报',
  weekly_report: '每周工作周报',
  monthly_report: '每月工作月报',
};

interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function shanghaiParts(ms: number): ShanghaiParts {
  const date = new Date(ms + SH_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function fromShanghai(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return Date.UTC(year, month - 1, day, hour, minute) - SH_OFFSET_MS;
}

function formatShanghai(ms: number): string {
  const parts = shanghaiParts(ms);
  const date = new Date(ms + SH_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
}

function invalidAt(atMs: number, nowMs: number): string | null {
  if (!Number.isFinite(atMs)) return '无法识别提醒时间。';
  if (atMs - nowMs < MIN_LEAD_MS) return '提醒时间至少要在 30 秒之后。';
  if (atMs - nowMs > MAX_LEAD_MS) return '提醒时间不能超过一年。';
  return null;
}

function splitClock(text: string): { hour: number; minute: number; rest: string } | null {
  const colon = text.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})\s*/u);
  if (colon) {
    return {
      hour: Number(colon[1]),
      minute: Number(colon[2]),
      rest: text.slice(colon[0].length).trim(),
    };
  }
  const half = text.match(/^(\d{1,2})\s*[点时]\s*半\s*/u);
  if (half) {
    return {
      hour: Number(half[1]),
      minute: 30,
      rest: text.slice(half[0].length).trim(),
    };
  }
  const clock = text.match(/^(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*分?\s*/u);
  if (clock) {
    return {
      hour: Number(clock[1]),
      minute: clock[2] ? Number(clock[2]) : 0,
      rest: text.slice(clock[0].length).trim(),
    };
  }
  return null;
}

function validClock(hour: number, minute: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * 解析 `/remind` 的时间前缀，支持：
 * 25分钟后 / 2小时后 / 3天后、明天9点、今天18:30、
 * 2026-11-01 09:00、11月1日 9点、9:00（已过则顺延到明天）。
 */
export function parseReminderArgs(
  raw: string,
  nowMs: number,
): ParsedReminder | string {
  const text = raw.trim();
  if (text === '') return '请补充提醒内容，例如：/remind 25分钟后 开会';

  const relative = text.match(
    /^(\d+)\s*(分钟|分|个小时|小时|天|周)\s*(?:后|之后|以后)\s*([\s\S]*)$/u,
  );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    const factor = unit === '分钟' || unit === '分'
      ? 60_000
      : unit === '个小时' || unit === '小时'
        ? 3_600_000
        : unit === '天'
          ? DAY_MS
          : 7 * DAY_MS;
    const atMs = nowMs + amount * factor;
    const message = relative[3]!.trim();
    if (message === '') return '请补充提醒内容，例如：/remind 25分钟后 开会';
    const error = invalidAt(atMs, nowMs);
    return error ?? { atMs, text: message };
  }

  const nowParts = shanghaiParts(nowMs);
  const dayPrefix = text.match(/^(今天|明天|后天)\s*([\s\S]*)$/u);
  if (dayPrefix) {
    const clock = splitClock(dayPrefix[2]!);
    if (!clock || !validClock(clock.hour, clock.minute)) {
      return '无法识别时间，请写成“明天 9:00 开会”这样的格式。';
    }
    const offset = dayPrefix[1] === '今天' ? 0 : dayPrefix[1] === '明天' ? 1 : 2;
    const base = new Date(
      Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day) + offset * DAY_MS,
    );
    const atMs = fromShanghai(
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      base.getUTCDate(),
      clock.hour,
      clock.minute,
    );
    if (clock.rest === '') return '请补充提醒内容，例如：/remind 明天9点 开会';
    const error = invalidAt(atMs, nowMs);
    return error ?? { atMs, text: clock.rest };
  }

  const isoDate = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*([\s\S]*)$/u,
  );
  if (isoDate) {
    const clock = splitClock(isoDate[4]!);
    if (!clock || !validClock(clock.hour, clock.minute)) {
      return '无法识别时间，请写成“2026-11-01 09:00 提交报告”这样的格式。';
    }
    const atMs = fromShanghai(
      Number(isoDate[1]),
      Number(isoDate[2]),
      Number(isoDate[3]),
      clock.hour,
      clock.minute,
    );
    if (clock.rest === '') return '请补充提醒内容。';
    const error = invalidAt(atMs, nowMs);
    return error ?? { atMs, text: clock.rest };
  }

  const monthDay = text.match(/^(\d{1,2})月(\d{1,2})[日号]\s*([\s\S]*)$/u);
  if (monthDay) {
    const clock = splitClock(monthDay[3]!);
    if (!clock || !validClock(clock.hour, clock.minute)) {
      return '无法识别时间，请写成“11月1日 9点 提交报告”这样的格式。';
    }
    let atMs = fromShanghai(
      nowParts.year,
      Number(monthDay[1]),
      Number(monthDay[2]),
      clock.hour,
      clock.minute,
    );
    if (atMs <= nowMs) {
      atMs = fromShanghai(
        nowParts.year + 1,
        Number(monthDay[1]),
        Number(monthDay[2]),
        clock.hour,
        clock.minute,
      );
    }
    if (clock.rest === '') return '请补充提醒内容。';
    const error = invalidAt(atMs, nowMs);
    return error ?? { atMs, text: clock.rest };
  }

  const clockOnly = splitClock(text);
  if (clockOnly && validClock(clockOnly.hour, clockOnly.minute)) {
    let atMs = fromShanghai(
      nowParts.year,
      nowParts.month,
      nowParts.day,
      clockOnly.hour,
      clockOnly.minute,
    );
    if (atMs <= nowMs) atMs += DAY_MS;
    if (clockOnly.rest === '') return '请补充提醒内容，例如：/remind 18:30 下班';
    const error = invalidAt(atMs, nowMs);
    return error ?? { atMs, text: clockOnly.rest };
  }

  return '无法识别时间。示例：/remind 25分钟后 开会、/remind 明天9点 提交周报、/remind 2026-11-01 09:00 复盘。';
}

function parseClockToken(text: string): { hour: number; minute: number } | null {
  const parsed = splitClock(text);
  if (!parsed || parsed.rest !== '') return null;
  return validClock(parsed.hour, parsed.minute)
    ? { hour: parsed.hour, minute: parsed.minute }
    : null;
}

const WEEKDAY_MAP: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

export function parseReportSpec(raw: string): ReportSpec | string {
  const text = raw.trim();
  const match = text.match(
    /^(daily|weekly|monthly)(?:_report)?\s+([\s\S]+)$/u,
  );
  if (!match) {
    return '用法：/report daily 09:00、/report weekly 周一 09:00、/report monthly 1 09:00。';
  }
  const frequency = match[1] as ReportFrequency;
  const rest = match[2]!.trim();

  if (frequency === 'daily') {
    const clock = parseClockToken(rest);
    if (!clock) return '无法识别时间，示例：/report daily 09:00';
    return { frequency, ...clock };
  }

  if (frequency === 'weekly') {
    const weekday = rest.match(
      /^(?:周|星期|礼拜)?([1-7一二三四五六日天])\s*([\s\S]+)$/u,
    );
    if (!weekday) return '无法识别星期，示例：/report weekly 周一 09:00';
    const day = WEEKDAY_MAP[weekday[1]!];
    const clock = parseClockToken(weekday[2]!);
    if (day === undefined || !clock) {
      return '无法识别时间，示例：/report weekly 周一 09:00';
    }
    return { frequency, weekday: day, ...clock };
  }

  const dayOfMonth = rest.match(/^(?:每月)?(\d{1,2})[日号]?\s*([\s\S]+)$/u);
  if (!dayOfMonth) return '无法识别日期，示例：/report monthly 1 09:00';
  const day = Number(dayOfMonth[1]);
  if (day < 1 || day > 28) {
    return '每月报告的日期请在 1–28 之间，避免部分月份没有该日期。';
  }
  const clock = parseClockToken(dayOfMonth[2]!);
  if (!clock) return '无法识别时间，示例：/report monthly 1 09:00';
  return { frequency, dayOfMonth: day, ...clock };
}

export function buildReportCron(spec: ReportSpec): string {
  const time = `${spec.minute} ${spec.hour}`;
  if (spec.frequency === 'weekly') return `${time} * * ${spec.weekday ?? 1}`;
  if (spec.frequency === 'monthly') return `${time} ${spec.dayOfMonth ?? 1} * *`;
  return `${time} * * *`;
}

function reportKindFromFrequency(frequency: ReportFrequency): PersonalReportKind {
  return `${frequency}_report` as PersonalReportKind;
}

function reportFrequencyFromKind(kind: ScheduledTaskKind): ReportFrequency | null {
  if (kind === 'daily_report') return 'daily';
  if (kind === 'weekly_report') return 'weekly';
  if (kind === 'monthly_report') return 'monthly';
  return null;
}

function describeCron(cron: string): string {
  const [minute, hour, dayOfMonth, , weekday] = cron.split(/\s+/u);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (dayOfMonth !== '*') return `每月 ${Number(dayOfMonth)} 日 ${time}`;
  if (weekday !== '*') {
    const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const index = Number(weekday) % 7;
    return `每${labels[index]} ${time}`;
  }
  return `每天 ${time}`;
}

/** 个人提醒与定时报告：命令、模型工具和定时投递共用的唯一入口。 */
export class PersonalAssistantService {
  private readonly store: ScheduledTaskStore;
  private readonly report: PersonalReportBuilder;
  private readonly now: () => number;
  private readonly maxActiveTasksPerUser: number;
  private readonly maxReportsPerUser: number;

  constructor(options: PersonalAssistantServiceOptions) {
    this.store = options.store;
    this.report = options.report;
    this.now = options.now ?? Date.now;
    this.maxActiveTasksPerUser = options.maxActiveTasksPerUser ?? 12;
    this.maxReportsPerUser = options.maxReportsPerUser ?? 4;
  }

  public async handleRemindCommand(
    message: InboundMessage,
    args: string[],
  ): Promise<string> {
    if (message.conversationType !== '1') {
      return '提醒只支持在单聊中创建，避免把个人事务发到群里。';
    }
    const raw = args.join(' ').trim();
    if (raw === '' || raw === 'list') {
      return this.formatTaskList(message.senderStaffId, 'reminder');
    }
    const cancel = raw.match(/^cancel\s+(\S+)$/iu);
    if (cancel) {
      return this.cancelAndDescribe(message.senderStaffId, cancel[1]!);
    }
    try {
      const task = await this.createReminderFromText({
        staffId: message.senderStaffId,
        conversationId: message.conversationId,
        raw,
      });
      return [
        `已设置提醒：${formatShanghai(Date.parse(task.nextRunAt!))}`,
        `内容：${task.prompt}`,
        '到点会用机器人单聊发给你。发送 /remind list 查看全部，/remind cancel <ID> 取消。',
      ].join('\n');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  public async handleReportCommand(
    message: InboundMessage,
    args: string[],
  ): Promise<string> {
    if (message.conversationType !== '1') {
      return '定时报告只支持在单聊中创建，避免把个人工作数据发到群里。';
    }
    const raw = args.join(' ').trim();
    if (raw === '' || raw === 'list') {
      return [
        '用法：',
        '- `/report daily 09:00` 每天定时推送到单聊',
        '- `/report weekly 周一 09:00` 每周定时推送',
        '- `/report monthly 1 09:00` 每月定时推送',
        '- `/report preview [weekly|monthly]` 立即生成一份',
        '- `/report cancel <ID>` 取消定时报告',
        '',
        await this.formatTaskList(message.senderStaffId, 'report'),
      ].join('\n');
    }
    if (raw === 'preview' || raw.startsWith('preview ')) {
      const period = raw.slice('preview'.length).trim();
      const kind: PersonalReportKind =
        period === 'weekly' || period === 'monthly'
          ? `${period}_report` as PersonalReportKind
          : 'daily_report';
      return this.previewReport(message.senderStaffId, kind);
    }
    const cancel = raw.match(/^cancel\s+(\S+)$/iu);
    if (cancel) {
      return this.cancelAndDescribe(message.senderStaffId, cancel[1]!);
    }
    const spec = parseReportSpec(raw);
    if (typeof spec === 'string') return spec;
    try {
      const task = await this.createReport({
        staffId: message.senderStaffId,
        conversationId: message.conversationId,
        spec,
      });
      return [
        `已创建${KIND_LABELS[task.kind]}：${describeCron(task.cron!)}`,
        `下次推送：${task.nextRunAt ? formatShanghai(Date.parse(task.nextRunAt)) : '待计算'}`,
        '发送 /report list 查看，/report cancel <ID> 取消。',
      ].join('\n');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  public async createReminderFromText(input: {
    staffId: string;
    conversationId: string;
    raw: string;
  }): Promise<ScheduledTask> {
    const parsed = parseReminderArgs(input.raw, this.now());
    if (typeof parsed === 'string') throw new Error(parsed);
    await this.assertQuota(input.staffId, 'reminder');
    const text = parsed.text.slice(0, 200);
    return this.store.create(
      {
        conversationId: input.conversationId,
        conversationType: '1',
        kind: 'reminder',
        title: `提醒：${text.slice(0, 40)}`,
        prompt: text,
        intervalSeconds: null,
        cron: null,
        enabled: true,
        createdBy: input.staffId,
      },
      parsed.atMs,
    );
  }

  public async createReport(input: {
    staffId: string;
    conversationId: string;
    spec: ReportSpec;
  }): Promise<ScheduledTask> {
    assertReportSpec(input.spec);
    await this.assertQuota(input.staffId, 'report');
    const cron = buildReportCron(input.spec);
    const kind = reportKindFromFrequency(input.spec.frequency);
    const next = computeNextRun(
      { enabled: true, cron, intervalSeconds: null, kind },
      this.now(),
    );
    const time = `${String(input.spec.hour).padStart(2, '0')}:${String(
      input.spec.minute,
    ).padStart(2, '0')}`;
    return this.store.create(
      {
        conversationId: input.conversationId,
        conversationType: '1',
        kind,
        title: `${REPORT_TITLES[input.spec.frequency]} ${time}`,
        prompt: '',
        intervalSeconds: null,
        cron,
        enabled: true,
        createdBy: input.staffId,
      },
      next,
    );
  }

  public async listOwn(staffId: string): Promise<ScheduledTask[]> {
    const tasks = await this.store.list();
    return tasks
      .filter(
        (task) =>
          task.createdBy === staffId &&
          task.kind !== 'prompt' &&
          task.enabled,
      )
      .sort((left, right) =>
        (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''),
      );
  }

  public async cancelOwn(
    staffId: string,
    idOrPrefix: string,
  ): Promise<ScheduledTask | null> {
    const target = idOrPrefix.trim().toLowerCase();
    if (target === '') return null;
    const tasks = await this.listOwn(staffId);
    const task =
      tasks.find((item) => item.id.toLowerCase() === target) ??
      tasks.find((item) => item.id.toLowerCase().startsWith(target));
    if (!task) return null;
    const removed = await this.store.remove(task.id);
    return removed ? task : null;
  }

  public async previewReport(
    staffId: string,
    kind: PersonalReportKind,
  ): Promise<string> {
    const result = await this.report.build({
      kind,
      operatorStaffId: staffId,
      now: this.now(),
    });
    return result.text;
  }

  public reminderDeliveryText(task: ScheduledTask): string {
    return `⏰ 提醒：${task.prompt}`;
  }

  public async reportDeliveryText(task: ScheduledTask): Promise<string> {
    const frequency = reportFrequencyFromKind(task.kind);
    if (!frequency) {
      throw new Error(`不是报告任务：${task.kind}`);
    }
    const result = await this.report.build({
      kind: reportKindFromFrequency(frequency),
      operatorStaffId: task.createdBy,
      now: this.now(),
    });
    return result.text;
  }

  private formatTaskList(staffId: string, filter: 'reminder' | 'report'): Promise<string> {
    return this.listOwn(staffId).then((all) => {
      const tasks = all.filter((task) =>
        filter === 'reminder'
          ? task.kind === 'reminder'
          : REPORT_KINDS.includes(task.kind),
      );
      if (tasks.length === 0) {
        return filter === 'reminder' ? '当前没有待触发的提醒。' : '当前没有定时报告。';
      }
      const header = filter === 'reminder' ? '当前提醒：' : '当前定时报告：';
      return [
        header,
        ...tasks.map((task) => {
          const schedule =
            task.kind === 'reminder'
              ? task.nextRunAt
                ? formatShanghai(Date.parse(task.nextRunAt))
                : '未排期'
              : task.cron
                ? describeCron(task.cron)
                : '未排期';
          return `- ${KIND_LABELS[task.kind]} · ${schedule} · ID ${task.id.slice(0, 8)}`;
        }),
        '发送 `/report cancel <ID>` 或 `/remind cancel <ID>` 取消。',
      ].join('\n');
    });
  }

  private async cancelAndDescribe(staffId: string, idOrPrefix: string): Promise<string> {
    const task = await this.cancelOwn(staffId, idOrPrefix);
    if (!task) return `没有找到可取消的任务：${idOrPrefix}`;
    return `已取消：${KIND_LABELS[task.kind]}（ID ${task.id.slice(0, 8)}）。`;
  }

  private async assertQuota(
    staffId: string,
    kind: 'reminder' | 'report',
  ): Promise<void> {
    const tasks = await this.listOwn(staffId);
    if (tasks.length >= this.maxActiveTasksPerUser) {
      throw new Error(
        `个人定时任务已达上限（${this.maxActiveTasksPerUser} 个），请先取消不用的任务。`,
      );
    }
    if (kind === 'report') {
      const reports = tasks.filter((task) => REPORT_KINDS.includes(task.kind));
      if (reports.length >= this.maxReportsPerUser) {
        throw new Error(
          `定时报告已达上限（${this.maxReportsPerUser} 个），请先取消不用的报告。`,
        );
      }
    }
  }
}

function assertReportSpec(spec: ReportSpec): void {
  if (!validClock(spec.hour, spec.minute)) {
    throw new Error('报告时间不合法，小时需在 0–23、分钟在 0–59。');
  }
  if (spec.frequency === 'weekly') {
    if (spec.weekday === undefined || spec.weekday < 1 || spec.weekday > 7) {
      throw new Error('每周报告需要指定 1–7（周日可用 7）。');
    }
  }
  if (spec.frequency === 'monthly') {
    if (spec.dayOfMonth === undefined || spec.dayOfMonth < 1 || spec.dayOfMonth > 28) {
      throw new Error('每月报告的日期需在 1–28。');
    }
  }
}
