import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { GroupWorkspaceService } from '../../groups/GroupWorkspaceService.js';
import type { GroupReportService } from '../../groups/GroupReportService.js';
import { describeReportCron } from '../../groups/GroupReportService.js';
import { parseReportSpec } from '../../personal/PersonalAssistantService.js';
import { parseDueAt } from '../../groups/GroupWorkspaceService.js';
import { formatShanghaiDateTime } from '../../time/shanghaiTime.js';
import {
  isGroupGoalStatus,
  isGroupTaskStatus,
} from '../../types/group-workspace.js';

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function goalLinkArg(
  args: Record<string, unknown>,
): string | null | undefined {
  if (!('goalId' in args)) return undefined;
  const value = args.goalId;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? null : text;
}

function formatDue(dueAt: number | null): string {
  if (!dueAt) return '';
  return `截止 ${formatShanghaiDateTime(dueAt)}`;
}

function actorOf(ctx: ExecutionContext): string {
  return ctx.personKey?.trim() || ctx.senderStaffId;
}

function resolveByPrefix<T extends { id: string; title: string }>(
  records: T[],
  id: string,
  label: string,
): { record: T } | { error: string } {
  const needle = id.trim().toLowerCase();
  if (!needle) return { error: `缺少${label} ID。` };
  const exact = records.find((record) => record.id.toLowerCase() === needle);
  if (exact) return { record: exact };
  const matches = records.filter((record) =>
    record.id.toLowerCase().startsWith(needle),
  );
  if (matches.length === 1 && matches[0]) return { record: matches[0] };
  if (matches.length > 1) {
    return { error: `${label} ID 前缀 ${id} 匹配到多条，请提供更完整的 ID。` };
  }
  return { error: `未找到${label} ${id}。` };
}

function formatSnapshot(snapshot: Awaited<
  ReturnType<GroupWorkspaceService['snapshot']>
>): string {
  const { workspace, goals, tasks } = snapshot;
  if (
    !workspace.purpose.trim() &&
    workspace.responsibilities.length === 0 &&
    goals.length === 0 &&
    tasks.length === 0
  ) {
    return '本群尚未配置工作区；可用 /group purpose 或管理台设置。';
  }
  const lines: string[] = [];
  if (workspace.purpose.trim()) lines.push(`群定位：${workspace.purpose.trim()}`);
  if (workspace.responsibilities.length > 0) {
    lines.push('群职责：', ...workspace.responsibilities.map((item) => `- ${item}`));
  }
  const activeGoals = goals.filter((goal) => goal.status !== 'archived');
  const goalTitles = new Map(goals.map((goal) => [goal.id, goal.title] as const));
  lines.push(
    activeGoals.length > 0 ? '群目标：' : '群目标：暂无。',
    ...activeGoals.map((goal) => {
      const meta = [
        goal.status,
        `进度 ${goal.progress}%`,
        goal.ownerName ? `负责人 ${goal.ownerName}` : '',
        formatDue(goal.dueAt),
      ].filter(Boolean);
      return `- ${goal.id.slice(0, 8)} · ${goal.title}（${meta.join(' · ')}）`;
    }),
  );
  const openTasks = tasks.filter((task) => task.status !== 'cancelled');
  lines.push(
    openTasks.length > 0 ? '群任务：' : '群任务：暂无。',
    ...openTasks.map((task) => {
      const linkedGoal = task.goalId ? goalTitles.get(task.goalId) : undefined;
      const meta = [
        task.status,
        task.assigneeName ? `负责人 ${task.assigneeName}` : '',
        formatDue(task.dueAt),
        linkedGoal ? `目标 ${linkedGoal}` : '',
      ].filter(Boolean);
      return `- ${task.id.slice(0, 8)} · ${task.title}（${meta.join(' · ')}）`;
    }),
  );
  return lines.join('\n');
}

/**
 * 让模型在群聊中维护当前群的目标与任务。
 * 工具只在本群内生效，不能跨群读取或改写其他群的数据。
 */
export class GroupWorkspaceToolProvider implements IToolProvider {
  public readonly providerName = 'group-workspace';
  private readonly service: GroupWorkspaceService;
  private readonly reports?: GroupReportService;

