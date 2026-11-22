import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemorySharedStateStore } from '../cluster/SharedStateStore.js';
import { handleChatStream, OneTimeTicketStore } from './chatStream.js';

describe('OneTimeTicketStore (O6 分布式共享票据)', () => {
  it('多实例共享 SharedStateStore 时可跨实例核销且防重放', async () => {
    let now = 100_000;
    const sharedState = new MemorySharedStateStore(() => now);
    const nodeA = new OneTimeTicketStore(60_000, () => now, sharedState);
    const nodeB = new OneTimeTicketStore(60_000, () => now, sharedState);

    const { ticket } = await nodeA.issueAsync();
    // 节点 B 可核销节点 A 签发的票据，且仅能消费一次
    await expect(nodeB.consumeAsync(ticket)).resolves.toBe(true);
    await expect(nodeB.consumeAsync(ticket)).resolves.toBe(false);
    // 即使回到签发节点 A 也不能重放
    await expect(nodeA.consumeAsync(ticket)).resolves.toBe(false);
  });

  it('共享票据超时后拒绝核销', async () => {
    let now = 100_000;
    const sharedState = new MemorySharedStateStore(() => now);
    const nodeA = new OneTimeTicketStore(10_000, () => now, sharedState);
    const nodeB = new OneTimeTicketStore(10_000, () => now, sharedState);

    const { ticket } = await nodeA.issueAsync();
    now += 11_000;
    await expect(nodeB.consumeAsync(ticket)).resolves.toBe(false);
  });

  it('handleChatStream 支持跨节点签发的一次性票据', async () => {
    let now = 100_000;
    const sharedState = new MemorySharedStateStore(() => now);
    const issuerNode = new OneTimeTicketStore(60_000, () => now, sharedState);
    const streamNode = new OneTimeTicketStore(60_000, () => now, sharedState);

    const app = new Hono();
    app.get('/chat/stream', (c) =>
      handleChatStream(c, {
        tickets: streamNode,
        chatStream: async (input, emit) => {
          emit({ type: 'answer_delta', content: `echo:${input.question}` });
        },
      }),
    );

    const { ticket } = await issuerNode.issueAsync();
    const res1 = await app.request(
      `/chat/stream?ticket=${encodeURIComponent(ticket)}&question=${encodeURIComponent('你好')}`,
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.text();
    expect(body1).toContain('echo:你好');

    // 再次复用同一票据返回 401
    const res2 = await app.request(
      `/chat/stream?ticket=${encodeURIComponent(ticket)}&question=${encodeURIComponent('重放')}`,
    );
    expect(res2.status).toBe(401);
  });
});
