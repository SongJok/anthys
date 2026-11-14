import { randomUUID } from 'node:crypto';
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
  remove(conversationId: string, actionId?: string): Promise<void>;
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
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/** 待确认写操作暂存区：支持单条覆盖或同会话多用户/多动作并发隔离 */
export class PendingActionStore {
  private readonly actions = new Map<string, PendingToolAction[]>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly multiPending: boolean;
  private readonly maxPendingPerConversation: number;
  private readonly persistence?: PendingActionPersistence;
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
    this.logger = options.logger;
  }

  /** 从持久层恢复未过期的待确认操作（应在开始服务前调用） */
  public async hydrate(): Promise<void> {
    const persistence = this.persistence;
    if (!persistence) return;
    try {
      const now = this.now();
      for (const action of await persistence.load(now)) {
        if (action.expiresAt <= now) continue;
        this.insertIntoQueue(action);
      }
      this.trim();
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'failed to hydrate pending tool actions',
      );
    }
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

  private persistSave(action: PendingToolAction): void {
    void this.persistence?.save(action).catch((error) => {
      this.logger?.warn(
        {
          conversationId: action.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to persist pending tool action',
      );
    });
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

  public put(input: {
    conversationId: string;
    toolName: string;
    args: Record<string, unknown>;
    risk: ToolRiskLevel;
    requestedBy: PendingToolAction['requestedBy'];
  }): PendingToolAction {
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
    this.insertIntoQueue(action);
    this.trim();
    this.persistSave(action);
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

  public take(
    conversationId: string,
    query?: PendingActionQuery,
  ): PendingToolAction | null {
    this.prune();
    const queue = this.actions.get(conversationId);
    if (!queue || queue.length === 0) return null;
    const idx = this.findIndex(queue, query);
    if (idx < 0) return null;
    const [action] = queue.splice(idx, 1);
    if (!action) return null;
    if (queue.length === 0) this.actions.delete(conversationId);
    this.persistRemove(conversationId, action.id);
    return action;
  }

  public cancel(
    conversationId: string,
    query?: PendingActionQuery,
  ): boolean {
    this.prune();
    const queue = this.actions.get(conversationId);
    if (!queue || queue.length === 0) return false;
    if (query?.actionIdPrefix || query?.staffId) {
      const idx = this.findIndex(queue, query);
      if (idx < 0) return false;
      const [removed] = queue.splice(idx, 1);
      if (queue.length === 0) this.actions.delete(conversationId);
      if (removed) this.persistRemove(conversationId, removed.id);
      return Boolean(removed);
    }
    this.actions.delete(conversationId);
    this.persistRemove(conversationId);
    return true;
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
    for (const [key, queue] of this.actions) {
      const alive = queue.filter((action) => action.expiresAt > now);
      if (alive.length === 0) {
        this.actions.delete(key);
      } else if (alive.length !== queue.length) {
        this.actions.set(key, alive);
      }
      for (const action of queue) {
        if (action.expiresAt <= now) this.persistRemove(key, action.id);
      }
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

const DESTRUCTIVE_PATTERN =
  /(^|[^a-z])(delete|remove|drop|purge|destroy|revoke|terminate|truncate|reset|unbind|wipe|uninstall)([^a-z]|$)/i;
const WRITE_PATTERN =
  /(^|[^a-z])(create|update|upsert|insert|set|add|write|upload|send|post|publish|move|rename|import|apply|execute|run|approve|reject|grant|assign|enable|disable|start|stop|restart|mute|cancel|manage|configure|modify|change|edit|patch|deploy|install|archive|sync|commit|merge|push|fork|transfer|bind|link|unlink|subscribe|unsubscribe|trigger|invoke|submit|schedule|register|unregister|attach|detach|copy|clone|restore|rollback|migrate|flush|clear|prune|close|lock|unlock|block|ban|kick|invite|pin|vote)([^a-z]|$)/i;

/** 工具未声明 risk 时按名称推断，宁可多问一次也不误执行写操作 */
export function classifyToolRisk(tool: {
  name: string;
  risk?: ToolRiskLevel;
  source?: string;
}): ToolRiskLevel {
  if (tool.risk) return tool.risk;
  const name = tool.name;
  if (DESTRUCTIVE_PATTERN.test(name)) return 'destructive';
  if (WRITE_PATTERN.test(name)) return 'write';
  return 'read';
}

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
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
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
  return [
    `操作需要确认：机器人准备调用工具 \`${action.toolName}\`（${label}，编号 \`${shortId}\`）。`,
    `参数：${formatArgs(action.args)}`,
    `回复「确认」或 \`/confirm ${shortId}\` 执行，或「取消」放弃；${ttlSeconds} 秒内有效。`,
  ].join('\n');
}

/**
 * ReAct 写操作闸门：风险工具在执行前登记为待确认动作，
 * 本轮立即结束并提示用户 /confirm；确认后由指令路由直接执行。
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
    const risk = classifyToolRisk({
      name: request.toolName,
      ...(request.risk ? { risk: request.risk } : {}),
      ...(request.source ? { source: request.source } : {}),
    });
    if (risk === 'read') return { approved: true };
    const action = options.store.put({
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
