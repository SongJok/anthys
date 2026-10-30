import { randomUUID } from 'node:crypto';
import type { McpClientPool, McpPoolLogger } from '../tools/mcp/McpClientPool.js';
import type {
  GroupBystanderPolicy,
  McpAdminPort,
  McpServerStatusView,
  McpServerTestResult,
  ReActTraceRecord,
  ReActTraceStep,
} from '../types/admin-and-console.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import type {
  AgentStreamEvent,
  InboundMessage,
  RunResult,
} from '../types/core.js';

/** McpClientPool 适配为 ChatOps / Web 共用的管控端口 */
export function createMcpAdminPort(
  getPool: () => McpClientPool | null,
  logger?: McpPoolLogger,
): McpAdminPort {
  const requirePool = (): McpClientPool => {
    const pool = getPool();
    if (!pool) throw new Error('MCP 连接池未初始化');
    return pool;
  };

  return {
    status(): McpServerStatusView[] {
      const pool = getPool();
      if (!pool) return [];
      return pool.status().map((server) => ({
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        connected: server.connected,
        toolCount: server.toolCount,
        lastError: server.lastError,
      }));
    },
    healthCheck: async () => {
      const pool = getPool();
      if (!pool) return [];
      return pool.healthCheck();
    },
    reloadServer: async (serverId) => {
      try {
        return (await requirePool().reloadServer(serverId)).map((tool) => ({
          serverId: tool.serverId,
          originalName: tool.originalName,
          namespacedName: tool.namespacedName,
          description: tool.description,
        }));
      } catch (error) {
        logger?.warn?.(
          {
            serverId,
            error: error instanceof Error ? error.message : String(error),
          },
          'mcp reload failed',
        );
        throw error;
      }
    },
    applyServers: async (servers: EnterpriseMcpServerConfig[]) => {
      const tools = await requirePool().applyServers(servers);
      return tools.map((tool) => ({
        serverId: tool.serverId,
        originalName: tool.originalName,
        namespacedName: tool.namespacedName,
        description: tool.description,
      }));
    },
    testServer: async (serverId: string): Promise<McpServerTestResult> => {
      const startedAt = Date.now();
      try {
        const tools = await requirePool().reloadServer(serverId);
        return {
          serverId,
          ok: true,
          latencyMs: Date.now() - startedAt,
          tools: tools.map((tool) => ({
            name: tool.originalName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      } catch (error) {
        return {
          serverId,
          ok: false,
          latencyMs: Date.now() - startedAt,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

interface OpenToolStep {
  step: ReActTraceStep;
  startedAt: number;
}

/**
 * 把 AgentStreamEvent 流累积成一条 ReAct 轨迹：
 * 原生思维链片段合并为 reasoning 步骤，工具调用记录入参/耗时/输出，
 * 最终答案单列 answer 步骤，供 Web 审计大盘与管理员 ChatOps 复盘。
 */
export class TraceCollector {
  private readonly steps: ReActTraceStep[] = [];
  private readonly openTools: OpenToolStep[] = [];
  private reasoningBuffer = '';
  private reasoningText = '';
  private answerBuffer = '';
  private totalTokens = 0;
  private stepCount = 0;
  private durationMs = 0;
  private errorMessage?: string;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public handle(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'reasoning_delta':
        this.reasoningBuffer += event.content;
        this.reasoningText += event.content;
        return;
      case 'tool_start': {
        this.flushReasoning();
        const step: ReActTraceStep = {
          index: this.steps.length,
          type: event.toolName.startsWith('sandbox_') ? 'sandbox' : 'tool',
          toolName: event.toolName,
          arguments: event.args,
        };
        this.steps.push(step);
        this.openTools.push({ step, startedAt: this.now() });
        return;
      }
      case 'tool_end': {
        const open = [...this.openTools]
          .reverse()
          .find(
            (item) =>
              item.step.toolName === event.toolName && item.step.durationMs === undefined,
          );
        if (open) {
          open.step.durationMs = this.now() - open.startedAt;
          open.step.output = event.summary;
          open.step.isError = event.isError;
          this.openTools.splice(this.openTools.indexOf(open), 1);
        }
        return;
      }
      case 'answer_delta':
        this.answerBuffer += event.content;
        return;
      case 'completed':
        this.totalTokens = event.usage.totalTokens;
        this.stepCount = event.usage.steps;
        this.durationMs = event.usage.durationMs;
        return;
      case 'error':
        this.errorMessage = event.message;
        return;
      default:
        return;
    }
  }

  public build(input: {
    message: InboundMessage;
    question?: string;
    result: RunResult;
    proactive: boolean;
  }): ReActTraceRecord {
    this.flushReasoning();
    const answer = input.result.answer ?? this.answerBuffer;
    if (answer) {
      this.steps.push({
        index: this.steps.length,
        type: 'answer',
        content: answer,
      });
    }
    const reasoning = this.reasoningText || input.result.reasoning;
    return {
      id: randomUUID(),
      conversationId: input.message.conversationId,
      messageId: input.message.messageId,
      senderStaffId: input.message.senderStaffId,
      senderNick: input.message.senderNick,
      conversationType: input.message.conversationType,
      proactive: input.proactive,
      question: input.question ?? input.message.text,
      reasoning,
      steps: this.steps,
      answer,
      totalTokens: this.totalTokens || input.result.usage.totalTokens,
      stepCount: this.stepCount || input.result.usage.steps,
      durationMs: this.durationMs || input.result.usage.durationMs,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  public getErrorMessage(): string | undefined {
    return this.errorMessage;
  }

  private flushReasoning(): void {
    if (!this.reasoningBuffer.trim()) return;
    this.steps.push({
      index: this.steps.length,
      type: 'reasoning',
      content: this.reasoningBuffer,
    });
    this.reasoningBuffer = '';
  }
}

/** 紧急静音审计辅助：把策略裁剪成可落库的快照 */
export function policySnapshot(
  policy: GroupBystanderPolicy,
): Record<string, unknown> {
  return {
    conversationId: policy.conversationId,
    bystanderEnabled: policy.bystanderEnabled,
    proactiveReplyEnabled: policy.proactiveReplyEnabled,
    cooldownSeconds: policy.cooldownSeconds,
    confidenceThreshold: policy.confidenceThreshold,
  };
}
