import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type {
  DwsBindingInput,
  DwsConsentInput,
  DwsIdentityRecord,
  DwsIdentityStore,
} from '../../types/dws-identity.js';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';
import type {
  DwsAuthChild,
  DwsStatusExecution,
} from './DwsAuthManager.js';
import { DwsIdentityError, DwsIdentityService } from './DwsIdentityService.js';
import type { DwsCliRunner, DwsRunResult } from './DwsCliRunner.js';

const DEVICE_OUTPUT = [
  '  link: https://login.dingtalk.com/oauth2/device/verify.htm',
  '  authorization code: HVSD-BJVT',
].join('\n');

const AUTHENTICATED: DwsStatusExecution = {
  exitCode: 0,
  stdout: JSON.stringify({ authenticated: true, token_valid: true }),
  stderr: '',
};

class MemoryStore implements DwsIdentityStore {
  private readonly records = new Map<string, DwsIdentityRecord>();

  async get(staffId: string): Promise<DwsIdentityRecord | null> {
    return this.records.get(staffId) ?? null;
  }

  async list(): Promise<DwsIdentityRecord[]> {
    return [...this.records.values()];
  }

  async upsertConsent(input: DwsConsentInput): Promise<DwsIdentityRecord> {
    const at = new Date().toISOString();
    const existing = this.records.get(input.staffId);
    const record: DwsIdentityRecord = {
      staffId: input.staffId,
      consentVersion: input.consentVersion,
      consentedAt: input.consentedAt,
      scopes: input.scopes,
      writeEnabled: existing?.writeEnabled ?? false,
      homeDir: input.homeDir,
      corpId: existing?.corpId ?? null,
      dwsUserId: existing?.dwsUserId ?? null,
      profile: existing?.profile ?? null,
      userName: existing?.userName ?? null,
      corpName: existing?.corpName ?? null,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.records.set(input.staffId, record);
    return record;
  }

  async setWriteEnabled(
    staffId: string,
    enabled: boolean,
  ): Promise<DwsIdentityRecord> {
    const record = this.records.get(staffId);
    if (!record) throw new Error('missing');
    const updated = { ...record, writeEnabled: enabled };
    this.records.set(staffId, updated);
    return updated;
  }

  async bind(input: DwsBindingInput): Promise<DwsIdentityRecord> {
    const record = this.records.get(input.staffId);
    if (!record) throw new Error('missing');
    const updated: DwsIdentityRecord = {
      ...record,
      corpId: input.corpId,
      dwsUserId: input.dwsUserId,
      profile: input.profile,
      userName: input.userName ?? null,
      corpName: input.corpName ?? null,
    };
    this.records.set(input.staffId, updated);
    return updated;
  }

  async unbind(staffId: string): Promise<void> {
    const record = this.records.get(staffId);
    if (!record) return;
    this.records.set(staffId, {
      ...record,
      corpId: null,
      dwsUserId: null,
      profile: null,
      userName: null,
      corpName: null,
    });
  }

  async remove(staffId: string): Promise<boolean> {
    return this.records.delete(staffId);
  }
}

function fakeSpawn(): {
  spawn: (args: string[], env: NodeJS.ProcessEnv) => DwsAuthChild;
  calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    spawn: (args, env) => {
      calls.push({ args, env });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() =>
        child.stderr.emit('data', Buffer.from(DEVICE_OUTPUT)),
      );
      return child as unknown as DwsAuthChild;
    },
  };
}

function fakeRunner(): {
  runner: DwsCliRunner;
  calls: Array<{ request: DwsCommandRequest; options: Record<string, unknown> }>;
} {
  const calls: Array<{
    request: DwsCommandRequest;
    options: Record<string, unknown>;
  }> = [];
  const runner = {
    run: async (request: DwsCommandRequest, options: Record<string, unknown>) => {
      calls.push({ request, options });
      const result: DwsRunResult = {
        command: ['dws'],
        exitCode: 0,
        stdout: '{}',
        stderr: '',
        truncated: false,
        page: 1,
        totalPages: 1,
        hasMore: false,
        timedOut: false,
      };
      return result;
    },
  } as unknown as DwsCliRunner;
  return { runner, calls };
}

