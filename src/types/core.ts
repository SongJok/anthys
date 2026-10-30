/**
 * 1. 统一入站消息契约
 */
export interface InboundAttachment {
  type: 'image' | 'file' | 'audio' | 'video';
  /** 钉钉机器人消息附件下载码，需换取 downloadUrl 后才能下载 */
  downloadCode: string;
  fileName?: string;
  fileSize?: number;
  durationMs?: number;
}

export interface InboundMessage {
  messageId: string;
  conversationId: string;
  conversationType: '1' | '2';
  senderStaffId: string;
  senderNick: string;
  isAtBot: boolean;
  text: string;
  /**
   * 卡片投递使用的 staffId；缺省回退 senderStaffId。
   * DWS 群消息只有 openDingTalkId，不能投递卡片，置空后走群维度投递。
   */
  cardDeliverUserId?: string;
  attachments?: InboundAttachment[];
  rawPayload: Record<string, unknown>;
  timestamp: number;
}

/**
 * 2. 人设与大模型配置契约
 */
export interface LLMAndPersonaConfig {
  provider: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  enableNativeReasoning: boolean;
  temperature: number;
  persona: {
    name: string;
    rolePrompt: string;
    speakingStyle: string;
  };
}

/**
 * 3. 动态循环控制策略（非固定查询限制）
 */
export interface DynamicLoopPolicy {
  maxWallTimeMs: number;
  maxTotalTokens: number;
  maxConsecutiveSameTool: number;
  convergenceCheck: boolean;
}

/** 流式引用（RAG / MCP 结果出处） */
export interface StreamCitation {
  index: number;
  title: string;
  url?: string;
  snippet?: string;
  source?: string;
}

export type PlanItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PlanItem {
  id: string;
  text: string;
  status: PlanItemStatus;
}

/**
 * 4. 流式输出事件流契约 v2（驱动钉钉 AI 卡片实时刷新）
 *
 * 约定：
 * - 每轮模型调用以 turn_start 开始，turnId 贯穿该轮的 delta / tool 事件；
 * - 带工具调用的轮次中产出的正文是「过程说明」（narration），轮次结束时通过
 *   answer_reset 把它从正文区移到思考区，避免工具前的话术污染最终答案；
 * - 仅最后一轮（无工具调用）的正文进入 answer_delta 的最终答案。
 */
export type AgentStreamEvent =
  | { type: 'turn_start'; turnId: string; step: number }
  | { type: 'reasoning_delta'; content: string; turnId?: string }
  | { type: 'narration_delta'; content: string; turnId?: string }
  | {
      type: 'answer_delta';
      content: string;
      turnId?: string;
      /** true 表示该轮已被判定为最终回答 */
      final?: boolean;
    }
  | { type: 'answer_reset'; narration: string; turnId?: string }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'citation'; citations: StreamCitation[] }
  | { type: 'status'; message: string }
  | {
      type: 'tool_start';
      toolName: string;
      args: Record<string, unknown>;
      stepId?: string;
      turnId?: string;
    }
  | {
      type: 'tool_progress';
      toolName: string;
      message: string;
      stepId?: string;
      elapsedMs?: number;
    }
  | {
      type: 'tool_end';
      toolName: string;
      summary: string;
      isError: boolean;
      stepId?: string;
      turnId?: string;
      durationMs?: number;
      truncated?: boolean;
      datasetKey?: string;
    }
  | {
      type: 'completed';
      usage: {
        totalTokens: number;
        steps: number;
        durationMs: number;
        stopped?: boolean;
      };
    }
  | { type: 'error'; message: string; retryable?: boolean };

/**
 * 工具执行上下文
 */
export interface ExecutionContext {
  conversationId: string;
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  conversationType: '1' | '2';
  /** epoch ms，超过该时间点即视为预算耗尽 */
  deadlineAt: number;
  now: () => number;
  /** 本次运行的中止信号（用户停止 / 超时 / 进程退出） */
  signal?: AbortSignal;
  /** 是否为群聊主动回复，供模型路由与用量归因使用 */
  proactive?: boolean;
  /** 运行中向当前会话追加一条文本提醒（工具需要用户干预时使用） */
  notify?: (text: string) => Promise<void> | void;
}

/** 工具的结构化返回值：文本 + 引用 / 卸载信息 */
export interface ToolExecutionOutput {
  text: string;
  citations?: StreamCitation[];
  datasetKey?: string;
  truncated?: boolean;
  /** 覆盖默认摘要（展示在卡片的工具轨迹里） */
  summary?: string;
}

/** 写操作确认：调用方在工具执行前决定是否放行 */
export interface ToolApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** 工具提供方声明的风险等级，未声明时由审批方按名称推断 */
  risk?: 'read' | 'write' | 'destructive';
  source?: string;
  conversationId: string;
  senderStaffId: string;
}

export interface ToolApprovalDecision {
  approved: boolean;
  /** 未放行时展示给用户的说明（含确认方式） */
  reason?: string;
}

/**
 * 5. 统一工具提供方契约（供阶段二、阶段四无缝扩展）
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  /** 是否可能产生写操作（用于审批 / 二次确认） */
  risk?: 'read' | 'write' | 'destructive';
  /** 工具来源，例如 builtin / mcp:code / dws / sandbox */
  source?: string;
  execute: (
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<string>;
  /** 需要回传引用 / 卸载数据集 / 自定义摘要时实现；优先于 execute */
  executeStructured?: (
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<ToolExecutionOutput>;
}

export interface IToolProvider {
  readonly providerName: string;
  getTools(ctx: ExecutionContext): Promise<ToolDefinition[]>;
}

/** OpenAI function-calling 兼容的工具声明 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
}

/**
 * 模型流式输出块（reasoning_content / thinking 与正文、工具调用增量的统一视图）
 */
export interface ChatStreamChunk {
  reasoningDelta?: string;
  contentDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  finishReason?: string | null;
  usage?: { totalTokens?: number };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  toolChoice: 'auto' | 'none';
  temperature: number;
  enableNativeReasoning: boolean;
}

export interface ChatModel {
  readonly modelName: string;
  streamChat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk>;
}

export interface RunUsage {
  totalTokens: number;
  steps: number;
  durationMs: number;
  stopped?: boolean;
}

export interface RunResult {
  answer: string;
  reasoning: string;
  /** 带工具轮次中的过程说明（已被 answer_reset 移出正文） */
  narration?: string;
  citations?: StreamCitation[];
  /** 实际执行本次推理的模型名（模型路由后可能不同于全局配置） */
  model?: string;
  usage: RunUsage;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  createdAt: number;
  /** 群聊中该消息的发送者昵称（用于回放时保留说话人） */
  senderNick?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ConversationRecord {
  id: string;
  conversationKey: string;
  conversationType: '1' | '2';
  createdAt: number;
}

export interface AgentEngine {
  run(input: {
    messages: ChatMessage[];
    context: ExecutionContext;
    emit: (event: AgentStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<RunResult>;
}
