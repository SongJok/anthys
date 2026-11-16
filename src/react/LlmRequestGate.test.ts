import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatStreamChunk } from '../types/core.js';
import {
  LlmRequestGate,
  resetSharedLlmRequestGates,
  sharedLlmRequestGate,
} from './LlmRequestGate.js';
import { OpenAIChatModel } from './OpenAIChatModel.js';
import { createChatModel } from './createChatModel.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('LlmRequestGate', () => {
  it('limit <= 0 时不限流，也不计数', async () => {
    const gate = new LlmRequestGate({ limit: 0 });
    const releases = await Promise.all([
      gate.acquire(),
      gate.acquire(),
      gate.acquire(),
    ]);
    expect(gate.stats()).toMatchObject({ active: 0, waiting: 0, queuedTotal: 0 });
    for (const release of releases) release();
    expect(gate.stats().active).toBe(0);
  });

  it('达到上限后排队，释放时按 FIFO 转交槽位且不超发', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const first = await gate.acquire();
    const order: number[] = [];
    const second = gate.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const third = gate.acquire().then((release) => {
      order.push(3);
      return release;
    });
    await flush();
    expect(gate.stats()).toMatchObject({ active: 1, waiting: 2, queuedTotal: 2 });
    expect(order).toEqual([]);

    first();
    const releaseSecond = await second;
    expect(order).toEqual([2]);
    expect(gate.stats().active).toBe(1);
    expect(gate.stats().waiting).toBe(1);

    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual([2, 3]);
    expect(gate.stats().active).toBe(1);

    releaseThird();
    expect(gate.stats()).toMatchObject({ active: 0, waiting: 0, acquiredTotal: 3 });
  });

  it('并发释放不会突破上限', async () => {
    const gate = new LlmRequestGate({ limit: 2 });
    const held = [await gate.acquire(), await gate.acquire()];
    let peak = 0;
    const waiters = Array.from({ length: 6 }, () =>
      gate.acquire().then((release) => {
        peak = Math.max(peak, gate.stats().active);
        return release;
      }),
    );
    await flush();
    expect(gate.stats().waiting).toBe(6);
    expect(gate.stats().active).toBe(2);

    held[0]!();
    held[1]!();
    const pending = [...waiters];
    while (pending.length > 0) {
      const release = await pending.shift()!;
      expect(gate.stats().active).toBeLessThanOrEqual(2);
      release();
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.stats()).toMatchObject({
      active: 0,
      waiting: 0,
      acquiredTotal: 8,
    });
  });

  it('释放函数幂等，重复调用不会多放一个槽位', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const first = await gate.acquire();
    const second = gate.acquire();
    first();
    first();
    const releaseSecond = await second;
    expect(gate.stats().active).toBe(1);
    expect(gate.stats().waiting).toBe(0);
    releaseSecond();
    expect(gate.stats().active).toBe(0);
  });

  it('等待中被 abort 会拒绝并让出排队位置', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const first = await gate.acquire();
    const controller = new AbortController();
    const pending = gate.acquire(controller.signal);
    const next = gate.acquire();
    await flush();
    expect(gate.stats().waiting).toBe(2);

    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(gate.stats().waiting).toBe(1);

    first();
    const releaseNext = await next;
    expect(gate.stats().active).toBe(1);
    releaseNext();
    expect(gate.stats().active).toBe(0);
  });

  it('传入已 abort 的信号立即拒绝，不占用槽位', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire(controller.signal)).rejects.toBeTruthy();
    expect(gate.stats()).toMatchObject({ active: 0, waiting: 0 });
    const release = await gate.acquire();
    expect(gate.stats().active).toBe(1);
    release();
  });
});

