import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';
import type {
  DwsIdentityRecord,
  DwsIdentityStore,
} from '../../types/dws-identity.js';
import {
  interpretDwsAuthStatus,
  parseDeviceFlowOutput,
  type DwsAuthChild,
  type DwsAuthLogger,
  type DwsAuthStatus,
  type DwsLoginTicket,
  type DwsStatusExecution,
} from './DwsAuthManager.js';
import {
  DwsCliRunner,
  type DwsRunOptions,
  type DwsRunResult,
} from './DwsCliRunner.js';

export const DWS_CONSENT_VERSION = 1;
export const DWS_READ_SCOPES = [
  'calendar.read',
  'todo.read',
  'approval.read',
  'contact.read',
  'doc.read',
  'wiki.read',
] as const;
export const DWS_WRITE_SCOPES = [
  'calendar.write',
  'todo.write',
  'approval.write',
  'contact.write',
] as const;

export type DwsIdentityState = 'unbound' | DwsAuthStatus['state'];

export interface DwsIdentityStatus {
  state: DwsIdentityState;
  record: DwsIdentityRecord | null;
  token: DwsAuthStatus | null;
  message?: string;
  checkedAt: number;
}

export interface DwsIdentityExecution {
  profile: string;
  env: NodeJS.ProcessEnv;
}

export type DwsIdentityErrorCode =
  | 'consent-required'
  | 'unbound'
  | 'binding-mismatch'
  | 'login-failed';

export class DwsIdentityError extends Error {
  constructor(
    public readonly code: DwsIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DwsIdentityError';
  }
}

export interface DwsIdentityEventMap {
  'login-started': (payload: { staffId: string; ticket: DwsLoginTicket }) => void;
  'login-success': (payload: {
    staffId: string;
    status: DwsIdentityStatus;
  }) => void;
  'login-failed': (payload: { staffId: string; reason: string }) => void;
}

export interface DwsIdentityServiceOptions {
  store: DwsIdentityStore;
  runner?: DwsCliRunner;
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** 每个员工独立 DWS home 的根目录，默认 .state/dws-profiles */
  profileRoot?: string;
  /** 期望绑定的钉钉企业 corpId；配置后拒绝绑定其他组织账号 */
  corpId?: string;
  statusTtlMs?: number;
  loginTimeoutMs?: number;
  logger?: DwsAuthLogger;
  now?: () => number;
  runCommand?: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<DwsStatusExecution>;
  spawnLogin?: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => DwsAuthChild;
}

interface LoginSession {
  ticket: DwsLoginTicket | null;
  ticketPromise: Promise<DwsLoginTicket>;
  child: DwsAuthChild;
  finished: boolean;
  timers: NodeJS.Timeout[];
}

const DEFAULT_STATUS_TTL_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 900_000;
const DEVICE_CODE_TICKET_TIMEOUT_MS = 20_000;
const PENDING_TTL_MS = 30 * 60_000;
const HOME_NAME_PATTERN = /^u-[a-f0-9]{24}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const AUTH_FAILURE_HINT =
  /登录|授权|auth|token|expired|unauth|401|403|未登录|过期|失效/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

interface ProfileEntry {
  profile: string;
  corpId: string;
  corpName?: string;
  userId: string;
  userName?: string;
  isCurrent: boolean;
}

function parseProfiles(raw: string): ProfileEntry[] {
  const payload = parseJsonObject(raw);
  if (!payload) return [];
  const list = Array.isArray(payload.profiles)
    ? payload.profiles
    : Array.isArray(asRecord(payload.result)?.profiles)
      ? (asRecord(payload.result)!.profiles as unknown[])
      : [];
  const entries: ProfileEntry[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const corpId = asString(record.corpId);
    const userId = asString(record.userId);
    if (!corpId || !userId) continue;
    entries.push({
      profile: asString(record.profile) ?? `${corpId}:${userId}`,
      corpId,
      userId,
      isCurrent: record.isCurrent === true,
      ...(asString(record.corpName)
        ? { corpName: asString(record.corpName) }
        : {}),
      ...(asString(record.userName)
        ? { userName: asString(record.userName) }
        : {}),
    });
  }
  return entries;
}

