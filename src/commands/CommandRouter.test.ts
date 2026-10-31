import { describe, expect, it } from 'vitest';
import { CommandRouter, parseCommand, type CommandRuntime } from './CommandRouter.js';
import type { InboundMessage } from '../types/core.js';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '/help',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

function runtime(overrides: Partial<CommandRuntime> = {}): {
  router: CommandRouter;
  replies: string[];
  calls: Record<string, unknown[]>;
} {
  const replies: string[] = [];
  const calls: Record<string, unknown[]> = {
    stop: [],
    retry: [],
    reset: [],
    mute: [],
    feedback: [],
    remind: [],
    reports: [],
  };
  const base: CommandRuntime = {
    isAdmin: () => true,
    stopRun: (cid) => {
      calls.stop.push(cid);
      return 1;
    },
    retryLast: async (cid) => {
      calls.retry.push(cid);
      return 'started';
    },
    resetConversation: async (msg) => {
      calls.reset.push(msg.messageId);
    },
    status: () => '模型：openai / gpt-4o',
    lastTrace: async () => '最近一次执行：刚刚',
    dwsStatus: () => 'DWS 授权：已授权',
    dwsLogin: async () => '已发起 DWS 设备授权。',
    setMuted: async (cid, muted) => {
      calls.mute.push([cid, muted]);
    },
    recordFeedback: async (input) => {
      calls.feedback.push(input);
    },
    confirmAction: async () => '已执行写操作。',
    cancelAction: async () => '已取消待确认的操作。',
    remind: async (msg, args) => {
      calls.remind.push([msg.messageId, args]);
      return '已设置提醒。';
    },
    reports: async (msg, args) => {
      calls.reports.push([msg.messageId, args]);
      return '已创建定时报告。';
    },
    reply: async (_message, text) => {
      replies.push(text);
    },
    ...overrides,
  };
  return { router: new CommandRouter(base), replies, calls };
}

describe('parseCommand', () => {
  it('支持半角/全角斜杠与参数', () => {
    expect(parseCommand('  /feedback 回答不准  ')).toEqual({
      name: 'feedback',
      args: ['回答不准'],
      raw: '/feedback 回答不准',
    });
    expect(parseCommand('／stop')?.name).toBe('stop');
    expect(parseCommand('你好 /stop')).toBeNull();
  });
});

describe('CommandRouter', () => {
  it('普通文本不拦截', async () => {
    const { router } = runtime();
    expect(await router.tryHandle(message({ text: '你好' }))).toBe(false);
  });

  it('/help /status /trace 返回文本', async () => {
    const { router, replies } = runtime();
    await router.tryHandle(message({ text: '/help' }));
    await router.tryHandle(message({ text: '/status' }));
    await router.tryHandle(message({ text: '/trace' }));
    expect(replies[0]).toContain('/feedback');
    expect(replies[1]).toContain('gpt-4o');
    expect(replies[2]).toContain('最近一次执行');
  });

  it('/stop 命中运行与未命中运行给出不同提示', async () => {
    const { router, replies, calls } = runtime();
    await router.tryHandle(message({ text: '/stop' }));
    expect(calls.stop).toEqual(['cid-1']);
    expect(replies[0]).toContain('已停止');

    const idle = runtime({ stopRun: () => 0 });
    await idle.router.tryHandle(message({ text: '/stop' }));
    expect(idle.replies[0]).toContain('没有进行中');
  });

  it('/reset 与 /retry 调用运行时', async () => {
    const { router, replies, calls } = runtime();
    await router.tryHandle(message({ text: '/reset' }));
    await router.tryHandle(message({ text: '/retry' }));
    expect(calls.reset).toEqual(['msg-1']);
    expect(calls.retry).toEqual(['cid-1']);
    expect(replies[1]).toContain('重新执行');
  });

  it('群聊 /mute 仅管理员可用', async () => {
    const group = message({ text: '/mute', conversationType: '2' });
    const denied = runtime({ isAdmin: () => false });
    await denied.router.tryHandle(group);
    expect(denied.calls.mute).toEqual([]);
    expect(denied.replies[0]).toContain('只有管理员');

    const allowed = runtime();
    await allowed.router.tryHandle(group);
    expect(allowed.calls.mute).toEqual([['cid-1', true]]);
  });

  it('/feedback 需要内容并记录', async () => {
    const { router, replies, calls } = runtime();
    await router.tryHandle(message({ text: '/feedback' }));
    expect(replies[0]).toContain('用法');
    await router.tryHandle(message({ text: '/feedback 答案不准确' }));
    expect(calls.feedback[0]).toMatchObject({
      conversationId: 'cid-1',
      staffId: 'staff-1',
      text: '答案不准确',
    });
  });

  it('/confirm 与 /cancel 调用确认运行时', async () => {
    const confirm = runtime({
      confirmAction: async () => '已执行 `create_ticket`。',
    });
    await confirm.router.tryHandle(message({ text: '/confirm' }));
    expect(confirm.replies[0]).toContain('已执行');

    const cancel = runtime({
      cancelAction: async () => '已取消待确认的操作。',
    });
    await cancel.router.tryHandle(message({ text: '/cancel' }));
    expect(cancel.replies[0]).toContain('已取消');
  });

  it('/remind 与 /report 转发给个人助手运行时', async () => {
    const { router, calls, replies } = runtime();
    await router.tryHandle(message({ text: '/remind 25分钟后 开会' }));
    await router.tryHandle(message({ text: '/report daily 09:00' }));
    expect(calls.remind).toEqual([['msg-1', ['25分钟后', '开会']]]);
    expect(calls.reports).toEqual([['msg-1', ['daily', '09:00']]]);
    expect(replies[0]).toContain('已设置提醒');
    expect(replies[1]).toContain('已创建定时报告');
  });

  it('未知指令给出帮助提示', async () => {
    const { router, replies } = runtime();
    await router.tryHandle(message({ text: '/deploy' }));
    expect(replies[0]).toContain('/help');
  });

  it('/dws-status 与 /dws-login 仅管理员可用', async () => {
    const denied = runtime({ isAdmin: () => false });
    await denied.router.tryHandle(message({ text: '/dws-status' }));
    expect(denied.replies[0]).toContain('只有管理员');

    const allowed = runtime({
      dwsStatus: () => 'DWS 授权：已授权',
      dwsLogin: async () => '已发起 DWS 设备授权，授权码：HVSD-BJVT',
    });
    await allowed.router.tryHandle(message({ text: '/dws-status' }));
    await allowed.router.tryHandle(message({ text: '/dws-login' }));
    expect(allowed.replies[0]).toContain('已授权');
    expect(allowed.replies[1]).toContain('HVSD-BJVT');
  });
});
