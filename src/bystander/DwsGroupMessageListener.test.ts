import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DwsGroupMessageListener,
  parseDwsGroupEvent,
  toInboundMessage,
  type DwsGroupChildProcess,
} from './DwsGroupMessageListener.js';
import type { InboundMessage } from '../types/core.js';

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly signals: Array<NodeJS.Signals | undefined> = [];

  public kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  public asChild(): DwsGroupChildProcess {
    return this as unknown as DwsGroupChildProcess;
  }
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

const FLAT_MESSAGE = {
  type: 'user_im_message_receive_group_all',
  event_id: 'event-1',
  message_id: 'msg-1',
  conversation_id: 'cid-1',
  sender: '王五',
  sender_open_dingtalk_id: 'Dy5dflTlbmfSiPALBjB9ZumnAkn52BFAeg',
  content: '接口 502 了，帮忙看一下',
  timestamp: 1_760_000_000_000,
};

describe('parseDwsGroupEvent', () => {
  it('maps flattened group message fields', () => {
    expect(parseDwsGroupEvent(FLAT_MESSAGE)).toEqual({
      messageId: 'msg-1',
      conversationId: 'cid-1',
      senderOpenId: 'Dy5dflTlbmfSiPALBjB9ZumnAkn52BFAeg',
      senderName: '王五',
      content: '接口 502 了，帮忙看一下',
      timestamp: 1_760_000_000_000,
      eventId: 'event-1',
    });
  });

  it('unwraps the unflattened transport envelope', () => {
    const parsed = parseDwsGroupEvent({
      type: 'event',
      event_type: 'user_im_message_receive_group_all',
      data: JSON.stringify({
        message_id: 'msg-2',
        conversation_id: 'cid-2',
        sender: '赵六',
        sender_open_dingtalk_id: 'open-2',
        content: '数据库连不上',
        create_time: 1_760_000_000_100,
      }),
    });
    expect(parsed?.messageId).toBe('msg-2');
    expect(parsed?.conversationId).toBe('cid-2');
    expect(parsed?.timestamp).toBe(1_760_000_000_100);
  });

  it('drops non-text, malformed and action events', () => {
    expect(
      parseDwsGroupEvent({ ...FLAT_MESSAGE, content: '{"card":"payload"}' }),
    ).toBeNull();
    expect(
      parseDwsGroupEvent({ ...FLAT_MESSAGE, message_id: undefined }),
    ).toBeNull();
    expect(
      parseDwsGroupEvent({
        type: 'user_im_message_recall_group',
        message_id: 'msg-3',
        conversation_id: 'cid-1',
        content: '撤回了一条消息',
      }),
    ).toBeNull();
  });

  it('accepts structured text content', () => {
    expect(
      parseDwsGroupEvent({ ...FLAT_MESSAGE, content: { text: '集群内存告警' } })
        ?.content,
    ).toBe('集群内存告警');
  });
});

describe('toInboundMessage', () => {
  it('marks DWS messages as non-@ and not card-deliverable', () => {
    const fields = parseDwsGroupEvent(FLAT_MESSAGE)!;
    const message = toInboundMessage(fields);
    expect(message.conversationType).toBe('2');
    expect(message.isAtBot).toBe(false);
    expect(message.senderStaffId).toBe(fields.senderOpenId);
    expect(message.senderNick).toBe('王五');
    expect(message.cardDeliverUserId).toBe('');
    expect(message.rawPayload.source).toBe('dws_event');
    expect(message.rawPayload.eventId).toBe('event-1');
  });
});

