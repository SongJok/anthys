import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenApiCardApi, type CardUpdate } from './CardStreamer.js';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Harness {
  endpoint: string;
  requests: CapturedRequest[];
  respondWith: (body: unknown, status?: number) => void;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  let response: { body: unknown; status: number } = {
    body: { success: true, requestId: 'req-1' },
    status: 200,
  };
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
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `127.0.0.1:${port}`,
    requests,
    respondWith: (body, status = 200) => {
      response = { body, status };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function singleApi(endpoint: string, token = 'tok-1'): OpenApiCardApi {
  return new OpenApiCardApi({
    clientId: 'app-key',
    clientSecret: 'app-secret',
    endpoint,
    protocol: 'http',
    getAccessToken: async () => token,
  });
}

const update: CardUpdate = {
  outTrackId: 'card_m1',
  guid: 'guid-1',
  key: 'answer_section',
  content: '## 你好',
  isFull: true,
  isFinalize: true,
  isError: false,
};

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('OpenApiCardApi', () => {
  it('creates and delivers a single-chat card with the documented request shape', async () => {
    harness = await startHarness();
    const api = singleApi(harness.endpoint);

    await api.createAndDeliver({
      cardTemplateId: 'tpl-1',
      outTrackId: 'card_m1',
      spaceId: 'dtv1.card//IM_ROBOT.cid-1',
      params: {
        thinking_section: '思考中',
        answer_section: '',
        status_bar: '正在思考…',
      },
      deliver: {
        conversationType: '1',
        robotCode: 'robot-1',
        userId: 'staff-1',
        conversationId: 'cid-1',
      },
    });

    expect(harness.requests).toHaveLength(1);
    const [request] = harness.requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1.0/card/instances/createAndDeliver');
    expect(request.headers['x-acs-dingtalk-access-token']).toBe('tok-1');
    expect(request.body).toMatchObject({
      cardTemplateId: 'tpl-1',
      outTrackId: 'card_m1',
      openSpaceId: 'dtv1.card//IM_ROBOT.cid-1',
      callbackType: 'STREAM',
      userId: 'staff-1',
      userIdType: 1,
      cardData: {
        cardParamMap: {
          thinking_section: '思考中',
          answer_section: '',
          status_bar: '正在思考…',
        },
      },
      imRobotOpenDeliverModel: {
        spaceType: 'IM_ROBOT',
        robotCode: 'robot-1',
      },
      imRobotOpenSpaceModel: { supportForward: true },
    });
    expect(request.body).not.toHaveProperty('imGroupOpenDeliverModel');
    expect(request.body).not.toHaveProperty('imGroupOpenSpaceModel');
    expect(request.body).not.toHaveProperty('imSingleOpenDeliverModel');
  });

  it('delivers a group card with robot code and atUserIds', async () => {
    harness = await startHarness();
    const api = singleApi(harness.endpoint);

    await api.createAndDeliver({
      cardTemplateId: 'tpl-1',
      outTrackId: 'card_m2',
      spaceId: 'dtv1.card//IM_GROUP.cid-2',
      params: {
        thinking_section: '',
        answer_section: '',
        status_bar: '正在思考…',
      },
      deliver: {
        conversationType: '2',
        robotCode: 'robot-9',
        userId: 'staff-9',
        conversationId: 'cid-2',
      },
    });

    const [request] = harness.requests;
    expect(request.body).toMatchObject({
      openSpaceId: 'dtv1.card//IM_GROUP.cid-2',
      callbackType: 'STREAM',
      imGroupOpenDeliverModel: {
        robotCode: 'robot-9',
        atUserIds: { 'staff-9': 'staff-9' },
      },
      imGroupOpenSpaceModel: { supportForward: true },
    });
    expect(request.body).not.toHaveProperty('imRobotOpenDeliverModel');
    expect(request.body).not.toHaveProperty('imRobotOpenSpaceModel');
  });

  it('sends streaming updates as a PUT with all block flags', async () => {
    harness = await startHarness();
    const api = singleApi(harness.endpoint, 'tok-2');

    await api.streamingUpdate(update);

    const [request] = harness.requests;
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('/v1.0/card/streaming');
    expect(request.headers['x-acs-dingtalk-access-token']).toBe('tok-2');
    expect(request.body).toEqual({
      outTrackId: 'card_m1',
      guid: 'guid-1',
      key: 'answer_section',
      content: '## 你好',
      isFull: true,
      isFinalize: true,
      isError: false,
    });
  });

  it('rejects when DingTalk reports success=false', async () => {
    harness = await startHarness();
    const api = singleApi(harness.endpoint);
    harness.respondWith({ success: false, requestId: 'req-2' });

    await expect(api.streamingUpdate(update)).rejects.toThrow(
      'streamingUpdate rejected by DingTalk',
    );

    harness.respondWith({ success: false, requestId: 'req-3' });
    await expect(
      api.createAndDeliver({
        cardTemplateId: 'tpl-1',
        outTrackId: 'card_m1',
        spaceId: 'dtv1.card//IM_ROBOT.cid-1',
        params: { thinking_section: '', answer_section: '', status_bar: '' },
        deliver: {
          conversationType: '1',
          robotCode: 'robot-1',
          userId: 'staff-1',
          conversationId: 'cid-1',
        },
      }),
    ).rejects.toThrow('createAndDeliver rejected by DingTalk');
  });

  it('requests a fresh access token for every call', async () => {
    harness = await startHarness();
    const tokens = ['tok-a', 'tok-b'];
    let index = 0;
    const api = new OpenApiCardApi({
      clientId: 'app-key',
      clientSecret: 'app-secret',
      endpoint: harness.endpoint,
      protocol: 'http',
      getAccessToken: async () => tokens[index++],
    });

    await api.streamingUpdate(update);
    await api.streamingUpdate({ ...update, guid: 'guid-2' });

    expect(harness.requests.map((r) => r.headers['x-acs-dingtalk-access-token'])).toEqual([
      'tok-a',
      'tok-b',
    ]);
  });
});
