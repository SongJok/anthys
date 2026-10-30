import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import { AttachmentStore } from './AttachmentStore.js';

function message(attachments: InboundMessage['attachments']): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '[图片]',
    attachments,
    rawPayload: {},
    timestamp: 0,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('AttachmentStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attachments-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('用下载码换取下载地址并把文件落盘', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: 'https://oss.example.com/a.png' }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );
    const store = new AttachmentStore({
      rootDir: dir,
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await store.store(
      message([
        {
          type: 'image',
          downloadCode: 'code-1',
          fileName: 'a.png',
        },
      ]),
    );

    expect(result.failed).toEqual([]);
    expect(result.stored).toHaveLength(1);
    const stored = result.stored[0]!;
    expect(stored).toMatchObject({
      type: 'image',
      fileName: 'a.png',
      size: 4,
      mimeType: 'image/png',
    });
    expect(await readFile(stored.localPath)).toEqual(Buffer.from(bytes));

    const [downloadCall, fileCall] = fetchImpl.mock.calls;
    expect(String(downloadCall?.[0])).toContain('messageFiles/download');
    expect(
      (downloadCall?.[1] as RequestInit).headers,
    ).toMatchObject({ 'x-acs-dingtalk-access-token': 'token-1' });
    expect(JSON.parse(String((downloadCall?.[1] as RequestInit).body))).toEqual({
      downloadCode: 'code-1',
      robotCode: 'robot-1',
    });
    expect(String(fileCall?.[0])).toBe('https://oss.example.com/a.png');
  });

  it('下载码换取失败时记录失败项，不阻塞其他附件', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: 'https://oss.example.com/b.txt' }),
      )
      .mockResolvedValueOnce(new Response('hello', { status: 200 }));
    const store = new AttachmentStore({
      rootDir: dir,
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await store.store(
      message([
        { type: 'image', downloadCode: 'bad', fileName: 'bad.png' },
        { type: 'file', downloadCode: 'good', fileName: 'b.txt' },
      ]),
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      type: 'image',
      fileName: 'bad.png',
    });
    expect(result.failed[0]?.error).toContain('403');
    expect(result.stored).toHaveLength(1);
    expect(result.stored[0]?.fileName).toBe('b.txt');
  });

  it('超过上限的附件直接拒绝', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: 'https://oss.example.com/big.bin' }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-length': '16' },
        }),
      );
    const store = new AttachmentStore({
      rootDir: dir,
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 8,
    });

    const result = await store.store(
      message([{ type: 'file', downloadCode: 'big', fileName: 'big.bin' }]),
    );
    expect(result.stored).toEqual([]);
    expect(result.failed[0]?.error).toContain('上限');
  });

  it('文件名会被清洗，避免路径穿越', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: 'https://oss.example.com/x' }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const store = new AttachmentStore({
      rootDir: dir,
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await store.store(
      message([
        {
          type: 'file',
          downloadCode: 'code',
          fileName: '../../etc/passwd',
        },
      ]),
    );
    const stored = result.stored[0]!;
    expect(stored.fileName).not.toContain('/');
    expect(stored.fileName).not.toContain('..');
    expect(stored.localPath.startsWith(dir)).toBe(true);
  });

  it('没有附件时不发起任何请求', async () => {
    const fetchImpl = vi.fn();
    const store = new AttachmentStore({
      rootDir: dir,
      robotCode: 'robot-1',
      getAccessToken: async () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await store.store(message(undefined));
    expect(result).toEqual({ stored: [], failed: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
