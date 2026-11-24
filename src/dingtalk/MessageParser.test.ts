import { describe, expect, it } from 'vitest';
import {
  extractDocumentReferences,
  parseStreamMessage,
  stripLeadingMentions,
} from './MessageParser.js';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    msgtype: 'text',
    createAt: 1_700_000_000_000,
    chatbotUserId: 'bot-1',
    text: { content: '@小钉 帮我算一下 1+1' },
    ...overrides,
  };
}

describe('parseStreamMessage', () => {
  it('单聊消息始终视为已 @ 机器人，并去掉开头 @ 前缀', () => {
    const message = parseStreamMessage(
      payload({ conversationType: '1', text: { content: '@小钉 你好' } }),
    );
    expect(message).not.toBeNull();
    expect(message).toMatchObject({
      messageId: 'msg-1',
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      isAtBot: true,
      text: '你好',
    });
  });

  it('群聊 isInAtList 为 true 时识别为 @ 机器人', () => {
    const message = parseStreamMessage(payload({ isInAtList: true }));
    expect(message?.isAtBot).toBe(true);
    expect(message?.text).toBe('帮我算一下 1+1');
  });

  it('群聊消息带上群名，缺失时不留空字段', () => {
    const withTitle = parseStreamMessage(
      payload({ conversationTitle: '研发大群', isInAtList: true }),
    );
    expect(withTitle?.conversationTitle).toBe('研发大群');
    expect(withTitle?.senderNick).toBe('张三');

    const withoutTitle = parseStreamMessage(payload({ isInAtList: true }));
    expect(withoutTitle).not.toHaveProperty('conversationTitle');
  });

  it('群聊通过 atUsers 中的 chatbotUserId 识别 @', () => {
    const message = parseStreamMessage(
      payload({ atUsers: [{ dingtalkId: 'bot-1' }] }),
    );
    expect(message?.isAtBot).toBe(true);
  });

  it('群聊未 @ 机器人时 isAtBot 为 false', () => {
    const message = parseStreamMessage(
      payload({ atUsers: [{ dingtalkId: 'someone-else' }] }),
    );
    expect(message?.isAtBot).toBe(false);
  });

  it('无法识别或缺少下载码的消息返回 null', () => {
    expect(parseStreamMessage(payload({ msgtype: 'richText' }))).toBeNull();
    expect(
      parseStreamMessage(payload({ msgtype: 'picture', content: {} })),
    ).toBeNull();
  });

  it('富文本消息提取文字和全部图片', () => {
    const message = parseStreamMessage(
      payload({
        msgtype: 'richText',
        isInAtList: true,
        content: {
          richText: [
            { text: '@小钉 看看这两张图' },
            { type: 'picture', downloadCode: 'code-image-1' },
            { type: 'picture', downloadCode: 'code-image-2' },
          ],
        },
      }),
    );
    expect(message?.text).toBe('看看这两张图');
    expect(message?.isAtBot).toBe(true);
    expect(message?.attachments).toEqual([
      { type: 'image', downloadCode: 'code-image-1' },
      { type: 'image', downloadCode: 'code-image-2' },
    ]);
  });

  it('纯图片富文本消息生成占位正文', () => {
    const message = parseStreamMessage(
      payload({
        msgtype: 'richText',
        content: {
          richText: [{ type: 'picture', downloadCode: 'code-image' }],
        },
      }),
    );
    expect(message?.text).toBe('[图片]');
    expect(message?.attachments).toEqual([
      { type: 'image', downloadCode: 'code-image' },
    ]);
  });

  it('图片消息解析出下载码并生成占位正文', () => {
    const message = parseStreamMessage(
      payload({
        msgtype: 'picture',
        isInAtList: true,
        content: { downloadCode: 'code-image' },
      }),
    );
    expect(message?.text).toBe('[图片]');
    expect(message?.isAtBot).toBe(true);
    expect(message?.attachments).toEqual([
      { type: 'image', downloadCode: 'code-image' },
    ]);
  });

  it('文件消息保留文件名、大小与下载码', () => {
    const message = parseStreamMessage(
      payload({
        msgtype: 'file',
        content: {
          downloadCode: 'code-file',
          fileName: '季度报表.xlsx',
          fileSize: 2048,
        },
      }),
    );
    expect(message?.text).toBe('[文件]');
    expect(message?.attachments).toEqual([
      {
        type: 'file',
        downloadCode: 'code-file',
        fileName: '季度报表.xlsx',
        fileSize: 2048,
      },
    ]);
  });

  it('兼容图片消息的 pictureDownloadCode 字段', () => {
    const message = parseStreamMessage(
      payload({
        msgtype: 'picture',
        content: { pictureDownloadCode: 'legacy-code' },
      }),
    );
    expect(message?.attachments?.[0]?.downloadCode).toBe('legacy-code');
  });

  it('缺少必要字段时返回 null', () => {
    expect(parseStreamMessage(payload({ msgId: '' }))).toBeNull();
    expect(parseStreamMessage(payload({ senderStaffId: undefined }))).toBeNull();
    expect(parseStreamMessage(payload({ conversationId: null }))).toBeNull();
    expect(parseStreamMessage(null)).toBeNull();
    expect(parseStreamMessage('not-an-object')).toBeNull();
  });

  it('只有 @ 没有正文的消息标记为 mentionOnly', () => {
    const message = parseStreamMessage(
      payload({ isInAtList: true, text: { content: '@小钉   ' } }),
    );
    expect(message).toMatchObject({
      text: '',
      isAtBot: true,
      mentionOnly: true,
    });
  });

  it('富文本只有 @ 没有正文时同样标记为 mentionOnly', () => {
    const message = parseStreamMessage(
      payload({
        msgtype: 'richText',
        isInAtList: true,
        content: { richText: [{ text: '@小钉 ' }] },
      }),
    );
    expect(message).toMatchObject({ text: '', mentionOnly: true });
  });

  it('纯空白正文不会因为没有 @ 前缀而被放行', () => {
    expect(
      parseStreamMessage(payload({ text: { content: '   ' } })),
    ).toBeNull();
    expect(
      parseStreamMessage(
        payload({
          msgtype: 'richText',
          content: { richText: [{ text: '  ' }] },
        }),
      ),
    ).toBeNull();
  });

  it('普通消息不携带 mentionOnly 标记', () => {
    expect(parseStreamMessage(payload())).not.toHaveProperty('mentionOnly');
  });

  it('createAt 缺失时使用注入的时钟', () => {
    const message = parseStreamMessage(
      payload({ createAt: undefined }),
      () => 42,
    );
    expect(message?.timestamp).toBe(42);
  });

  it('stripLeadingMentions 只移除开头连续 @', () => {
    expect(stripLeadingMentions('@小钉 @助手 你好 @同事')).toBe('你好 @同事');
    expect(stripLeadingMentions('没有 @ 前缀')).toBe('没有 @ 前缀');
  });

  it('语音消息提取钉钉原生 recognition 文本作为正文与 nativeRecognition', () => {
    const message = parseStreamMessage(
      payload({
        conversationType: '1',
        msgtype: 'audio',
        content: {
          downloadCode: 'code-audio',
          duration: 3200,
          recognition: '帮我查一下明天的日程',
        },
      }),
    );
    expect(message?.text).toBe('帮我查一下明天的日程');
    expect(message?.attachments).toEqual([
      {
        type: 'audio',
        downloadCode: 'code-audio',
        durationMs: 3200,
        nativeRecognition: '帮我查一下明天的日程',
      },
    ]);
  });

  it('解析群聊引用回复（repliedMsg / quoteContent）上下文', () => {
    const message = parseStreamMessage(
      payload({
        isInAtList: true,
        text: {
          content: '@小钉 帮我看看这条报错原因',
          isReplyMsg: true,
          repliedMsg: {
            msgId: 'orig-msg-99',
            senderStaffId: 'staff-2',
            senderNick: '李四',
            msgType: 'text',
            content: { text: 'Error: ECONNRESET 10.0.1.5:5432' },
          },
        },
      }),
    );
    expect(message?.text).toBe('帮我看看这条报错原因');
    expect(message?.quotedMessage).toEqual({
      messageId: 'orig-msg-99',
      senderStaffId: 'staff-2',
      senderNick: '李四',
      msgtype: 'text',
      text: 'Error: ECONNRESET 10.0.1.5:5432',
    });
  });

  it('解析互动卡片中的 JSON cardData 与官方文档链接', () => {
    const url = 'https://alidocs.dingtalk.com/i/nodes/doc-card-1';
    const message = parseStreamMessage(
      payload({
        conversationType: '1',
        msgtype: 'interactiveCard',
        interactiveCard: {
          cardData: JSON.stringify({
            header: { title: { type: 'text', text: '示例文档标题' } },
            contents: [
              {
                type: 'markdown',
                text: `[打开需求文档](${url})`,
              },
            ],
          }),
        },
      }),
    );
    expect(message).toMatchObject({
      text: '[钉钉文档]',
      documentReferences: [{ url, title: '示例文档标题' }],
    });
  });

  it('解析 action_card 的 singleURL 与标题', () => {
    const message = parseStreamMessage(
      payload({
        conversationType: '1',
        msgtype: 'action_card',
        action_card: {
          title: '项目需求说明',
          singleURL: 'https://alidocs.dingtalk.com/i/nodes/action-doc',
        },
      }),
    );
    expect(message?.documentReferences).toEqual([
      {
        url: 'https://alidocs.dingtalk.com/i/nodes/action-doc',
        title: '项目需求说明',
      },
    ]);
  });

  it('解析多层转发消息中的文档卡片', () => {
    const url = 'https://alidocs.dingtalk.com/i/nodes/forward-doc';
    const message = parseStreamMessage(
      payload({
        conversationType: '1',
        msgtype: 'mixed',
        forwardMessages: [
          {
            msgtype: 'markdown',
            markdown: {
              title: '转发的需求文档',
              text: `[查看文档](${url})`,
            },
          },
        ],
      }),
    );
    expect(message?.documentReferences).toEqual([
      { url, title: '转发的需求文档' },
    ]);
  });

  it('普通文本引用文档卡片时保留指令并提取引用链接', () => {
    const url = 'https://alidocs.dingtalk.com/i/nodes/quoted-doc';
    const message = parseStreamMessage(
      payload({
        conversationType: '1',
        text: {
          content: '帮我生成一份测试用例',
          repliedMsg: {
            msgId: 'quoted-card-msg',
            msgType: 'interactiveCard',
            cardData: {
              title: '需求文档',
              url,
            },
          },
        },
      }),
    );
    expect(message?.text).toBe('帮我生成一份测试用例');
    expect(message?.documentReferences).toEqual([
      { url, title: '需求文档' },
    ]);
    expect(message?.quotedMessage).toMatchObject({
      messageId: 'quoted-card-msg',
      msgtype: 'interactiveCard',
    });
  });

  it('未知卡片没有链接时降级为标题，不伪造文档引用', () => {
    const message = parseStreamMessage(
      payload({
        conversationType: '1',
        msgtype: 'interactiveCard',
        cardData: { header: { title: { text: '系统通知' } } },
      }),
    );
    expect(message?.text).toBe('[卡片] 系统通知');
    expect(message).not.toHaveProperty('documentReferences');
  });

  it('没有文档链接或卡片标题的未知消息仍被忽略', () => {
    expect(
      parseStreamMessage(
        payload({ conversationType: '1', msgtype: 'interactiveCard', cardData: {} }),
      ),
    ).toBeNull();
  });
});

