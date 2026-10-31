import { execFile } from 'node:child_process';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';

export type DwsDomain = DwsCommandRequest['domain'];

/** 按域开放的子命令白名单；多段命令用空格连接，如 `event create`。 */
export const DWS_SUBCOMMAND_WHITELIST: Record<
  DwsDomain,
  readonly string[]
> = {
  doc: ['search', 'read', 'list', 'get'],
  wiki: ['search', 'read', 'list', 'get'],
  calendar: [
    'event list',
    '+today',
    '+week',
    '+search-event',
    'busy search',
    'event create',
    'event update',
    'event delete',
  ],
  todo: [
    'task list',
    'task get',
    '+today',
    '+due-today',
    '+overdue',
    '+search',
    'task create',
    'task update',
    'task done',
  ],
  contact: ['search', 'get', 'list', 'self', 'user invite', 'user update'],
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
    'create-instance',
    'approve',
    'reject',
    'revoke',
  ],
};

/** 部分域在 CLI 中的真实命令前缀与 domain 名不一致 */
const DOMAIN_COMMAND_PREFIX: Record<DwsDomain, readonly string[]> = {
  doc: ['doc'],
  wiki: ['wiki'],
  calendar: ['calendar'],
  todo: ['todo'],
  contact: ['contact'],
  approval: ['oa', 'approval'],
};

const DOMAINS = Object.keys(DWS_SUBCOMMAND_WHITELIST) as DwsDomain[];
const SUBCOMMAND_TOKEN_PATTERN = /^\+?[a-z][a-z0-9-]*$/i;
const FLAG_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const MAX_FLAG_VALUE_LENGTH = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export interface DwsCliRunnerOptions {
  binary?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DwsRunOptions {
  page?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DwsRunResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  page: number;
  totalPages: number;
  hasMore: boolean;
  timedOut: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把布尔/数字/字符串 flag 安全转换为 argv；绝不经过 shell 拼接。 */
export function buildDwsArgs(request: DwsCommandRequest): string[] {
  if (!DOMAINS.includes(request.domain)) {
    throw new Error(`不支持的 DWS 域: ${String(request.domain)}`);
  }
  const allowed = DWS_SUBCOMMAND_WHITELIST[request.domain];
  const tokens = request.subcommand
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (
    tokens.length === 0 ||
    tokens.some((token) => !SUBCOMMAND_TOKEN_PATTERN.test(token))
  ) {
    throw new Error(`非法的 DWS 子命令: "${request.subcommand}"`);
  }
  const subcommand = tokens.join(' ');
  if (!allowed.includes(subcommand)) {
    throw new Error(
      `DWS 子命令不在白名单内: ${request.domain} ${subcommand}（允许: ${allowed.join(', ')}）`,
    );
  }
  if (!request.operatorStaffId.trim()) {
    throw new Error('DWS 调用缺少 operatorStaffId');
  }

  const args = [...DOMAIN_COMMAND_PREFIX[request.domain], ...tokens];
  for (const [rawKey, value] of Object.entries(request.flags)) {
    const key = rawKey.trim();
    if (!FLAG_NAME_PATTERN.test(key)) {
      throw new Error(
        `非法的 DWS 参数名: "${rawKey}"（只允许字母开头，包含字母、数字与 -）`,
      );
    }
    if (typeof value === 'boolean') {
      if (value) args.push(`--${key}`);
      continue;
    }
    const text = String(value);
    if (text.includes('\0')) {
      throw new Error(`DWS 参数 ${key} 包含非法空字符`);
    }
    if (text.length > MAX_FLAG_VALUE_LENGTH) {
      throw new Error(`DWS 参数 ${key} 超过 ${MAX_FLAG_VALUE_LENGTH} 字符上限`);
    }
    args.push(`--${key}`, text);
  }
  return args;
}

/**
 * 受控的 DWS CLI 子进程执行器。
 * 只使用 execFile(binary, argsArray)，不拼接 shell；身份通过环境变量注入。
 */
export class DwsCliRunner {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly maxBuffer: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: DwsCliRunnerOptions = {}) {
    this.binary = options.binary ?? 'dws';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = Math.max(
      200,
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    );
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.env = options.env ?? process.env;
  }

  /** 身份透传：当前员工的 StaffId 通过环境变量交给 DWS CLI。 */
  public buildEnv(operatorStaffId: string): NodeJS.ProcessEnv {
    return {
      ...this.env,
      DWS_OPERATOR_STAFF_ID: operatorStaffId,
      DWS_OPERATOR_ID: operatorStaffId,
    };
  }

  public async run(
    request: DwsCommandRequest,
    options: DwsRunOptions = {},
  ): Promise<DwsRunResult> {
    const args = buildDwsArgs(request);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const execution = await this.execute(
      args,
      this.buildEnv(request.operatorStaffId),
      timeoutMs,
      options.signal,
    );

    const totalPages = Math.max(
      1,
      Math.ceil(execution.stdout.length / this.maxOutputChars),
    );
    const requestedPage = Number.isFinite(options.page)
      ? Math.floor(options.page as number)
      : 1;
    const page = Math.min(Math.max(requestedPage, 1), totalPages);
    const start = (page - 1) * this.maxOutputChars;
    const stdout = execution.stdout.slice(start, start + this.maxOutputChars);

    return {
      command: [this.binary, ...args],
      exitCode: execution.exitCode,
      stdout,
      stderr: execution.stderr,
      truncated: totalPages > 1,
      page,
      totalPages,
      hasMore: page < totalPages,
      timedOut: execution.timedOut,
    };
  }

  private execute(
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    return new Promise((resolve) => {
      execFile(
        this.binary,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: this.maxBuffer,
          env,
          encoding: 'utf8',
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, exitCode: 0, timedOut: false });
            return;
          }
          const failure = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
          };
          const missingBinary = failure.code === 'ENOENT';
          const timedOut =
            failure.killed === true || failure.signal === 'SIGTERM';
          const exitCode = missingBinary
            ? 127
            : timedOut
              ? 124
              : typeof failure.code === 'number'
                ? failure.code
                : 1;
          resolve({
            stdout,
            stderr: missingBinary
              ? `dws CLI 不可用或未安装: ${errorText(error)}`
              : stderr || errorText(error),
            exitCode,
            timedOut,
          });
        },
      );
    });
  }
}
