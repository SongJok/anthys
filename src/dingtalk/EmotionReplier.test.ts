import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EmotionReplier,
  OpenApiRobotEmotionApi,
  type EmotionTarget,
  type RobotEmotionApi,
} from './EmotionReplier.js';
import type { InboundMessage } from '../types/core.js';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Harness {
  endpoint: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const target: EmotionTarget = {
  robotCode: 'robot-1',
  openConversationId: 'cid-1',
  openMsgId: 'msg-1',
  emotionType: 1,
  emotionName: 'Like',
};

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '你好',
    rawPayload: {},
    timestamp: 0,
    ...overrides,
  };
}

function fakeApi(options: { failReply?: boolean; failRecall?: boolean } = {}): {
  api: RobotEmotionApi;
  replied: EmotionTarget[];
  recalled: EmotionTarget[];
} {
  const replied: EmotionTarget[] = [];
  const recalled: EmotionTarget[] = [];
  return {
    replied,
    recalled,
    api: {
      async reply(target) {
        if (options.failReply) throw new Error('no permission');
        replied.push(target);
      },
      async recall(target) {
        if (options.failRecall) throw new Error('not found');
        recalled.push(target);
      },
    },
  };
}

function replier(
  fake: { api: RobotEmotionApi },
  options: { enabled?: boolean; emotionName?: string } = {},
): EmotionReplier {
  return new EmotionReplier({
    api: fake.api,
    enabled: options.enabled ?? true,
    emotionName: options.emotionName ?? 'Like',
    robotCode: () => 'robot-1',
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('EmotionReplier', () => {
  it('处理开始贴表情，结束时用相同参数撤回', async () => {
    const fake = fakeApi();
    const subject = replier(fake);
    const message = inbound();

    subject.mark(message);
    await flush();
    expect(fake.replied).toEqual([
      {
        robotCode: 'robot-1',
        openConversationId: 'cid-1',
        openMsgId: 'msg-1',
        emotionType: 1,
        emotionName: 'Like',
      },
    ]);

    await subject.clear(message);
    expect(fake.recalled).toEqual(fake.replied);
  });

  it('同一消息重复 mark 只贴一次，避免重试路径重复刷屏', async () => {
    const fake = fakeApi();
    const subject = replier(fake);
    const message = inbound();

    subject.mark(message);
    subject.mark(message);
    await flush();
    expect(fake.replied).toHaveLength(1);

    await subject.clear(message);
    await subject.clear(message);
    expect(fake.recalled).toHaveLength(1);
  });

  it('贴表情失败只记日志，不阻塞后续流程，也不发起撤回', async () => {
    const fake = fakeApi({ failReply: true });
    const warnings: string[] = [];
    const subject = new EmotionReplier({
      api: fake.api,
      enabled: true,
      emotionName: 'Like',
      robotCode: () => 'robot-1',
      logger: { warn: (_obj, msg) => warnings.push(msg) },
    });

    subject.mark(inbound());
    await flush();
    await subject.clear(inbound());

    expect(fake.recalled).toHaveLength(0);
    expect(warnings).toEqual(['reply emotion failed']);
  });

  it('关闭开关时既贴表情也不撤回', async () => {
    const fake = fakeApi();
    const subject = replier(fake, { enabled: false });
    const message = inbound();

    subject.mark(message);
    await flush();
    await subject.clear(message);

    expect(fake.replied).toHaveLength(0);
    expect(fake.recalled).toHaveLength(0);
  });

  it('SDK 边界：贴表情与撤回命中官方接口并带上机器人身份', async () => {
    harness = await startHarness();
    const api = new OpenApiRobotEmotionApi({
      clientId: 'app-key',
      clientSecret: 'app-secret',
      endpoint: harness.endpoint,
      protocol: 'http',
      getAccessToken: async () => 'tok-1',
    });

    await api.reply(target);
    await api.recall(target);

    expect(harness.requests.map((request) => request.url)).toEqual([
      '/v1.0/robot/emotion/reply',
      '/v1.0/robot/emotion/recall',
    ]);
    for (const request of harness.requests) {
      expect(request.method).toBe('POST');
      expect(request.headers['x-acs-dingtalk-access-token']).toBe('tok-1');
      expect(request.body).toMatchObject({
        robotCode: 'robot-1',
        openConversationId: 'cid-1',
        openMsgId: 'msg-1',
        emotionType: 1,
        emotionName: 'Like',
      });
    }
  });

  it('撤回失败不影响主流程', async () => {
    const fake = fakeApi({ failRecall: true });
    const warnings: string[] = [];
    const subject = new EmotionReplier({
      api: fake.api,
      enabled: true,
      emotionName: 'Like',
      robotCode: () => 'robot-1',
      logger: { warn: (_obj, msg) => warnings.push(msg) },
    });
    const message = inbound();

    subject.mark(message);
    await flush();
    await expect(subject.clear(message)).resolves.toBeUndefined();
    expect(warnings).toEqual(['recall emotion failed']);
  });
});
