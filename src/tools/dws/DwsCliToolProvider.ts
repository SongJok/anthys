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

const DOC_TARGETS = ['doc', 'wiki'] as const;
const DOC_ACTIONS = ['search', 'read', 'list', 'get'] as const;
const ORG_RESOURCES = ['contact', 'calendar', 'todo', 'approval'] as const;
const ORG_ACTIONS = ['search', 'get', 'list', 'self', 'today', 'freebusy'] as const;
const AUTH_FAILURE_HINT =
  /登录|授权|auth|token|expired|unauth|401|403|未登录|过期|失效/i;

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

export class DwsCliToolProvider implements IToolProvider {
  public readonly providerName = 'dws';
  private readonly runner: DwsCliRunner;
  private readonly auth?: DwsAuthManager;
  private readonly isAdmin: (staffId: string) => boolean;
  private readonly now: () => number;
  /** 同一会话 2 分钟内只提示一次，避免同轮多次工具调用重复弹消息 */
  private readonly lastNoticeAt = new Map<string, number>();

  constructor(options: DwsCliToolProviderOptions = {}) {
    this.runner = options.runner ?? new DwsCliRunner();
    this.auth = options.auth;
    this.isAdmin = options.isAdmin ?? (() => false);
    this.now = options.now ?? Date.now;
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [this.docTool(), this.orgTool()];
  }

  private async execute(
    ctx: ExecutionContext,
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
    if (result.exitCode !== 0 && this.auth && AUTH_FAILURE_HINT.test(result.stderr)) {
      const status = await this.auth.status({ force: true });
      if (status.state === 'expired') {
        return this.authorizationPrompt(ctx, status);
      }
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
        '查询钉钉组织与办公信息：contact 通讯录（search/get/list/self 查同事与值班人）、calendar 日程（list/today/freebusy）、todo 待办（list/search/get/today）、approval 审批（list/search/get）。',
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
              '操作，按资源不同可选：contact=search/get/list/self，calendar=list/today/search/freebusy，todo=list/search/get/today，approval=list/search/get',
          },
          query: { type: 'string', description: '搜索关键词，如姓名、待办标题、审批标题' },
          userId: { type: 'string', description: '目标员工 userId（查日程或待办时使用）' },
          date: { type: 'string', description: '日期，格式 YYYY-MM-DD（查日程时使用）' },
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
        const action = requireString(args, 'action', '操作');
        const allowed = DWS_SUBCOMMAND_WHITELIST[resource as DwsDomain];
        if (!allowed.includes(action)) {
          throw new Error(
            `资源 ${resource} 不支持操作 ${action}（允许: ${allowed.join(', ')}）`,
          );
        }

        const flags: DwsCommandRequest['flags'] = {};
        const query = optionalString(args, 'query');
        const userId = optionalString(args, 'userId');
        const date = optionalString(args, 'date');
        if (query) flags.query = query;
        if (userId) flags.user = userId;
        if (date) flags.date = date;

        return this.execute(
          ctx,
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
}