export function formatDwsConsentText(
  record?: DwsIdentityRecord | null,
): string {
  const agreed =
    record && record.consentVersion === DWS_CONSENT_VERSION
      ? `当前状态：已同意（v${record.consentVersion}）${
          record.writeEnabled ? '，已允许写操作' : '，仅只读'
        }`
      : '当前状态：尚未同意';
  return [
    `DWS 个人授权说明（v${DWS_CONSENT_VERSION}）`,
    '为了用你本人的钉钉身份查询，而不是借用管理员账号，机器人需要在你本机单独完成一次设备码授权：',
    '- 只在你发起请求时使用你的身份，不会用于其他员工；',
    '- 默认只读范围：日程、待办、审批、通讯录、文档 / 知识库；',
    '- 令牌以 file-DEK 加密保存在独立目录，管理员无法查看令牌内容；',
    `- 发送 /dws-logout 会清除本机令牌；发送 /dws-consent revoke 会同时撤销同意。`,
    '',
    agreed,
    '',
    '同意只读范围：发送 `/dws-consent agree`',
    '额外允许写操作（建日程、建待办、发审批等）：发送 `/dws-consent write`',
    '改回只读：发送 `/dws-consent read`',
    '撤销同意并清除本地绑定：发送 `/dws-consent revoke`',
  ].join('\n');
}

/**
 * 每员工独立 DWS home 的身份与授权服务。
 * - 只从 staffId 推导目录，不接受调用方传入路径或 profile；
 * - 设备码登录后校验 profile 的 userId 与发起人一致，防止绑到别人的账号；
 * - 业务命令强制带 `--profile` 与该用户独立的环境变量。
 */
