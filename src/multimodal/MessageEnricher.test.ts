import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type { AttachmentStoreResult } from './AttachmentStore.js';
import {
  enrichInboundMessage,
  renderAttachmentSection,
  renderDocumentSection,
} from './MessageEnricher.js';

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

describe('renderDocumentSection', () => {
  it('渲染文档标题、链接和按提问人权限读取的约束', () => {
    const section = renderDocumentSection([
      {
        title: '私聊转游戏或者一起看等',
        url: 'https://alidocs.dingtalk.com/i/nodes/doc-1',
      },
    ]);
    expect(section).toContain('「私聊转游戏或者一起看等」');
    expect(section).toContain('https://alidocs.dingtalk.com/i/nodes/doc-1');
    expect(section).toContain('documentId');
    expect(section).toContain('提问人本人有权限');
  });

  it('没有文档引用时返回空字符串', () => {
    expect(renderDocumentSection()).toBe('');
    expect(renderDocumentSection([])).toBe('');
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

  it('语音附件通过 ASR 转写并替换 [语音] 占位正文', async () => {
    const store = {
      store: vi.fn().mockResolvedValue({
        stored: [
          {
            type: 'audio',
            fileName: 'voice.amr',
            localPath: '/tmp/voice.amr',
            size: 1200,
          },
        ],
        failed: [],
      } satisfies AttachmentStoreResult),
    };
    const audio = {
      transcribe: vi.fn().mockResolvedValue('明天上午十点提醒我开评审会'),
    };
    const result = await enrichInboundMessage(
      message({
        text: '[语音]',
        attachments: [{ type: 'audio', downloadCode: 'code-audio' }],
      }),
      { store, audio },
    );
    expect(audio.transcribe).toHaveBeenCalledTimes(1);
    expect(result.message.text).toContain('明天上午十点提醒我开评审会');
    expect(result.message.text).not.toMatch(/^\[语音\]/);
    expect(result.message.text).toContain('语音转写：明天上午十点提醒我开评审会');
  });

  it('无附件但存在引用回复时反查并注入【引用消息】上下文', async () => {
    const store = { store: vi.fn() };
    const resolveQuotedMessage = vi.fn().mockResolvedValue({
      messageId: 'orig-1',
      senderNick: '王五',
      text: '数据库连接超时 5000ms',
    });
    const result = await enrichInboundMessage(
      message({
        text: '帮我定位一下根因',
        quotedMessage: { messageId: 'orig-1' },
      }),
      { store, resolveQuotedMessage },
    );
    expect(store.store).not.toHaveBeenCalled();
    expect(resolveQuotedMessage).toHaveBeenCalledWith('orig-1', 'cid-1');
    expect(result.message.text).toContain('【引用消息（王五）】');
    expect(result.message.text).toContain('数据库连接超时 5000ms');
    expect(result.message.text).toContain('帮我定位一下根因');
  });

  it('纯文档卡片无需下载附件也会注入模型上下文', async () => {
    const store = { store: vi.fn() };
    const url = 'https://alidocs.dingtalk.com/i/nodes/enrich-doc';
    const result = await enrichInboundMessage(
      message({
        text: '[钉钉文档]',
        documentReferences: [{ url, title: '需求文档' }],
      }),
      { store },
    );
    expect(store.store).not.toHaveBeenCalled();
    expect(result.message.text).toContain('【用户消息中的钉钉文档】');
    expect(result.message.text).toContain('「需求文档」');
    expect(result.message.text).toContain(url);
    expect(result.message.documentReferences).toEqual([{ url, title: '需求文档' }]);
  });
});
