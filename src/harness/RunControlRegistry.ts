import type { InboundMessage } from '../types/core.js';

export type RunStopReason = 'user' | 'shutdown';

export interface ActiveRunInfo {
  conversationId: string;
  messageId: string;
  startedAt: number;
  stopReason: RunStopReason | null;
}

interface QueuedRun extends ActiveRunInfo {
  controller: AbortController;
  signalStarted: () => void;
}

export interface BeginRunResult {
  signal: AbortSignal;
  /** 入队时前面已有的任务数；0 表示立即开始 */
  queuedAhead: number;
  /** 轮到自己或被取消时 resolve；恢复后必须检查 signal.aborted */
  started: Promise<void>;
  finish: () => void;
}

function conversationKeyFor(message: InboundMessage): string {
  return message.conversationId || message.senderStaffId;
}

/**
 * 会话级运行控制：同一会话严格按到达顺序串行执行，
 * 新消息只排队、不会打断进行中的回答；只有 /stop（stop）与进程退出（stopAll）
 * 会中止当前回答并清空该会话的排队任务。
 */
export class RunControlRegistry {
  private readonly queues = new Map<string, QueuedRun[]>();
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
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const run: QueuedRun = {
      conversationId: key,
      messageId: message.messageId,
      startedAt: 0,
      stopReason: null,
      controller: new AbortController(),
      signalStarted,
    };
    const queuedAhead = queue.length;
    queue.push(run);
    if (queuedAhead === 0) this.startRun(run);
    return {
      signal: run.controller.signal,
      queuedAhead,
      started,
      finish: () => this.release(key, run),
    };
  }

  public stop(conversationId: string): number {
    return this.abortAll(conversationId, 'user');
  }

  public stopAll(): number {
    let stopped = 0;
    for (const key of [...this.queues.keys()]) {
      stopped += this.abortAll(key, 'shutdown');
    }
    return stopped;
  }

  public isBusy(conversationId: string): boolean {
    return (this.queues.get(conversationId)?.length ?? 0) > 0;
  }

  /** 正在执行的会话数（每个会话同时只有一个回答在跑） */
  public activeCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      if (queue.length > 0) count += 1;
    }
    return count;
  }

  /** 正在等待轮到自己执行的问题数 */
  public pendingCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      count += Math.max(0, queue.length - 1);
    }
    return count;
  }

  public activeRuns(): ActiveRunInfo[] {
    const runs: ActiveRunInfo[] = [];
    for (const queue of this.queues.values()) {
      const head = queue[0];
      if (!head) continue;
      runs.push({
        conversationId: head.conversationId,
        messageId: head.messageId,
        startedAt: head.startedAt,
        stopReason: head.stopReason,
      });
    }
    return runs;
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

  private startRun(run: QueuedRun): void {
    run.startedAt = this.now();
    run.signalStarted();
  }

  /** finish 与 stop 都会走到这里；不在队列中时是安全的空操作 */
  private release(key: string, run: QueuedRun): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const index = queue.indexOf(run);
    if (index < 0) return;
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(key);
      return;
    }
    if (index === 0) this.startRun(queue[0]!);
  }

  private abortAll(
    conversationId: string,
    reason: RunStopReason,
  ): number {
    const queue = this.queues.get(conversationId);
    if (!queue) return 0;
    this.queues.delete(conversationId);
    const runs = queue.splice(0);
    for (const run of runs) {
      run.stopReason = reason;
      if (!run.controller.signal.aborted) run.controller.abort();
      // 让排队中的任务醒来自行检查 signal，避免永久等待
      run.signalStarted();
    }
    return runs.length;
  }
}
