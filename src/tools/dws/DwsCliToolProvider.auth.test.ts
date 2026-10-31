import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/core.js';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';
import type { DwsIdentityRecord } from '../../types/dws-identity.js';
import type {
  DwsIdentityService,
  DwsIdentityState,
  DwsIdentityStatus,
} from './DwsIdentityService.js';
import { DwsCliToolProvider } from './DwsCliToolProvider.js';
import type { DwsCliRunner, DwsRunResult } from './DwsCliRunner.js';

const TICKET = {
  verifyUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=HVSD-BJVT',
  userCode: 'HVSD-BJVT',
  expiresAt: Date.now() + 15 * 60_000,
};

function identityRecord(
  overrides: Partial<DwsIdentityRecord> = {},
): DwsIdentityRecord {
  const at = new Date(0).toISOString();
  return {
    staffId: 'staff-1',
    consentVersion: 1,
    consentedAt: at,
    scopes: [],
    writeEnabled: false,
    homeDir: 'u-0123456789abcdef01234567',
    corpId: 'ding-corp',
    dwsUserId: 'staff-1',
    profile: 'ding-corp:staff-1',
    userName: '张三',
    corpName: '测试企业',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function succeeded(text = '{"doc":1}'): DwsRunResult {
  return {
    command: ['dws', 'doc', 'list'],
    exitCode: 0,
    stdout: text,
    stderr: '',
    truncated: false,
    page: 1,
    totalPages: 1,
    hasMore: false,
    timedOut: false,
  };
}

interface FakeIdentityOptions {
  record?: DwsIdentityRecord | null;
  states?: DwsIdentityState[];
  runResult?: DwsRunResult;
  startFails?: boolean;
}

function fakeIdentity(options: FakeIdentityOptions = {}): {
  identity: DwsIdentityService;
  calls: {
    runs: DwsCommandRequest[];
    ensureReadConsent: number;
    startLogin: number;
    pending: Array<{ staffId: string; conversationId: string }>;
  };
} {
  const record = options.record === undefined ? null : options.record;
  const states = [...(options.states ?? [record ? 'authenticated' : 'unbound'])];
  const calls = {
    runs: [] as DwsCommandRequest[],
    ensureReadConsent: 0,
    startLogin: 0,
    pending: [] as Array<{ staffId: string; conversationId: string }>,
  };
  const nextState = (): DwsIdentityState =>
    states.length > 1 ? states.shift()! : states[0]!;
  const status = async (): Promise<DwsIdentityStatus> => {
    const state = nextState();
    return {
      state,
      record,
      token:
        state === 'authenticated' || state === 'expired'
          ? {
              state: state === 'expired' ? 'expired' : 'authenticated',
              authenticated: state === 'authenticated',
              tokenValid: state === 'authenticated',
              refreshTokenValid: state === 'authenticated',
              checkedAt: Date.now(),
            }
          : null,
      checkedAt: Date.now(),
      ...(state === 'expired' ? { message: 'DWS 登录已过期，需要重新授权' } : {}),
    };
  };
  const service = {
    getRecord: async () => record,
    status,
    ensureReadConsent: async () => {
      calls.ensureReadConsent += 1;
      return record ?? identityRecord({ profile: null, corpId: null, dwsUserId: null });
    },
    startLogin: async () => {
      calls.startLogin += 1;
      if (options.startFails) throw new Error('无法启动授权进程');
      return TICKET;
    },
    markPending: (staffId: string, conversationId: string) => {
      calls.pending.push({ staffId, conversationId });
    },
    run: async (_staffId: string, request: DwsCommandRequest) => {
      calls.runs.push(request);
      return options.runResult ?? succeeded();
    },
    isAuthFailure: (text: string) => /expired|token|授权/i.test(text),
    invalidate: () => undefined,
  };
  return { identity: service as unknown as DwsIdentityService, calls };
}

function legacyRunner(result: DwsRunResult): {
  runner: DwsCliRunner;
  calls: DwsCommandRequest[];
} {
  const calls: DwsCommandRequest[] = [];
  const runner = {
    run: async (request: DwsCommandRequest) => {
      calls.push(request);
      return result;
    },
  } as unknown as DwsCliRunner;
  return { runner, calls };
}

function context(overrides: Partial<ExecutionContext> = {}): {
  ctx: ExecutionContext;
  notes: string[];
} {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      conversationType: '1',
      deadlineAt: Date.now() + 30_000,
      now: Date.now,
      notify: async (text) => {
        notes.push(text);
      },
      ...overrides,
    },
  };
}

