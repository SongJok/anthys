import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type DwsAuthState = 'authenticated' | 'expired' | 'unavailable';

export interface DwsAuthStatus {
  state: DwsAuthState;
  authenticated: boolean;
  tokenValid: boolean;
  refreshTokenValid: boolean;
  expiresAt?: string;
  refreshExpiresAt?: string;
  userName?: string;
  corpName?: string;
  /** 过期/不可用时的可读原因 */
  message?: string;
  checkedAt: number;
}

export interface DwsLoginTicket {
  userCode: string;
  verifyUrl: string;
  startedAt: number;
  expiresAt: number;
  startedBy: string;
}

export interface DwsAuthLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn?(obj: Record<string, unknown>, msg: string): void;
}

export interface DwsAuthChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface DwsStatusExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DwsAuthManagerOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  /** dws auth status 超时，默认 5s */
  statusTimeoutMs?: number;
  /** 授权状态缓存时长，默认 60s */
  statusTtlMs?: number;
  /** 设备码有效期，默认 15 分钟（与钉钉设备授权一致） */
  loginTimeoutMs?: number;
  logger?: DwsAuthLogger;
  now?: () => number;
  runStatus?: (args: string[]) => Promise<DwsStatusExecution>;
  spawnLogin?: (args: string[]) => DwsAuthChild;
}

export interface DwsAuthEventMap {
  'login-started': (ticket: DwsLoginTicket) => void;
  'login-success': (payload: { staffId: string; status: DwsAuthStatus }) => void;
  'login-failed': (payload: { staffId: string; reason: string }) => void;
}

const DEFAULT_STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_STATUS_TTL_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 900_000;
const DEVICE_CODE_TICKET_TIMEOUT_MS = 20_000;
const PENDING_TTL_MS = 30 * 60_000;
const DEFAULT_VERIFY_URL = 'https://login.dingtalk.com/oauth2/device/verify.htm';
const AUTH_ERROR_HINT =
  /登录|授权|auth|token|expired|unauth|401|403|未登录|过期|失效/i;

