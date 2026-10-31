import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import {
  parseReportSpec,
  type PersonalAssistantService,
  type ReportFrequency,
} from '../../personal/PersonalAssistantService.js';
import type { PersonalReportKind } from '../../personal/PersonalReportBuilder.js';

export interface PersonalAssistantToolProviderOptions {
  service: PersonalAssistantService;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`参数 ${key}（${label}）必须是非空字符串`);
  return value;
}

/** 单聊内的个人提醒与定时报告；群聊不挂载，避免个人事务外泄。 */
export class PersonalAssistantToolProvider implements IToolProvider {
  public readonly providerName = 'personal-assistant';
  private readonly service: PersonalAssistantService;

  constructor(options: PersonalAssistantToolProviderOptions) {
    this.service = options.service;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (ctx.conversationType !== '1') return [];
    return [this.reminderTool(), this.reportTool()];
  }

  private reminderTool(): ToolDefinition {
    return {
      name: 'personal_reminder',
      description:
        '管理当前用户的钉钉个人提醒（仅单聊）。action=create 时用 when 描述时间（如“25分钟后”“明天9点”“2026-11-01 09:00”），text 写提醒内容；action=list 查看；action=cancel 按 id 取消。提醒到点由机器人单聊发送。',
      risk: 'read',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'cancel'] },
          when: {
            type: 'string',
            description: '提醒时间描述，create 时必填，如“25分钟后”“明天9点”',
          },
          text: {
            type: 'string',
            description: '提醒内容，create 时必填，如“开会”“提交周报”',
          },
          id: { type: 'string', description: '提醒 ID，cancel 时必填' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, execCtx) => {
        if (execCtx.conversationType !== '1') {
          throw new Error('个人提醒仅在单聊中可用');
        }
        const action = requireString(args, 'action', '操作');
        if (action === 'create') {
          const when = requireString(args, 'when', '提醒时间');
          const text = requireString(args, 'text', '提醒内容');
          const task = await this.service.createReminderFromText({
            staffId: execCtx.senderStaffId,
            conversationId: execCtx.conversationId,
            raw: `${when} ${text}`,
          });
          return JSON.stringify({
            ok: true,
            taskId: task.id,
            at: task.nextRunAt,
            message: `已设置提醒：${task.title}`,
          });
        }
        if (action === 'list') {
          const tasks = await this.service.listOwn(execCtx.senderStaffId);
          return JSON.stringify({
            ok: true,
            reminders: tasks
              .filter((task) => task.kind === 'reminder')
              .map((task) => ({
                id: task.id,
                title: task.title,
                at: task.nextRunAt,
              })),
          });
        }
        if (action === 'cancel') {
          const id = requireString(args, 'id', '提醒 ID');
          const task = await this.service.cancelOwn(execCtx.senderStaffId, id);
          if (!task) {
            return JSON.stringify({ ok: false, message: `没有找到提醒：${id}` });
          }
          return JSON.stringify({ ok: true, message: `已取消提醒：${task.title}` });
        }
        throw new Error(`不支持的 action：${action}`);
      },
    };
  }

  private reportTool(): ToolDefinition {
    return {
      name: 'personal_report',
      description:
        '管理当前用户的日/周/月工作简报（仅单聊）。action=create 需要 frequency 与 time，可选 weekday（1-7，周日用 7）或 dayOfMonth（1-28）；action=preview 立即用钉钉日程/待办/审批生成一份；action=list 查看；action=cancel 取消。报告为确定性汇总，不调用大模型。',
      risk: 'read',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'cancel', 'preview'],
          },
          frequency: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: '报告频率，create 时必填',
          },
          time: {
            type: 'string',
            description: '推送时间 HH:mm，create 时必填',
          },
          weekday: {
            type: 'integer',
            minimum: 1,
            maximum: 7,
            description: '每周几推送，weekly 时使用，默认 1',
          },
          dayOfMonth: {
            type: 'integer',
            minimum: 1,
            maximum: 28,
            description: '每月几号推送，monthly 时使用，默认 1',
          },
          id: { type: 'string', description: '报告任务 ID，cancel 时必填' },
          period: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'preview 的报告周期，默认 daily',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, execCtx) => {
        if (execCtx.conversationType !== '1') {
          throw new Error('个人报告仅在单聊中可用');
        }
        const action = requireString(args, 'action', '操作');
        if (action === 'create') {
          const frequency = requireString(
            args,
            'frequency',
            '报告频率',
          ) as ReportFrequency;
          if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
            throw new Error(`不支持的 frequency：${frequency}`);
          }
          const time = requireString(args, 'time', '推送时间');
          const weekday =
            typeof args.weekday === 'number' ? args.weekday : undefined;
          const dayOfMonth =
            typeof args.dayOfMonth === 'number' ? args.dayOfMonth : undefined;
          const raw =
            frequency === 'daily'
              ? `${frequency} ${time}`
              : frequency === 'weekly'
                ? `${frequency} ${weekday ?? 1} ${time}`
                : `${frequency} ${dayOfMonth ?? 1} ${time}`;
          const spec = parseReportSpec(raw);
          if (typeof spec === 'string') throw new Error(spec);
          const task = await this.service.createReport({
            staffId: execCtx.senderStaffId,
            conversationId: execCtx.conversationId,
            spec,
          });
          return JSON.stringify({
            ok: true,
            taskId: task.id,
            cron: task.cron,
            nextRunAt: task.nextRunAt,
            message: `已创建${task.title}`,
          });
        }
        if (action === 'list') {
          const tasks = await this.service.listOwn(execCtx.senderStaffId);
          return JSON.stringify({
            ok: true,
            reports: tasks
              .filter((task) => task.kind !== 'reminder')
              .map((task) => ({
                id: task.id,
                title: task.title,
                cron: task.cron,
                nextRunAt: task.nextRunAt,
              })),
          });
        }
        if (action === 'cancel') {
          const id = requireString(args, 'id', '报告任务 ID');
          const task = await this.service.cancelOwn(execCtx.senderStaffId, id);
          if (!task) {
            return JSON.stringify({ ok: false, message: `没有找到报告任务：${id}` });
          }
          return JSON.stringify({ ok: true, message: `已取消：${task.title}` });
        }
        if (action === 'preview') {
          const period = optionalString(args, 'period') ?? 'daily';
          if (!['daily', 'weekly', 'monthly'].includes(period)) {
            throw new Error(`不支持的 period：${period}`);
          }
          const kind = `${period}_report` as PersonalReportKind;
          const text = await this.service.previewReport(
            execCtx.senderStaffId,
            kind,
          );
          return text;
        }
        throw new Error(`不支持的 action：${action}`);
      },
    };
  }
}
