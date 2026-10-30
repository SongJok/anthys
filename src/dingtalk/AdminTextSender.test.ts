import { describe, expect, it, vi } from 'vitest';
import { DingTalkAdminTextSender } from './AdminTextSender.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DingTalkAdminTextSender', () => {
  it('用 sampleText 给管理员发单聊消息', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: 'k-1' }));
    const sender = new DingTalkAdminTextSender({
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await sender.send(['admin-1', 'admin-1', ' '], '权限不足');

    expect(result).toEqual({
      ok: true,
      sentStaffIds: ['admin-1'],
      failed: [],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('/v1.0/robot/oToMessages/batchSend');
    expect((init as RequestInit).headers).toMatchObject({
      'x-acs-dingtalk-access-token': 'token-1',
    });
    const body = JSON.parse(String((init as RequestInit).body)) as {
      robotCode: string;
      userIds: string[];
      msgKey: string;
      msgParam: string;
    };
    expect(body).toMatchObject({
      robotCode: 'robot-1',
      userIds: ['admin-1'],
      msgKey: 'sampleText',
    });
    expect(JSON.parse(body.msgParam)).toEqual({ content: '权限不足' });
  });

  it('超过 20 人时分批发送', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ processQueryKey: 'k' }));
    const sender = new DingTalkAdminTextSender({
      robotCode: () => 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const admins = Array.from({ length: 25 }, (_, index) => `admin-${index}`);

    const result = await sender.send(admins, '通知');

    expect(result.ok).toBe(true);
    expect(result.sentStaffIds).toHaveLength(25);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse(
      String((fetchImpl.mock.calls[1]![1] as RequestInit).body),
    ) as { userIds: string[] };
    expect(second.userIds).toHaveLength(5);
  });

  it('取 token 失败时返回失败明细', async () => {
    const sender = new DingTalkAdminTextSender({
      robotCode: 'robot-1',
      getAccessToken: async () => {
        throw new Error('client not ready');
      },
    });

    const result = await sender.send(['admin-1'], '通知');

    expect(result.ok).toBe(false);
    expect(result.failed[0]).toMatchObject({
      staffId: 'admin-1',
      error: 'client not ready',
    });
  });
});
