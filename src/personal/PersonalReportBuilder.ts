import type { DwsCommandRequest } from '../types/mcp-and-sandbox.js';
import { DwsCliRunner } from '../tools/dws/DwsCliRunner.js';

export type PersonalReportKind =
  | 'daily_report'
  | 'weekly_report'
  | 'monthly_report';

export interface PersonalReportRequest {
  kind: PersonalReportKind;
  operatorStaffId: string;
  now?: number;
}

export interface PersonalReportResult {
  text: string;
  ok: boolean;
  errors: string[];
}

export interface PersonalReportBuilderOptions {
  runner?: DwsCliRunner;
  /** 单条 DWS 查询超时，默认 20 秒 */
  timeoutMs?: number;
}

const SH_OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_REPORT_CHARS = 2_400;
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

interface EventItem {
  title: string;
  startMs: number | null;
  endMs: number | null;
  attendees: string[];
}

interface TodoItem {
  title: string;
  dueMs: number | null;
  overdue: boolean;
}

interface ApprovalItem {
  title: string;
  originator: string;
  createdMs: number | null;
}

function shanghaiParts(ms: number): ShanghaiParts {
  const date = new Date(ms + SH_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    weekday: date.getUTCDay(),
  };
}

function startOfShanghaiDay(ms: number): number {
  const parts = shanghaiParts(ms);
  return Date.UTC(parts.year, parts.month - 1, parts.day) - SH_OFFSET_MS;
}

