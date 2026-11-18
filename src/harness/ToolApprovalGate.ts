import { randomUUID } from 'node:crypto';
import { resolveToolRisk } from '../tools/toolRisk.js';
import type {
  ExecutionContext,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../types/core.js';

export type ToolRiskLevel = 'read' | 'write' | 'destructive';

export interface PendingToolAction {
  id: string;
  conversationId: string;
  toolName: string;
  args: Record<string, unknown>;
  risk: ToolRiskLevel;
  requestedBy: {
    staffId: string;
    nick?: string;
    messageId?: string;
    conversationType?: '1' | '2';
    personKey?: string;
  };
  createdAt: number;
  expiresAt: number;
}

export interface PendingActionPersistence {
  load(nowMs: number): Promise<PendingToolAction[]>;
  save(action: PendingToolAction): Promise<void>;
  /** 容量淘汰专用删除；用户取消走 cancelPending 保留审计 */
  remove(conversationId: string, actionId?: string): Promise<void>;
  /** CAS：pending 且未过期 → executing；失败返回 null */
  claim(
    actionId: string,
    owner: string,
    nowMs: number,
  ): Promise<PendingToolAction | null>;
  settle(
    actionId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    detail: string,
    nowMs: number,
  ): Promise<void>;
  cancelPending(
    conversationId: string,
    actionId?: string,
    nowMs?: number,
  ): Promise<number>;
  /** 重启时把上一进程 executing 的动作标记 unknown，返回受影响动作 */
  recoverExecuting(nowMs: number): Promise<PendingToolAction[]>;
  markExpired(nowMs: number): Promise<number>;
  purgeSettled(beforeMs: number): Promise<number>;
}

export interface PendingActionQuery {
  staffId?: string;
  actionIdPrefix?: string;
}

export interface PendingActionStoreOptions {
  /** 确认有效期，默认 5 分钟 */
  ttlMs?: number;
  now?: () => number;
  /** 最多保留的会话数，超出时淘汰最旧记录 */
  limit?: number;
  /** 是否允许同会话并发保留多条待确认写操作（默认 false 保持单条覆盖语义） */
  multiPending?: boolean;
  /** 开启 multiPending 时单会话最多保留条数，默认 8 */
  maxPendingPerConversation?: number;
  /** 持久化后端；重启后未过期的待确认操作可以恢复 */
  persistence?: PendingActionPersistence;
  /** 终态审计记录保留期，默认 7 天 */
  settledRetentionMs?: number;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/** 待确认写操作暂存区：持久化优先登记，执行前 CAS 抢占，重启不自动重放 */
export class PendingActionStore {
  private readonly actions = new Map<string, PendingToolAction[]>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly multiPending: boolean;
  private readonly maxPendingPerConversation: number;
  private readonly persistence?: PendingActionPersistence;
  private readonly settledRetentionMs: number;
  private readonly logger?: PendingActionStoreOptions['logger'];

  constructor(options: PendingActionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? 500;
    this.multiPending = options.multiPending ?? false;
    this.maxPendingPerConversation = Math.max(
      1,
      options.maxPendingPerConversation ?? 8,
    );
    this.persistence = options.persistence;
    this.settledRetentionMs = options.settledRetentionMs ?? 7 * 24 * 3_600_000;
    this.logger = options.logger;
  }

  /**
   * 从持久层恢复未过期的待确认操作（应在开始服务前调用）。
   * 上一进程 executing 的动作标记为 unknown 并返回，交由调用方告警，绝不自动重放。
   */
  public async hydrate(): Promise<PendingToolAction[]> {
    const persistence = this.persistence;
    if (!persistence) return [];
    let unknown: PendingToolAction[] = [];
    try {
      const now = this.now();
      unknown = await persistence.recoverExecuting(now);
      for (const action of await persistence.load(now)) {
        if (action.expiresAt <= now) continue;
        this.insertIntoQueue(action);
      }
      this.trim();
      void persistence
        .purgeSettled(now - this.settledRetentionMs)
        .catch((error) => {
          this.logger?.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'failed to purge settled pending actions',
          );
        });
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'failed to hydrate pending tool actions',
      );
    }
    return unknown;
  }

  private insertIntoQueue(action: PendingToolAction): void {
    if (!this.multiPending) {
      this.actions.set(action.conversationId, [action]);
      return;
    }
    const existing = this.actions.get(action.conversationId) ?? [];
    const filtered = existing.filter((item) => item.id !== action.id);
    filtered.push(action);
    while (filtered.length > this.maxPendingPerConversation) {
      const evicted = filtered.shift();
      if (evicted) this.persistRemove(action.conversationId, evicted.id);
    }
    this.actions.set(action.conversationId, filtered);
  }

  private findIndex(
    queue: PendingToolAction[],
    query?: PendingActionQuery,
  ): number {
    if (queue.length === 0) return -1;
    const prefix = query?.actionIdPrefix?.trim().toLowerCase();
    if (prefix) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.id.toLowerCase().startsWith(prefix)) return i;
      }
      return -1;
    }
    if (query?.staffId) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.requestedBy.staffId === query.staffId) return i;
      }
      // 指定 staffId 时必须精确匹配，禁止回退队尾误取消他人操作
      return -1;
    }
    return queue.length - 1;
  }

  private persistRemove(conversationId: string, actionId?: string): void {
    void this.persistence?.remove(conversationId, actionId).catch((error) => {
      this.logger?.warn(
        {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to remove persisted pending tool action',
      );
    });
  }

  /** 持久化优先：先落库再进入内存队列；落库失败直接抛错，由闸门拒绝执行 */
  public async put(input: {
    conversationId: string;
    toolName: string;
    args: Record<string, unknown>;
    risk: ToolRiskLevel;
    requestedBy: PendingToolAction['requestedBy'];
  }): Promise<PendingToolAction> {
    this.prune();
    const createdAt = this.now();
    const action: PendingToolAction = {
      id: randomUUID(),
      conversationId: input.conversationId,
      toolName: input.toolName,
      args: input.args,
      risk: input.risk,
      requestedBy: input.requestedBy,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    await this.persistence?.save(action);
    this.insertIntoQueue(action);
    this.trim();
    return action;
  }

  public peek(
    conversationId: string,
    query?: PendingActionQuery,
  ): PendingToolAction | null {
    this.prune();
    const queue = this.actions.get(conversationId);
    if (!queue || queue.length === 0) return null;
    const idx = this.findIndex(queue, query);
    return idx >= 0 ? (queue[idx] ?? null) : null;
  }

  public peekAll(conversationId: string): PendingToolAction[] {
    this.prune();
    return [...(this.actions.get(conversationId) ?? [])];
  }

  private removeFromMemory(
    conversationId: string,
    actionId: string,
  ): void {
    const queue = this.actions.get(conversationId);
    if (!queue) return;
    const idx = queue.findIndex((item) => item.id === actionId);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.actions.delete(conversationId);
  }

  /**
   * 执行前 CAS 抢占：持久层 pending→executing 成功才返回动作，
   * 重复确认 / 跨进程竞争 / 已过期都会返回 null。
   */
  public async claimForExecution(
    conversationId: string,
    query: PendingActionQuery | undefined,
    owner: string,
  ): Promise<PendingToolAction | null> {
    this.prune();
    const queue = this.actions.get(conversationId);
    if (!queue || queue.length === 0) return null;
    const idx = this.findIndex(queue, query);
    if (idx < 0) return null;
    const action = queue[idx];
    if (!action) return null;
    if (this.persistence) {
      const claimed = await this.persistence.claim(
        action.id,
        owner,
        this.now(),
      );
      if (!claimed) {
        this.removeFromMemory(conversationId, action.id);
        return null;
      }
      this.removeFromMemory(conversationId, action.id);
      return claimed;
    }
    this.removeFromMemory(conversationId, action.id);
    return action;
  }

  /** 执行落定：succeeded / failed / cancelled；失败只告警不抛错 */
  public async settle(
    actionId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    detail: string,
  ): Promise<boolean> {
    if (!this.persistence) return true;
    try {
      await this.persistence.settle(actionId, status, detail, this.now());
      return true;
    } catch (error) {
      this.logger?.warn(
        {
          actionId,
          status,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to settle pending tool action',
      );
      return false;
    }
  }

  public async cancel(
    conversationId: string,
    query?: PendingActionQuery,
  ): Promise<boolean> {
    this.prune();
    const queue = this.actions.get(conversationId);
    let removedFromMemory = false;
    if (queue && queue.length > 0) {
      if (query?.actionIdPrefix || query?.staffId) {
        const idx = this.findIndex(queue, query);
        if (idx >= 0) {
          const [removed] = queue.splice(idx, 1);
          if (queue.length === 0) this.actions.delete(conversationId);
          removedFromMemory = Boolean(removed);
          if (removed) {
            await this.persistence?.cancelPending(
              conversationId,
              removed.id,
              this.now(),
            );
          }
        }
      } else {
        this.actions.delete(conversationId);
        removedFromMemory = true;
        await this.persistence?.cancelPending(conversationId, undefined, this.now());
      }
    }
    return removedFromMemory;
  }

  public get size(): number {
    this.prune();
    let count = 0;
    for (const queue of this.actions.values()) {
      count += queue.length;
    }
    return count;
  }

  public get ttlSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }

  private prune(): void {
    const now = this.now();
    let sawExpired = false;
    for (const [key, queue] of this.actions) {
      const alive = queue.filter((action) => action.expiresAt > now);
      if (alive.length === 0) {
        this.actions.delete(key);
      } else if (alive.length !== queue.length) {
        this.actions.set(key, alive);
      }
      if (alive.length !== queue.length) sawExpired = true;
    }
    if (sawExpired && this.persistence) {
      void this.persistence.markExpired(now).catch((error) => {
        this.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'failed to mark expired pending actions',
        );
      });
    }
  }

  private trim(): void {
    while (this.actions.size > this.limit) {
      const oldest = this.actions.keys().next();
      if (oldest.done) return;
      this.actions.delete(oldest.value);
      this.persistRemove(oldest.value);
    }
  }
}

