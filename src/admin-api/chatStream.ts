import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SharedStateStore } from '../cluster/SharedStateStore.js';
import type { AgentStreamEvent } from '../types/core.js';
import type { MetricsRegistry } from './metrics.js';

/**
 * 一次性 SSE 票据：EventSource 无法携带 Authorization 头，
 * 控制台先用 Bearer 换取短时票据，再凭票据订阅流。
 * 集群模式下通过 SharedStateStore 跨实例共享并原子核销。
 */
export class OneTimeTicketStore {
  private readonly tickets = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sharedState?: SharedStateStore,
  ) {}

  public issue(): { ticket: string; expiresAt: number } {
    this.prune();
    const ticket = randomUUID().replace(/-/g, '');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  public async issueAsync(): Promise<{ ticket: string; expiresAt: number }> {
    const issued = this.issue();
    if (this.sharedState) {
      const ttlSeconds = Math.max(1, Math.ceil(this.ttlMs / 1_000));
      try {
        await this.sharedState.setJson(
          `sse_ticket:${issued.ticket}`,
          { expiresAt: issued.expiresAt },
          ttlSeconds,
        );
      } catch {
        // 共享存储失败时回退本进程票据
      }
    }
    return issued;
  }

  public consume(ticket: string): boolean {
    const expiresAt = this.tickets.get(ticket);
    if (expiresAt === undefined) return false;
    this.tickets.delete(ticket);
    return expiresAt > this.now();
  }

  public async consumeAsync(ticket: string): Promise<boolean> {
    if (!ticket) return false;
    if (this.sharedState) {
      const key = `sse_ticket:${ticket}`;
      try {
        const entry = this.sharedState.takeJson
          ? await this.sharedState.takeJson<{ expiresAt?: number }>(key)
          : await (async () => {
              const found = await this.sharedState!.getJson<{
                expiresAt?: number;
              }>(key);
              if (found) await this.sharedState!.delete(key);
              return found;
            })();
        if (entry) {
          this.tickets.delete(ticket);
          return typeof entry.expiresAt === 'number'
            ? entry.expiresAt > this.now()
            : true;
        }
        // 共享存储已权威确认不存在或已被其他实例消费，本地同样清理防重放
        this.tickets.delete(ticket);
        return false;
      } catch {
        // 共享存储故障时回退本进程消费
      }
    }
    return this.consume(ticket);
  }

  public get size(): number {
    this.prune();
    return this.tickets.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}

export interface ConsoleChatInput {
  question: string;
  systemPrompt?: string;
  conversationId?: string;
  signal?: AbortSignal;
}

export type ConsoleChatHandler = (
  input: ConsoleChatInput,
  emit: (event: AgentStreamEvent) => void,
) => Promise<void>;

export interface ChatStreamDeps {
  tickets: OneTimeTicketStore;
  chatStream?: ConsoleChatHandler;
  metrics?: MetricsRegistry;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/** GET /api/v1/chat/stream?ticket=...&question=... */
export async function handleChatStream(
  c: Context,
  deps: ChatStreamDeps,
): Promise<Response> {
  const ticket = c.req.query('ticket') ?? '';
  if (!ticket || !(await deps.tickets.consumeAsync(ticket))) {
    return c.json({ ok: false, error: '票据无效或已过期，请重新获取' }, 401);
  }
  const handler = deps.chatStream;
  if (!handler) {
    return c.json({ ok: false, error: '在线对话未启用' }, 503);
  }
  const question = (c.req.query('question') ?? '').trim();
  if (!question) {
    return c.json({ ok: false, error: '缺少 question 参数' }, 400);
  }
  const systemPrompt = c.req.query('systemPrompt')?.trim() || undefined;
  const conversationId = c.req.query('conversationId')?.trim() || undefined;

  deps.metrics?.inc('console_chat_total');
  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    let writeQueue: Promise<void> = Promise.resolve();
    let closed = false;
    const write = (event: string, data: unknown): void => {
      if (closed) return;
      writeQueue = writeQueue.then(async () => {
        try {
          await stream.writeSSE({
            event,
            data: JSON.stringify(data),
          });
        } catch {
          closed = true;
        }
      });
    };
    const emit = (event: AgentStreamEvent): void => {
      write(event.type, event);
    };

    try {
      await handler(
        {
          question,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(conversationId ? { conversationId } : {}),
          signal: controller.signal,
        },
        emit,
      );
      write('done', { type: 'done' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.logger?.warn({ error: msg }, 'console chat stream failed');
      deps.metrics?.inc('console_chat_errors_total');
      write('error', { type: 'error', message: msg });
    } finally {
      await writeQueue;
    }
  });
}
