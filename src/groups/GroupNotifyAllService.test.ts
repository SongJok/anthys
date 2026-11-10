import { describe, expect, it } from 'vitest';
import {
  GroupNotifyAllService,
  type GroupNotifyAllAuditRecord,
  type GroupNotifyAllDeliver,
  type GroupNotifyAllDeliverInput,
} from './GroupNotifyAllService.js';

const NOW = 1_764_500_000_000;

function setup(
  options: {
    enabled?: boolean;
    admins?: string[];
    cooldownSeconds?: number;
    dailyQuota?: number;
    maxTextChars?: number;
    deliver?: GroupNotifyAllDeliver;
    audit?: (record: GroupNotifyAllAuditRecord) => Promise<void> | void;
  } = {},
) {
  let clock = NOW;
  const delivered: GroupNotifyAllDeliverInput[] = [];
  const audits: GroupNotifyAllAuditRecord[] = [];
  const admins = new Set(options.admins ?? ['staff-admin']);
  const service = new GroupNotifyAllService({
    isAdmin: (staffId) => admins.has(staffId),
    enabled: options.enabled ?? true,
    cooldownSeconds: options.cooldownSeconds ?? 60,
    dailyQuota: options.dailyQuota ?? 10,
    maxTextChars: options.maxTextChars ?? 1_000,
    now: () => clock,
    audit: async (record) => {
      audits.push(record);
      await options.audit?.(record);
    },
  });
  service.deliver =
    options.deliver ??
    (async (input) => {
      delivered.push(input);
      return { channel: 'card' };
    });
  return {
    service,
    delivered,
    audits,
    advance: (ms: number) => {
      clock += ms;
    },
    request: (overrides: Partial<Parameters<GroupNotifyAllService['notify']>[0]> = {}) => ({
      conversationId: 'cid-group-1',
      text: '明天上午 9 点全员开会',
      actorStaffId: 'staff-admin',
      actorNick: '管理员',
      requesterMessageId: 'msg-1',
      ...overrides,
    }),
  };
}

describe('GroupNotifyAllService', () => {
  it('功能关闭时拒绝发送且不投递', async () => {
    const { service, delivered, request } = setup({ enabled: false });
    expect(service.canUse('staff-admin')).toBe(false);
    expect(await service.notify(request())).toContain('未开启');
    expect(delivered).toHaveLength(0);
  });

  it('非管理员拒绝发送', async () => {
    const { service, delivered, request } = setup();
    expect(service.canUse('staff-9')).toBe(false);
    expect(
      await service.notify(request({ actorStaffId: 'staff-9' })),
    ).toContain('只有管理员');
    expect(delivered).toHaveLength(0);
  });

  it('空内容与超长内容被拒绝', async () => {
    const { service, delivered, request } = setup({ maxTextChars: 10 });
    expect(await service.notify(request({ text: '   ' }))).toContain('不能为空');
    expect(
      await service.notify(request({ text: '甲'.repeat(11) })),
    ).toContain('内容过长');
    expect(delivered).toHaveLength(0);
  });

  it('管理员发送成功：真实投递、记录冷却与审计', async () => {
    const { service, delivered, audits, request } = setup();
    const reply = await service.notify(request());
    expect(reply).toContain('已向本群发送 @所有人 通知');
    expect(reply).toContain('AI 卡片');
    expect(reply).toContain('明天上午 9 点全员开会');
    expect(delivered).toEqual([
      {
        conversationId: 'cid-group-1',
        text: '明天上午 9 点全员开会',
        requesterMessageId: 'msg-1',
      },
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      conversationId: 'cid-group-1',
      actorStaffId: 'staff-admin',
      result: 'succeeded',
      channel: 'card',
    });
  });

  it('冷却期内重复发送被拒绝并给出剩余秒数', async () => {
    const { service, delivered, advance, request } = setup({
      cooldownSeconds: 60,
    });
    await service.notify(request());
    advance(30_000);
    const reply = await service.notify(request({ text: '第二条' }));
    expect(reply).toContain('30 秒后再试');
    expect(delivered).toHaveLength(1);
    advance(31_000);
    expect(await service.notify(request({ text: '第二条' }))).toContain(
      '已向本群发送',
    );
    expect(delivered).toHaveLength(2);
  });

  it('单群每日配额用尽后拒绝，跨上海自然日重置', async () => {
    const { service, delivered, advance, request } = setup({
      cooldownSeconds: 0,
      dailyQuota: 2,
    });
    await service.notify(request());
    await service.notify(request());
    expect(await service.notify(request())).toContain('已达上限');
    expect(delivered).toHaveLength(2);
    advance(24 * 3_600_000);
    expect(await service.notify(request())).toContain('已向本群发送');
    expect(delivered).toHaveLength(3);
  });

  it('不同群的冷却与配额互不影响', async () => {
    const { service, delivered, request } = setup({ cooldownSeconds: 60 });
    await service.notify(request());
    expect(
      await service.notify(request({ conversationId: 'cid-group-2' })),
    ).toContain('已向本群发送');
    expect(delivered).toHaveLength(2);
  });

  it('投递失败时如实返回失败，不标记冷却，允许重试', async () => {
    const { service, audits, request } = setup({
      deliver: async () => {
        throw new Error('卡片创建失败');
      },
    });
    const reply = await service.notify(request());
    expect(reply).toContain('发送失败');
    expect(reply).toContain('卡片创建失败');
    expect(reply).toContain('请勿声称已通知所有人');
    expect(audits[0]).toMatchObject({ result: 'failed', error: '卡片创建失败' });
    expect(await service.notify(request())).toContain('发送失败');
  });

  it('并发确认同一群时只投递一次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: GroupNotifyAllDeliverInput[] = [];
    const { service, request } = setup({
      deliver: async (input) => {
        delivered.push(input);
        await gate;
        return { channel: 'card' };
      },
    });
    const first = service.notify(request());
    const second = await service.notify(request());
    expect(second).toContain('正在发送');
    release();
    expect(await first).toContain('已向本群发送');
    expect(delivered).toHaveLength(1);
  });

  it('投递端口未就绪时拒绝', async () => {
    const { service, request } = setup();
    service.deliver = null;
    expect(await service.notify(request())).toContain('未就绪');
  });

  it('审计失败不影响发送结果', async () => {
    const { service, delivered, request } = setup({
      audit: async () => {
        throw new Error('db down');
      },
    });
    expect(await service.notify(request())).toContain('已向本群发送');
    expect(delivered).toHaveLength(1);
  });

  it('文本通道成功时回执标明文本消息', async () => {
    const { service, request } = setup({
      deliver: async () => ({ channel: 'text' }),
    });
    expect(await service.notify(request())).toContain('文本消息');
  });
});