/** 统一走 fail-closed 风险注册表：显式声明优先，未声明按 write 进入审批 */
export { resolveToolRisk as classifyToolRisk } from '../tools/toolRisk.js';

export interface ToolApprovalGateOptions {
  store: PendingActionStore;
  /** 关闭后所有工具直接放行 */
  enabled?: boolean;
  logger?: {
    info?(obj: Record<string, unknown>, msg: string): void;
  };
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(args);
    return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
  } catch {
    return String(args);
  }
}

export function formatApprovalPrompt(
  action: PendingToolAction,
  ttlSeconds: number,
): string {
  const label = action.risk === 'destructive' ? '高危写操作' : '写操作';
  const shortId = action.id.slice(0, 8);
  const impact =
    action.risk === 'destructive'
      ? '影响：该操作可能删除或不可逆地修改企业数据，执行后无法自动撤销。'
      : '影响：该操作会对外产生写入（发送消息 / 修改日程 / 提交数据等）。';
  return [
    `操作需要确认：机器人准备调用工具 \`${action.toolName}\`（${label}，编号 \`${shortId}\`）。`,
    `参数：${formatArgs(action.args)}`,
    impact,
    `回复「确认」或 \`/confirm ${shortId}\` 执行，或「取消」放弃；${ttlSeconds} 秒内有效。`,
  ].join('\n');
}

