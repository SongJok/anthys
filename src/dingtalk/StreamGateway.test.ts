import { describe, expect, it, vi } from 'vitest';
import { TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import {
  StreamGateway,
  type StreamCallbackMessage,
  type StreamClient,
} from './StreamGateway.js';
import type { InboundMessage } from '../types/core.js';

class FakeClient implements StreamClient {
  public callback: ((message: StreamCallbackMessage) => void) | null = null;
  public topic: string | null = null;
  public callbacks = new Map<
    string,
    (message: StreamCallbackMessage) => void
  >();
  public acks: Array<[string, unknown]> = [];
  public connectCalls = 0;
  public disconnectCalls = 0;

  public registerCallbackListener(
    topic: string,
    callback: (message: StreamCallbackMessage) => void,
  ): unknown {
    this.topic = topic;
    this.callback = callback;
    this.callbacks.set(topic, callback);
    return this;
  }

  public socketCallBackResponse(messageId: string, result: unknown): void {
    this.acks.push([messageId, result]);
  }

  public async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
  }
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msgId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    msgtype: 'text',
    createAt: 1_700_000_000_000,
    text: { content: '你好' },
    ...overrides,
  });
}

describe('StreamGateway', () => {
  it('注册 TOPIC_ROBOT 并建立连接', async () => {
    const client = new FakeClient();
    const gateway = new StreamGateway({
      client,
      handler: async () => undefined,
    });
    await gateway.start();
    expect(client.topic).toBe(TOPIC_ROBOT);
    expect(client.connectCalls).toBe(1);

    gateway.stop();
    expect(client.disconnectCalls).toBe(1);
  });

  it('共享去重命中时跳过处理', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const claim = vi.fn(async () => false);
    const gateway = new StreamGateway({
      client,
      handler,
      dedupeStore: { claim },
    });
    await gateway.start();

    await gateway.dispatch(payload(), 'msg-9');

    expect(claim).toHaveBeenCalledWith('stream:msg-9', 600);
    expect(handler).not.toHaveBeenCalled();
  });

  it('共享去重异常时回退到本地去重', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const claim = vi.fn(async () => {
      throw new Error('db down');
    });
    const gateway = new StreamGateway({
      client,
      handler,
      dedupeStore: { claim },
    });
    await gateway.start();

    await gateway.dispatch(payload(), 'msg-10');
    await gateway.dispatch(payload(), 'msg-10');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('收到回调先 ACK 再异步处理', async () => {
    const client = new FakeClient();
    const gate: { release?: () => void } = {};
    const handled: InboundMessage[] = [];
    const handler = vi.fn(
      (message: InboundMessage) =>
        new Promise<void>((resolve) => {
          handled.push(message);
          gate.release = resolve;
        }),
    );
    const gateway = new StreamGateway({ client, handler });
    await gateway.start();

    client.callback?.({
      headers: { messageId: 'msg-1' },
      data: payload(),
    });

    expect(client.acks).toEqual([
      ['msg-1', { status: 'SUCCESS' }],
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handled[0]?.text).toBe('你好');

    gate.release?.();
    await Promise.resolve();
  });

  it('群聊未 @ 机器人的消息直接忽略', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const gateway = new StreamGateway({ client, handler });

    await gateway.dispatch(
      payload({ conversationType: '2', atUsers: [] }),
      'msg-group-1',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('群聊 @ 机器人的消息正常处理', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async (_message: InboundMessage) => undefined);
    const gateway = new StreamGateway({ client, handler });

    await gateway.dispatch(
      payload({
        conversationType: '2',
        isInAtList: true,
        text: { content: '@小钉 你好' },
      }),
      'msg-group-2',
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      conversationType: '2',
      isAtBot: true,
      text: '你好',
    });
  });

  it('相同 messageId 只处理一次（钉钉重推去重）', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const gateway = new StreamGateway({ client, handler });

    await gateway.dispatch(payload(), 'msg-dup');
    await gateway.dispatch(payload(), 'msg-dup');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('非法 JSON 与非文本消息被忽略', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const gateway = new StreamGateway({ client, handler });

    await gateway.dispatch('{not-json', 'msg-bad');
    await gateway.dispatch(payload({ msgtype: 'picture' }), 'msg-pic');
    expect(handler).not.toHaveBeenCalled();
  });

  it('缺少 messageId 时不 ACK 也不处理', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const gateway = new StreamGateway({ client, handler });
    await gateway.start();

    client.callback?.({ headers: { messageId: '' }, data: payload() });

    expect(client.acks).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler 抛错时不让 dispatch 失败', async () => {
    const client = new FakeClient();
    const gateway = new StreamGateway({
      client,
      handler: async () => {
        throw new Error('db down');
      },
    });
    await expect(gateway.dispatch(payload(), 'msg-err')).resolves.toBeUndefined();
  });

  it('注册卡片回调并把按钮动作转成指令', async () => {
    const client = new FakeClient();
    const actions: Array<{ command: string; conversationId: string }> = [];
    const gateway = new StreamGateway({
      client,
      handler: async () => undefined,
      cardActionHandler: async (action) => {
        actions.push(action);
      },
    });
    await gateway.start();
    expect(client.callbacks.has(TOPIC_CARD)).toBe(true);

    const cardCallback = client.callbacks.get(TOPIC_CARD);
    cardCallback?.({
      headers: { messageId: 'card-1' },
      data: JSON.stringify({
        type: 'actionCallback',
        data: {
          outTrackId: 'track-1',
          conversationId: 'cid-1',
          conversationType: 2,
          userId: 'staff-1',
          cardPrivateData: { actionIds: ['stop'] },
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.acks).toContainEqual(['card-1', { status: 'SUCCESS' }]);
    expect(actions[0]).toMatchObject({
      command: '/stop',
      conversationId: 'cid-1',
      conversationType: '2',
    });
  });

  it('未识别的卡片动作被忽略', async () => {
    const client = new FakeClient();
    const handler = vi.fn(async () => undefined);
    const gateway = new StreamGateway({
      client,
      handler: async () => undefined,
      cardActionHandler: handler,
    });
    await gateway.dispatchCardAction(
      JSON.stringify({
        data: { conversationId: 'cid-1', cardPrivateData: { actionIds: ['unknown'] } },
      }),
      'card-2',
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
