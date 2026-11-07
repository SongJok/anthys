import type { InboundMessage } from '../types/core.js';
import type {
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskStore,
} from '../types/admin-and-console.js';
import {
  buildReportCron,
  parseReminderArgs,
  parseReportSpec,
  type PersonalTaskMode,
  type ReportSpec,
} from '../personal/PersonalAssistantService.js';
import { computeNextRun } from '../scheduler/ScheduledTaskScheduler.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const GROUP_REPORT_LIMIT = 4;
const GROUP_SCHEDULE_LIMIT = 8;
const REPORT_TITLES: Record<ReportSpec['frequency'], string> = {
  daily: '群目标每日播报',
  weekly: '群目标每周播报',
  monthly: '群目标每月播报',
};
const USAGE = [
  '群目标播报用法（群聊，管理员创建）：',
  '- `/group report` 查看本群定时播报',
  '- `/group report daily 09:00` 每天播报群目标与任务进度',
  '- `/group report weekly 周一 09:00` / `/group report monthly 1 09:00`',
  '- `/group report preview` 立即生成一份',
  '- `/group report cancel <ID>` 取消',
].join('\n');

export interface GroupReportServiceOptions {
  store: ScheduledTaskStore;
  isAdmin: (staffId: string) => boolean;
  buildDigest: (conversationId: string) => Promise<string>;
  now?: () => number;
}