async function runDocTool(
  provider: DwsCliToolProvider,
  ctx: ExecutionContext,
): Promise<string> {
  const tools = await provider.getTools(ctx);
  const tool = tools.find((item) => item.name === 'dws_doc_search_and_read');
  if (!tool) throw new Error('doc tool missing');
  return tool.execute({ target: 'doc', action: 'list' }, ctx);
}

async function runCalendarCreate(
  provider: DwsCliToolProvider,
  ctx: ExecutionContext,
): Promise<string> {
  const tools = await provider.getTools(ctx);
  const tool = tools.find((item) => item.name === 'dws_calendar_manage');
  if (!tool) throw new Error('calendar tool missing');
  return tool.execute(
    {
      action: 'create',
      title: '评审',
      start: '2026-11-02T10:00:00+08:00',
      end: '2026-11-02T11:00:00+08:00',
    },
    ctx,
  );
}

describe('DwsCliToolProvider 每员工独立身份闸门', () => {
  it('未授权时自动记录只读同意发起登录并让用户直接点链接授权', async () => {
    const { identity, calls } = fakeIdentity();
    const provider = new DwsCliToolProvider({ identity });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      ok: boolean;
      authRequired: boolean;
      identityRequired: boolean;
      readConsentRecorded: boolean;
      loginUrl: string;
      userCode: string;
      instruction: string;
    };

    expect(calls.runs).toHaveLength(0);
    expect(calls.ensureReadConsent).toBe(1);
    expect(calls.startLogin).toBe(1);
    expect(calls.pending).toEqual([
      { staffId: 'staff-1', conversationId: 'conv-1' },
    ]);
    expect(output.ok).toBe(false);
    expect(output.authRequired).toBe(true);
    expect(output.identityRequired).toBe(true);
    expect(output.readConsentRecorded).toBe(true);
    expect(output.userCode).toBe('HVSD-BJVT');
    expect(output.loginUrl).toContain('user_code=HVSD-BJVT');
    expect(output.instruction).not.toContain('/dws-consent');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('HVSD-BJVT');
    expect(notes[0]).not.toContain('/dws-login');
  });

  it('授权过期时在单聊自动发起本人设备码登录', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord(),
      states: ['expired'],
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      ok: boolean;
      authRequired: boolean;
      loginUrl: string;
      userCode: string;
    };

    expect(calls.runs).toHaveLength(0);
    expect(calls.startLogin).toBe(1);
    expect(calls.pending).toEqual([{ staffId: 'staff-1', conversationId: 'conv-1' }]);
    expect(output.ok).toBe(false);
    expect(output.authRequired).toBe(true);
    expect(output.userCode).toBe('HVSD-BJVT');
    expect(output.loginUrl).toContain('user_code=HVSD-BJVT');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('HVSD-BJVT');
  });

  it('同一会话短时间内重复过期调用只提示一次', async () => {
    const { identity } = fakeIdentity({
      record: identityRecord(),
      states: ['expired'],
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx, notes } = context();

    await runDocTool(provider, ctx);
    await runDocTool(provider, ctx);
    expect(notes).toHaveLength(1);
  });

  it('群聊授权过期时自动发起登录并只私聊发送链接', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord(),
      states: ['expired'],
    });
    const privateNotes: string[] = [];
    const provider = new DwsCliToolProvider({
      identity,
      personalNotifier: (staffId, text) => {
        privateNotes.push(`${staffId}|${text}`);
        return true;
      },
    });
    const { ctx, notes } = context({ conversationType: '2' });

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      authRequired: boolean;
      loginUrl?: string;
      userCode?: string;
      authorizationSentPrivately: boolean;
      instruction: string;
    };

    expect(calls.startLogin).toBe(1);
    expect(calls.pending).toEqual([
      { staffId: 'staff-1', conversationId: 'conv-1' },
    ]);
    expect(output.authRequired).toBe(true);
    expect(output.loginUrl).toBeUndefined();
    expect(output.userCode).toBeUndefined();
    expect(output.authorizationSentPrivately).toBe(true);
    expect(output.instruction).toContain('私聊');
    expect(output.instruction).not.toContain('/dws-login');
    expect(privateNotes).toHaveLength(1);
    expect(privateNotes[0]).toContain('staff-1|');
    expect(privateNotes[0]).toContain('HVSD-BJVT');
    expect(notes).toHaveLength(0);
  });

  it('群聊重复触发时不重复私聊发送链接', async () => {
    const { identity } = fakeIdentity({
      record: identityRecord(),
      states: ['expired'],
    });
    const privateNotes: string[] = [];
    const provider = new DwsCliToolProvider({
      identity,
      personalNotifier: (_staffId, text) => {
        privateNotes.push(text);
        return true;
      },
    });
    const { ctx } = context({ conversationType: '2' });

    await runDocTool(provider, ctx);
    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      authorizationSentPrivately: boolean;
    };
    expect(privateNotes).toHaveLength(1);
    expect(output.authorizationSentPrivately).toBe(true);
  });

  it('群聊且无法私聊时不回传授权链接或命令', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord(),
      states: ['expired'],
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx } = context({ conversationType: '2' });

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      authRequired: boolean;
      loginUrl?: string;
      userCode?: string;
      authorizationSentPrivately: boolean;
      instruction: string;
    };

    expect(calls.startLogin).toBe(1);
    expect(output.authRequired).toBe(true);
    expect(output.loginUrl).toBeUndefined();
    expect(output.userCode).toBeUndefined();
    expect(output.authorizationSentPrivately).toBe(false);
    expect(output.instruction).not.toContain('/dws-login');
    expect(output.instruction).not.toContain('HVSD-BJVT');
  });

  it('授权有效时使用本人身份执行只读工具', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord(),
      states: ['authenticated'],
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      ok: boolean;
    };

    expect(output.ok).toBe(true);
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0]?.operatorStaffId).toBe('staff-1');
    expect(notes).toHaveLength(0);
  });

  it('只读授权拒绝写工具并提示单独授权', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord({ writeEnabled: false }),
      states: ['authenticated'],
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx } = context();

    const output = JSON.parse(await runCalendarCreate(provider, ctx)) as {
      ok: boolean;
      writeConsentRequired: boolean;
      instruction: string;
    };

    expect(calls.runs).toHaveLength(0);
    expect(output.ok).toBe(false);
    expect(output.writeConsentRequired).toBe(true);
    expect(output.instruction).toContain('/dws-consent write');
  });

  it('额外授权写操作后执行写工具', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord({ writeEnabled: true }),
      states: ['authenticated'],
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx } = context();

    const output = JSON.parse(await runCalendarCreate(provider, ctx)) as {
      ok: boolean;
    };

    expect(output.ok).toBe(true);
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0]?.subcommand).toBe('event create');
  });

  it('执行阶段才发现授权过期时同样弹出重新授权', async () => {
    const { identity, calls } = fakeIdentity({
      record: identityRecord(),
      states: ['authenticated', 'expired'],
      runResult: {
        ...succeeded(),
        exitCode: 3,
        stdout: '',
        stderr: 'token expired, please login again',
      },
    });
    const provider = new DwsCliToolProvider({ identity });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      authRequired: boolean;
    };

    expect(calls.runs).toHaveLength(1);
    expect(output.authRequired).toBe(true);
    expect(notes[0]).toContain('HVSD-BJVT');
  });

  it('未配置身份服务时保持原有 runner 行为', async () => {
    const { runner, calls } = legacyRunner(succeeded());
    const provider = new DwsCliToolProvider({ runner });
    const { ctx, notes } = context();
    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      ok: boolean;
    };
    expect(output.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(notes).toHaveLength(0);
  });
});
