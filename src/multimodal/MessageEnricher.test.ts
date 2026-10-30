import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type { AttachmentStoreResult } from './AttachmentStore.js';
import { enrichInboundMessage, renderAttachmentSection } from './MessageEnricher.js';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '[图片]',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

describe('renderAttachmentSection', () => {
  it('渲染附件路径、识别内容与失败项', () => {
    const section = renderAttachmentSection(
      [
        {
          type: 'image',
          fileName: 'shot.png',
          localPath: '/tmp/0-shot.png',
          size: 2 * 1024 * 1024,
          mimeType: 'image/png',
        },
        {
          type: 'file',
          fileName: 'report.pdf',
          localPath: '/tmp/1-report.pdf',
          size: 512,
        },
      ],
      new Map([['/tmp/0-shot.png', '登录页报错 401']]),
      [{ type: 'file', fileName: 'x.csv', error: 'HTTP 403' }],
    );
    expect(section).toContain('【用户附件】');
    expect(section).toContain('图片「shot.png」本地路径：/tmp/0-shot.png（2.0 MB）');
    expect(section).toContain('识别内容：登录页报错 401');
    expect(section).toContain('文件「report.pdf」');
    expect(section).toContain('文件「x.csv」下载失败：HTTP 403');
  });

  it('没有附件时返回空字符串', () => {
    expect(renderAttachmentSection([], new Map(), [])).toBe('');
  });
});

describe('enrichInboundMessage', () => {
  it('无附件时原样返回，不触碰存储', async () => {
    const store = { store: vi.fn() };
    const result = await enrichInboundMessage(message(), { store });
    expect(store.store).not.toHaveBeenCalled();
    expect(result.message).toEqual(message());
  });

  it('下载附件、识别图片并拼接进用户文本', async () => {
    const stored: AttachmentStoreResult = {
      stored: [
        {
          type: 'image',
          fileName: 'shot.png',
          localPath: '/tmp/0-shot.png',
          size: 100,
          mimeType: 'image/png',
        },
      ],
      failed: [],
    };
    const store = { store: vi.fn().mockResolvedValue(stored) };
    const vision = { describe: vi.fn().mockResolvedValue('报错 500') };
    const result = await enrichInboundMessage(
      message({ attachments: [{ type: 'image', downloadCode: 'c' }] }),
      { store, vision },
    );

    expect(vision.describe).toHaveBeenCalledWith(stored.stored[0]);
    expect(result.message.text).toContain('[图片]');
    expect(result.message.text).toContain('识别内容：报错 500');
    expect(result.attachments).toHaveLength(1);
  });

  it('附件全部失败时仍提示失败信息', async () => {
    const store = {
      store: vi.fn().mockResolvedValue({
        stored: [],
        failed: [{ type: 'file', fileName: 'a.pdf', error: 'HTTP 404' }],
      }),
    };
    const result = await enrichInboundMessage(
      message({ text: '[文件]', attachments: [{ type: 'file', downloadCode: 'c' }] }),
      { store },
    );
    expect(result.message.text).toContain('「a.pdf」下载失败：HTTP 404');
  });
});
