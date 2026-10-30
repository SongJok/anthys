import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentStreamEvent } from '../types/core.js';
import type { MetricsRegistry } from './metrics.js';

/**
 * 一次性 SSE 票据：EventSource 无法携带 Authorization 头，
 * 控制台先用 Bearer 换取短时票据，再凭票据订阅流。
 */
export class OneTimeTicketStore {
  private readonly tickets = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  public issue(): { ticket: string; expiresAt: number } {
    this.prune();
    const ticket = randomUUID().replace(/-/g, '');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  public consume(ticket: string): boolean {
    const expiresAt = this.tickets.get(ticket);
    if (expiresAt === undefined) return false;
    this.tickets.delete(ticket);
    return expiresAt > this.now();
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
  if (!ticket || !deps.tickets.consume(ticket)) {
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
      await handler({ question, systemPrompt, signal: controller.signal }, emit);
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
