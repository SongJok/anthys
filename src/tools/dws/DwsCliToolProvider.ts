import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';
import {
  DwsCliRunner,
  type DwsRunResult,
} from './DwsCliRunner.js';
import {
  DWS_CONSENT_VERSION,
  DwsIdentityError,
  type DwsIdentityService,
  type DwsIdentityStatus,
} from './DwsIdentityService.js';
import type { DwsIdentityRecord } from '../../types/dws-identity.js';
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
const MAX_CONTENT_CHARS = 30_000;

type DocTarget = (typeof DOC_TARGETS)[number];
type DocAction = (typeof DOC_ACTIONS)[number];
type OrgResource = (typeof ORG_RESOURCES)[number];
type OrgAction = (typeof ORG_ACTIONS)[number];

export interface DwsCliToolProviderOptions {
  runner?: DwsCliRunner;
  /** 每员工独立身份；配置后所有调用强制使用提问人自己的 profile */
  identity?: DwsIdentityService;
  /** 群聊里把授权链接私聊推给提问人，避免在群里暴露授权码 */
  personalNotifier?: (
    staffId: string,
    text: string,
  ) => Promise<boolean> | boolean;
  /** 检测到应用权限缺失时主动通知管理员 */
  permissionNotifier?: DwsPermissionNotifier;
  now?: () => number;
}

export interface DwsAuthorizationGate {
  userText: string;
  /** 本次检查是否真的发起了设备码登录（用于登记授权后自动续跑的写任务） */
  loginStarted: boolean;
  code: 'auth' | 'write-opt-out';
}

interface AuthBlock {
  json: string;
  userText: string;
  loginStarted: boolean;
  code: DwsAuthorizationGate['code'];
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

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`参数 ${key}（${label}）必须是 ${min}-${max} 的整数`);
  }
  return number;
}

