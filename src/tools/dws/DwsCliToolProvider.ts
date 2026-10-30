import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';
import {
  DWS_SUBCOMMAND_WHITELIST,
  DwsCliRunner,
  type DwsDomain,
  type DwsRunResult,
} from './DwsCliRunner.js';
import type { DwsAuthManager, DwsAuthStatus } from './DwsAuthManager.js';
import {
  DWS_PERMISSION_GUIDES,
  formatDwsPermissionInstruction,
  isDwsPermissionError,
  type DwsPermissionNotice,
  type DwsPermissionNotifier,
} from './DwsPermissionNotice.js';

const DOC_TARGETS = ['doc', 'wiki'] as const;
const DOC_ACTIONS = ['search', 'read', 'list', 'get'] as const;
const ORG_RESOURCES = ['contact', 'calendar', 'todo', 'approval'] as const;

/** 只读工具只允许这些子命令，即使白名单里已有写命令也不能借道执行 */
const ORG_READ_ACTIONS: Record<
  (typeof ORG_RESOURCES)[number],
  readonly string[]
> = {
  contact: ['search', 'get', 'list', 'self'],
  calendar: ['list', 'today', 'search', 'freebusy'],
  todo: ['list', 'search', 'get', 'today'],
  approval: [
    'list-pending',
    'list-submitted',
    'list-executed',
    'list-cc',
    'detail',
    'records',
    'tasks',
    'list-forms',
    'search-forms',
    'form-schema',
  ],
};

const ORG_ACTIONS = [
  ...new Set(Object.values(ORG_READ_ACTIONS).flat()),
] as const;

const AUTH_FAILURE_HINT =
  /登录|授权|auth|token|expired|unauth|401|403|未登录|过期|失效/i;
const PERMISSION_NOTICE_INTERVAL_MS = 10 * 60_000;

type DocTarget = (typeof DOC_TARGETS)[number];
type DocAction = (typeof DOC_ACTIONS)[number];
type OrgResource = (typeof ORG_RESOURCES)[number];
type OrgAction = (typeof ORG_ACTIONS)[number];

export interface DwsCliToolProviderOptions {
  runner?: DwsCliRunner;
  /** 授权过期时触发提醒与设备码登录 */
  auth?: DwsAuthManager;
  /** 管理员判定；只有管理员可以发起重新授权 */
  isAdmin?: (staffId: string) => boolean;
  /** 检测到应用权限缺失时主动通知管理员 */
  permissionNotifier?: DwsPermissionNotifier;
  now?: () => number;
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${key}（${label}）必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`参数 ${key} 必须是字符串`);
  }
  return value.trim() === '' ? undefined : value.trim();
}

function optionalStringList(
  args: Record<string, unknown>,
  key: string,
  label: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const list = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`参数 ${key}（${label}）必须是字符串数组或逗号分隔字符串`);
  }
  const list = value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`参数 ${key}（${label}）的每一项都必须是非空字符串`);
    }
    return item.trim();
  });
  return list.length > 0 ? list : undefined;
}

function optionalNumberList(
  args: Record<string, unknown>,
  key: string,
  label: string,
): number[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`参数 ${key}（${label}）必须是数字数组`);
  }
  const list = value.map((item) => {
    const number = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(number)) {
      throw new Error(`参数 ${key}（${label}）的每一项都必须是数字`);
    }
    return Math.floor(number);
  });
  return list.length > 0 ? list : undefined;
}