describe('sharedLlmRequestGate', () => {
  beforeEach(() => {
    resetSharedLlmRequestGates();
    delete process.env.LLM_MAX_CONCURRENT_REQUESTS;
  });

  it('同一端点共享闸门，不同端点相互隔离', () => {
    const a = sharedLlmRequestGate('https://api.deepseek.test/v1', 3);
    const b = sharedLlmRequestGate('https://api.deepseek.test/v1', 3);
    const c = sharedLlmRequestGate('https://api.moonshot.test/v1', 3);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.stats().limit).toBe(3);
  });

  it('createChatModel 为同端点的不同角色注入同一个闸门', () => {
    process.env.LLM_MAX_CONCURRENT_REQUESTS = '2';
    const base = {
      provider: 'openai-compatible' as const,
      dialect: 'deepseek' as const,
      baseUrl: 'https://api.deepseek.test/v1',
      apiKey: 'sk-test',
      temperature: 0,
      thinking: 'auto' as const,
    };
    createChatModel({ ...base, model: 'deepseek-chat' });
    createChatModel({ ...base, model: 'deepseek-reasoner' });
    const stats = sharedLlmRequestGate(base.baseUrl, 2).stats();
    expect(stats.limit).toBe(2);
  });
});

function asyncStream<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function makeRequest(): ChatCompletionRequest {
  return {
    messages: [{ role: 'user', content: '现在几点' }],
    tools: [],
    toolChoice: 'auto',
    temperature: 0.3,
    enableNativeReasoning: false,
  };
}

function modelWithGate(gate: LlmRequestGate, create: unknown): OpenAIChatModel {
  return new OpenAIChatModel({
    baseUrl: 'https://api.deepseek.test/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    requestGate: gate,
  });
}

describe('OpenAIChatModel 槽位释放', () => {
  it('流正常结束后释放在途槽位', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const create = vi.fn(async () =>
      asyncStream([{ choices: [{ delta: { content: '完成' } }] }]),
    );
    const model = modelWithGate(gate, create);
    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of model.streamChat(makeRequest())) {
      chunks.push(chunk);
      expect(gate.stats().active).toBe(1);
    }
    expect(chunks).toEqual([{ contentDelta: '完成' }]);
    expect(gate.stats().active).toBe(0);
  });

  it('提前 break 与流内抛错都会释放槽位', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const breaking = modelWithGate(
      gate,
      vi.fn(async () =>
        asyncStream([
          { choices: [{ delta: { content: 'a' } }] },
          { choices: [{ delta: { content: 'b' } }] },
        ]),
      ),
    );
    for await (const _chunk of breaking.streamChat(makeRequest())) break;
    expect(gate.stats().active).toBe(0);

    const failing = modelWithGate(
      gate,
      vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'a' } }] };
          throw new Error('上游断流');
        },
      })),
    );
    await expect(async () => {
      for await (const _chunk of failing.streamChat(makeRequest())) {
        // 消费到抛错为止
      }
    }).rejects.toThrow('上游断流');
    expect(gate.stats().active).toBe(0);

    const release = await gate.acquire();
    expect(gate.stats().active).toBe(1);
    release();
  });

  it('槽位满时后续请求排队，前一个流结束后才发起', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    let resolveFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const firstCreate = vi.fn(async () => {
      await firstBlocked;
      return asyncStream([{ choices: [{ delta: { content: 'first' } }] }]);
    });
    const secondCreate = vi.fn(async () =>
      asyncStream([{ choices: [{ delta: { content: 'second' } }] }]),
    );
    const first = modelWithGate(gate, firstCreate);
    const second = modelWithGate(gate, secondCreate);

    const firstDone = (async () => {
      for await (const _chunk of first.streamChat(makeRequest())) {
        // 消费完第一个流
      }
    })();
    await flush();
    expect(firstCreate).toHaveBeenCalledTimes(1);

    const secondDone = (async () => {
      for await (const _chunk of second.streamChat(makeRequest())) {
        // 消费完第二个流
      }
    })();
    await flush();
    expect(secondCreate).not.toHaveBeenCalled();
    expect(gate.stats().waiting).toBe(1);

    resolveFirst!();
    await Promise.all([firstDone, secondDone]);
    expect(secondCreate).toHaveBeenCalledTimes(1);
    expect(gate.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('排队期间被 abort 不会发起上游请求', async () => {
    const gate = new LlmRequestGate({ limit: 1 });
    const held = await gate.acquire();
    const create = vi.fn(async () => asyncStream([]));
    const model = modelWithGate(gate, create);
    const controller = new AbortController();
    const pending = (async () => {
      for await (const _chunk of model.streamChat(
        makeRequest(),
        controller.signal,
      )) {
        // 不应产出任何内容
      }
    })();
    await flush();
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(gate.stats().waiting).toBe(0);
    held();
    expect(gate.stats().active).toBe(0);
  });
});