/** 接受对象/数组或 JSON 字符串，校验后统一序列化为 CLI 需要的 JSON 字符串 */
function optionalJsonFlag(
  args: Record<string, unknown>,
  key: string,
  label: string,
  expected: 'object' | 'array',
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`参数 ${key}（${label}）必须是合法 JSON`);
    }
  }
  const valid =
    expected === 'array'
      ? Array.isArray(parsed)
      : Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!valid) {
    throw new Error(`参数 ${key}（${label}）必须是 JSON ${expected === 'array' ? '数组' : '对象'}`);
  }
  const text = JSON.stringify(parsed);
  if (text.length > 1_900) {
    throw new Error(`参数 ${key}（${label}）过长，请减少条件后重试`);
  }
  return text;
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
  private readonly identity?: DwsIdentityService;
  private readonly personalNotifier?: DwsCliToolProviderOptions['personalNotifier'];
  private readonly permissionNotifier?: DwsPermissionNotifier;
  private readonly now: () => number;
  /** 同一会话 2 分钟内只提示一次，避免同轮多次工具调用重复弹消息 */
  private readonly lastNoticeAt = new Map<string, number>();
  /** 同一会话同类权限问题 10 分钟内只通知管理员一次 */
  private readonly lastPermissionNoticeAt = new Map<string, number>();

  constructor(options: DwsCliToolProviderOptions = {}) {
    this.runner = options.runner ?? new DwsCliRunner();
    this.identity = options.identity;
    this.personalNotifier = options.personalNotifier;
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
      this.docManageTool(),
      this.reportReadTool(),
      this.reportSubmitTool(),
      this.aitableTool(),
      this.minutesTool(),
    ];
  }

  private async execute(
    ctx: ExecutionContext,
    toolName: string,
    request: DwsCommandRequest,
    page: number,
    write = false,
  ): Promise<string> {
    if (ctx.deadlineAt - this.now() <= 0) {
      throw new Error('执行已超时，无法调用 DWS');
    }
    const identity = this.identity;
    if (identity) {
      const blocked = await this.authCheck(ctx, write);
      if (blocked) return blocked.json;
    }

    const remaining = ctx.deadlineAt - this.now();
    if (remaining <= 0) {
      throw new Error('执行已超时，无法调用 DWS');
    }
    let result: DwsRunResult;
    try {
      result = identity
        ? await identity.run(ctx.senderStaffId, request, {
            page,
            timeoutMs: Math.min(15_000, remaining),
          })
        : await this.runner.run(request, {
            page,
            timeoutMs: Math.min(15_000, remaining),
          });
    } catch (error) {
      if (identity && error instanceof DwsIdentityError) {
        const record = await identity.getRecord(ctx.senderStaffId);
        const consentOk = record?.consentVersion === DWS_CONSENT_VERSION;
        const prompt = await this.identityPrompt(
          ctx,
          consentOk ? record : null,
          'unbound',
        );
        return prompt.json;
      }
      throw error;
    }
    if (
      result.exitCode !== 0 &&
      identity &&
      identity.isAuthFailure(`${result.stdout}\n${result.stderr}`)
    ) {
      const status = await identity.status(ctx.senderStaffId, { force: true });
      if (status.state === 'expired') {
        const prompt = await this.identityPrompt(
          ctx,
          status.record,
          'expired',
          status,
        );
        return prompt.json;
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

  /** 长内容先写入临时文件，避免超出单个 flag 长度上限，也避免 shell 转义问题 */
  private async executeWithFile(
    ctx: ExecutionContext,
    toolName: string,
    request: DwsCommandRequest,
    page: number,
    write: boolean,
    fileFlag: 'content-file' | 'contents-file',
    content: string,
    extension: 'md' | 'json',
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dws-content-'));
    const file = join(dir, `payload.${extension}`);
    try {
      await writeFile(file, content, 'utf8');
      return await this.execute(
        ctx,
        toolName,
        {
          ...request,
          flags: { ...request.flags, [fileFlag]: file },
        },
        page,
        write,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * 写工具在进入审批闸门前先完成本人授权检查，
   * 返回需要直接展示给用户的说明；null 表示可以继续。
   */
  public async authorizationPrompt(
    ctx: ExecutionContext,
    write = true,
  ): Promise<string | null> {
    const blocked = await this.authCheck(ctx, write);
    return blocked?.userText ?? null;
  }

  /** 结构化授权检查：额外告诉调用方本次是否已发起登录，便于登记续跑任务 */
  public async authorizationGate(
    ctx: ExecutionContext,
    write = true,
  ): Promise<DwsAuthorizationGate | null> {
    const blocked = await this.authCheck(ctx, write);
    if (!blocked) return null;
    return {
      userText: blocked.userText,
      loginStarted: blocked.loginStarted,
      code: blocked.code,
    };
  }

  private async authCheck(
    ctx: ExecutionContext,
    write: boolean,
  ): Promise<AuthBlock | null> {
    const identity = this.identity;
    if (!identity) return null;
    if (ctx.senderStaffId.startsWith('$:')) {
      return {
        code: 'auth',
        loginStarted: false,
        json: JSON.stringify({
          ok: false,
          authRequired: true,
          externalIdentity: true,
          instruction:
            '提问人的身份是群里加密/外部身份，钉钉没有提供企业账号（staffId），无法发起个人 DWS 授权，也不能私聊发送链接或查询个人数据。不要重复调用 DWS 工具，也不要声称已查询到数据；只简短说明需要用企业账号在单聊中提问。',
        }),
        userText:
          '钉钉没有向我提供你的企业账号标识（当前是群里的加密/外部身份），我无法查询你的个人钉钉数据，也无法把授权链接发给你。请用企业账号在单聊中向我提问，我会直接把授权链接发给你。',
      };
    }
    const record = await identity.getRecord(ctx.senderStaffId);
    const consentOk = record?.consentVersion === DWS_CONSENT_VERSION;
    if (!record?.profile || !consentOk) {
      return this.identityPrompt(ctx, consentOk ? record : null, 'unbound', undefined, {
        write,
      });
    }
    if (write && record.writeOptOut) {
      return this.writeOptOutBlock();
    }
    const status = await identity.status(ctx.senderStaffId);
    if (status.state === 'expired') {
      return this.identityPrompt(ctx, record, 'expired', status, { write });
    }
    if (write && !record.writeEnabled) {
      try {
        await identity.ensureWritePermission(ctx.senderStaffId);
      } catch (error) {
        if (error instanceof DwsIdentityError && error.code === 'write-opt-out') {
          return this.writeOptOutBlock();
        }
        if (error instanceof DwsIdentityError && error.code === 'consent-required') {
          return this.identityPrompt(ctx, null, 'unbound', undefined, {
            write: true,
          });
        }
        throw error;
      }
    }
    return null;
  }

  private writeOptOutBlock(): AuthBlock {
    return {
      code: 'write-opt-out',
      loginStarted: false,
      json: JSON.stringify({
        ok: false,
        writeConsentRequired: true,
        instruction:
          '你此前把个人 DWS 授权改回了只读，写操作不会自动执行。若需要代你创建或修改日程、待办、审批，请先发送 /dws-consent write 重新允许写操作后重试。不要重复调用写工具。',
      }),
      userText:
        '你此前把钉钉授权改回了只读，写操作不会自动执行。若要代你创建或修改日程、待办、审批，请先发送 /dws-consent write 重新允许写操作后再试。',
    };
  }

  /**
   * 令牌缺失或过期时不再让用户记命令：机器人自动记录只读同意并
   * 发起本人设备码登录，用户只需打开链接授权。群聊里链接只私聊发送。
   */
  private async identityPrompt(
    ctx: ExecutionContext,
    record: DwsIdentityRecord | null,
    reason: 'unbound' | 'expired',
    status?: DwsIdentityStatus,
    options: { write?: boolean } = {},
  ): Promise<AuthBlock> {
    const identity = this.identity!;
    const write = options.write ?? false;
    const singleChat = ctx.conversationType === '1';
    const consentCurrent = record?.consentVersion === DWS_CONSENT_VERSION;
    let autoConsentRecorded = false;
    let ticket: { verifyUrl: string; userCode: string; expiresAt: number } | null =
      null;
    let failure: string | undefined;

    try {
      if (!consentCurrent) {
        await identity.ensureReadConsent(ctx.senderStaffId, { write });
        autoConsentRecorded = true;
      } else if (write) {
        await identity.ensureReadConsent(ctx.senderStaffId, { write: true });
      }
      const active = await identity.startLogin(ctx.senderStaffId);
      ticket = {
        verifyUrl: active.verifyUrl,
        userCode: active.userCode,
        expiresAt: active.expiresAt,
      };
      identity.markPending(ctx.senderStaffId, ctx.conversationId, {
        resume: true,
        messageId: ctx.messageId,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const intro =
      reason === 'expired'
        ? '你的钉钉授权已过期，需要你本人重新授权后才能继续。'
        : autoConsentRecorded
          ? write
            ? '首次代你执行写操作前，需要你本人完成一次授权。'
            : '首次查询你的钉钉数据前，需要你本人完成一次授权。'
          : '你还未完成钉钉授权，需要你本人授权后才能继续。';
    const text = ticket
      ? [
          intro,
          write
            ? '授权范围：日程、待办、审批、通讯录、文档与知识库的查询，以及代你创建或修改日程、待办、审批等普通写操作；取消日程、覆盖文档等高危操作仍会先请你 /confirm。'
            : '授权范围：日程、待办、审批、通讯录、文档与知识库的只读查询；不会代替你创建或修改任何数据。',
          '请在 15 分钟内打开以下链接完成授权：',
          ticket.verifyUrl,
          `授权码：${ticket.userCode}`,
          write
            ? '授权完成后我会自动继续刚才的写操作；取消日程、覆盖文档等高危操作仍会再次请你 /confirm。'
            : '授权完成后我会自动继续刚才的问题。',
        ].join('\n')
      : `${intro}我尝试自动发起授权但失败了${failure ? `（${failure}）` : ''}，请稍后再试。`;

    // 单聊直接发；群聊只私聊给提问人，避免授权码出现在群里
    let delivered = false;
    if (ticket) {
      const now = this.now();
      const noticeKey = singleChat
        ? ctx.conversationId
        : `dm:${ctx.senderStaffId}`;
      const lastAt = this.lastNoticeAt.get(noticeKey) ?? 0;
      if (now - lastAt < 120_000) {
        delivered = true;
      } else if (singleChat) {
        if (ctx.notify) {
          try {
            await ctx.notify(text);
            delivered = true;
          } catch {
            // 通知失败不应阻断工具返回
          }
        }
      } else if (this.personalNotifier) {
        try {
          delivered = await this.personalNotifier(ctx.senderStaffId, text);
        } catch {
          delivered = false;
        }
      }
      if (delivered) {
        this.lastNoticeAt.set(noticeKey, now);
        if (this.lastNoticeAt.size > 200) {
          for (const [key, at] of this.lastNoticeAt) {
            if (now - at > 600_000) this.lastNoticeAt.delete(key);
          }
        }
      }
    }

    const instruction = ticket
      ? singleChat
        ? `个人 DWS 授权缺失或已过期。已把授权链接和授权码发给用户；不要重复调用 DWS 工具，也不要声称已查询或写入数据。${
            write
              ? '简短提醒用户打开链接完成授权，授权成功后系统会自动继续并直接执行刚才的写操作。'
              : '简短提醒用户打开链接完成授权，授权成功后系统会自动继续刚才的问题。'
          }`
        : delivered
          ? '个人 DWS 授权缺失或已过期，已把授权链接私聊发送给提问人。不要重复调用 DWS 工具；在群里只说明已私聊发送授权链接、请其打开完成授权，不要在群里复述链接或授权码。'
          : '个人 DWS 授权缺失或已过期，但无法私聊发送授权链接。不要重复调用 DWS 工具；只简短告知用户授权未完成、稍后再试。'
      : '个人 DWS 授权缺失或已过期，且自动发起授权失败。不要重复调用 DWS 工具；只简短告知用户稍后再试。';

    const userText = !ticket
      ? '我尝试自动发起钉钉授权但失败了，请稍后再试。'
      : singleChat
        ? text
        : delivered
          ? '已把钉钉授权链接私聊发给你，请打开链接完成授权后再发一次刚才的问题。'
          : '需要你本人完成钉钉授权，但我无法把授权链接私聊发给你。请在企业内部单聊中向我提问，我会直接把授权链接发给你。';

    return {
      code: 'auth',
      loginStarted: Boolean(ticket),
      json: JSON.stringify({
        ok: false,
        authRequired: true,
        identityRequired: reason === 'unbound',
        authState: status?.state ?? 'unbound',
        ...(write ? { writeRequested: true } : {}),
        ...(status?.message ? { reason: status.message } : {}),
        ...(autoConsentRecorded ? { readConsentRecorded: true } : {}),
        ...(ticket && write ? { writeConsentRecorded: true } : {}),
        ...(singleChat && ticket
          ? {
              loginUrl: ticket.verifyUrl,
              userCode: ticket.userCode,
              expiresInSeconds: Math.max(
                0,
                Math.ceil((ticket.expiresAt - this.now()) / 1000),
              ),
            }
          : {}),
        ...(!singleChat ? { authorizationSentPrivately: delivered } : {}),
        ...(failure ? { loginError: failure } : {}),
        instruction,
      }),
      userText,
    };
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
        '检索并读取钉钉文档与知识库，仅限于提问人本人有权限查看的内容。action=search 按关键词搜索，read/get 按 documentId 读取正文（长文可用 page 翻页），list 列出本人最近文档。找不到时可能只是无权访问，不要断言企业内不存在。',
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
          taskId: {
            type: 'string',
            description: '待办任务 ID（todo 的 get 使用）',
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

        const flags: DwsCommandRequest['flags'] = {};
        const query = optionalString(args, 'query');
        const userId = optionalString(args, 'userId');
        const date = optionalString(args, 'date');
        const taskId = optionalString(args, 'taskId');
        const instanceId = optionalString(args, 'instanceId');
        const processCode = optionalString(args, 'processCode');
        const start = optionalString(args, 'start');
        const end = optionalString(args, 'end');

        let subcommand = action;
        if (resource === 'calendar') {
          // CLI v1 的真实入口：event list / +today / +search-event / busy search
          if (action === 'today') {
            subcommand = '+today';
          } else if (action === 'list') {
            subcommand = 'event list';
            if (date) {
              flags.start = `${date}T00:00:00+08:00`;
              flags.end = `${date}T23:59:59+08:00`;
            }
            if (start) flags.start = start;
            if (end) flags.end = end;
          } else if (action === 'search') {
            if (!query) throw new Error('calendar 的 search 必须提供 query');
            subcommand = '+search-event';
            flags.query = query;
            if (start) flags.start = start;
            if (end) flags.end = end;
          } else if (action === 'freebusy') {
            if (!userId) throw new Error('calendar 的 freebusy 必须提供 userId');
            if (!start || !end) {
              throw new Error('calendar 的 freebusy 必须提供 start 与 end');
            }
            subcommand = 'busy search';
            flags.users = userId;
            flags.start = start;
            flags.end = end;
          }
        } else if (resource === 'todo') {
          // CLI v1 的真实入口：task list / task get / +due-today / +search
          if (action === 'today') {
            subcommand = '+due-today';
          } else if (action === 'list') {
            subcommand = 'task list';
            flags.status = 'false';
            flags['role-types'] = 'executor';
          } else if (action === 'search') {
            if (!query) throw new Error('todo 的 search 必须提供 query');
            subcommand = '+search';
            flags.query = query;
          } else if (action === 'get') {
            if (!taskId) throw new Error('todo 的 get 必须提供 taskId');
            subcommand = 'task get';
            flags['task-id'] = taskId;
          }
        } else {
          if (query) flags.query = query;
          if (userId) flags.user = userId;
          if (date) flags.date = date;
          if (instanceId) flags['instance-id'] = instanceId;
          if (processCode) flags['process-code'] = processCode;
          if (start) flags.start = start;
          if (end) flags.end = end;
        }

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
            subcommand,
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
        '创建或修改钉钉日程（写操作）。action=create 需要 title、start、end；action=update 需要 eventId 以及至少一个要修改的字段。时间为 ISO-8601，例如 2026-03-10T14:00:00+08:00。请直接调用本工具提交：已获本人写授权时系统会直接执行；不要只输出文字确认或编造已创建的结果。',
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
          true,
        );
      },
    };
  }

  private calendarCancelTool(): ToolDefinition {
    return {
      name: 'dws_calendar_cancel',
      description:
        '取消（删除）钉钉日程（高危写操作）。必须提供 eventId；可先用只读工具确认日程真实存在。请直接调用本工具提交：系统会登记为待确认动作并提示用户回复 /confirm；不要只输出文字确认或声称已取消。',
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
          true,
        );
      },
    };
  }

  private todoManageTool(): ToolDefinition {
    return {
      name: 'dws_todo_manage',
      description:
        '创建、修改或完成钉钉待办（写操作）。action=create 需要 title，executors 省略时默认指派给当前提问人；action=update 需要 taskId；action=complete 需要 taskId，status 默认 true。请直接调用本工具提交：已获本人写授权时系统会直接执行；不要只输出文字确认或编造待办 ID。',
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
            true,
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
            true,
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
            true,
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
        '邀请员工加入企业或修改员工组织信息（写操作）。action=invite 需要 orgUserName、orgUserMobile；action=update 需要 userId 以及至少一个修改项。部门用 deptIds 数字数组传入。请直接调用本工具提交：已获本人写授权时系统会直接执行；不要只输出文字确认。',
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
            true,
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
            true,
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
        '发起、同意或拒绝钉钉审批（写操作）。action=create 需要 processCode 与 formValues（表单字段对象）；action=approve/reject 需要 instanceId 与 taskId。发起前应先用只读工具查询表单 Schema。请直接调用本工具提交：已获本人写授权时系统会直接执行；不要只输出文字确认。',
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
            true,
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
            true,
          );
        }

        throw new Error(`action 只允许 create、approve 或 reject，收到: ${action}`);
      },
    };
  }

  private docManageTool(): ToolDefinition {
    return {
      name: 'dws_doc_manage',
      description:
        '创建钉钉在线文档，或向已有文档追加/覆盖 Markdown 内容（写操作）。action=create 需要 name 与 content，可选 folder（文件夹 nodeId）或 workspace（知识库 ID）；action=append 需要 documentId 与 content，只在文档末尾追加；action=overwrite 会清空原文，必须额外传 confirmOverwrite=true，并建议先用 dws_doc_search_and_read 备份正文。长内容自动写入临时文件传给 DWS。已获本人写授权时 create/append 会直接执行；overwrite 仍需用户回复 /confirm。不要只输出文字确认或编造文档链接。',
      risk: 'write',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'append', 'overwrite'],
            description: 'create 新建 / append 末尾追加 / overwrite 整篇覆盖（危险）',
          },
          name: { type: 'string', description: '文档标题，create 时必填' },
          documentId: {
            type: 'string',
            description: '文档 ID 或 URL，append/overwrite 时必填',
          },
          content: {
            type: 'string',
            description: 'Markdown 正文，最多 30000 字符',
          },
          folder: {
            type: 'string',
            description: '目标文件夹 nodeId，create 时可选',
          },
          workspace: {
            type: 'string',
            description: '目标知识库 ID，create 时可选',
          },
          confirmOverwrite: {
            type: 'boolean',
            description: 'overwrite 时必须显式传 true，表示确认清空原内容',
          },
        },
        required: ['action', 'content'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        const content = requireString(args, 'content', '文档内容');
        if (content.length > MAX_CONTENT_CHARS) {
          throw new Error(
            `文档内容过长（${content.length} 字符），请控制在 ${MAX_CONTENT_CHARS} 字符以内，可分段追加`,
          );
        }
        const name = optionalString(args, 'name');
        const documentId = optionalString(args, 'documentId');
        const folder = optionalString(args, 'folder');
        const workspace = optionalString(args, 'workspace');

        if (action === 'create') {
          if (!name) throw new Error('action=create 时必须提供 name');
          const flags: DwsCommandRequest['flags'] = {
            name,
            'content-format': 'markdown',
          };
          if (folder) flags.folder = folder;
          if (workspace) flags.workspace = workspace;
          return this.executeWithFile(
            ctx,
            'dws_doc_manage',
            {
              domain: 'doc',
              subcommand: 'create',
              flags,
              operatorStaffId: ctx.senderStaffId,
            },
            optionalPage(args),
            true,
            'content-file',
            content,
            'md',
          );
        }

        if (action !== 'append' && action !== 'overwrite') {
          throw new Error(
            `action 只允许 create、append 或 overwrite，收到: ${action}`,
          );
        }
        if (!documentId) {
          throw new Error(`action=${action} 时必须提供 documentId`);
        }
        const flags: DwsCommandRequest['flags'] = {
          node: documentId,
          mode: action,
          'content-format': 'markdown',
        };
        if (action === 'overwrite') {
          if (args.confirmOverwrite !== true) {
            throw new Error(
              'overwrite 会清空原文档，必须显式传 confirmOverwrite=true；如需保留原文请改用 append',
            );
          }
          flags.yes = true;
        }
        return this.executeWithFile(
          ctx,
          'dws_doc_manage',
          {
            domain: 'doc',
            subcommand: 'update',
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
          true,
          'content-file',
          content,
          'md',
        );
      },
    };
  }

  private reportReadTool(): ToolDefinition {
    return {
      name: 'dws_report_read',
      description:
        '只读查询钉钉日志（OA 周报应用）：templates 列出可用模版，template 读取模版字段，inbox 查我收到的日志，outbox 查我发出的日志，entry 读取单份正文，stats 读取已读统计，latest 读取我最近提交的日志。时间使用 ISO-8601（如 2026-03-10T00:00:00+08:00）；inbox 必须提供 start 与 end；outbox 查询跨度最多 20 天。提交日志请使用 dws_report_submit。',
      risk: 'read',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'templates',
              'template',
              'inbox',
              'outbox',
              'entry',
              'stats',
              'latest',
            ],
          },
          templateName: {
            type: 'string',
            description: '日志模版名称，action=template 时必填，outbox 可按它过滤',
          },
          reportId: {
            type: 'string',
            description: '日志 ID，action=entry/stats 时必填（来自 inbox/outbox）',
          },
          start: { type: 'string', description: '开始时间 ISO-8601' },
          end: { type: 'string', description: '结束时间 ISO-8601' },
          senderUserIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'inbox 按发送人过滤的 staffId 列表',
          },
          keyword: {
            type: 'string',
            description: 'action=latest 时按模版名称精确过滤',
          },
          cursor: {
            type: 'integer',
            minimum: 0,
            description: 'inbox/outbox 分页游标，首次传 0',
          },
          size: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'inbox/outbox 每页条数，最大 20',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '输出分页页码，默认 1',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        const templateName = optionalString(args, 'templateName');
        const reportId = optionalString(args, 'reportId');
        const start = optionalString(args, 'start');
        const end = optionalString(args, 'end');
        const keyword = optionalString(args, 'keyword');
        const senderUserIds = optionalStringList(
          args,
          'senderUserIds',
          '发送人',
        );
        const cursor = optionalInteger(args, 'cursor', '分页游标', 0, 1e9);
        const size = optionalInteger(args, 'size', '每页条数', 1, 20);
        const flags: DwsCommandRequest['flags'] = {};

        let subcommand: string;
        switch (action) {
          case 'templates':
            subcommand = 'template list';
            break;
          case 'template':
            if (!templateName) {
              throw new Error('action=template 时必须提供 templateName');
            }
            subcommand = 'template get';
            flags.name = templateName;
            break;
          case 'inbox':
            if (!start || !end) {
              throw new Error('action=inbox 时必须提供 start 与 end');
            }
            subcommand = 'inbox list';
            flags.start = start;
            flags.end = end;
            if (senderUserIds) {
              flags['sender-user-ids'] = senderUserIds.join(',');
            }
            if (cursor !== undefined) flags.cursor = cursor;
            if (size !== undefined) flags.size = size;
            break;
          case 'outbox':
            if ((start && !end) || (!start && end)) {
              throw new Error('action=outbox 的 start 与 end 必须同时提供');
            }
            subcommand = 'outbox list';
            if (start) flags.start = start;
            if (end) flags.end = end;
            if (templateName) flags['template-name'] = templateName;
            if (cursor !== undefined) flags.cursor = cursor;
            if (size !== undefined) flags.size = size;
            break;
          case 'entry':
          case 'stats':
            if (!reportId) {
              throw new Error(`action=${action} 时必须提供 reportId`);
            }
            subcommand = action === 'entry' ? 'entry get' : 'entry stats';
            flags['report-id'] = reportId;
            break;
          case 'latest':
            if ((start && !end) || (!start && end)) {
              throw new Error('action=latest 的 start 与 end 必须同时提供');
            }
            subcommand = '+report-latest';
            if (start) flags.start = start;
            if (end) flags.end = end;
            if (keyword) flags.keyword = keyword;
            break;
          default:
            throw new Error(
              `action 只允许 templates、template、inbox、outbox、entry、stats、latest，收到: ${action}`,
            );
        }

        return this.execute(
          ctx,
          'dws_report_read',
          {
            domain: 'report',
            subcommand,
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }

  private reportSubmitTool(): ToolDefinition {
    return {
      name: 'dws_report_submit',
      description:
        '按钉钉日志模版提交一份日报/周报（写操作）。先调用 dws_report_read 的 templates/template 取得 templateId 与字段定义；contents 中每项的 key 必须等于模版字段名，content 为字段正文；toUserIds 至少一个接收人，否则日志对任何人都不可见。请直接调用本工具提交：已获本人写授权时系统会直接执行；不要只输出文字确认或编造提交结果。',
      risk: 'write',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '日志模版 ID（来自 dws_report_read templates）',
          },
          contents: {
            type: 'array',
            description:
              '字段内容数组，每项至少包含 key 与 content，可选 sort/contentType/type，例如 [{"key":"今日完成","content":"..."}]',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: '模版字段名' },
                content: { type: 'string', description: '字段正文（Markdown）' },
                sort: { type: 'string', description: '排序值，默认按数组顺序' },
                contentType: {
                  type: 'string',
                  description: '内容类型，默认 markdown',
                },
                type: {
                  type: 'string',
                  description: '字段类型，默认 1',
                },
              },
              required: ['key', 'content'],
            },
          },
          toUserIds: {
            type: 'array',
            items: { type: 'string' },
            description: '日志接收人 userId 列表，至少一个',
          },
          toChat: {
            type: 'boolean',
            description: '是否同时发送到接收人单聊，默认 false',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '输出分页页码，默认 1',
          },
        },
        required: ['templateId', 'contents', 'toUserIds'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const templateId = requireString(args, 'templateId', '模版 ID');
        const toUserIds = optionalStringList(args, 'toUserIds', '接收人');
        if (!toUserIds || toUserIds.length === 0) {
          throw new Error('toUserIds 至少需要一个接收人 userId');
        }
        const rawContents = args.contents;
        if (!Array.isArray(rawContents) || rawContents.length === 0) {
          throw new Error('contents 必须是非空数组');
        }
        const contents = rawContents.map((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`contents[${index}] 必须是对象`);
          }
          const record = item as Record<string, unknown>;
          const key = typeof record.key === 'string' ? record.key.trim() : '';
          const content =
            typeof record.content === 'string' ? record.content : '';
          if (!key || !content.trim()) {
            throw new Error(`contents[${index}] 必须包含非空的 key 与 content`);
          }
          const sort =
            record.sort === undefined ? String(index) : String(record.sort);
          const contentType =
            typeof record.contentType === 'string' &&
            record.contentType.trim() !== ''
              ? record.contentType.trim()
              : 'markdown';
          const type =
            record.type === undefined ? '1' : String(record.type);
          return { key, sort, content, contentType, type };
        });
        const payload = JSON.stringify(contents);
        if (payload.length > MAX_CONTENT_CHARS * 4) {
          throw new Error('日志内容过长，请精简后再提交');
        }
        const flags: DwsCommandRequest['flags'] = {
          'template-id': templateId,
          'to-user-ids': toUserIds.join(','),
          yes: true,
        };
        if (args.toChat === true) flags['to-chat'] = true;

        return this.executeWithFile(
          ctx,
          'dws_report_submit',
          {
            domain: 'report',
            subcommand: 'entry submit',
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
          true,
          'contents-file',
          payload,
          'json',
        );
      },
    };
  }

  private aitableTool(): ToolDefinition {
    return {
      name: 'dws_aitable',
      description:
        '只读查询钉钉 AI 表格（多维表）：base_list/base_search 找 Base，base_get 看表目录，table_get 看字段与视图，field_get 展开字段配置，record_query 查记录（支持 filters/sort/keyword/recordIds），record_stats 做 COUNT/SUM/AVG 等标量统计，record_group_stats 做分组与 DISTINCT 统计。数值比较的过滤值必须是 JSON 数字；单选/多选过滤使用选项名称字面量。写记录请使用对应的企业 MCP 或 DWS 写工具。',
      risk: 'read',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'base_list',
              'base_search',
              'base_get',
              'table_get',
              'field_get',
              'record_query',
              'record_stats',
              'record_group_stats',
            ],
          },
          baseId: {
            type: 'string',
            description: 'Base ID（base_list/base_search 返回）',
          },
          tableId: {
            type: 'string',
            description: '数据表 ID（base_get/table_get 返回）',
          },
          tableIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'table_get 指定表 ID 列表，最多 10 个；省略返回全部表',
          },
          fieldIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'field_get 或 record_query 要返回的字段 ID，最多 100 个',
          },
          recordIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'record_query 按记录 ID 精准取数，最多 100 个',
          },
          query: {
            type: 'string',
            description: 'base_search 的关键词，或 record_query 的全文关键词',
          },
          cursor: { type: 'string', description: '分页游标，首次不传' },
          limit: {
            type: 'integer',
            minimum: 1,
            description: '返回条数：base_list 最大 10，record_query 最大 100，group_stats 最大 1000',
          },
          filters: {
            type: 'object',
            description:
              '结构化过滤 JSON，例如 {"operator":"and","operands":[{"operator":"eq","operands":["fldX","值"]}]}',
          },
          sort: {
            type: 'array',
            description:
              '排序 JSON 数组，例如 [{"fieldId":"fldX","direction":"desc"}]',
          },
          stats: {
            type: 'array',
            description:
              '统计项数组。record_stats 用大写 statsType（如 {"fieldId":"fldAmount","statsType":"SUM"}）；record_group_stats 用小写（如 sum、distinct）',
          },
          group: {
            type: 'array',
            description:
              '分组字段数组，用于 record_group_stats，例如 [{"fieldId":"fldCategory","direction":"ASC","arraySplitMode":true}]',
          },
          keyword: {
            type: 'string',
            description: 'record_stats 的全文关键词',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '输出分页页码，默认 1',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        const baseId = optionalString(args, 'baseId');
        const tableId = optionalString(args, 'tableId');
        const query = optionalString(args, 'query');
        const cursor = optionalString(args, 'cursor');
        const keyword = optionalString(args, 'keyword');
        const tableIds = optionalStringList(args, 'tableIds', '数据表 ID');
        const fieldIds = optionalStringList(args, 'fieldIds', '字段 ID');
        const recordIds = optionalStringList(args, 'recordIds', '记录 ID');
        const filters = optionalJsonFlag(args, 'filters', '过滤条件', 'object');
        const sort = optionalJsonFlag(args, 'sort', '排序条件', 'array');
        const stats = optionalJsonFlag(args, 'stats', '统计项', 'array');
        const group = optionalJsonFlag(args, 'group', '分组字段', 'array');
        const limit = optionalInteger(args, 'limit', '返回条数', 1, 1_000);

        for (const [name, value] of [
          ['tableIds', tableIds],
          ['fieldIds', fieldIds],
          ['recordIds', recordIds],
        ] as const) {
          if (value && value.length > 100) {
            throw new Error(`参数 ${name} 最多 100 项`);
          }
        }

        const flags: DwsCommandRequest['flags'] = {};
        const requireBase = () => {
          if (!baseId) throw new Error(`action=${action} 必须提供 baseId`);
          flags['base-id'] = baseId;
        };
        const requireTable = () => {
          if (!tableId) throw new Error(`action=${action} 必须提供 tableId`);
          flags['table-id'] = tableId;
        };

        let subcommand: string;
        switch (action) {
          case 'base_list':
            if (limit !== undefined && limit > 10) {
              throw new Error('base_list 的 limit 最大为 10');
            }
            subcommand = 'base list';
            if (limit !== undefined) flags.limit = limit;
            if (cursor) flags.cursor = cursor;
            break;
          case 'base_search':
            if (!query) {
              throw new Error('action=base_search 必须提供 query');
            }
            subcommand = 'base search';
            flags.query = query;
            if (cursor) flags.cursor = cursor;
            break;
          case 'base_get':
            requireBase();
            subcommand = 'base get';
            break;
          case 'table_get':
            requireBase();
            if (tableIds) {
              if (tableIds.length > 10) {
                throw new Error('table_get 的 tableIds 最多 10 个');
              }
              flags['table-ids'] = tableIds.join(',');
            }
            subcommand = 'table get';
            break;
          case 'field_get':
            requireBase();
            requireTable();
            if (fieldIds) flags['field-ids'] = fieldIds.join(',');
            subcommand = 'field get';
            break;
          case 'record_query': {
            requireBase();
            requireTable();
            if (limit !== undefined && limit > 100) {
              throw new Error('record_query 的 limit 最大为 100');
            }
            if (query) flags.query = query;
            if (fieldIds) flags['field-ids'] = fieldIds.join(',');
            if (recordIds) flags['record-ids'] = recordIds.join(',');
            if (filters) flags.filters = filters;
            if (sort) flags.sort = sort;
            if (limit !== undefined) flags.limit = limit;
            if (cursor) flags.cursor = cursor;
            subcommand = 'record query';
            break;
          }
          case 'record_stats':
            requireBase();
            requireTable();
            if (!stats) throw new Error('action=record_stats 必须提供 stats');
            flags.stats = stats;
            if (filters) flags.filters = filters;
            if (keyword) flags.keyword = keyword;
            if (sort) flags.sort = sort;
            if (limit !== undefined) flags.limit = limit;
            subcommand = 'record stats';
            break;
          case 'record_group_stats':
            requireBase();
            requireTable();
            if (!stats) {
              throw new Error('action=record_group_stats 必须提供 stats');
            }
            if (limit !== undefined && limit > 1_000) {
              throw new Error('record_group_stats 的 limit 最大为 1000');
            }
            flags.stats = stats;
            if (group) flags.group = group;
            if (filters) flags.filters = filters;
            if (sort) flags.sort = sort;
            if (limit !== undefined) flags.limit = limit;
            subcommand = 'record group-stats';
            break;
          default:
            throw new Error(
              `action 只允许 base_list、base_search、base_get、table_get、field_get、record_query、record_stats、record_group_stats，收到: ${action}`,
            );
        }

        return this.execute(
          ctx,
          'dws_aitable',
          {
            domain: 'aitable',
            subcommand,
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }

  private minutesTool(): ToolDefinition {
    return {
      name: 'dws_minutes',
      description:
        '只读查询钉钉 AI 听记（妙记）：list 按 mine/shared/all 列出听记，latest 取我最新一条，search 按标题关键词/时间搜索，info 看基础信息，summary 看 AI 摘要，transcript 看完整转写，keywords 看关键词，todos 看提取的待办，action_items 看行动项。先用 list/latest/search 拿到 taskUuid，再读取详情；转写较长时会分页。',
      risk: 'read',
      source: 'dws',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list',
              'latest',
              'search',
              'info',
              'summary',
              'transcript',
              'keywords',
              'todos',
              'action_items',
            ],
          },
          scope: {
            type: 'string',
            enum: ['mine', 'shared', 'all'],
            description: 'list/search 的范围，默认 list=mine、search=all',
          },
          id: {
            type: 'string',
            description:
              '听记 taskUuid；除 list/latest/search 外必填，action_items 可省略表示最新一条',
          },
          query: {
            type: 'string',
            description: 'search 的标题关键词；search 至少提供 query/start/end 之一',
          },
          keyword: {
            type: 'string',
            description: 'latest 的关键词过滤',
          },
          start: { type: 'string', description: '开始时间 ISO-8601' },
          end: { type: 'string', description: '结束时间 ISO-8601' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: '每页条数，默认 10',
          },
          cursor: { type: 'string', description: '分页 token，首页不传' },
          direction: {
            type: 'string',
            enum: ['0', '1'],
            description: 'transcript 排序：0 正序（默认），1 倒序',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '输出分页页码，默认 1',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const action = requireString(args, 'action', '操作');
        const scopeValue = optionalString(args, 'scope');
        const scope =
          scopeValue === 'mine' || scopeValue === 'shared' || scopeValue === 'all'
            ? scopeValue
            : undefined;
        if (scopeValue && !scope) {
          throw new Error('scope 只允许 mine、shared 或 all');
        }
        const id = optionalString(args, 'id');
        const query = optionalString(args, 'query');
        const keyword = optionalString(args, 'keyword');
        const start = optionalString(args, 'start');
        const end = optionalString(args, 'end');
        const cursor = optionalString(args, 'cursor');
        const direction = optionalString(args, 'direction');
        if (direction && direction !== '0' && direction !== '1') {
          throw new Error('direction 只允许 0 或 1');
        }
        const limit = optionalInteger(args, 'limit', '每页条数', 1, 100);
        const flags: DwsCommandRequest['flags'] = {};

        const requireId = () => {
          if (!id) {
            throw new Error(
              `action=${action} 必须提供 id（先用 list/latest/search 查询 taskUuid）`,
            );
          }
        };

        let subcommand: string;
        switch (action) {
          case 'list':
            subcommand = `list ${scope ?? 'mine'}`;
            if (query) flags.query = query;
            if (start) flags.start = start;
            if (end) flags.end = end;
            if (limit !== undefined) flags.limit = limit;
            if (cursor) flags.cursor = cursor;
            break;
          case 'latest':
            subcommand = '+latest';
            if (keyword) flags.keyword = keyword;
            break;
          case 'search':
            if (!query && !start && !end) {
              throw new Error(
                'action=search 至少提供 query、start、end 之一',
              );
            }
            subcommand = '+search';
            flags.scope = scope ?? 'all';
            if (query) flags.query = query;
            if (start) flags.start = start;
            if (end) flags.end = end;
            if (limit !== undefined) flags.limit = limit;
            if (cursor) flags.cursor = cursor;
            break;
          case 'info':
          case 'summary':
          case 'transcript':
          case 'keywords':
          case 'todos':
            requireId();
            subcommand =
              action === 'transcript' ? 'get transcription' : `get ${action}`;
            flags.id = id!;
            if (action === 'transcript' && direction) {
              flags.direction = direction;
            }
            break;
          case 'action_items':
            subcommand = '+action-items';
            if (id) flags.id = id;
            break;
          default:
            throw new Error(
              `action 只允许 list、latest、search、info、summary、transcript、keywords、todos、action_items，收到: ${action}`,
            );
        }

        return this.execute(
          ctx,
          'dws_minutes',
          {
            domain: 'minutes',
            subcommand,
            flags,
            operatorStaffId: ctx.senderStaffId,
          },
          optionalPage(args),
        );
      },
    };
  }
}