function service(options: {
  store?: MemoryStore;
  profiles?: string;
  spawn?: ReturnType<typeof fakeSpawn>;
  runner?: ReturnType<typeof fakeRunner>;
  runCommand?: (args: string[]) => DwsStatusExecution;
} = {}): {
  service: DwsIdentityService;
  store: MemoryStore;
  spawnCalls: ReturnType<typeof fakeSpawn>;
  runnerCalls: ReturnType<typeof fakeRunner>;
} {
  const store = options.store ?? new MemoryStore();
  const spawnCalls = options.spawn ?? fakeSpawn();
  const runnerCalls = options.runner ?? fakeRunner();
  const profiles = options.profiles ?? JSON.stringify({
    profiles: [
      {
        profile: 'ding-corp:staff-1',
        corpId: 'ding-corp',
        corpName: '测试企业',
        userId: 'staff-1',
        userName: '张三',
        isCurrent: true,
      },
    ],
  });
  const instance = new DwsIdentityService({
    store,
    runner: runnerCalls.runner,
    profileRoot: join(
      tmpdir(),
      `dws-identity-${Math.random().toString(16).slice(2)}`,
    ),
    corpId: 'ding-corp',
    runCommand: async (args) =>
      args[0] === 'profile'
        ? { exitCode: 0, stdout: profiles, stderr: '' }
        : options.runCommand?.(args) ?? AUTHENTICATED,
    spawnLogin: spawnCalls.spawn,
  });
  return { service: instance, store, spawnCalls, runnerCalls };
}

async function login(staffId: string, instance: DwsIdentityService) {
  const ticket = await instance.startLogin(staffId);
  const success = new Promise<{ staffId: string; status: unknown }>(
    (resolve, reject) => {
      instance.once('login-success', resolve as never);
      instance.once('login-failed', ({ reason }) => reject(new Error(reason)));
    },
  );
  const session = (instance as unknown as {
    sessions: Map<string, { child: EventEmitter }>;
  }).sessions.get(staffId);
  session?.child.emit('exit', 0, null);
  return { ticket, success: await success };
}

