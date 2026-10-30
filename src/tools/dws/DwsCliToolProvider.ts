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

const DOC_TARGETS = ['doc', 'wiki'] as const;
const DOC_ACTIONS = ['search', 'read', 'list', 'get'] as const;
const ORG_RESOURCES = ['contact', 'calendar', 'todo', 'approval'] as const;
const ORG_ACTIONS = ['search', 'get', 'list', 'self', 'today', 'freebusy'] as const;

type DocTarget = (typeof DOC_TARGETS)[number];
type DocAction = (typeof DOC_ACTIONS)[number];
type OrgResource = (typeof ORG_RESOURCES)[number];
type OrgAction = (typeof ORG_ACTIONS)[number];

export interface DwsCliToolProviderOptions {
  runner?: DwsCliRunner;
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

  constructor(options: DwsCliToolProviderOptions = {}) {
    this.runner = options.runner ?? new DwsCliRunner();
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [this.docTool(), this.orgTool()];
  }

  private async execute(
    ctx: ExecutionContext,
    request: DwsCommandRequest,
    page: number,
  ): Promise<string> {
    const remaining = ctx.deadlineAt - ctx.now();
    if (remaining <= 0) {
      throw new Error('执行已超时，无法调用 DWS');
    }
    const result = await this.runner.run(request, {
      page,
      timeoutMs: Math.min(15_000, remaining),
    });
    return formatResult(request, result);
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