describe('extractDocumentReferences', () => {
  it('只接受官方 HTTPS 文档域名并拒绝凭据、端口及伪装域名', () => {
    const references = extractDocumentReferences({
      links: [
        'https://alidocs.dingtalk.com/i/nodes/ok',
        'http://alidocs.dingtalk.com/i/nodes/insecure',
        'https://alidocs.dingtalk.com.evil.example/i/nodes/fake',
        'https://evil.example@alidocs.dingtalk.com/i/nodes/credentials',
        'https://alidocs.dingtalk.com:444/i/nodes/port',
        'https://example.com/i/nodes/other',
      ],
    });
    expect(references).toEqual([
      { url: 'https://alidocs.dingtalk.com/i/nodes/ok' },
    ]);
  });

  it('兼容 docs.dingtalk.com、 Markdown 标题、JSON 字符串与去重', () => {
    const url = 'https://docs.dingtalk.com/d/doc-2';
    const references = extractDocumentReferences({
      cardData: JSON.stringify({
        title: '嵌套文档',
        text: `[读取](${url})`,
        duplicate: url,
      }),
    });
    expect(references).toEqual([{ url, title: '嵌套文档' }]);
  });

  it('限制引用数量并安全处理循环对象', () => {
    const record: Record<string, unknown> = {
      links: Array.from(
        { length: 10 },
        (_, index) => `https://alidocs.dingtalk.com/i/nodes/doc-${index}`,
      ),
    };
    record.self = record;
    expect(extractDocumentReferences(record)).toHaveLength(5);
  });
});