function isoAt(ms: number, endOfDay = false): string {
  const parts = shanghaiParts(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${
    endOfDay ? '23:59:59' : '00:00:00'
  }+08:00`;
}

function formatDay(ms: number): string {
  const parts = shanghaiParts(ms);
  return `${parts.year}年${parts.month}月${parts.day}日（${WEEKDAY_LABELS[parts.weekday]}）`;
}

function formatMonthDay(ms: number): string {
  const parts = shanghaiParts(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(parts.month)}-${pad(parts.day)}`;
}

function formatDateTime(ms: number): string {
  const parts = shanghaiParts(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function clip(text: string, limit = MAX_REPORT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}\n…（内容过长已截断）`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTimeValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00+08:00`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickArray(payload: Record<string, unknown>, paths: string[][]): unknown[] {
  for (const path of paths) {
    let cursor: unknown = payload;
    for (const key of path) {
      const record = asRecord(cursor);
      if (!record) {
        cursor = undefined;
        break;
      }
      cursor = record[key];
    }
    if (Array.isArray(cursor)) return cursor;
  }
  return [];
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function normalizeEvents(items: unknown[]): EventItem[] {
  const events: EventItem[] = [];
  for (const raw of items) {
    const record = asRecord(raw);
    if (!record) continue;
    const start = asRecord(record.start);
    const end = asRecord(record.end);
    const startMs =
      parseTimeValue(start?.dateTime) ??
      parseTimeValue(start?.date) ??
      parseTimeValue(record.startTime);
    const endMs =
      parseTimeValue(end?.dateTime) ??
      parseTimeValue(end?.date) ??
      parseTimeValue(record.endTime);
    const attendees = Array.isArray(record.attendees)
      ? record.attendees
          .map((item) => pickString(asRecord(item) ?? {}, ['displayName', 'name']))
          .filter(Boolean)
      : [];
    events.push({
      title: pickString(record, ['summary', 'title', 'subject']) || '未命名日程',
      startMs,
      endMs,
      attendees,
    });
  }
  return events.sort(
    (left, right) => (left.startMs ?? 0) - (right.startMs ?? 0),
  );
}

function normalizeTodos(items: unknown[], nowMs: number): TodoItem[] {
  const todos: TodoItem[] = [];
  for (const raw of items) {
    const record = asRecord(raw);
    if (!record) continue;
    const dueMs =
      parseTimeValue(record.dueTime) ??
      parseTimeValue(record.planFinishDate) ??
      parseTimeValue(record.dueDate);
    todos.push({
      title: pickString(record, ['subject', 'title', 'content']) || '未命名待办',
      dueMs,
      overdue: dueMs !== null && dueMs < nowMs,
    });
  }
  return todos.sort((left, right) => {
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    return (left.dueMs ?? Number.MAX_SAFE_INTEGER) -
      (right.dueMs ?? Number.MAX_SAFE_INTEGER);
  });
}

function normalizeApprovals(items: unknown[]): ApprovalItem[] {
  const approvals: ApprovalItem[] = [];
  for (const raw of items) {
    const record = asRecord(raw);
    if (!record) continue;
    approvals.push({
      title:
        pickString(record, [
          'title',
          'processInstanceTitle',
          'name',
          'processCodeTitle',
        ]) || '未命名审批',
      originator: pickString(record, [
        'originatorName',
        'originatorUserId',
        'originator',
      ]),
      createdMs:
        parseTimeValue(record.createTime) ??
        parseTimeValue(record.gmtCreate) ??
        parseTimeValue(record.createTimeISO),
    });
  }
  return approvals;
}

function eventLine(event: EventItem, withDate = false): string {
  const clock =
    event.startMs === null
      ? ''
      : `${withDate ? `${formatMonthDay(event.startMs)} ` : ''}${formatDateTime(event.startMs)} `;
  const duration =
    event.startMs !== null && event.endMs !== null && event.endMs > event.startMs
      ? `（${Math.round((event.endMs - event.startMs) / 60_000)} 分钟`
      : '';
  const people = event.attendees.length > 1 ? `${event.attendees.length} 人` : '';
  const suffix =
    duration && people
      ? `${duration}，${people}）`
      : duration
        ? `${duration}）`
        : people
          ? `（${people}）`
          : '';
  return `- ${clock}${event.title}${suffix}`;
}

function todoLine(todo: TodoItem): string {
  const tag = todo.overdue ? '[逾期] ' : '';
  const due =
    todo.dueMs === null
      ? ''
      : `（截止 ${formatMonthDay(todo.dueMs)}${todo.overdue ? '' : ` ${formatDateTime(todo.dueMs)}`}）`;
  return `- ${tag}${todo.title}${due}`;
}

/** 用钉钉日程/待办/审批生成确定性的个人工作简报，不经过模型。 */
export class PersonalReportBuilder {
  private readonly runner: DwsCliRunner;
  private readonly timeoutMs: number;

  constructor(options: PersonalReportBuilderOptions = {}) {
    this.runner =
      options.runner ??
      new DwsCliRunner({ timeoutMs: 20_000, maxOutputChars: 2_000_000 });
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  public async build(request: PersonalReportRequest): Promise<PersonalReportResult> {
    const now = request.now ?? Date.now();
    const errors: string[] = [];
    const kind = request.kind;
    const todayStart = startOfShanghaiDay(now);
    const todayEnd = todayStart + DAY_MS - 1_000;
    const tomorrowStart = todayStart + DAY_MS;
    const tomorrowEnd = tomorrowStart + DAY_MS - 1_000;

    const rangeStart =
      kind === 'weekly_report'
        ? startOfShanghaiDay(now - 6 * DAY_MS)
        : kind === 'monthly_report'
          ? startOfShanghaiDay(now - 29 * DAY_MS)
          : todayStart;
    const rangeEnd = kind === 'daily_report' ? todayEnd : now;

    let events: EventItem[] = [];
    let tomorrowEvents: EventItem[] = [];
    let todos: TodoItem[] = [];
    let approvals: ApprovalItem[] = [];

    try {
      const payload = await this.query('calendar', 'event list', {
        start: isoAt(rangeStart),
        end: isoAt(rangeEnd, true),
        limit: 100,
        format: 'json',
      }, request.operatorStaffId);
      events = normalizeEvents(
        pickArray(payload, [
          ['result', 'events'],
          ['data', 'events'],
          ['events'],
        ]),
      );
    } catch (error) {
      errors.push(`日程：${errorText(error)}`);
    }

    if (kind === 'daily_report' && errors.length === 0) {
      try {
        const payload = await this.query('calendar', 'event list', {
          start: isoAt(tomorrowStart),
          end: isoAt(tomorrowEnd, true),
          limit: 20,
          format: 'json',
        }, request.operatorStaffId);
        tomorrowEvents = normalizeEvents(
          pickArray(payload, [
            ['result', 'events'],
            ['data', 'events'],
            ['events'],
          ]),
        );
      } catch (error) {
        errors.push(`明日日程：${errorText(error)}`);
      }
    }

    try {
      const payload = await this.query('todo', 'task list', {
        status: 'false',
        size: 50,
        format: 'json',
      }, request.operatorStaffId);
      todos = normalizeTodos(
        pickArray(payload, [
          ['result', 'todoCards'],
          ['data', 'todos'],
          ['data', 'tasks'],
          ['todos'],
        ]),
        now,
      );
    } catch (error) {
      errors.push(`待办：${errorText(error)}`);
    }

    try {
      const payload = await this.query('approval', 'list-pending', {
        start: isoAt(rangeStart),
        end: isoAt(rangeEnd, true),
        format: 'json',
      }, request.operatorStaffId);
      approvals = normalizeApprovals(
        pickArray(payload, [
          ['result', 'processInstanceList'],
          ['data', 'processInstanceList'],
          ['processInstanceList'],
          ['result'],
        ]),
      );
    } catch (error) {
      errors.push(`审批：${errorText(error)}`);
    }

    return {
      text: clip(
        this.render({
          kind,
          now,
          rangeStart,
          rangeEnd,
          events,
          tomorrowEvents,
          todos,
          approvals,
          errors,
        }),
      ),
      ok: errors.length === 0,
      errors,
    };
  }

  private async query(
    domain: DwsCommandRequest['domain'],
    subcommand: string,
    flags: DwsCommandRequest['flags'],
    operatorStaffId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.runner.run(
      { domain, subcommand, flags, operatorStaffId },
      { timeoutMs: this.timeoutMs },
    );
    if (result.timedOut) {
      throw new Error('查询超时');
    }
    if (result.exitCode !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim();
      throw new Error(detail.slice(0, 200) || `退出码 ${result.exitCode}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error('返回内容不是合法 JSON，可能已截断');
    }
    const record = asRecord(payload);
    if (!record) throw new Error('返回结构异常');
    if (record.success === false || asRecord(record.error)) {
      const error = asRecord(record.error);
      const message =
        pickString(error ?? {}, ['message', 'hint', 'reason']) ||
        pickString(record, ['message', 'hint']) ||
        'DWS 返回失败';
      throw new Error(message);
    }
    return record;
  }

  private render(input: {
    kind: PersonalReportKind;
    now: number;
    rangeStart: number;
    rangeEnd: number;
    events: EventItem[];
    tomorrowEvents: EventItem[];
    todos: TodoItem[];
    approvals: ApprovalItem[];
    errors: string[];
  }): string {
    const {
      kind,
      now,
      rangeStart,
      rangeEnd,
      events,
      tomorrowEvents,
      todos,
      approvals,
      errors,
    } = input;
    const lines: string[] = [];
    if (kind === 'daily_report') {
      lines.push(`今日工作简报 · ${formatDay(now)}`, '');
      lines.push(`【今日日程】${events.length} 场`);
      lines.push(
        ...(events.length > 0
          ? events.slice(0, 12).map((event) => eventLine(event))
          : ['- 今天没有日程安排']),
      );
      lines.push('');
      lines.push(`【明日日程】${tomorrowEvents.length} 场`);
      lines.push(
        ...(tomorrowEvents.length > 0
          ? tomorrowEvents.slice(0, 6).map((event) => eventLine(event))
          : ['- 明天暂无日程']),
      );
      lines.push('');
    } else {
      const meetingMs = events.reduce(
        (total, event) =>
          total +
          (event.startMs !== null && event.endMs !== null && event.endMs > event.startMs
            ? event.endMs - event.startMs
            : 0),
        0,
      );
      const hours = Math.round((meetingMs / 3_600_000) * 10) / 10;
      lines.push(
        `工作${kind === 'weekly_report' ? '周报' : '月报'} · ${formatMonthDay(rangeStart)} ~ ${formatMonthDay(rangeEnd)}`,
        '',
      );
      lines.push(
        `【会议】共 ${events.length} 场，累计 ${hours} 小时`,
      );
      const attendeeCount = new Map<string, number>();
      for (const event of events) {
        for (const name of event.attendees) {
          if (name === '') continue;
          attendeeCount.set(name, (attendeeCount.get(name) ?? 0) + 1);
        }
      }
      const topAttendees = [...attendeeCount.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([name]) => name);
      if (topAttendees.length > 0) {
        lines.push(`高频参与人：${topAttendees.join('、')}`);
      }
      lines.push(
        ...(events.length > 0
          ? events.slice(0, 10).map((event) => eventLine(event, true))
          : ['- 本周期没有会议']),
      );
      lines.push('');
    }

    const overdue = todos.filter((todo) => todo.overdue).length;
    lines.push(`【待办】未完成 ${todos.length} 项，逾期 ${overdue} 项`);
    lines.push(
      ...(todos.length > 0
        ? todos.slice(0, 10).map(todoLine)
        : ['- 没有未完成待办']),
    );
    lines.push('');

    lines.push(`【待我审批】${approvals.length} 项`);
    lines.push(
      ...(approvals.length > 0
        ? approvals.slice(0, 8).map((item) => {
            const origin = item.originator ? `（发起人：${item.originator}）` : '';
            return `- ${item.title}${origin}`;
          })
        : ['- 暂无待处理审批']),
    );

    if (errors.length > 0) {
      lines.push('', '【数据提示】');
      lines.push(...errors.map((item) => `- ${item}`));
      lines.push('可发送 /dws-status 检查 DWS 授权状态。');
    }

    lines.push('', '数据来源：钉钉日程 / 待办 / 审批（当前 DWS 授权账号）');
    return lines.join('\n');
  }
}
