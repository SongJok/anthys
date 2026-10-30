import type { InboundMessage } from '../types/core.js';

export type RunStopReason = 'user' | 'superseded' | 'shutdown';

export interface ActiveRunInfo {
  conversationId: string;
  messageId: string;
  startedAt: number;
  stopReason: RunStopReason | null;
}

interface ActiveRun extends ActiveRunInfo {
  controller: AbortController;
}

export interface BeginRunResult {
  signal: AbortSignal;
  finish: () => void;
}

function conversationKeyFor(message: InboundMessage): string {
  return message.conversationId || message.senderStaffId;
}

/**
 * 会话级运行控制：同一会话只保留一个进行中的回答，
 * 新消息会中止旧回答，/stop、卡片按钮与进程退出共用同一套中止入口。
 */
export class RunControlRegistry {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly lastMessages = new Map<string, InboundMessage>();
  private readonly lastMessageLimit: number;

  constructor(
    private readonly now: () => number = Date.now,
    options: { lastMessageLimit?: number } = {},
  ) {
    this.lastMessageLimit = options.lastMessageLimit ?? 500;
  }

  public begin(message: InboundMessage): BeginRunResult {
    const key = conversationKeyFor(message);
    this.abort(key, 'superseded');
    const run: ActiveRun = {
      conversationId: key,
      messageId: message.messageId,
      startedAt: this.now(),
      stopReason: null,
      controller: new AbortController(),
    };
    this.runs.set(key, run);
    return {
      signal: run.controller.signal,
      finish: () => {
        if (this.runs.get(key) === run) this.runs.delete(key);
      },
    };
  }

  public stop(conversationId: string): number {
    return this.abort(conversationId, 'user') ? 1 : 0;
  }

  public stopAll(): number {
    let stopped = 0;
    for (const key of [...this.runs.keys()]) {
      if (this.abort(key, 'shutdown', false)) stopped += 1;
    }
    this.runs.clear();
    return stopped;
  }

  public isBusy(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  public activeCount(): number {
    return this.runs.size;
  }

  public activeRuns(): ActiveRunInfo[] {
    return [...this.runs.values()].map((run) => ({
      conversationId: run.conversationId,
      messageId: run.messageId,
      startedAt: run.startedAt,
      stopReason: run.stopReason,
    }));
  }

  public remember(message: InboundMessage): void {
    const key = conversationKeyFor(message);
    this.lastMessages.delete(key);
    this.lastMessages.set(key, message);
    if (this.lastMessages.size <= this.lastMessageLimit) return;
    const oldest = this.lastMessages.keys().next();
    if (!oldest.done) this.lastMessages.delete(oldest.value);
  }

  public lastMessage(conversationId: string): InboundMessage | null {
    return this.lastMessages.get(conversationId) ?? null;
  }

  private abort(
    conversationId: string,
    reason: RunStopReason,
    remove = true,
  ): boolean {
    const run = this.runs.get(conversationId);
    if (!run) return false;
    run.stopReason = reason;
    if (!run.controller.signal.aborted) run.controller.abort();
    if (remove) this.runs.delete(conversationId);
    return true;
  }
}
