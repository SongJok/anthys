import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DingTalkMediaSender } from './MediaSender.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DingTalkMediaSender', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-'));
    filePath = join(dir, '季度报表.xlsx');
    await writeFile(filePath, 'sheet');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('先上传媒体再发送单聊文件消息', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, media_id: 'media-1' }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: 'k-1' }));
    const sender = new DingTalkMediaSender({
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await sender.send({
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      filePath,
    });

    expect(result).toMatchObject({
      ok: true,
      fileName: '季度报表.xlsx',
      mediaId: 'media-1',
      fileSize: 5,
    });

    const [uploadUrl, uploadInit] = fetchImpl.mock.calls[0]!;
    expect(String(uploadUrl)).toContain('media/upload');
    expect(String(uploadUrl)).toContain('access_token=token-1');
    expect((uploadInit as RequestInit).body).toBeInstanceOf(FormData);

    const [sendUrl, sendInit] = fetchImpl.mock.calls[1]!;
    expect(String(sendUrl)).toContain('/v1.0/robot/oToMessages/batchSend');
    const body = JSON.parse(String((sendInit as RequestInit).body)) as {
      robotCode: string;
      userIds: string[];
      msgKey: string;
      msgParam: string;
    };
    expect(body).toMatchObject({
      robotCode: 'robot-1',
      userIds: ['staff-1'],
      msgKey: 'sampleFile',
    });
    expect(JSON.parse(body.msgParam)).toMatchObject({
      mediaId: 'media-1',
      fileName: '季度报表.xlsx',
      fileType: 'xlsx',
    });
  });

  it('群聊走群消息接口并使用 openConversationId', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, media_id: 'media-2' }))
      .mockResolvedValueOnce(jsonResponse({}));
    const sender = new DingTalkMediaSender({
      robotCode: () => 'robot-live',
      getAccessToken: async () => 'token-2',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await sender.send({
      conversationId: 'cid-group',
      conversationType: '2',
      senderStaffId: 'staff-1',
      filePath,
      fileName: '报表.xlsx',
    });
    expect(result.ok).toBe(true);

    const [sendUrl, sendInit] = fetchImpl.mock.calls[1]!;
    expect(String(sendUrl)).toContain('/v1.0/robot/groupMessages/send');
    expect(JSON.parse(String((sendInit as RequestInit).body))).toMatchObject({
      robotCode: 'robot-live',
      openConversationId: 'cid-group',
      msgKey: 'sampleFile',
    });
  });

  it('媒体上传返回 errcode 时整体失败', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 40001, errmsg: 'bad token' }));
    const sender = new DingTalkMediaSender({
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await sender.send({
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      filePath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bad token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('超过大小上限时不上传', async () => {
    const fetchImpl = vi.fn();
    const sender = new DingTalkMediaSender({
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 2,
    });
    const result = await sender.send({
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      filePath,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('上限');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('文件不存在时返回可读错误', async () => {
    const sender = new DingTalkMediaSender({
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const result = await sender.send({
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      filePath: join(dir, 'missing.pdf'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('读取文件失败');
  });
});