export class DwsIdentityService extends EventEmitter {
  private readonly store: DwsIdentityStore;
  private readonly runner: DwsCliRunner;
  private readonly binary: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly profileRoot: string;
  private readonly corpId?: string;
  private readonly statusTtlMs: number;
  private readonly loginTimeoutMs: number;
  private readonly logger?: DwsAuthLogger;
  private readonly now: () => number;
  private readonly runCommandFn: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<DwsStatusExecution>;
  private readonly spawnLoginFn: (
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => DwsAuthChild;
  private readonly statusCache = new Map<string, DwsIdentityStatus>();
  private readonly sessions = new Map<string, LoginSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<
    string,
    Map<string, { resume: boolean; createdAt: number }>
  >();

  constructor(options: DwsIdentityServiceOptions) {
    super();
    this.store = options.store;
    this.binary = options.binary ?? 'dws';
    this.baseEnv = options.baseEnv ?? process.env;
    this.profileRoot = resolve(
      options.profileRoot ??
        join(process.cwd(), '.state', 'dws-profiles'),
    );
    this.corpId = options.corpId?.trim() || undefined;
    this.statusTtlMs = options.statusTtlMs ?? DEFAULT_STATUS_TTL_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.runner =
      options.runner ??
      new DwsCliRunner({
        binary: this.binary,
        env: this.baseEnv,
        timeoutMs: 20_000,
        maxOutputChars: 2_000_000,
      });
    this.runCommandFn =
      options.runCommand ??
      ((args, env) =>
        new Promise<DwsStatusExecution>((resolveResult) => {
          execFile(
            this.binary,
            args,
            {
              env,
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
              encoding: 'utf8',
            },
            (error, stdout, stderr) => {
              if (!error) {
                resolveResult({ exitCode: 0, stdout, stderr });
                return;
              }
              const failure = error as NodeJS.ErrnoException;
              resolveResult({
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
      ((args, env) =>
        spawn(this.binary, args, {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as DwsAuthChild);
  }

  public override on<E extends keyof DwsIdentityEventMap>(
    event: E,
    listener: DwsIdentityEventMap[E],
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

  public async getRecord(staffId: string): Promise<DwsIdentityRecord | null> {
    return this.store.get(staffId);
  }

  public async hasCurrentConsent(staffId: string): Promise<boolean> {
    const record = await this.store.get(staffId);
    return record?.consentVersion === DWS_CONSENT_VERSION;
  }

  public async recordConsent(staffId: string): Promise<DwsIdentityRecord> {
    const record = await this.store.upsertConsent({
      staffId,
      consentVersion: DWS_CONSENT_VERSION,
      scopes: [...DWS_READ_SCOPES, ...DWS_WRITE_SCOPES],
      consentedAt: new Date(this.now()).toISOString(),
      homeDir: this.homeName(staffId),
    });
    this.invalidate(staffId);
    return record;
  }

  /**
   * 令牌问题自动触发：静默记录当前版本的只读同意，用户无需发送指令。
   * 写操作仍需显式授权；旧版本同意里的写权限不随自动续同意继承。
   */
  public async ensureReadConsent(staffId: string): Promise<DwsIdentityRecord> {
    const existing = await this.store.get(staffId);
    if (existing?.consentVersion === DWS_CONSENT_VERSION) return existing;
    let record = await this.store.upsertConsent({
      staffId,
      consentVersion: DWS_CONSENT_VERSION,
      scopes: [...DWS_READ_SCOPES],
      consentedAt: new Date(this.now()).toISOString(),
      homeDir: this.homeName(staffId),
    });
    if (existing?.writeEnabled) {
      record = await this.store.setWriteEnabled(staffId, false);
    }
    this.invalidate(staffId);
    return record;
  }

  public async setWriteEnabled(
    staffId: string,
    enabled: boolean,
  ): Promise<DwsIdentityRecord> {
    const record = await this.store.get(staffId);
    if (!record || record.consentVersion !== DWS_CONSENT_VERSION) {
      throw new DwsIdentityError(
        'consent-required',
        '请先发送 /dws-consent agree 同意只读授权范围。',
      );
    }
    const updated = await this.store.setWriteEnabled(staffId, enabled);
    this.invalidate(staffId);
    return updated;
  }

  public async status(
    staffId: string,
    options: { force?: boolean } = {},
  ): Promise<DwsIdentityStatus> {
    const at = this.now();
    const cached = this.statusCache.get(staffId);
    if (
      !options.force &&
      cached &&
      at - cached.checkedAt < this.statusTtlMs
    ) {
      return cached;
    }
    const record = await this.store.get(staffId);
    if (
      !record ||
      record.consentVersion !== DWS_CONSENT_VERSION ||
      !record.profile
    ) {
      const status: DwsIdentityStatus = {
        state: 'unbound',
        record,
        token: null,
        message: record
          ? record.consentVersion !== DWS_CONSENT_VERSION
            ? '授权范围已更新，需要重新同意后才可继续使用'
            : '已同意授权但尚未完成设备码登录'
          : '尚未同意个人 DWS 授权',
        checkedAt: at,
      };
      this.statusCache.set(staffId, status);
      return status;
    }
    const env = await this.envFor(staffId);
    const execution = await this.runCommandFn(
      ['auth', 'status', '-f', 'json', '--profile', record.profile],
      env,
    );
    const token = interpretDwsAuthStatus(execution, at);
    const status: DwsIdentityStatus = {
      state: token.state,
      record,
      token,
      checkedAt: at,
      ...(token.message ? { message: token.message } : {}),
    };
    this.statusCache.set(staffId, status);
    return status;
  }

  /**
   * 发起当前员工的设备码登录。必须已有当前版本的同意记录；
   * 同一员工同时只保留一个登录会话。
   */
  public async startLogin(staffId: string): Promise<DwsLoginTicket> {
    const record = await this.store.get(staffId);
    if (!record || record.consentVersion !== DWS_CONSENT_VERSION) {
      throw new DwsIdentityError(
        'consent-required',
        '请先在单聊发送 /dws-consent agree 同意授权范围。',
      );
    }
    const existing = this.sessions.get(staffId);
    if (existing) return existing.ticketPromise;

    const startedAt = this.now();
    const env = await this.envFor(staffId);
    const args = ['auth', 'login', '--device', '--no-browser'];
    if (this.corpId) args.push('--profile', this.corpId);
    let child: DwsAuthChild;
    try {
      child = this.spawnLoginFn(args, env);
    } catch (error) {
      throw new DwsIdentityError('login-failed', errorText(error));
    }

    let resolveTicket!: (ticket: DwsLoginTicket) => void;
    let rejectTicket!: (error: Error) => void;
    const ticketPromise = new Promise<DwsLoginTicket>((resolvePromise, reject) => {
      resolveTicket = resolvePromise;
      rejectTicket = reject;
    });
    ticketPromise.catch(() => undefined);

    const session: LoginSession = {
      ticket: null,
      ticketPromise,
      child,
      finished: false,
      timers: [],
    };
    this.sessions.set(staffId, session);

    let buffer = '';
    const finish = (error?: Error): void => {
      if (session.finished) return;
      session.finished = true;
      for (const timer of session.timers) clearTimeout(timer);
      if (this.sessions.get(staffId) === session) {
        this.sessions.delete(staffId);
      }
      if (error) {
        rejectTicket(error);
        this.logger?.warn?.({ staffId, reason: error.message }, 'dws identity login failed');
        this.emit('login-failed', { staffId, reason: error.message });
        return;
      }
      void this.verifyAndBind(staffId)
        .then((status) => {
          this.logger?.info?.(
            { staffId, user: status.record?.userName, profile: status.record?.profile },
            'dws identity login succeeded',
          );
          this.emit('login-success', { staffId, status });
        })
        .catch((cause: unknown) => {
          const reason = errorText(cause);
          this.logger?.warn?.({ staffId, reason }, 'dws identity binding rejected');
          this.emit('login-failed', { staffId, reason });
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
        startedBy: staffId,
      };
      session.ticket = ticket;
      resolveTicket(ticket);
      this.emit('login-started', { staffId, ticket });
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
      this.cancelLogin(staffId);
      finish(new Error('等待 DWS 授权码超时'));
    }, DEVICE_CODE_TICKET_TIMEOUT_MS);
    const expireTimer = setTimeout(() => {
      this.cancelLogin(staffId);
      finish(new Error('DWS 授权码已过期，请重新发起'));
    }, this.loginTimeoutMs);
    codeTimer.unref();
    expireTimer.unref();
    session.timers.push(codeTimer, expireTimer);

    return ticketPromise;
  }

  public cancelLogin(staffId: string): void {
    const session = this.sessions.get(staffId);
    if (!session) return;
    try {
      session.child.kill('SIGTERM');
    } catch {
      // 进程可能已退出
    }
  }

  /** 清除该员工的本地 DWS 登录态，保留同意记录。 */
  public async logout(staffId: string): Promise<boolean> {
    const record = await this.store.get(staffId);
    this.cancelLogin(staffId);
    if (!record?.profile) {
      await this.store.unbind(staffId);
      this.invalidate(staffId);
      await this.wipeHome(staffId);
      return false;
    }
    const env = await this.envFor(staffId);
    await this.runCommandFn(
      ['auth', 'logout', '--yes', '--profile', record.profile],
      env,
    ).catch(() => undefined);
    await this.store.unbind(staffId);
    this.invalidate(staffId);
    await this.wipeHome(staffId);
    return true;
  }

  /** 撤销同意与绑定，并删除本机加密凭据目录。 */
  public async revokeConsent(staffId: string): Promise<void> {
    await this.logout(staffId).catch(() => undefined);
    await this.store.remove(staffId);
    this.invalidate(staffId);
    await this.wipeHome(staffId);
  }

  public async executionFor(
    staffId: string,
  ): Promise<DwsIdentityExecution | null> {
    const record = await this.store.get(staffId);
    if (
      !record ||
      record.consentVersion !== DWS_CONSENT_VERSION ||
      !record.profile ||
      !PROFILE_PATTERN.test(record.profile)
    ) {
      return null;
    }
    const env = await this.envFor(staffId);
    return { profile: record.profile, env };
  }

  public async run(
    staffId: string,
    request: DwsCommandRequest,
    options: DwsRunOptions = {},
  ): Promise<DwsRunResult> {
    const execution = await this.executionFor(staffId);
    if (!execution) {
      throw new DwsIdentityError(
        'unbound',
        '当前钉钉账号尚未完成个人 DWS 授权',
      );
    }
    const previous = this.queues.get(staffId) ?? Promise.resolve();
    const task = previous.then(() =>
      this.runner.run(request, {
        ...options,
        env: execution.env,
        profile: execution.profile,
      }),
    );
    this.queues.set(
      staffId,
      task.catch(() => undefined),
    );
    return task;
  }

  public isAuthFailure(text: string): boolean {
    return AUTH_FAILURE_HINT.test(text);
  }

  public invalidate(staffId: string): void {
    this.statusCache.delete(staffId);
  }

  public markPending(
    staffId: string,
    conversationId: string,
    options: { resume?: boolean } = {},
  ): void {
    if (!staffId || !conversationId) return;
    const entries = this.pending.get(staffId) ?? new Map();
    const existing = entries.get(conversationId);
    entries.set(conversationId, {
      resume: existing?.resume || (options.resume ?? true),
      createdAt: this.now(),
    });
    this.pending.set(staffId, entries);
  }

  public takePending(
    staffId: string,
  ): Array<{ conversationId: string; resume: boolean }> {
    const entries = this.pending.get(staffId);
    if (!entries) return [];
    this.pending.delete(staffId);
    const at = this.now();
    return [...entries.entries()]
      .filter(([, meta]) => at - meta.createdAt <= PENDING_TTL_MS)
      .map(([conversationId, meta]) => ({
        conversationId,
        resume: meta.resume,
      }));
  }

  public dispose(): void {
    for (const staffId of [...this.sessions.keys()]) this.cancelLogin(staffId);
    this.pending.clear();
    this.statusCache.clear();
    this.queues.clear();
    this.removeAllListeners();
  }

  private async verifyAndBind(staffId: string): Promise<DwsIdentityStatus> {
    const env = await this.envFor(staffId);
    const execution = await this.runCommandFn(
      ['profile', 'list', '-f', 'json'],
      env,
    );
    const profiles = parseProfiles(execution.stdout);
    const previous = await this.store.get(staffId);
    const expectedCorp = this.corpId ?? previous?.corpId ?? undefined;
    const byUser = profiles.filter((entry) => entry.userId === staffId);
    const candidates = expectedCorp
      ? byUser.filter((entry) => entry.corpId === expectedCorp)
      : byUser;
    const match =
      candidates.find((entry) => entry.isCurrent) ?? candidates[0];
    if (!match) {
      await this.wipeHome(staffId);
      const seen = byUser.length
        ? byUser.map((entry) => `${entry.userName ?? entry.userId}@${entry.corpName ?? entry.corpId}`).join('、')
        : '未发现可用账号';
      throw new DwsIdentityError(
        'binding-mismatch',
        `授权账号与当前钉钉账号不一致（${seen}），已取消绑定。请确认使用本人钉钉完成授权。`,
      );
    }
    await this.store.bind({
      staffId,
      corpId: match.corpId,
      dwsUserId: match.userId,
      profile: match.profile,
      userName: match.userName ?? null,
      corpName: match.corpName ?? null,
    });
    this.invalidate(staffId);
    return this.status(staffId, { force: true });
  }

  private homeName(staffId: string): string {
    return `u-${createHash('sha256').update(staffId).digest('hex').slice(0, 24)}`;
  }

  private async ensureHome(staffId: string): Promise<string> {
    const record = await this.store.get(staffId);
    const name =
      record?.homeDir && HOME_NAME_PATTERN.test(record.homeDir)
        ? record.homeDir
        : this.homeName(staffId);
    const dir = join(this.profileRoot, name);
    const configDir = join(dir, 'config');
    const dataDir = join(dir, 'data');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    await chmod(configDir, 0o700).catch(() => undefined);
    await chmod(dataDir, 0o700).catch(() => undefined);
    return dir;
  }

  private async envFor(staffId: string): Promise<NodeJS.ProcessEnv> {
    const dir = await this.ensureHome(staffId);
    return {
      ...this.baseEnv,
      DWS_CONFIG_DIR: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
      DWS_DISABLE_KEYCHAIN: '1',
    };
  }

  private async wipeHome(staffId: string): Promise<void> {
    const record = await this.store.get(staffId);
    const name =
      record?.homeDir && HOME_NAME_PATTERN.test(record.homeDir)
        ? record.homeDir
        : this.homeName(staffId);
    await rm(join(this.profileRoot, name), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}