describe('DwsGroupMessageListener', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(options: {
    allowed?: string[];
    shouldIgnore?: (messageId: string) => boolean;
    ignoreSenders?: string[];
    logger?: typeof noopLogger;
  } = {}) {
    const children: FakeChild[] = [];
    const received: InboundMessage[] = [];
    const listener = new DwsGroupMessageListener({
      binary: 'dws',
      allowedConversations: options.allowed ?? ['cid-1'],
      shouldIgnore: options.shouldIgnore,
      ignoreSenders: options.ignoreSenders,
      settleMs: 0,
      sleep: async () => undefined,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child.asChild();
      },
      logger: options.logger ?? noopLogger,
      onMessage: (message) => {
        received.push(message);
      },
    });
    return { listener, children, received };
  }

  it('subscribes to group messages through the personal event stream', () => {
    const children: FakeChild[] = [];
    const spawned = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child.asChild();
    });
    const listener = new DwsGroupMessageListener({
      binary: '/usr/local/bin/dws',
      onMessage: () => undefined,
      spawn: spawned,
      logger: noopLogger,
    });
    listener.start();
    expect(spawned).toHaveBeenCalledWith('/usr/local/bin/dws', [
      'event',
      'consume',
      'user_im_message_receive_group_all',
      '--flatten',
      '--ephemeral',
      '--format',
      'ndjson',
      '--yes',
    ]);
    listener.stop();
  });

  it('forwards allowed group messages and drops everything else', async () => {
    const { listener, children, received } = setup({
      ignoreSenders: ['小美'],
    });
    listener.start();
    const child = children[0]!;

    child.stdout.write(line(FLAT_MESSAGE));
    child.stdout.write(
      line({ ...FLAT_MESSAGE, message_id: 'msg-other', conversation_id: 'cid-9' }),
    );
    child.stdout.write(
      line({ ...FLAT_MESSAGE, message_id: 'msg-bot', sender: '小美' }),
    );
    child.stdout.write('not-json\n');

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.messageId).toBe('msg-1');
  });

  it('skips messages already handled by the stream gateway', async () => {
    const shouldIgnore = vi.fn((messageId: string) => messageId === 'msg-1');
    const { listener, children, received } = setup({ shouldIgnore });
    listener.start();
    children[0]!.stdout.write(line(FLAT_MESSAGE));

    await vi.waitFor(() => expect(shouldIgnore).toHaveBeenCalledWith('msg-1'));
    expect(received).toHaveLength(0);
  });

  it('deduplicates repeated deliveries of the same message', async () => {
    const { listener, children, received } = setup();
    listener.start();
    children[0]!.stdout.write(line(FLAT_MESSAGE));
    children[0]!.stdout.write(line(FLAT_MESSAGE));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toHaveLength(1);
  });

  it('ignores configured senders (e.g. the bot itself)', async () => {
    const { listener, children, received } = setup({
      ignoreSenders: ['小钉'],
    });
    listener.start();
    children[0]!.stdout.write(
      line({ ...FLAT_MESSAGE, message_id: 'msg-bot', sender: '小钉' }),
    );
    children[0]!.stdout.write(line(FLAT_MESSAGE));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.messageId).toBe('msg-1');
  });

  it('stops with SIGTERM and does not restart afterwards', async () => {
    vi.useFakeTimers();
    const { listener, children } = setup();
    listener.start();
    const child = children[0]!;

    listener.stop();
    expect(child.signals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(listener.isRunning).toBe(false);
  });

  it('restarts the subscription after the process exits', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const listener = new DwsGroupMessageListener({
      onMessage: () => undefined,
      settleMs: 0,
      restartDelayMs: 100,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child.asChild();
      },
      logger: noopLogger,
    });
    listener.start();
    expect(children).toHaveLength(1);

    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(120);
    expect(children).toHaveLength(2);
    listener.stop();
  });

  it('honours retry_after_seconds reported by dws', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const listener = new DwsGroupMessageListener({
      onMessage: () => undefined,
      settleMs: 0,
      restartDelayMs: 100,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child.asChild();
      },
      logger: noopLogger,
    });
    listener.start();

    children[0]!.stderr.write('  "retry_after_seconds": 30,\n');
    children[0]!.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(children).toHaveLength(2);
    listener.stop();
  });

  it('reports each unlistened group only once', async () => {
    const info = vi.fn();
    const { listener, children } = setup({
      allowed: [],
      logger: { ...noopLogger, info },
    });
    listener.start();
    children[0]!.stdout.write(line(FLAT_MESSAGE));
    children[0]!.stdout.write(line({ ...FLAT_MESSAGE, message_id: 'msg-2' }));

    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        { conversationId: 'cid-1' },
        expect.stringContaining('BYSTANDER_LISTEN_GROUPS'),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      info.mock.calls.filter((call) =>
        String(call[0]?.conversationId ?? '') === 'cid-1',
      ),
    ).toHaveLength(1);
  });

  it('can refresh the allowed groups at runtime', async () => {
    const { listener, children, received } = setup({ allowed: [] });
    listener.start();
    children[0]!.stdout.write(line(FLAT_MESSAGE));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);

    listener.setAllowedConversations(['cid-1']);
    children[0]!.stdout.write(line({ ...FLAT_MESSAGE, message_id: 'msg-2' }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.messageId).toBe('msg-2');
  });

  it('logs allowlist changes so a missing group is visible', () => {
    const info = vi.fn();
    const { listener } = setup({ allowed: [], logger: { ...noopLogger, info } });

    listener.setAllowedConversations(['cid-1']);
    expect(info).toHaveBeenCalledWith(
      { count: 1, added: ['cid-1'], removed: [] },
      'dws group listen allowlist updated',
    );

    info.mockClear();
    listener.setAllowedConversations(['cid-1']);
    expect(info).not.toHaveBeenCalled();
  });

  it('reports an ignored sender once instead of dropping silently', async () => {
    const info = vi.fn();
    const { listener, children, received } = setup({
      ignoreSenders: ['小美'],
      logger: { ...noopLogger, info },
    });
    listener.start();
    children[0]!.stdout.write(
      line({ ...FLAT_MESSAGE, message_id: 'msg-bot-1', sender: '小美' }),
    );
    children[0]!.stdout.write(
      line({ ...FLAT_MESSAGE, message_id: 'msg-bot-2', sender: '小美' }),
    );

    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ sender: '小美', conversationId: 'cid-1' }),
        'dws group message skipped, sender is in the ignore list',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);
    expect(
      info.mock.calls.filter(
        (call) =>
          call[1] === 'dws group message skipped, sender is in the ignore list',
      ),
    ).toHaveLength(1);
  });

  it('reports the first parse failure for each payload shape', async () => {
    const info = vi.fn();
    const { listener, children } = setup({ logger: { ...noopLogger, info } });
    listener.start();
    children[0]!.stdout.write(
      line({ type: 'user_im_group_updated', foo: 'bar' }),
    );

    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        { shape: 'foo,type' },
        'dws group message dropped, no usable message fields',
      ),
    );
  });
});
