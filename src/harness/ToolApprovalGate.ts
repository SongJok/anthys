import { randomUUID } from 'node:crypto';
import type {
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
  };
  createdAt: number;
  expiresAt: number;
}

export interface PendingActionStoreOptions {
  /** 确认有效期，默认 5 分钟 */
  ttlMs?: number;
  now?: () => number;
  /** 最多保留的会话数，超出时淘汰最旧记录 */
  limit?: number;
}

/** 每个会话只保留一个待确认写操作，新请求覆盖旧请求 */
export class PendingActionStore {
  private readonly actions = new Map<string, PendingToolAction>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(options: PendingActionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? 500;
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
    this.actions.set(input.conversationId, action);
    this.trim();
    return action;
  }

  public peek(conversationId: string): PendingToolAction | null {
    this.prune();
    return this.actions.get(conversationId) ?? null;
  }

  public take(conversationId: string): PendingToolAction | null {
    this.prune();
    const action = this.actions.get(conversationId);
    if (!action) return null;
    this.actions.delete(conversationId);
    return action;
  }

  public cancel(conversationId: string): boolean {
    this.prune();
    return this.actions.delete(conversationId);
  }

  public get size(): number {
    this.prune();
    return this.actions.size;
  }

  public get ttlSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, action] of this.actions) {
      if (action.expiresAt <= now) this.actions.delete(key);
    }
  }

  private trim(): void {
    while (this.actions.size > this.limit) {
      const oldest = this.actions.keys().next();
      if (oldest.done) return;
      this.actions.delete(oldest.value);
    }
  }
}

const DESTRUCTIVE_PATTERN =
  /(^|[^a-z])(delete|remove|drop|purge|destroy|revoke|terminate|truncate|reset|unbind|wipe|uninstall)([^a-z]|$)/i;
const WRITE_PATTERN =
  /(^|[^a-z])(create|update|upsert|insert|set|add|write|upload|send|post|publish|move|rename|import|apply|execute|run|approve|reject|grant|assign|enable|disable|start|stop|restart|mute|cancel|manage|configure|modify|change|edit|patch|deploy|install|archive)([^a-z]|$)/i;

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
  return [
    `操作需要确认：机器人准备调用工具 \`${action.toolName}\`（${label}）。`,
    `参数：${formatArgs(action.args)}`,
    `回复 \`/confirm\` 执行，或 \`/cancel\` 取消；${ttlSeconds} 秒内有效。`,
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
) => Promise<ToolApprovalDecision> {
  const enabled = options.enabled ?? true;
  return async (request) => {
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
      requestedBy: { staffId: request.senderStaffId },
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
