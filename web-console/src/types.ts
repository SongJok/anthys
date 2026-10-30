export interface PersonaConfig {
  name: string;
  rolePrompt: string;
  speakingStyle: string;
}

export interface LLMConfig {
  provider: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  enableNativeReasoning: boolean;
  temperature: number;
  persona: PersonaConfig;
}

export interface LoopPolicy {
  maxWallTimeMs: number;
  maxTotalTokens: number;
  maxConsecutiveSameTool: number;
  convergenceCheck: boolean;
}

export interface DingTalkConfig {
  clientId: string;
  clientSecretMasked: string;
  robotCode: string;
  aiCardTemplateId: string;
  adminStaffIds: string[];
  dwsCliEnabled: boolean;
}

export interface StreamStatus {
  connected: boolean;
  detail?: string;
}

export type McpDomain =
  | 'code'
  | 'data'
  | 'log'
  | 'apidoc'
  | 'business'
  | 'general';
export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

export interface McpServerConfig {
  id: string;
  name: string;
  domain: McpDomain;
  transport: McpTransport;
  endpointOrCommand: string;
  args?: string[];
  envOrHeaders?: Record<string, string>;
  timeoutMs: number;
  maxResultChars: number;
  enabled: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  lastError: string | null;
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpTestResult {
  serverId: string;
  ok: boolean;
  latencyMs: number;
  tools: McpToolSchema[];
  error?: string;
}

export interface McpAccessPolicy {
  id: string;
  conversationId?: string;
  role?: 'admin' | 'employee';
  allowedServerIds: string[];
  allowedTools: string[];
  enabled: boolean;
}

export interface GroupPolicy {
  conversationId: string;
  bystanderEnabled: boolean;
  proactiveReplyEnabled: boolean;
  slidingWindowSize: number;
  cooldownSeconds: number;
  confidenceThreshold: number;
  triggerTopics: string[];
}

export type DefaultGroupPolicy = Omit<GroupPolicy, 'conversationId'>;

export interface KnownGroup {
  conversationId: string;
  title: string | null;
  conversationType: '1' | '2';
  bystanderEnabled: boolean | null;
  proactiveReplyEnabled: boolean | null;
  lastActiveAt: number | null;
  policy?: GroupPolicy;
}

export interface GroupTraceStat {
  conversationId: string;
  turns: number;
  proactiveReplies: number;
  totalTokens: number;
}

export interface TraceDailyStats {
  totalTokens: number;
  totalTurns: number;
  byGroup: GroupTraceStat[];
}

export interface ChatToolCall {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
  durationMs?: number;
}

export interface ChatTurnUsage {
  totalTokens: number;
  steps: number;
  durationMs: number;
  stopped?: boolean;
}

export interface ReActTraceStep {
  index: number;
  type: 'reasoning' | 'narration' | 'plan' | 'citation' | 'tool' | 'sandbox' | 'answer';
  content?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  durationMs?: number;
  output?: string;
  isError?: boolean;
}

export interface ReActTrace {
  id: string;
  conversationId: string;
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  conversationType: '1' | '2';
  proactive: boolean;
  question: string;
  reasoning: string;
  steps: ReActTraceStep[];
  answer: string;
  totalTokens: number;
  stepCount: number;
  durationMs: number;
  createdAt: string;
}

export interface TracePage {
  items: ReActTrace[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLog {
  id: string;
  adminStaffId: string;
  adminNick: string;
  actionType:
    | 'UPDATE_LLM'
    | 'UPDATE_DINGTALK'
    | 'RELOAD_MCP'
    | 'UPDATE_MCP_POLICY'
    | 'UPDATE_GROUP_POLICY'
    | 'EMERGENCY_MUTE'
    | 'UPDATE_RETENTION'
    | 'PURGE_DATA'
    | 'DELETE_USER_DATA'
    | 'QUERY_STATS';
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardPayload {
  system: {
    dingtalk: DingTalkConfig;
    llm: LLMConfig;
    loopPolicy: LoopPolicy;
    mcpServers: McpServerConfig[];
    defaultBystanderPolicy: DefaultGroupPolicy;
    mcpAccessPolicies: McpAccessPolicy[];
  };
  mcpServers: McpServerStatus[];
  stream: StreamStatus | null;
  today: TraceDailyStats;
  groups: KnownGroup[];
  auditLogs: AuditLog[];
}

export interface LlmTestResult {
  answer: string;
  reasoning: string;
  usage: { totalTokens: number; durationMs: number };
}

export type RetentionKind =
  | 'messages'
  | 'summaries'
  | 'traces'
  | 'audit'
  | 'usage'
  | 'attachments';

export interface RetentionPolicy {
  messagesDays: number;
  tracesDays: number;
  attachmentsHours: number;
  auditDays: number;
  usageDays: number;
}

export interface RetentionStats {
  policy: RetentionPolicy;
  now: number;
  totals: Record<RetentionKind, number>;
  expired: Record<RetentionKind, number>;
  attachmentBytes: number;
}

export interface CleanupResult {
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  deleted: Record<RetentionKind, number>;
}

export interface DeletionResult {
  target: string;
  deleted: Record<string, number>;
  attachmentsRemoved: number;
}
