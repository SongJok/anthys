/**
 * 1. 统一入站消息契约
 */
export interface InboundMessage {
  messageId: string;
  conversationId: string;
  conversationType: '1' | '2';
  senderStaffId: string;
  senderNick: string;
  isAtBot: boolean;
  text: string;
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

/**
 * 4. 流式输出事件流契约（驱动钉钉 AI 卡片实时刷新）
 */
export type AgentStreamEvent =
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; summary: string; isError: boolean }
  | { type: 'answer_delta'; content: string }
  | {
      type: 'completed';
      usage: { totalTokens: number; steps: number; durationMs: number };
    }
  | { type: 'error'; message: string };

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
}

/**
 * 5. 统一工具提供方契约（供阶段二、阶段四无缝扩展）
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<string>;
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
}

export interface RunResult {
  answer: string;
  reasoning: string;
  usage: RunUsage;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  createdAt: number;
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
