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
  /** 已拿到全局槽位并真正开始执行；false 表示仍在排队 */
  started: boolean;
}

export interface BeginRunResult {
  signal: AbortSignal;
  /** 入队时前面已有的任务数；0 表示本会话空闲 */
  queuedAhead: number;
  /** 本会话空闲但全局槽位已满，需要等待其他会话释放 */
  waitForSlot: boolean;
  /** 轮到自己或被取消时 resolve；恢复后必须检查 signal.aborted */
  started: Promise<void>;
  finish: () => void;
}

export interface RunControlOptions {
  lastMessageLimit?: number;
  /** 进程级同时执行的回答上限；<= 0 表示不限流 */
  maxActiveRuns?: number;
}

function conversationKeyFor(message: InboundMessage): string {
  return message.conversationId || message.senderStaffId;
}

/**
 * 会话级运行控制：同一会话严格按到达顺序串行执行，
 * 新消息只排队、不会打断进行中的回答；只有 /stop（stop）与进程退出（stopAll）
 * 会中止当前回答并清空该会话的排队任务。
 *
 * 在此之上叠加进程级槽位闸门：同时执行的回答数不超过 maxActiveRuns，
 * 超出的会话队首按到达顺序等待，避免突发流量把 LLM 与数据库连接打满。
 */
export class RunControlRegistry {
  private readonly queues = new Map<string, QueuedRun[]>();
  private readonly steeringQueues = new Map<string, string[]>();
  private readonly lastMessages = new Map<string, InboundMessage>();
  private readonly messagesById = new Map<string, InboundMessage>();
  private readonly lastMessageLimit: number;
  private readonly maxActiveRuns: number;
  /** 等待全局槽位的会话队首，按到达顺序排列 */
  private readonly slotWaiters: QueuedRun[] = [];
  private startedCount = 0;

  constructor(
    private readonly now: () => number = Date.now,
    options: RunControlOptions = {},
  ) {
    this.lastMessageLimit = options.lastMessageLimit ?? 500;
    this.maxActiveRuns = options.maxActiveRuns ?? 0;
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
      started: false,
    };
    const queuedAhead = queue.length;
    queue.push(run);
    if (queuedAhead === 0) this.startIfPossible(run);
    return {
      signal: run.controller.signal,
      queuedAhead,
      waitForSlot: queuedAhead === 0 && !run.started,
      started,
      finish: () => this.release(key, run),
    };
  }

  public stop(conversationId: string): number {
    return this.abortAll(conversationId, 'user');
  }

  /** 向进行中的会话追加一条动态引导指令，ReActRunner 在下一轮思考前注入 */
  public pushSteering(conversationId: string, instruction: string): boolean {
    const text = instruction.trim();
    if (!text || !this.isBusy(conversationId)) return false;
    const queue = this.steeringQueues.get(conversationId) ?? [];
    queue.push(text.slice(0, 1_000));
    if (queue.length > 8) queue.shift();
    this.steeringQueues.set(conversationId, queue);
    return true;
  }

  /** 读取并清空该会话待消费的动态引导指令 */
  public consumeSteering(conversationId: string): string[] {
    const queue = this.steeringQueues.get(conversationId);
    if (!queue || queue.length === 0) return [];
    this.steeringQueues.delete(conversationId);
    return queue;
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

  /** 正在执行的回答数（已拿到全局槽位，每个会话同时只有一个） */
  public activeCount(): number {
    return this.startedCount;
  }

  /** 尚未开始执行的问题数：会话内积压 + 等待全局槽位 */
  public pendingCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      for (const run of queue) {
        if (!run.started) count += 1;
      }
    }
    return count;
  }

  /** 本会话空闲但因全局槽位已满而等待的回答数 */
  public slotWaiterCount(): number {
    return this.slotWaiters.length;
  }

  /** 进程级并发上限；0 表示不限流 */
  public concurrencyLimit(): number {
    return this.maxActiveRuns;
  }

  public activeRuns(): ActiveRunInfo[] {
    const runs: ActiveRunInfo[] = [];
    for (const queue of this.queues.values()) {
      const head = queue[0];
      if (!head || !head.started) continue;
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
    if (message.messageId) {
      this.messagesById.delete(message.messageId);
      this.messagesById.set(message.messageId, message);
    }
    if (this.lastMessages.size > this.lastMessageLimit) {
      const oldest = this.lastMessages.keys().next();
      if (!oldest.done) this.lastMessages.delete(oldest.value);
    }
    if (this.messagesById.size > this.lastMessageLimit) {
      const oldestById = this.messagesById.keys().next();
      if (!oldestById.done) this.messagesById.delete(oldestById.value);
    }
  }

  public lastMessage(conversationId: string): InboundMessage | null {
    return this.lastMessages.get(conversationId) ?? null;
  }

  public messageById(messageId: string): InboundMessage | null {
    return this.messagesById.get(messageId) ?? null;
  }

  private hasFreeSlot(): boolean {
    return this.maxActiveRuns <= 0 || this.startedCount < this.maxActiveRuns;
  }

  private startIfPossible(run: QueuedRun): void {
    if (run.started) return;
    if (this.hasFreeSlot()) {
      this.startRun(run);
      return;
    }
    if (!this.slotWaiters.includes(run)) this.slotWaiters.push(run);
  }

  private startRun(run: QueuedRun): void {
    run.started = true;
    run.startedAt = this.now();
    this.startedCount += 1;
    run.signalStarted();
  }

  /** 槽位空出后按到达顺序唤醒等待中的会话队首 */
  private pumpSlots(): void {
    while (this.slotWaiters.length > 0 && this.hasFreeSlot()) {
      const next = this.slotWaiters.shift();
      if (!next || next.started || next.stopReason) continue;
      this.startRun(next);
    }
  }

  private dropSlotWaiter(run: QueuedRun): void {
    const index = this.slotWaiters.indexOf(run);
    if (index >= 0) this.slotWaiters.splice(index, 1);
  }

  /** finish 与 stop 都会走到这里；不在队列中时是安全的空操作 */
  private release(key: string, run: QueuedRun): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const index = queue.indexOf(run);
    if (index < 0) return;
    queue.splice(index, 1);
    if (run.started) {
      this.startedCount -= 1;
    } else {
      this.dropSlotWaiter(run);
    }
    if (queue.length === 0) {
      this.queues.delete(key);
    } else if (index === 0) {
      // 新队首排到全局等待队尾，避免同一会话持续插队饿死其他会话
      const next = queue[0]!;
      if (!next.started && !this.slotWaiters.includes(next)) {
        this.slotWaiters.push(next);
      }
    }
    this.pumpSlots();
  }

  private abortAll(
    conversationId: string,
    reason: RunStopReason,
  ): number {
    this.steeringQueues.delete(conversationId);
    const queue = this.queues.get(conversationId);
    if (!queue) return 0;
    this.queues.delete(conversationId);
    const runs = queue.splice(0);
    for (const run of runs) {
      run.stopReason = reason;
      if (run.started) {
        this.startedCount -= 1;
      } else {
        this.dropSlotWaiter(run);
      }
      if (!run.controller.signal.aborted) run.controller.abort();
      // 让排队中的任务醒来自行检查 signal，避免永久等待
      run.signalStarted();
    }
    this.pumpSlots();
    return runs.length;
  }
}