const DEVICE_CODE_PATTERN = /authorization code:\s*([A-Za-z0-9]{4,8}-[A-Za-z0-9]{4,8})/i;
const VERIFY_URL_PATTERN = /(https:\/\/[^\s"'<>]*oauth2\/device\/verify\.htm[^\s"'<>]*)/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从设备授权流程输出里解析授权码与验证链接（dws 输出到 stderr）。 */
export function parseDeviceFlowOutput(
  text: string,
): { userCode: string; verifyUrl: string } | null {
  const code = text.match(DEVICE_CODE_PATTERN);
  if (!code) return null;
  const userCode = code[1].toUpperCase();
  const base = (text.match(VERIFY_URL_PATTERN)?.[1] ?? DEFAULT_VERIFY_URL).split(
    '?',
  )[0];
  return {
    userCode,
    verifyUrl: `${base}?user_code=${encodeURIComponent(userCode)}`,
  };
}

/** 把 `dws auth status -f json` 的结果归一化为三态。 */
export function interpretDwsAuthStatus(
  execution: DwsStatusExecution,
  checkedAt: number,
): DwsAuthStatus {
  const payload = parseJsonObject(execution.stdout);
  if (payload) {
    const authenticated = asBool(payload.authenticated);
    const tokenValid = asBool(payload.token_valid);
    const refreshTokenValid = asBool(payload.refresh_token_valid);
    if (authenticated || tokenValid || refreshTokenValid) {
      const expired = !tokenValid && !refreshTokenValid;
      return {
        state: expired ? 'expired' : 'authenticated',
        authenticated,
        tokenValid,
        refreshTokenValid,
        ...(asString(payload.expires_at)
          ? { expiresAt: asString(payload.expires_at) }
          : {}),
        ...(asString(payload.refresh_expires_at)
          ? { refreshExpiresAt: asString(payload.refresh_expires_at) }
          : {}),
        ...(asString(payload.user_name)
          ? { userName: asString(payload.user_name) }
          : {}),
        ...(asString(payload.corp_name)
          ? { corpName: asString(payload.corp_name) }
          : {}),
        ...(expired ? { message: 'DWS 登录已过期，需要重新授权' } : {}),
        checkedAt,
      };
    }
    return {
      state: 'expired',
      authenticated: false,
      tokenValid: false,
      refreshTokenValid: false,
      ...(asString(payload.message)
        ? { message: asString(payload.message) }
        : {}),
      checkedAt,
    };
  }

  const detail = (execution.stderr || execution.stdout || '').trim();
  if (AUTH_ERROR_HINT.test(detail)) {
    return {
      state: 'expired',
      authenticated: false,
      tokenValid: false,
      refreshTokenValid: false,
      message: detail.slice(0, 300),
      checkedAt,
    };
  }
  return {
    state: 'unavailable',
    authenticated: false,
    tokenValid: false,
    refreshTokenValid: false,
    message: `无法获取 DWS 授权状态${detail ? `：${detail.slice(0, 300)}` : ''}`,
    checkedAt,
  };
}

interface LoginSession {
  ticket: DwsLoginTicket | null;
  ticketPromise: Promise<DwsLoginTicket>;
  startedBy: string;
  child: DwsAuthChild;
  finished: boolean;
  timers: NodeJS.Timeout[];
}

/**
 * DWS CLI 授权状态与设备码登录管理。
 * 只负责“是否过期 / 发起设备授权 / 何时完成”，不负责消息投递。
 */
export class DwsAuthManager extends EventEmitter {
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly statusTimeoutMs: number;
  private readonly statusTtlMs: number;
  private readonly loginTimeoutMs: number;
  private readonly logger?: DwsAuthLogger;
  private readonly now: () => number;
  private readonly runStatusFn: (args: string[]) => Promise<DwsStatusExecution>;
  private readonly spawnLoginFn: (args: string[]) => DwsAuthChild;
  private statusCache: DwsAuthStatus | null = null;
  private session: LoginSession | null = null;
  private readonly pending = new Map<
    string,
    { resume: boolean; createdAt: number }
  >();

  constructor(options: DwsAuthManagerOptions = {}) {
    super();
    this.binary = options.binary ?? 'dws';
    this.env = options.env ?? process.env;
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    this.statusTtlMs = options.statusTtlMs ?? DEFAULT_STATUS_TTL_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.runStatusFn =
      options.runStatus ??
      ((args) =>
        new Promise<DwsStatusExecution>((resolve) => {
          execFile(
            this.binary,
            args,
            {
              env: this.env,
              timeout: this.statusTimeoutMs,
              maxBuffer: 1024 * 1024,
              encoding: 'utf8',
            },
            (error, stdout, stderr) => {
              if (!error) {
                resolve({ exitCode: 0, stdout, stderr });
                return;
              }
              const failure = error as NodeJS.ErrnoException;
              resolve({
                exitCode:
                  failure.code === 'ENOENT'
                    ? 127
                    : typeof failure.code === 'number'
                      ? failure.code
                      : 1,
                stdout: stdout ?? '',
                stderr:
                  failure.code === 'ENOENT'
                    ? `dws CLI 不可用或未安装: ${errorText(error)}`
                    : stderr || errorText(error),
              });
            },
          );
        }));
    this.spawnLoginFn =
      options.spawnLogin ??
      ((args) =>
        spawn(this.binary, args, {
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as DwsAuthChild);
  }

  public override on<E extends keyof DwsAuthEventMap>(
    event: E,
    listener: DwsAuthEventMap[E],
  ): this;
  public override on(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this;
  public override on(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this {
    return super.on(event, listener);
  }

  /** 读取授权状态（默认缓存 60s，force 时强制刷新）。 */
  public async status(
    options: { force?: boolean } = {},
  ): Promise<DwsAuthStatus> {
    const at = this.now();
    if (
      !options.force &&
      this.statusCache &&
      at - this.statusCache.checkedAt < this.statusTtlMs
    ) {
      return this.statusCache;
    }
    let result: DwsAuthStatus;
    try {
      const execution = await this.runStatusFn(['auth', 'status', '-f', 'json']);
      result = interpretDwsAuthStatus(execution, at);
    } catch (error) {
      result = {
        state: 'unavailable',
        authenticated: false,
        tokenValid: false,
        refreshTokenValid: false,
        message: `无法获取 DWS 授权状态：${errorText(error)}`,
        checkedAt: at,
      };
    }
    this.statusCache = result;
    return result;
  }

  public activeLogin(): DwsLoginTicket | null {
    return this.session?.ticket ?? null;
  }

  /**
   * 发起设备码授权，返回可展示给用户的授权码与链接。
   * 同一时间只允许一个授权会话，重复调用复用进行中的票据。
   */
  public startLogin(input: { startedBy: string }): Promise<DwsLoginTicket> {
    if (this.session) return this.session.ticketPromise;

    const startedAt = this.now();
    let child: DwsAuthChild;
    try {
      child = this.spawnLoginFn(['auth', 'login', '--device', '--no-browser']);
    } catch (error) {
      return Promise.reject(error);
    }

    let resolveTicket!: (ticket: DwsLoginTicket) => void;
    let rejectTicket!: (error: Error) => void;
    const ticketPromise = new Promise<DwsLoginTicket>((resolve, reject) => {
      resolveTicket = resolve;
      rejectTicket = reject;
    });
    // 调用方可能只关心事件，避免未处理的 rejection
    ticketPromise.catch(() => undefined);

    const session: LoginSession = {
      ticket: null,
      ticketPromise,
      startedBy: input.startedBy,
      child,
      finished: false,
      timers: [],
    };
    this.session = session;

    let buffer = '';
    const finish = (error?: Error): void => {
      if (session.finished) return;
      session.finished = true;
      for (const timer of session.timers) clearTimeout(timer);
      if (this.session === session) this.session = null;
      if (error) {
        rejectTicket(error);
        this.logger?.warn?.(
          { staffId: session.startedBy, reason: error.message },
          'dws device login failed',
        );
        this.emit('login-failed', {
          staffId: session.startedBy,
          reason: error.message,
        });
        return;
      }
      void this.status({ force: true }).then((status) => {
        if (status.state === 'authenticated') {
          this.logger?.info?.(
            { staffId: session.startedBy, user: status.userName },
            'dws device login succeeded',
          );
          this.emit('login-success', {
            staffId: session.startedBy,
            status,
          });
          return;
        }
        const reason = status.message ?? '授权未生效，请重试';
        this.emit('login-failed', { staffId: session.startedBy, reason });
      });
    };

    const scan = (chunk: string): void => {
      buffer += chunk;
      if (session.ticket) return;
      const parsed = parseDeviceFlowOutput(buffer);
      if (!parsed) return;
      const ticket: DwsLoginTicket = {
        ...parsed,
        startedAt,
        expiresAt: startedAt + this.loginTimeoutMs,
        startedBy: input.startedBy,
      };
      session.ticket = ticket;
      resolveTicket(ticket);
      this.emit('login-started', ticket);
    };

    child.stderr?.on('data', (data: Buffer | string) => scan(String(data)));
    child.stdout?.on('data', (data: Buffer | string) => scan(String(data)));
    child.on('error', (error: Error) => finish(error));
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          signal
            ? `DWS 授权进程被终止（${signal}）`
            : `DWS 授权进程退出码 ${code ?? 'unknown'}`,
        ),
      );
    });

    const codeTimer = setTimeout(() => {
      if (session.ticket) return;
      this.cancel();
      finish(new Error('等待 DWS 授权码超时'));
    }, DEVICE_CODE_TICKET_TIMEOUT_MS);
    const expireTimer = setTimeout(() => {
      this.cancel();
      finish(new Error('DWS 授权码已过期，请重新发起'));
    }, this.loginTimeoutMs);
    codeTimer.unref();
    expireTimer.unref();
    session.timers.push(codeTimer, expireTimer);

    return ticketPromise;
  }

  public cancel(): void {
    const session = this.session;
    if (!session) return;
    try {
      session.child.kill('SIGTERM');
    } catch {
      // 进程可能已退出
    }
  }

  /** 记录“授权完成后需要续跑”的会话；默认续跑上一条问题。 */
  public markPending(
    conversationId: string,
    options: { resume?: boolean } = {},
  ): void {
    if (!conversationId) return;
    const existing = this.pending.get(conversationId);
    this.pending.set(conversationId, {
      // 一旦登记过“续跑原始问题”，后续手动 /dws-login 不应降级为仅通知
      resume: existing?.resume || (options.resume ?? true),
      createdAt: this.now(),
    });
  }

  public takePending(): Array<{ conversationId: string; resume: boolean }> {
    const at = this.now();
    const entries = [...this.pending.entries()];
    this.pending.clear();
    return entries
      .filter(([, meta]) => at - meta.createdAt <= PENDING_TTL_MS)
      .map(([conversationId, meta]) => ({
        conversationId,
        resume: meta.resume,
      }));
  }

  public clearPending(): void {
    this.pending.clear();
  }

  public invalidateStatus(): void {
    this.statusCache = null;
  }

  public dispose(): void {
    this.cancel();
    this.pending.clear();
    this.statusCache = null;
    this.removeAllListeners();
  }
}