/**
 * ReAct 写操作闸门：风险工具在执行前持久化登记为待确认动作，
 * 本轮立即结束并提示用户 /confirm；确认后由指令路由 CAS 抢占执行。
 */
export function createToolApprovalGate(
  options: ToolApprovalGateOptions,
): (
  request: ToolApprovalRequest,
  context?: ExecutionContext,
) => Promise<ToolApprovalDecision> {
  const enabled = options.enabled ?? true;
  return async (request, context) => {
    if (!enabled) return { approved: true };
    const risk = resolveToolRisk({
      name: request.toolName,
      ...(request.risk ? { risk: request.risk } : {}),
      ...(request.source ? { source: request.source } : {}),
    });
    if (risk === 'read') return { approved: true };
    let action: PendingToolAction;
    try {
      action = await options.store.put({
        conversationId: request.conversationId,
        toolName: request.toolName,
        args: request.args,
        risk,
        requestedBy: {
          staffId: request.senderStaffId,
          ...(context?.senderNick ? { nick: context.senderNick } : {}),
          ...(context?.messageId ? { messageId: context.messageId } : {}),
          ...(context?.conversationType
            ? { conversationType: context.conversationType }
            : {}),
          ...(context?.personKey ? { personKey: context.personKey } : {}),
        },
      });
    } catch (error) {
      return {
        approved: false,
        reason: `审批登记失败（持久化不可用），已阻止执行 \`${request.toolName}\`，请稍后重试：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    options.logger?.info?.(
      {
        conversationId: request.conversationId,
        toolName: request.toolName,
        risk,
        actionId: action.id,
      },
      'tool execution awaiting confirmation',
    );
    return {
      approved: false,
      reason: formatApprovalPrompt(action, options.store.ttlSeconds),
    };
  };
}