  constructor(options: {
    service: GroupWorkspaceService;
    reports?: GroupReportService;
  }) {
    this.service = options.service;
    this.reports = options.reports;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (ctx.conversationType !== '2') return [];
    const conversationId = ctx.conversationId;
    return [
      {
        name: 'group_workspace_view',
        description:
          '查看当前群的工作区：群定位、群职责、群目标与群任务。回答“这个群负责什么”“我们还有哪些任务”时使用。只能读取当前群。',
        parametersJsonSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        risk: 'read',
        source: 'group-workspace',
        execute: async () =>
          formatSnapshot(await this.service.snapshot(conversationId)),
      },
      {
        name: 'group_goal_create',
        description:
          '为当前群创建一个长期目标。仅在群聊中可用，用于把讨论形成的群目标沉淀下来。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '目标标题' },
            detail: { type: 'string', description: '目标说明或验收标准' },
            progress: {
              type: 'number',
              description: '初始进度 0–100（可选，默认 0）',
            },
            ownerName: { type: 'string', description: '负责人姓名（可选）' },
            due: {
              type: 'string',
              description: '截止日期，YYYY-MM-DD 或 ISO 时间（可选）',
            },
          },
          required: ['title'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-workspace',
        execute: async (args) => {
          const title = optionalString(args, 'title');
          if (!title) return '缺少目标标题。';
          const progress = optionalNumber(args, 'progress');
          const goal = await this.service.createGoal(
            conversationId,
            {
              title,
              ...(optionalString(args, 'detail')
                ? { detail: optionalString(args, 'detail')! }
                : {}),
              ...(progress !== undefined ? { progress } : {}),
              ...(optionalString(args, 'ownerName')
                ? { ownerName: optionalString(args, 'ownerName')! }
                : {}),
              dueAt: parseDueAt(
                optionalString(args, 'due') ?? null,
              ),
            },
            actorOf(ctx),
          );
          return `已创建群目标 ${goal.id.slice(0, 8)}：${goal.title}`;
        },
      },
      {
        name: 'group_goal_update',
        description:
          '更新当前群的群目标（状态、进度、标题、说明、负责人、截止日期）。goalId 支持 ID 前缀。状态改为 achieved 时进度自动置为 100。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            goalId: { type: 'string', description: '群目标 ID 或前缀' },
            status: {
              type: 'string',
              enum: ['active', 'achieved', 'paused', 'archived'],
              description: '新状态',
            },
            title: { type: 'string' },
            detail: { type: 'string' },
            progress: { type: 'number', description: '进度 0–100' },
            ownerName: { type: 'string' },
            due: { type: 'string', description: 'YYYY-MM-DD 或 ISO 时间' },
          },
          required: ['goalId'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-workspace',
        execute: async (args) => {
          const goalId = optionalString(args, 'goalId');
          if (!goalId) return '缺少目标 ID。';
          const snapshot = await this.service.snapshot(conversationId);
          const resolved = resolveByPrefix(snapshot.goals, goalId, '群目标');
          if ('error' in resolved) return resolved.error;
          if (
            !this.service.canManage(
              resolved.record,
              ctx.senderStaffId,
              actorOf(ctx),
            )
          ) {
            return '只有创建人或管理员可以修改群目标。';
          }
          const status = optionalString(args, 'status');
          if (status && !isGroupGoalStatus(status)) {
            return `未知目标状态：${status}`;
          }
          const due = optionalString(args, 'due');
          const progress = optionalNumber(args, 'progress');
          const updated = await this.service.updateGoal(
            conversationId,
            resolved.record.id,
            {
              ...(status && isGroupGoalStatus(status) ? { status } : {}),
              ...(progress !== undefined ? { progress } : {}),
              ...(optionalString(args, 'title')
                ? { title: optionalString(args, 'title')! }
                : {}),
              ...(optionalString(args, 'detail') !== undefined
                ? { detail: optionalString(args, 'detail') ?? '' }
                : {}),
              ...(optionalString(args, 'ownerName') !== undefined
                ? { ownerName: optionalString(args, 'ownerName') ?? '' }
                : {}),
              ...(due !== undefined ? { dueAt: parseDueAt(due) } : {}),
            },
            actorOf(ctx),
          );
          return `群目标 ${updated.id.slice(0, 8)} 已更新。`;
        },
      },
      {
        name: 'group_task_create',
        description:
          '为当前群创建一个待办任务，并可记录负责人、截止日期与关联的群目标。仅在群聊中可用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '任务标题' },
            detail: { type: 'string', description: '任务说明' },
            goalId: {
              type: ['string', 'null'],
              description: '关联的群目标 ID 或前缀（可选）',
            },
            assigneeName: { type: 'string', description: '负责人姓名（可选）' },
            due: {
              type: 'string',
              description: '截止日期，YYYY-MM-DD 或 ISO 时间（可选）',
            },
          },
          required: ['title'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-workspace',
        execute: async (args) => {
          const title = optionalString(args, 'title');
          if (!title) return '缺少任务标题。';
          const goalLink = goalLinkArg(args);
          const task = await this.service.createTask(
            conversationId,
            {
              title,
              ...(optionalString(args, 'detail')
                ? { detail: optionalString(args, 'detail')! }
                : {}),
              ...(goalLink !== undefined ? { goalId: goalLink } : {}),
              ...(optionalString(args, 'assigneeName')
                ? { assigneeName: optionalString(args, 'assigneeName')! }
                : {}),
              dueAt: parseDueAt(optionalString(args, 'due') ?? null),
            },
            actorOf(ctx),
          );
          return `已创建群任务 ${task.id.slice(0, 8)}：${task.title}`;
        },
      },
      {
        name: 'group_task_update',
        description:
          '更新当前群的群任务（状态、标题、说明、负责人、截止日期、关联目标）。taskId 支持 ID 前缀。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '群任务 ID 或前缀' },
            status: {
              type: 'string',
              enum: ['todo', 'doing', 'done', 'cancelled'],
            },
            title: { type: 'string' },
            detail: { type: 'string' },
            goalId: {
              type: ['string', 'null'],
              description: '关联的群目标 ID 或前缀；传 null 取消关联',
            },
            assigneeName: { type: 'string' },
            due: { type: 'string', description: 'YYYY-MM-DD 或 ISO 时间' },
          },
          required: ['taskId'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-workspace',
        execute: async (args) => {
          const taskId = optionalString(args, 'taskId');
          if (!taskId) return '缺少任务 ID。';
          const snapshot = await this.service.snapshot(conversationId);
          const resolved = resolveByPrefix(snapshot.tasks, taskId, '群任务');
          if ('error' in resolved) return resolved.error;
          if (
            !this.service.canManage(
              resolved.record,
              ctx.senderStaffId,
              actorOf(ctx),
            )
          ) {
            return '只有创建人或管理员可以修改群任务。';
          }
          const status = optionalString(args, 'status');
          if (status && !isGroupTaskStatus(status)) {
            return `未知任务状态：${status}`;
          }
          const due = optionalString(args, 'due');
          const goalLink = goalLinkArg(args);
          const updated = await this.service.updateTask(
            conversationId,
            resolved.record.id,
            {
              ...(status && isGroupTaskStatus(status) ? { status } : {}),
              ...(goalLink !== undefined ? { goalId: goalLink } : {}),
              ...(optionalString(args, 'title')
                ? { title: optionalString(args, 'title')! }
                : {}),
              ...(optionalString(args, 'detail') !== undefined
                ? { detail: optionalString(args, 'detail') ?? '' }
                : {}),
              ...(optionalString(args, 'assigneeName') !== undefined
                ? { assigneeName: optionalString(args, 'assigneeName') ?? '' }
                : {}),
              ...(due !== undefined ? { dueAt: parseDueAt(due) } : {}),
            },
            actorOf(ctx),
          );
          return `群任务 ${updated.id.slice(0, 8)} 已更新。`;
        },
      },
      {
        name: 'group_memory_save',
        description:
          '把当前群的长期知识（项目代号、约定、决策结论、群规则）写成群级语义记忆，后续群聊可召回。不要保存临时状态或私人信息。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要沉淀的群知识' },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: '检索关键词（可选）',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-workspace',
        execute: async (args) => {
          const content = optionalString(args, 'content');
          if (!content) return '缺少要保存的内容。';
          const saved = await this.service.rememberNote({
            conversationId,
            content: content.slice(0, 500),
            keywords: optionalStringArray(args, 'keywords') ?? [],
            createdBy: actorOf(ctx),
            ...(ctx.messageId ? { sourceMessageId: ctx.messageId } : {}),
          });
          return saved
            ? '已写入群级语义记忆。'
            : '群记忆写入未启用。';
        },
      },
      {
        name: 'group_memory_list',
        description:
          '查看或检索当前群的长期群记忆。回答“我们之前约定过什么”时使用；只返回本群条目。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词（可选）' },
            limit: { type: 'number', description: '返回条数，默认 20' },
          },
          additionalProperties: false,
        },
        risk: 'read',
        source: 'group-workspace',
        execute: async (args) => {
          const query = optionalString(args, 'query');
          const limit = optionalNumber(args, 'limit');
          const records = await this.service.listMemories(conversationId, {
            ...(query ? { query } : {}),
            limit: limit === undefined ? 20 : Math.round(limit),
          });
          if (records.length === 0) {
            return query
              ? `没有找到匹配「${query}」的群记忆。`
              : '本群还没有沉淀记忆。';
          }
          return [
            query ? '匹配的群记忆：' : '群记忆：',
            ...records.map(
              (record) =>
                `- ${record.id.slice(0, 8)} · ${record.content}（更新 ${formatShanghaiDateTime(record.updatedAt)}）`,
            ),
          ].join('\n');
        },
      },
      {
        name: 'group_memory_forget',
        description:
          '删除一条当前群的群记忆。只有管理员可以操作；memoryId 支持 ID 前缀。用户要求忘记某条群约定时使用。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            memoryId: { type: 'string', description: '群记忆 ID 或前缀' },
          },
          required: ['memoryId'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-workspace',
        execute: async (args) => {
          const memoryId = optionalString(args, 'memoryId');
          if (!memoryId) return '缺少群记忆 ID。';
          return this.service.forgetMemory(
            conversationId,
            memoryId,
            ctx.senderStaffId,
          );
        },
      },
      {
        name: 'group_digest',
        description:
          '生成当前群的目标与任务进度摘要：目标进度、逾期任务、3 天内到期任务、进行中任务。用户问“群里进展如何”时使用，无需再调用模型总结。',
        parametersJsonSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        risk: 'read',
        source: 'group-workspace',
        execute: async () => this.service.buildDigest(conversationId),
      },
      ...(this.reports
        ? [
            {
              name: 'group_report_schedule',
              description:
                '为本群设置定期群目标播报。管理员专用，按 cron 把目标进度与任务摘要推送到群里。用户说“每天/每周播报群进度”时使用。',
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  frequency: {
                    type: 'string',
                    enum: ['daily', 'weekly', 'monthly'],
                    description: '播报频率',
                  },
                  time: { type: 'string', description: '时间，如 09:00' },
                  weekday: {
                    type: 'string',
                    description: 'weekly 时的星期，如 周一 或 1-7（可选）',
                  },
                  dayOfMonth: {
                    type: 'string',
                    description: 'monthly 时的日期 1-28（可选）',
                  },
                },
                required: ['frequency', 'time'],
                additionalProperties: false,
              },
              risk: 'write' as const,
              source: 'group-workspace',
              execute: async (args: Record<string, unknown>) => {
                if (!this.reports!.canManage(ctx.senderStaffId)) {
                  return '只有管理员可以创建群目标播报。';
                }
                const frequency = optionalString(args, 'frequency');
                if (
                  frequency !== 'daily' &&
                  frequency !== 'weekly' &&
                  frequency !== 'monthly'
                ) {
                  return 'frequency 需为 daily、weekly 或 monthly。';
                }
                const time = optionalString(args, 'time') ?? '';
                const weekday = optionalString(args, 'weekday') ?? '周一';
                const dayOfMonth = optionalString(args, 'dayOfMonth') ?? '1';
                const raw =
                  frequency === 'weekly'
                    ? `weekly ${weekday} ${time}`
                    : frequency === 'monthly'
                      ? `monthly ${dayOfMonth} ${time}`
                      : `daily ${time}`;
                const spec = parseReportSpec(raw);
                if (typeof spec === 'string') return spec;
                try {
                  const task = await this.reports!.create({
                    conversationId,
                    actor: ctx.senderStaffId,
                    spec,
                  });
                  return `已创建群目标播报：${describeReportCron(task.cron ?? '')}`;
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              },
            },
            {
              name: 'group_report_list',
              description: '查看当前群的定时群目标播报。',
              parametersJsonSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              risk: 'read' as const,
              source: 'group-workspace',
              execute: async () => {
                const tasks = await this.reports!.list(conversationId);
                if (tasks.length === 0) return '本群还没有定时播报。';
                return [
                  '当前群播报：',
                  ...tasks.map(
                    (task) =>
                      `- ${describeReportCron(task.cron ?? '')} · ${task.enabled ? '已启用' : '已停用'} · ID ${task.id.slice(0, 8)}`,
                  ),
                ].join('\n');
              },
            },
            {
              name: 'group_report_cancel',
              description:
                '取消当前群的一条定时播报。reportId 支持 ID 前缀；仅创建人或管理员可操作。',
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  reportId: { type: 'string', description: '播报 ID 或前缀' },
                },
                required: ['reportId'],
                additionalProperties: false,
              },
              risk: 'write' as const,
              source: 'group-workspace',
              execute: async (args: Record<string, unknown>) => {
                const reportId = optionalString(args, 'reportId');
                if (!reportId) return '缺少播报 ID。';
                return this.reports!.cancel(
                  conversationId,
                  reportId,
                  ctx.senderStaffId,
                );
              },
            },
          ]
        : []),
    ];
  }
}