describe('DwsIdentityService', () => {
  it('同意时写入版本、只读+写范围与独立的 home', async () => {
    const { service: instance, store } = service();
    const record = await instance.recordConsent('staff-1');
    expect(record.consentVersion).toBe(1);
    expect(record.homeDir).toMatch(/^u-[a-f0-9]{24}$/);
    expect(record.scopes).toContain('calendar.read');
    expect(record.writeEnabled).toBe(false);
    expect(await store.get('staff-1')).toMatchObject({ profile: null });
  });

  it('未同意时拒绝发起设备码登录', async () => {
    const { service: instance } = service();
    await expect(instance.startLogin('staff-1')).rejects.toMatchObject({
      code: 'consent-required',
    });
  });

  it('自动续同意只记录只读范围并清除旧写权限', async () => {
    const { service: instance, store } = service();
    const first = await instance.ensureReadConsent('staff-1');
    expect(first.consentVersion).toBe(1);
    expect(first.scopes.every((scope) => scope.endsWith('.read'))).toBe(true);
    expect(first.writeEnabled).toBe(false);
    const again = await instance.ensureReadConsent('staff-1');
    expect(again.consentedAt).toBe(first.consentedAt);

    await store.upsertConsent({
      staffId: 'staff-2',
      consentVersion: 0,
      scopes: ['calendar.write'],
      consentedAt: new Date(0).toISOString(),
      homeDir: 'u-0123456789abcdef01234567',
    });
    await store.setWriteEnabled('staff-2', true);
    const refreshed = await instance.ensureReadConsent('staff-2');
    expect(refreshed.consentVersion).toBe(1);
    expect(refreshed.writeEnabled).toBe(false);
    expect(refreshed.scopes).not.toContain('calendar.write');
  });

  it('设备码登录后校验 userId 一致并绑定', async () => {
    const { service: instance, store, spawnCalls } = service();
    await instance.recordConsent('staff-1');
    const { ticket, success } = await login('staff-1', instance);
    expect(ticket.userCode).toBe('HVSD-BJVT');
    expect(spawnCalls.calls[0]?.args).toEqual([
      'auth',
      'login',
      '--device',
      '--no-browser',
      '--profile',
      'ding-corp',
    ]);
    const env = spawnCalls.calls[0]?.env ?? {};
    expect(env.DWS_DISABLE_KEYCHAIN).toBe('1');
    expect(env.DWS_CONFIG_DIR).toContain('config');
    expect(env.XDG_DATA_HOME).toContain('data');
    expect(success.staffId).toBe('staff-1');

    const record = await store.get('staff-1');
    expect(record?.profile).toBe('ding-corp:staff-1');
    expect(record?.dwsUserId).toBe('staff-1');
    expect(record?.userName).toBe('张三');
  });

  it('CLI 授权完成后非零退出仍按 profile 落地绑定', async () => {
    const { service: instance, store } = service();
    await instance.recordConsent('staff-1');
    const ticket = await instance.startLogin('staff-1');
    expect(ticket.userCode).toBe('HVSD-BJVT');
    const success = new Promise<{ staffId: string }>((resolve, reject) => {
      instance.once('login-success', resolve as never);
      instance.once('login-failed', ({ reason }) => reject(new Error(reason)));
    });
    const session = (instance as unknown as {
      sessions: Map<string, { child: EventEmitter }>;
    }).sessions.get('staff-1');
    session?.child.emit('exit', 2, null);
    await expect(success).resolves.toMatchObject({ staffId: 'staff-1' });
    expect((await store.get('staff-1'))?.profile).toBe('ding-corp:staff-1');
  });

  it('授权账号与发起人不一致时拒绝绑定', async () => {    const profiles = JSON.stringify({
      profiles: [
        {
          profile: 'ding-corp:someone-else',
          corpId: 'ding-corp',
          userId: 'someone-else',
          isCurrent: true,
        },
      ],
    });
    const { service: instance, store } = service({ profiles });
    await instance.recordConsent('staff-1');
    const failure = new Promise<{ reason: string }>((resolve) => {
      instance.once('login-failed', resolve as never);
    });
    await instance.startLogin('staff-1');
    const session = (instance as unknown as {
      sessions: Map<string, { child: EventEmitter }>;
    }).sessions.get('staff-1');
    session?.child.emit('exit', 0, null);
    const event = await failure;
    expect(event.reason).toContain('不一致');
    expect((await store.get('staff-1'))?.profile).toBeNull();
  });

  it('未绑定时拒绝执行业务命令', async () => {
    const { service: instance } = service();
    await expect(
      instance.run('staff-1', {
        domain: 'doc',
        subcommand: 'list',
        flags: {},
        operatorStaffId: 'staff-1',
      }),
    ).rejects.toBeInstanceOf(DwsIdentityError);
  });

  it('执行业务命令时注入本人 profile 与独立环境变量', async () => {
    const { service: instance, runnerCalls, store } = service();
    await instance.recordConsent('staff-1');
    await login('staff-1', instance);
    const result = await instance.run(
      'staff-1',
      {
        domain: 'doc',
        subcommand: 'list',
        flags: {},
        operatorStaffId: 'staff-1',
      },
      { page: 2 },
    );
    expect(result.exitCode).toBe(0);
    const call = runnerCalls.calls.at(-1);
    expect(call?.options.profile).toBe('ding-corp:staff-1');
    const env = call?.options.env as NodeJS.ProcessEnv;
    expect(env.DWS_DISABLE_KEYCHAIN).toBe('1');
    expect((await store.get('staff-1'))?.profile).toBe('ding-corp:staff-1');
  });

  it('写授权需要先同意，登出保留同意但清除绑定', async () => {
    const { service: instance, store } = service();
    await expect(instance.setWriteEnabled('staff-1', true)).rejects.toMatchObject({
      code: 'consent-required',
    });
    await instance.recordConsent('staff-1');
    await login('staff-1', instance);
    const updated = await instance.setWriteEnabled('staff-1', true);
    expect(updated.writeEnabled).toBe(true);

    await instance.logout('staff-1');
    const record = await store.get('staff-1');
    expect(record?.profile).toBeNull();
    expect(record?.consentVersion).toBe(1);
  });
});