export function describeReportCron(cron: string): string {
  const [minute, hour, dayOfMonth, , weekday] = cron.split(/\s+/u);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (dayOfMonth !== '*') return `每月 ${Number(dayOfMonth)} 日 ${time}`;
  if (weekday !== '*') {
    if (weekday === '1-5') return `每个工作日 ${time}`;
    const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${labels[Number(weekday) % 7]} ${time}`;
  }
  return `每天 ${time}`;
}

function inferGroupTaskMode(text: string): PersonalTaskMode {
  if (
    /(?:检索|搜索|查询|抓取|汇总|整理|生成|盘点)[\s\S]*(?:新闻|资讯|动态|简报|日报|周报|报告|摘要|总结|热点|热搜|天气|行情)|(?:发|发送|推送|提供|整理|播报)(?:一份|最新|今日|每日|全球|近期)?[\s\S]*(?:新闻|资讯|动态|简报|热点|热搜|天气|行情)/u.test(
      text,
    )
  ) {
    return 'prompt';
  }
  return 'reminder';
}

/** 群目标定期播报：按 cron 把确定性摘要推送到群聊，不消耗模型 token。 */
export class GroupReportService {
  private readonly store: ScheduledTaskStore;
  private readonly isAdmin: (staffId: string) => boolean;
  private readonly buildDigest: (conversationId: string) => Promise<string>;
  private readonly now: () => number;

  constructor(options: GroupReportServiceOptions) {
    this.store = options.store;
    this.isAdmin = options.isAdmin;
    this.buildDigest = options.buildDigest;
    this.now = options.now ?? Date.now;
  }

  public usage(): string {
    return USAGE;
  }

  public canManage(staffId: string): boolean {
    return this.isAdmin(staffId);
  }

  public async list(conversationId: string): Promise<ScheduledTask[]> {
    const tasks = await this.store.list();
    return tasks.filter(
      (task) =>
        task.conversationId === conversationId && task.kind === 'group_report',
    );
  }

  public async create(input: {
    conversationId: string;
    actor: string;
    spec: ReportSpec;
  }): Promise<ScheduledTask> {
    const existing = await this.list(input.conversationId);
    if (existing.length >= GROUP_REPORT_LIMIT) {
      throw new Error(
        `本群定时播报已达上限（${GROUP_REPORT_LIMIT} 个），请先取消不用的播报。`,
      );
    }
    const cron = buildReportCron(input.spec);
    const time = `${String(input.spec.hour).padStart(2, '0')}:${String(
      input.spec.minute,
    ).padStart(2, '0')}`;
    const next = computeNextRun(
      { enabled: true, cron, intervalSeconds: null, kind: 'group_report' },
      Date.now(),
    );
    return this.store.create(
      {
        conversationId: input.conversationId,
        conversationType: '2',
        kind: 'group_report',
        title: `${REPORT_TITLES[input.spec.frequency]} ${time}`,
        prompt: '',
        intervalSeconds: null,
        cron,
        enabled: true,
        createdBy: input.actor,
      },
      next,
    );
  }

  public async cancel(
    conversationId: string,
    idOrPrefix: string,
    staffId: string,
  ): Promise<string> {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) return '请输入播报 ID 前缀。';
    const tasks = await this.list(conversationId);
    const exact = tasks.find((task) => task.id.toLowerCase() === needle);
    const matches = tasks.filter((task) =>
      task.id.toLowerCase().startsWith(needle),
    );
    const task = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!task) {
      return matches.length > 1
        ? `ID 前缀 ${idOrPrefix} 匹配到多个播报，请多输入几位。`
        : `未找到群播报 ${idOrPrefix}。`;
    }
    if (task.createdBy !== staffId && !this.isAdmin(staffId)) {
      return '只有创建人或管理员可以取消群播报。';
    }
    const removed = await this.store.remove(task.id);
    return removed
      ? `已取消群播报：${describeReportCron(task.cron ?? '')}（ID ${task.id.slice(0, 8)}）。`
      : '取消失败，播报可能已被删除。';
  }

  public async listSchedules(conversationId: string): Promise<ScheduledTask[]> {
    const tasks = await this.store.list();
    return tasks.filter(
      (task) =>
        task.conversationId === conversationId &&
        task.conversationType === '2' &&
        (task.kind === 'prompt' || task.kind === 'reminder') &&
        task.enabled,
    );
  }

  public async createScheduleFromText(input: {
    conversationId: string;
    actor: string;
    raw: string;
    mode?: PersonalTaskMode;
  }): Promise<ScheduledTask> {
    const parsed = parseReminderArgs(input.raw, this.now());
    if (typeof parsed === 'string') throw new Error(parsed);
    const existing = await this.listSchedules(input.conversationId);
    if (existing.length >= GROUP_SCHEDULE_LIMIT) {
      throw new Error(
        `本群定时任务已达上限（${GROUP_SCHEDULE_LIMIT} 个），请先取消不用的任务。`,
      );
    }
    const rawText = parsed.text.slice(0, 200);
    const mode = input.mode ?? inferGroupTaskMode(rawText);
    const kind: ScheduledTaskKind = mode === 'prompt' ? 'prompt' : 'reminder';
    const titlePrefix = kind === 'prompt' ? '群定时任务：' : '群提醒：';
    return this.store.create(
      {
        conversationId: input.conversationId,
        conversationType: '2',
        kind,
        title: `${titlePrefix}${rawText.slice(0, 40)}`,
        prompt: rawText,
        intervalSeconds: null,
        cron: parsed.cron ?? null,
        enabled: true,
        createdBy: input.actor,
      },
      parsed.atMs,
    );
  }

  public async cancelSchedule(
    conversationId: string,
    idOrPrefix: string,
    staffId: string,
  ): Promise<string> {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) return '请输入群定时任务 ID 前缀。';
    const tasks = await this.listSchedules(conversationId);
    const exact = tasks.find((task) => task.id.toLowerCase() === needle);
    const matches = tasks.filter((task) =>
      task.id.toLowerCase().startsWith(needle),
    );
    const task = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!task) {
      return matches.length > 1
        ? `ID 前缀 ${idOrPrefix} 匹配到多个群定时任务，请多输入几位。`
        : `未找到本群定时任务 ${idOrPrefix}。`;
    }
    if (task.createdBy !== staffId && !this.isAdmin(staffId)) {
      return '只有创建人或管理员可以取消该群定时任务。';
    }
    const removed = await this.store.remove(task.id);
    return removed
      ? `已取消群定时任务：${task.title}（ID ${task.id.slice(0, 8)}）。`
      : '取消失败，任务可能已被删除。';
  }

  public async handleCommand(
    message: InboundMessage,
    args: string[],
  ): Promise<string> {
    if (message.conversationType !== '2') {
      return '群目标播报只能在群聊中设置。';
    }
    const raw = args.join(' ').trim();
    if (raw === '' || raw === 'list') {
      const tasks = await this.list(message.conversationId);
      return [
        USAGE,
        '',
        tasks.length === 0
          ? '本群还没有定时播报。'
          : [
              '当前播报：',
              ...tasks.map(
                (task) =>
                  `- ${describeReportCron(task.cron ?? '')} · ${task.enabled ? '已启用' : '已停用'} · ID ${task.id.slice(0, 8)}${
                    task.nextRunAt
                      ? ` · 下次 ${formatShanghaiDateTime(Date.parse(task.nextRunAt))}`
                      : ''
                  }`,
              ),
            ].join('\n'),
      ].join('\n');
    }
    if (raw === 'preview') {
      return this.buildDigest(message.conversationId);
    }
    const cancel = /^cancel\s+(\S+)$/iu.exec(raw);
    if (cancel) {
      return this.cancel(
        message.conversationId,
        cancel[1]!,
        message.senderStaffId,
      );
    }
    if (!this.isAdmin(message.senderStaffId)) {
      return '只有管理员可以创建群目标播报。';
    }
    const spec = parseReportSpec(raw);
    if (typeof spec === 'string') return spec;
    try {
      const task = await this.create({
        conversationId: message.conversationId,
        actor: message.senderStaffId,
        spec,
      });
      return [
        `已创建群目标播报：${describeReportCron(task.cron!)}`,
        `下次推送：${task.nextRunAt ? formatShanghaiDateTime(Date.parse(task.nextRunAt)) : '待计算'}`,
        '发送 `/group report` 查看，`/group report cancel <ID>` 取消。',
      ].join('\n');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