function optionalJsonObject(
  args: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`参数 ${key}（${label}）必须是合法 JSON 对象`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`参数 ${key}（${label}）必须是 JSON 对象`);
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`参数 ${key}（${label}）必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requireNumericId(
  args: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = args[key];
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`参数 ${key}（${label}）必须是正整数 ID`);
  }
  return number;
}

function optionalPage(args: Record<string, unknown>): number {
  const value = args.page;
  if (value === undefined || value === null) return 1;
  const page = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(page) || page < 1) {
    throw new Error('参数 page 必须是大于等于 1 的整数');
  }
  return Math.floor(page);
}

function formatResult(
  request: DwsCommandRequest,
  result: DwsRunResult,
): string {
  const hint = result.timedOut
    ? 'DWS 命令执行超时，可缩小查询范围或稍后重试。'
    : result.exitCode !== 0
      ? 'DWS 命令执行失败，请根据 stderr 调整查询条件。'
      : result.hasMore
        ? `输出较长，已分页：当前第 ${result.page}/${result.totalPages} 页，可传入 page=${result.page + 1} 获取后续内容。`
        : undefined;
  return JSON.stringify({
    ok: result.exitCode === 0,
    domain: request.domain,
    subcommand: request.subcommand,
    command: result.command,
    exitCode: result.exitCode,
    page: result.page,
    totalPages: result.totalPages,
    hasMore: result.hasMore,
    truncated: result.truncated,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(hint ? { hint } : {}),
  });
}

function deptsFlag(deptIds: number[] | undefined): string | undefined {
  return deptIds
    ? JSON.stringify(deptIds.map((deptId) => ({ deptId })))
    : undefined;
}

export class DwsCliToolProvider implements IToolProvider {
  public readonly providerName = 'dws';
  private readonly runner: DwsCliRunner;
  private readonly auth?: DwsAuthManager;
  private readonly isAdmin: (staffId: string) => boolean;
  private readonly permissionNotifier?: DwsPermissionNotifier;
  private readonly now: () => number;
  /** 同一会话 2 分钟内只提示一次，避免同轮多次工具调用重复弹消息 */
  private readonly lastNoticeAt = new Map<string, number>();
  /** 同一会话同类权限问题 10 分钟内只通知管理员一次 */
  private readonly lastPermissionNoticeAt = new Map<string, number>();

  constructor(options: DwsCliToolProviderOptions = {}) {
    this.runner = options.runner ?? new DwsCliRunner();
    this.auth = options.auth;
    this.isAdmin = options.isAdmin ?? (() => false);
    this.permissionNotifier = options.permissionNotifier;
    this.now = options.now ?? Date.now;
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [
      this.docTool(),
      this.orgTool(),
      this.calendarManageTool(),
      this.calendarCancelTool(),
      this.todoManageTool(),
      this.contactManageTool(),
      this.approvalManageTool(),
    ];
  }

  private async execute(
    ctx: ExecutionContext,
    toolName: string,
    request: DwsCommandRequest,
    page: number,
  ): Promise<string> {
    if (ctx.deadlineAt - this.now() <= 0) {
      throw new Error('执行已超时，无法调用 DWS');
    }
    const gate = await this.checkAuthorization(ctx);
    if (gate) return gate;

    const remaining = ctx.deadlineAt - this.now();
    if (remaining <= 0) {
      throw new Error('执行已超时，无法调用 DWS');
    }
    const result = await this.runner.run(request, {
      page,
      timeoutMs: Math.min(15_000, remaining),
    });
    if (
      result.exitCode !== 0 &&
      this.auth &&
      AUTH_FAILURE_HINT.test(`${result.stdout}\n${result.stderr}`)
    ) {
      const status = await this.auth.status({ force: true });
      if (status.state === 'expired') {
        return this.authorizationPrompt(ctx, status);
      }
    }
    if (
      result.exitCode !== 0 &&
      isDwsPermissionError(
        request.domain,
        `${result.stdout}\n${result.stderr}`,
      )
    ) {
      return this.permissionPrompt(ctx, toolName, request, result);
    }
    return formatResult(request, result);
  }

  private async checkAuthorization(
    ctx: ExecutionContext,
  ): Promise<string | null> {
    if (!this.auth) return null;
    const status = await this.auth.status();
    if (status.state !== 'expired') return null;
    return this.authorizationPrompt(ctx, status);
  }

  /**
   * DWS 授权过期时：管理员直接发起设备码登录并把链接推给当前会话；
   * 非管理员提示联系管理员。两种情况都会登记“登录成功后自动续跑”。
   */
  private async authorizationPrompt(
    ctx: ExecutionContext,
    status: DwsAuthStatus,
  ): Promise<string> {
    const auth = this.auth!;
    const admin = this.isAdmin(ctx.senderStaffId);
    let ticket = auth.activeLogin();
    let startError: string | undefined;
    if (admin && !ticket) {
      try {
        ticket = await auth.startLogin({ startedBy: ctx.senderStaffId });
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }
    auth.markPending(ctx.conversationId, { resume: true });

    let text: string;
    if (!admin) {
      text =
        'DWS 授权已过期，暂时无法查询企业文档与组织数据。请联系管理员发送 /dws-login 完成重新授权，授权成功后我会自动继续刚才的问题。';
    } else if (ticket) {
      text = [
        'DWS 授权已过期，需要重新授权后才能继续查询企业数据。',
        '请在钉钉中打开以下链接完成授权（15 分钟内有效）：',
        ticket.verifyUrl,
        `授权码：${ticket.userCode}`,
        '授权完成后我会自动继续刚才的问题。',
      ].join('\n');
    } else {
      text = `DWS 授权已过期，自动发起重新授权失败：${startError ?? '未知原因'}。请稍后发送 /dws-login 重试。`;
    }

    if (ctx.notify) {
      const now = this.now();
      const lastAt = this.lastNoticeAt.get(ctx.conversationId) ?? 0;
      if (now - lastAt >= 120_000) {
        try {
          await ctx.notify(text);
          this.lastNoticeAt.set(ctx.conversationId, now);
          if (this.lastNoticeAt.size > 200) {
            for (const [key, at] of this.lastNoticeAt) {
              if (now - at > 600_000) this.lastNoticeAt.delete(key);
            }
          }
        } catch {
          // 通知失败不应阻断工具返回
        }
      }
    }

    return JSON.stringify({
      ok: false,
      authRequired: true,
      authState: status.state,
      ...(status.message ? { reason: status.message } : {}),
      ...(ticket
        ? {
            loginUrl: ticket.verifyUrl,
            userCode: ticket.userCode,
            expiresInSeconds: Math.max(
              0,
              Math.ceil((ticket.expiresAt - this.now()) / 1000),
            ),
          }
        : {}),
      instruction: admin
        ? 'DWS 授权已过期，已向用户发送重新授权链接与授权码。不要重复调用 DWS 工具；直接简要说明需要用户完成授权，授权成功后系统会自动继续。'
        : 'DWS 授权已过期且当前用户不是管理员，已提示其联系管理员。不要重复调用 DWS 工具；告知用户等待管理员完成授权，授权成功后系统会自动继续。',
    });
  }

  /**
   * 应用/接口权限缺失：主动通知管理员并给出开通步骤，
   * 同时要求模型向用户说明而不是反复重试。
   */
  private async permissionPrompt(
    ctx: ExecutionContext,
    toolName: string,
    request: DwsCommandRequest,
    result: DwsRunResult,
  ): Promise<string> {
    const now = this.now();
    const notice: DwsPermissionNotice = {
      conversationId: ctx.conversationId,
      conversationType: ctx.conversationType,
      senderStaffId: ctx.senderStaffId,
      senderNick: ctx.senderNick,
      toolName,
      domain: request.domain,
      action: `${DWS_PERMISSION_GUIDES[request.domain].label}（${request.subcommand}）`,
      command: result.command.join(' '),
      error: `${result.stdout}\n${result.stderr}`,
      occurredAt: now,
    };

    const key = `${ctx.conversationId}|${request.domain}|${request.subcommand}|${toolName}`;
    const lastAt = this.lastPermissionNoticeAt.get(key) ?? 0;
    let notified = now - lastAt < PERMISSION_NOTICE_INTERVAL_MS;
    if (this.permissionNotifier && !notified) {
      try {
        notified = await this.permissionNotifier(notice);
        if (notified) {
          this.lastPermissionNoticeAt.set(key, now);
          if (this.lastPermissionNoticeAt.size > 200) {
            for (const [entryKey, at] of this.lastPermissionNoticeAt) {
              if (now - at > 30 * 60_000) {
                this.lastPermissionNoticeAt.delete(entryKey);
              }
            }
          }
        }
      } catch {
        notified = false;
      }
    }

    return JSON.stringify({
      ok: false,
      permissionDenied: true,
      adminNotified: notified,
      domain: request.domain,
      subcommand: request.subcommand,
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      instruction: formatDwsPermissionInstruction(notice, notified),
    });
  }

  private docTool(): ToolDefinition {
    return {
      name: 'dws_doc_search_and_read',
      description:
        '检索并读取企业内钉钉文档与知识库（含线上故障复盘文档）。action=search 按关键词搜索，read/get 按 documentId 读取正文，list 列出最近文档。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: [...DOC_TARGETS],
            description: 'doc=普通文档，wiki=知识库',
          },
          action: {
            type: 'string',
            enum: [...DOC_ACTIONS],
            description: 'search 搜索 / read 读取 / get 获取 / list 列出',
          },
          query: { type: 'string', description: '搜索关键词，action=search 时必填' },
          documentId: {
            type: 'string',
            description: '文档 ID，action=read/get 时必填',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '输出分页页码，默认 1；hasMore=true 时可翻页',
          },
        },
        required: ['target', 'action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const target = requireString(args, 'target', '文档类型') as DocTarget;
        if (!DOC_TARGETS.includes(target)) {
          throw new Error(
            `不支持的文档类型: ${target}（允许: ${DOC_TARGETS.join(', ')}）`,
          );
        }
        const action = requireString(args, 'action', '操作') as DocAction;
        if (!DOC_ACTIONS.includes(action)) {
          throw new Error(
            `不支持的文档操作: ${action}（允许: ${DOC_ACTIONS.join(', ')}）`,
          );
        }
        const query = optionalString(args, 'query');
        const documentId = optionalString(args, 'documentId');
        if (action === 'search' && !query) {
          throw new Error('action=search 时必须提供 query');
        }
        if ((action === 'read' || action === 'get') && !documentId) {
          throw new Error(`action=${action} 时必须提供 documentId`);
        }

        const flags: DwsCommandRequest['flags'] = {};
        if (query) flags.query = query;
        if (documentId) flags.id = documentId;

        return this.execute(
          ctx,
          'dws_doc_search_and_read',
          {
            domain: target,
            subcommand: action,
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }

  private orgTool(): ToolDefinition {
    return {
      name: 'dws_org_and_schedule',
      description:
        '只读查询钉钉组织与办公信息：contact 通讯录（search/get/list/self）、calendar 日程（list/today/search/freebusy）、todo 待办（list/search/get/today）、approval 审批（list-pending/list-submitted/detail/records/tasks/list-forms/search-forms/form-schema）。写操作请使用对应的写工具。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: [...ORG_RESOURCES],
            description: 'contact 通讯录 / calendar 日程 / todo 待办 / approval 审批',
          },
          action: {
            type: 'string',
            enum: [...ORG_ACTIONS],
            description:
              '查询操作，按资源不同可选：contact=search/get/list/self，calendar=list/today/search/freebusy，todo=list/search/get/today，approval=list-pending/list-submitted/detail/records/tasks/list-forms/search-forms/form-schema',
          },
          query: { type: 'string', description: '搜索关键词，如姓名、待办标题、审批标题' },
          userId: { type: 'string', description: '目标员工 userId（查日程或待办时使用）' },
          date: { type: 'string', description: '日期，格式 YYYY-MM-DD（查日程时使用）' },
          instanceId: {
            type: 'string',
            description: '审批实例 ID（approval 的 detail/records/tasks 使用）',
          },
          processCode: {
            type: 'string',
            description: '审批模板 processCode（approval 的 form-schema 使用）',
          },
          start: {
            type: 'string',
            description:
              '开始时间 ISO-8601（approval 的 list-pending 使用，必填）',
          },
          end: {
            type: 'string',
            description:
              '结束时间 ISO-8601（approval 的 list-pending 使用，必填）',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '输出分页页码，默认 1；hasMore=true 时可翻页',
          },
        },
        required: ['resource', 'action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const resource = requireString(
          args,
          'resource',
          '资源类型',
        ) as OrgResource;
        if (!ORG_RESOURCES.includes(resource)) {
          throw new Error(
            `不支持的资源类型: ${resource}（允许: ${ORG_RESOURCES.join(', ')}）`,
          );
        }
        const action = requireString(args, 'action', '操作') as OrgAction;
        const allowed = ORG_READ_ACTIONS[resource];
        if (!allowed.includes(action)) {
          throw new Error(
            `资源 ${resource} 不支持只读操作 ${action}（允许: ${allowed.join(', ')}）`,
          );
        }
        const whitelisted = DWS_SUBCOMMAND_WHITELIST[resource as DwsDomain];
        if (!whitelisted.includes(action)) {
          throw new Error(
            `资源 ${resource} 不支持操作 ${action}（允许: ${whitelisted.join(', ')}）`,
          );
        }

        const flags: DwsCommandRequest['flags'] = {};
        const query = optionalString(args, 'query');
        const userId = optionalString(args, 'userId');
        const date = optionalString(args, 'date');
        const instanceId = optionalString(args, 'instanceId');
        const processCode = optionalString(args, 'processCode');
        const start = optionalString(args, 'start');
        const end = optionalString(args, 'end');
        if (query) flags.query = query;
        if (userId) flags.user = userId;
        if (date) flags.date = date;
        if (instanceId) flags['instance-id'] = instanceId;
        if (processCode) flags['process-code'] = processCode;
        if (start) flags.start = start;
        if (end) flags.end = end;

        if (resource === 'approval') {
          if (action === 'list-pending' && (!start || !end)) {
            throw new Error('approval 的 list-pending 必须提供 start 与 end');
          }
          if (
            ['detail', 'records', 'tasks'].includes(action) &&
            !instanceId
          ) {
            throw new Error(`approval 的 ${action} 必须提供 instanceId`);
          }
          if (action === 'form-schema' && !processCode) {
            throw new Error('approval 的 form-schema 必须提供 processCode');
          }
          if (action === 'search-forms' && !query) {
            throw new Error('approval 的 search-forms 必须提供 query');
          }
        }

        return this.execute(
          ctx,
          'dws_org_and_schedule',
          {
            domain: resource,
            subcommand: action,
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }

  private calendarManageTool(): ToolDefinition {
    return {
      name: 'dws_calendar_manage',
      description:
        '创建或修改钉钉日程（写操作，执行前需要用户 /confirm）。action=create 需要 title、start、end；action=update 需要 eventId 以及至少一个要修改的字段。时间为 ISO-8601，例如 2026-03-10T14:00:00+08:00。',
      risk: 'write',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update'] },
          eventId: {
            type: 'string',
            description: '日程 ID，action=update 时必填（可先用只读工具查询）',
          },
          title: { type: 'string', description: '日程标题' },
          start: { type: 'string', description: '开始时间 ISO-8601' },
          end: { type: 'string', description: '结束时间 ISO-8601' },
          description: { type: 'string', description: '日程描述' },
          location: { type: 'string', description: '地点备注' },
          timezone: { type: 'string', description: 'IANA 时区，默认 Asia/Shanghai' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: '参会人 userId 列表',
          },
          remindMinutes: {
            type: 'string',
            description: '开始前提醒分钟数，逗号分隔，如 5,15',
          },
          calendarId: {
            type: 'string',
            description: '日历 ID，默认主日历',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        if (action !== 'create' && action !== 'update') {
          throw new Error(`action 只允许 create 或 update，收到: ${action}`);
        }
        const eventId = optionalString(args, 'eventId');
        const title = optionalString(args, 'title');
        const start = optionalString(args, 'start');
        const end = optionalString(args, 'end');
        const description = optionalString(args, 'description');
        const location = optionalString(args, 'location');
        const timezone = optionalString(args, 'timezone');
        const attendees = optionalStringList(args, 'attendees', '参会人');
        const remindMinutes = optionalString(args, 'remindMinutes');
        const calendarId = optionalString(args, 'calendarId');

        if (action === 'create') {
          if (!title || !start || !end) {
            throw new Error('action=create 时必须提供 title、start、end');
          }
        } else {
          if (!eventId) {
            throw new Error('action=update 时必须提供 eventId');
          }
          if (
            !title &&
            !start &&
            !end &&
            !description &&
            !location &&
            !timezone &&
            !attendees &&
            !remindMinutes
          ) {
            throw new Error('action=update 时至少提供一个要修改的字段');
          }
        }

        const flags: DwsCommandRequest['flags'] = { yes: true };
        if (eventId) flags.id = eventId;
        if (title) flags.title = title;
        if (start) flags.start = start;
        if (end) flags.end = end;
        if (description) flags.desc = description;
        if (location) flags.location = location;
        if (timezone) flags.timezone = timezone;
        if (attendees) flags.attendees = attendees.join(',');
        if (remindMinutes) flags['remind-minutes'] = remindMinutes;
        if (calendarId) flags['calendar-id'] = calendarId;

        return this.execute(
          ctx,
          'dws_calendar_manage',
          {
            domain: 'calendar',
            subcommand: `event ${action}`,
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }

  private calendarCancelTool(): ToolDefinition {
    return {
      name: 'dws_calendar_cancel',
      description:
        '取消（删除）钉钉日程（高危写操作，执行前需要用户 /confirm）。必须提供 eventId；可先用只读工具确认日程真实存在。',
      risk: 'destructive',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: '要取消的日程 ID' },
          calendarId: {
            type: 'string',
            description: '日历 ID，默认主日历',
          },
        },
        required: ['eventId'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const eventId = requireString(args, 'eventId', '日程 ID');
        const calendarId = optionalString(args, 'calendarId');
        const flags: DwsCommandRequest['flags'] = {
          id: eventId,
          yes: true,
        };
        if (calendarId) flags['calendar-id'] = calendarId;
        return this.execute(
          ctx,
          'dws_calendar_cancel',
          {
            domain: 'calendar',
            subcommand: 'event delete',
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }

  private todoManageTool(): ToolDefinition {
    return {
      name: 'dws_todo_manage',
      description:
        '创建、修改或完成钉钉待办（写操作，执行前需要用户 /confirm）。action=create 需要 title，executors 省略时默认指派给当前提问人；action=update 需要 taskId；action=complete 需要 taskId，status 默认 true。',
      risk: 'write',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'complete'] },
          taskId: {
            type: 'string',
            description: '待办任务 ID，update/complete 时必填',
          },
          title: { type: 'string', description: '待办标题' },
          executors: {
            type: 'array',
            items: { type: 'string' },
            description: '执行人 userId 列表，create 时省略则默认当前提问人',
          },
          due: {
            type: 'string',
            description: '截止时间 ISO-8601，如 2026-03-10T18:00:00+08:00',
          },
          priority: {
            type: 'string',
            description: '优先级：10低 / 20普通 / 30较高 / 40紧急',
          },
          status: {
            type: 'boolean',
            description: 'complete 时的完成状态，默认 true',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        const taskId = optionalString(args, 'taskId');
        const title = optionalString(args, 'title');
        const executors = optionalStringList(args, 'executors', '执行人');
        const due = optionalString(args, 'due');
        const priority = optionalString(args, 'priority');
        const status =
          typeof args.status === 'boolean' ? args.status : undefined;

        if (action === 'create') {
          if (!title) throw new Error('action=create 时必须提供 title');
          const flags: DwsCommandRequest['flags'] = {
            title,
            executors: (executors ?? [ctx.senderStaffId]).join(','),
            yes: true,
          };
          if (due) flags.due = due;
          if (priority) flags.priority = priority;
          return this.execute(
            ctx,
            'dws_todo_manage',
            {
              domain: 'todo',
              subcommand: 'task create',
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        if (action === 'update') {
          if (!taskId) throw new Error('action=update 时必须提供 taskId');
          if (!title && !due && !priority) {
            throw new Error('action=update 时至少提供 title、due、priority 之一');
          }
          const flags: DwsCommandRequest['flags'] = {
            'task-id': taskId,
            yes: true,
          };
          if (title) flags.title = title;
          if (due) flags.due = due;
          if (priority) flags.priority = priority;
          return this.execute(
            ctx,
            'dws_todo_manage',
            {
              domain: 'todo',
              subcommand: 'task update',
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        if (action === 'complete') {
          if (!taskId) throw new Error('action=complete 时必须提供 taskId');
          return this.execute(
            ctx,
            'dws_todo_manage',
            {
              domain: 'todo',
              subcommand: 'task done',
              flags: {
                'task-id': taskId,
                status: String(status ?? true),
                yes: true,
              },
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        throw new Error(`action 只允许 create、update 或 complete，收到: ${action}`);
      },
    };
  }

  private contactManageTool(): ToolDefinition {
    return {
      name: 'dws_contact_manage',
      description:
        '邀请员工加入企业或修改员工组织信息（写操作，执行前需要用户 /confirm）。action=invite 需要 orgUserName、orgUserMobile；action=update 需要 userId 以及至少一个修改项。部门用 deptIds 数字数组传入。',
      risk: 'write',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['invite', 'update'] },
          userId: { type: 'string', description: '员工 userId，update 时必填' },
          orgUserName: {
            type: 'string',
            description: '员工在企业内的姓名',
          },
          orgUserMobile: {
            type: 'string',
            description: '员工手机号，invite 时必填',
          },
          deptIds: {
            type: 'array',
            items: { type: 'integer' },
            description: '所属部门 ID 列表',
          },
          masterUserId: {
            type: 'string',
            description: '直属主管 userId，update 时可选',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        const userId = optionalString(args, 'userId');
        const orgUserName = optionalString(args, 'orgUserName');
        const orgUserMobile = optionalString(args, 'orgUserMobile');
        const deptIds = optionalNumberList(args, 'deptIds', '部门 ID');
        const masterUserId = optionalString(args, 'masterUserId');
        const depts = deptsFlag(deptIds);

        if (action === 'invite') {
          if (!orgUserName || !orgUserMobile) {
            throw new Error(
              'action=invite 时必须提供 orgUserName 与 orgUserMobile',
            );
          }
          const flags: DwsCommandRequest['flags'] = {
            'org-user-name': orgUserName,
            'org-user-mobile': orgUserMobile,
            yes: true,
          };
          if (depts) flags.depts = depts;
          return this.execute(
            ctx,
            'dws_contact_manage',
            {
              domain: 'contact',
              subcommand: 'user invite',
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        if (action === 'update') {
          if (!userId) throw new Error('action=update 时必须提供 userId');
          if (!orgUserName && !depts && !masterUserId) {
            throw new Error(
              'action=update 时至少提供 orgUserName、deptIds、masterUserId 之一',
            );
          }
          const flags: DwsCommandRequest['flags'] = {
            'user-id': userId,
            yes: true,
          };
          if (orgUserName) flags['org-user-name'] = orgUserName;
          if (depts) flags.depts = depts;
          if (masterUserId) flags['master-user-id'] = masterUserId;
          return this.execute(
            ctx,
            'dws_contact_manage',
            {
              domain: 'contact',
              subcommand: 'user update',
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        throw new Error(`action 只允许 invite 或 update，收到: ${action}`);
      },
    };
  }

  private approvalManageTool(): ToolDefinition {
    return {
      name: 'dws_approval_manage',
      description:
        '发起、同意或拒绝钉钉审批（写操作，执行前需要用户 /confirm）。action=create 需要 processCode 与 formValues（表单字段对象）；action=approve/reject 需要 instanceId 与 taskId。发起前应先用只读工具查询表单 Schema。',
      risk: 'write',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'approve', 'reject'] },
          processCode: {
            type: 'string',
            description: '审批模板 processCode，create 时必填',
          },
          formValues: {
            type: 'object',
            description: '表单字段对象，create 时必填，如 {"事由":"测试"}',
          },
          approvers: {
            type: 'array',
            items: { type: 'string' },
            description: '审批人 userId 列表，create 时可选',
          },
          ccList: {
            type: 'array',
            items: { type: 'string' },
            description: '抄送人 userId 列表，create 时可选',
          },
          originatorUserId: {
            type: 'string',
            description: '发起人 userId，默认当前提问人',
          },
          instanceId: {
            type: 'string',
            description: '审批实例 ID，approve/reject 时必填',
          },
          taskId: {
            type: 'string',
            description:
              '审批任务数字 ID，approve/reject 时必填（先用 tasks 查询，DWS 要求正整数）',
          },
          remark: {
            type: 'string',
            description: '审批意见，approve/reject 时可选',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');

        if (action === 'create') {
          const processCode = requireString(
            args,
            'processCode',
            '审批模板 processCode',
          );
          const formValues = optionalJsonObject(
            args,
            'formValues',
            '表单字段',
          );
          if (!formValues) {
            throw new Error('action=create 时必须提供 formValues');
          }
          const approvers = optionalStringList(args, 'approvers', '审批人');
          const ccList = optionalStringList(args, 'ccList', '抄送人');
          const originatorUserId =
            optionalString(args, 'originatorUserId') ?? ctx.senderStaffId;
          const flags: DwsCommandRequest['flags'] = {
            'process-code': processCode,
            'form-values': JSON.stringify(formValues),
            'originator-user-id': originatorUserId,
            yes: true,
          };
          if (approvers) flags.approvers = approvers.join(',');
          if (ccList) flags['cc-list'] = ccList.join(',');
          return this.execute(
            ctx,
            'dws_approval_manage',
            {
              domain: 'approval',
              subcommand: 'create-instance',
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        if (action === 'approve' || action === 'reject') {
          const instanceId = requireString(args, 'instanceId', '审批实例 ID');
          const taskId = requireNumericId(args, 'taskId', '审批任务 ID');
          const remark = optionalString(args, 'remark');
          const flags: DwsCommandRequest['flags'] = {
            'instance-id': instanceId,
            'task-id': taskId,
            yes: true,
          };
          if (remark) flags.remark = remark;
          return this.execute(
            ctx,
            'dws_approval_manage',
            {
              domain: 'approval',
              subcommand: action,
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
          );
        }

        throw new Error(`action 只允许 create、approve 或 reject，收到: ${action}`);
      },
    };
  }
}
