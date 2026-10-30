import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/core.js';
import type {
  DwsAuthChild,
  DwsStatusExecution,
} from './DwsAuthManager.js';
import { DwsAuthManager } from './DwsAuthManager.js';
import { DwsCliToolProvider } from './DwsCliToolProvider.js';
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
const EXPIRED: DwsStatusExecution = {
  exitCode: 0,
  stdout: JSON.stringify({ authenticated: false }),
  stderr: '',
};

function statusSequence(
  sequence: DwsStatusExecution[],
): () => Promise<DwsStatusExecution> {
  let index = 0;
  return async () => sequence[Math.min(index++, sequence.length - 1)];
}

function fakeSpawn(): () => DwsAuthChild {
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
  return () => child as unknown as DwsAuthChild;
}

function fakeRunner(result: DwsRunResult): {
  runner: DwsCliRunner;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const runner = {
    run: async (request: Record<string, unknown>) => {
      calls.push(request);
      return result;
    },
  } as unknown as DwsCliRunner;
  return { runner, calls };
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

describe('DwsCliToolProvider 授权闸门', () => {
  it('管理员遇到过期授权时发起设备码登录并提醒当前会话', async () => {
    const { runner, calls } = fakeRunner(succeeded());
    const auth = new DwsAuthManager({
      runStatus: async () => EXPIRED,
      spawnLogin: fakeSpawn(),
    });
    const provider = new DwsCliToolProvider({
      runner,
      auth,
      isAdmin: () => true,
    });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      ok: boolean;
      authRequired: boolean;
      loginUrl: string;
      userCode: string;
    };

    expect(calls).toHaveLength(0);
    expect(output.ok).toBe(false);
    expect(output.authRequired).toBe(true);
    expect(output.userCode).toBe('HVSD-BJVT');
    expect(output.loginUrl).toContain('user_code=HVSD-BJVT');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('DWS 授权已过期');
    expect(notes[0]).toContain('HVSD-BJVT');
  });

  it('同一会话短时间内重复调用只提示一次', async () => {
    const { runner } = fakeRunner(succeeded());
    const auth = new DwsAuthManager({
      runStatus: async () => EXPIRED,
      spawnLogin: fakeSpawn(),
    });
    const provider = new DwsCliToolProvider({
      runner,
      auth,
      isAdmin: () => true,
    });
    const { ctx, notes } = context();

    await runDocTool(provider, ctx);
    await runDocTool(provider, ctx);
    expect(notes).toHaveLength(1);
  });

  it('非管理员不发起登录，只提示联系管理员', async () => {    const { runner, calls } = fakeRunner(succeeded());
    const auth = new DwsAuthManager({
      runStatus: async () => EXPIRED,
      spawnLogin: () => {
        throw new Error('非管理员不应触发登录');
      },
    });
    const provider = new DwsCliToolProvider({
      runner,
      auth,
      isAdmin: () => false,
    });
    const { ctx, notes } = context({
      senderStaffId: 'staff-2',
      conversationType: '2',
    });

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      authRequired: boolean;
      loginUrl?: string;
    };

    expect(calls).toHaveLength(0);
    expect(output.authRequired).toBe(true);
    expect(output.loginUrl).toBeUndefined();
    expect(notes[0]).toContain('联系管理员');
  });

  it('授权有效时正常执行 DWS 工具', async () => {
    const { runner, calls } = fakeRunner(succeeded());
    const auth = new DwsAuthManager({
      runStatus: async () => AUTHENTICATED,
    });
    const provider = new DwsCliToolProvider({ runner, auth });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      ok: boolean;
    };

    expect(output.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(notes).toHaveLength(0);
  });

  it('执行阶段才发现授权过期时同样弹出重新授权提示', async () => {
    const failed: DwsRunResult = {
      ...succeeded(),
      exitCode: 3,
      stdout: '',
      stderr: 'token expired, please login again',
    };
    const { runner } = fakeRunner(failed);
    const auth = new DwsAuthManager({
      runStatus: statusSequence([AUTHENTICATED, EXPIRED]),
      spawnLogin: fakeSpawn(),
    });
    const provider = new DwsCliToolProvider({
      runner,
      auth,
      isAdmin: () => true,
    });
    const { ctx, notes } = context();

    const output = JSON.parse(await runDocTool(provider, ctx)) as {
      authRequired: boolean;
    };
    expect(output.authRequired).toBe(true);
    expect(notes[0]).toContain('HVSD-BJVT');
  });

  it('未配置授权管理器时保持原有行为', async () => {
    const { runner, calls } = fakeRunner(succeeded());
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
