import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  DwsAuthManager,
  interpretDwsAuthStatus,
  parseDeviceFlowOutput,
  type DwsAuthChild,
  type DwsStatusExecution,
} from './DwsAuthManager.js';

class FakeChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public killed = false;

  public kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

const DEVICE_OUTPUT = [
  '● Step 1: Requesting device authorization code...',
  '  link: https://login.dingtalk.com/oauth2/device/verify.htm',
  '  authorization code: HVSD-BJVT',
  '  Or open the following link:',
  '  https://login.dingtalk.com/oauth2/device/verify.htm?user_code=HVSD-BJVT',
  '  Authorization code will expire in 900 seconds.',
].join('\n');

const AUTHENTICATED: DwsStatusExecution = {
  exitCode: 0,
  stdout: JSON.stringify({
    success: true,
    authenticated: true,
    token_valid: true,
    refresh_token_valid: true,
    expires_at: '2026-10-30T19:07:39.581308+08:00',
    refresh_expires_at: '2026-11-29T17:07:39.581308+08:00',
    user_name: 'Joony',
    corp_name: 'demo',
  }),
  stderr: '',
};

const EXPIRED: DwsStatusExecution = {
  exitCode: 0,
  stdout: JSON.stringify({ success: true, authenticated: false }),
  stderr: '',
};

function statusSequence(sequence: DwsStatusExecution[]): {
  runStatus: () => Promise<DwsStatusExecution>;
  calls: () => number;
} {
  let index = 0;
  return {
    runStatus: async () => sequence[Math.min(index++, sequence.length - 1)],
    calls: () => index,
  };
}

function fakeSpawn(output = DEVICE_OUTPUT): {
  spawnLogin: () => DwsAuthChild;
  child: FakeChild;
  args: string[][];
} {
  const child = new FakeChild();
  const args: string[][] = [];
  return {
    spawnLogin: () => {
      args.push(['auth', 'login', '--device', '--no-browser']);
      setImmediate(() => child.stderr.emit('data', Buffer.from(output)));
      return child as unknown as DwsAuthChild;
    },
    child,
    args,
  };
}

describe('parseDeviceFlowOutput', () => {
  it('解析授权码并规范化验证链接', () => {
    expect(parseDeviceFlowOutput(DEVICE_OUTPUT)).toEqual({
      userCode: 'HVSD-BJVT',
      verifyUrl:
        'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=HVSD-BJVT',
    });
  });

  it('缺少授权码时返回 null', () => {
    expect(parseDeviceFlowOutput('waiting for user')).toBeNull();
  });

  it('分片输出累积后仍可解析', () => {
    const first = 'authorization code: ABCD-1234';
    expect(parseDeviceFlowOutput(first)?.userCode).toBe('ABCD-1234');
  });
});

describe('interpretDwsAuthStatus', () => {
  it('识别已授权状态', () => {
    const status = interpretDwsAuthStatus(AUTHENTICATED, 1);
    expect(status.state).toBe('authenticated');
    expect(status.userName).toBe('Joony');
    expect(status.corpName).toBe('demo');
  });

  it('authenticated=false 判定为过期', () => {
    const status = interpretDwsAuthStatus(EXPIRED, 1);
    expect(status.state).toBe('expired');
  });

  it('访问令牌过期但刷新令牌有效时仍视为可用', () => {
    const status = interpretDwsAuthStatus(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          authenticated: true,
          token_valid: false,
          refresh_token_valid: true,
        }),
        stderr: '',
      },
      1,
    );
    expect(status.state).toBe('authenticated');
  });

  it('CLI 缺失等非授权错误判定为不可用', () => {
    const status = interpretDwsAuthStatus(
      {
        exitCode: 127,
        stdout: '',
        stderr: 'dws CLI 不可用或未安装: spawn dws ENOENT',
      },
      1,
    );
    expect(status.state).toBe('unavailable');
    expect(status.message).toContain('ENOENT');
  });
});

describe('DwsAuthManager', () => {
  it('缓存授权状态，force 时重新检测', async () => {
    const sequence = statusSequence([AUTHENTICATED, EXPIRED]);
    const manager = new DwsAuthManager({
      runStatus: sequence.runStatus,
      statusTtlMs: 60_000,
      now: () => 1,
    });
    expect((await manager.status()).state).toBe('authenticated');
    expect((await manager.status()).state).toBe('authenticated');
    expect(sequence.calls()).toBe(1);
    expect((await manager.status({ force: true })).state).toBe('expired');
    expect(sequence.calls()).toBe(2);
  });

  it('状态检测抛错时降级为不可用', async () => {
    const manager = new DwsAuthManager({
      runStatus: async () => {
        throw new Error('boom');
      },
    });
    const status = await manager.status();
    expect(status.state).toBe('unavailable');
    expect(status.message).toContain('boom');
  });

  it('发起设备码登录后解析票据并在进程退出后判定成功', async () => {
    const sequence = statusSequence([AUTHENTICATED]);
    const fake = fakeSpawn();
    const manager = new DwsAuthManager({
      runStatus: sequence.runStatus,
      spawnLogin: fake.spawnLogin,
    });
    const success = new Promise<{ staffId: string }>((resolve) =>
      manager.on('login-success', resolve),
    );

    const ticket = await manager.startLogin({ startedBy: 'staff-1' });
    expect(ticket).toMatchObject({
      userCode: 'HVSD-BJVT',
      startedBy: 'staff-1',
    });
    expect(ticket.verifyUrl).toContain('user_code=HVSD-BJVT');

    fake.child.emit('exit', 0, null);
    const payload = await success;
    expect(payload.staffId).toBe('staff-1');
    expect(manager.activeLogin()).toBeNull();
  });

  it('授权进行中重复调用返回同一票据', async () => {
    const manager = new DwsAuthManager({
      runStatus: async () => AUTHENTICATED,
      spawnLogin: fakeSpawn().spawnLogin,
    });
    const [first, second] = await Promise.all([
      manager.startLogin({ startedBy: 'staff-1' }),
      manager.startLogin({ startedBy: 'staff-2' }),
    ]);
    expect(second.verifyUrl).toBe(first.verifyUrl);
    expect(second.startedBy).toBe('staff-1');
  });

  it('授权进程非零退出时发出失败事件', async () => {
    const fake = fakeSpawn();
    const manager = new DwsAuthManager({
      runStatus: async () => AUTHENTICATED,
      spawnLogin: fake.spawnLogin,
    });
    const failed = new Promise<{ reason: string }>((resolve) =>
      manager.on('login-failed', resolve),
    );
    await manager.startLogin({ startedBy: 'staff-1' });
    fake.child.emit('exit', 3, null);
    expect((await failed).reason).toContain('3');
  });

  it('待续跑会话保留 resume=true，并支持过期淘汰', async () => {
    let now = 1_000;
    const manager = new DwsAuthManager({
      runStatus: async () => AUTHENTICATED,
      now: () => now,
    });
    manager.markPending('conv-1', { resume: true });
    manager.markPending('conv-1', { resume: false });
    manager.markPending('conv-2', { resume: false });
    const pending = manager.takePending();
    expect(pending).toEqual([
      { conversationId: 'conv-1', resume: true },
      { conversationId: 'conv-2', resume: false },
    ]);

    manager.markPending('conv-3');
    now += 31 * 60_000;
    expect(manager.takePending()).toEqual([]);
  });
});
