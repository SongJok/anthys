/**
 * 阶段四：管理员单聊管控（ChatOps）与 Web 管理后台的公共契约。
 */
import type { DynamicLoopPolicy, LLMAndPersonaConfig } from './core.js';
import type { EnterpriseMcpServerConfig } from './mcp-and-sandbox.js';
import type { GroupBystanderPolicy } from './bystander-and-memory.js';

export type { GroupBystanderPolicy } from './bystander-and-memory.js';

/** 钉钉企业侧配置（API 只返回脱敏后的 AppSecret） */
export interface DingTalkEnterpriseConfig {
  clientId: string;
  clientSecretMasked: string;
  robotCode: string;
  aiCardTemplateId: string;
  /** 拥有单聊管理权限的管理员钉钉 StaffId 列表 */
  adminStaffIds: string[];
  dwsCliEnabled: boolean;
}

/** 按群 / 角色限制 MCP 工具可见范围的策略 */
export interface McpToolAccessPolicy {
  id: string;
  /** 为空表示匹配所有群聊 */
  conversationId?: string;
  /** 为空表示匹配所有角色 */
  role?: 'admin' | 'employee';
  /** 为空表示不限制 Server，只受 allowedTools 约束 */
  allowedServerIds: string[];
  /** 允许的原始工具名或命名空间工具名；为空表示该 Server 下全部工具 */
  allowedTools: string[];
  enabled: boolean;
}

/** 1. 全局系统动态配置聚合契约（持久于 sys_configs 表） */
export interface EnterpriseBotSystemConfig {
  dingtalk: DingTalkEnterpriseConfig;
  llm: LLMAndPersonaConfig;
  loopPolicy: DynamicLoopPolicy;
  mcpServers: EnterpriseMcpServerConfig[];
  defaultBystanderPolicy: Omit<GroupBystanderPolicy, 'conversationId'>;
  mcpAccessPolicies: McpToolAccessPolicy[];
}

export type AdminActionType =
  | 'UPDATE_LLM'
  | 'UPDATE_DINGTALK'
  | 'RELOAD_MCP'
  | 'UPDATE_MCP_POLICY'
  | 'UPDATE_GROUP_POLICY'
  | 'EMERGENCY_MUTE'
  | 'UPDATE_SCHEDULES'
  | 'UPDATE_RETENTION'
  | 'PURGE_DATA'
  | 'DELETE_USER_DATA'
  | 'UPDATE_GLOSSARY'
  | 'QUERY_STATS';

/** 2. 管理员单聊管控审计记录契约 */
export interface AdminAuditLog {
  id: string;
  adminStaffId: string;
  adminNick: string;
  actionType: AdminActionType;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAuditInput {
  adminStaffId: string;
  adminNick: string;
  actionType: AdminActionType;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
}

/** 配置变更广播的 Scope */
export type ConfigScope =
  | 'dingtalk'
  | 'llm'
  | 'loopPolicy'
  | 'mcpServers'
  | 'mcpAccessPolicies'
  | 'defaultBystanderPolicy'
  | 'groupPolicy';

export interface ConfigChangeEvent {
  scope: ConfigScope;
  before: unknown;
  after: unknown;
  at: number;
  actorStaffId?: string;
  conversationId?: string;
}

/** 3. ReAct 全链路审计轨迹 */
export type ReActTraceStepType =
  | 'reasoning'
  | 'narration'
  | 'plan'
  | 'citation'
  | 'tool'
  | 'sandbox'
  | 'answer';

export interface ReActTraceStep {
  index: number;
  type: ReActTraceStepType;
  content?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  durationMs?: number;
  isError?: boolean;
}

export interface ReActTraceRecord {
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
  /** ISO 8601 */
  createdAt: string;
}

export interface ReActTraceQuery {
  page: number;
  pageSize: number;
  conversationId?: string;
  /** 只查询该 epoch ms 之后的轨迹（用于“今天”统计） */
  sinceMs?: number;
}

export interface ReActTracePage {
  items: ReActTraceRecord[];
  total: number;
  page: number;
  pageSize: number;
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

/** 轨迹查询与聚合（Web 大盘 / ChatOps 共用） */
export interface ReActTraceStore {
  append(record: ReActTraceRecord): Promise<void>;
  query(input: ReActTraceQuery): Promise<ReActTracePage>;
  dailyStats(dayStartMs: number, dayEndMs: number): Promise<TraceDailyStats>;
}

/** 用量账本与配额 */
export interface UsagePolicy {
  enabled: boolean;
  /** 单个员工每日 Token 上限，0 表示不限 */
  dailyTokensPerUser: number;
  /** 单个群每日 Token 上限，0 表示不限 */
  dailyTokensPerConversation: number;
}

/** 按场景选择模型；空字符串表示沿用全局 llm.model */
export interface ModelRoutingPolicy {
  defaultModel?: string;
  proactiveModel?: string;
  adminModel?: string;
}

export interface UsageLedgerInput {
  conversationId: string;
  conversationType: '1' | '2';
  senderStaffId: string;
  senderNick: string;
  model: string;
  totalTokens: number;
  steps: number;
  durationMs: number;
  proactive: boolean;
}

export interface UsageLedgerEntry extends UsageLedgerInput {
  id: string;
  createdAt: string;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  tokens: number;
  turns: number;
}

export interface UsageSummary {
  sinceMs: number;
  totalTokens: number;
  totalTurns: number;
  byUser: UsageBreakdownRow[];
  byConversation: UsageBreakdownRow[];
}

export interface UsageLedgerStore {
  append(input: UsageLedgerInput): Promise<void>;
  tokensSince(filter: {
    sinceMs: number;
    senderStaffId?: string;
    conversationId?: string;
  }): Promise<number>;
  summarySince(sinceMs: number): Promise<UsageSummary>;
  purgeBefore(epochMs: number): Promise<number>;
}

/** 定时任务与主动播报 */
export interface ScheduledTask {
  id: string;
  conversationId: string;
  conversationType: '1' | '2';
  title: string;
  prompt: string;
  /** 固定间隔，秒；与 cron 二选一 */
  intervalSeconds: number | null;
  /** 5 段 cron（Asia/Shanghai），与 intervalSeconds 二选一 */
  cron: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskInput {
  conversationId: string;
  conversationType: '1' | '2';
  title: string;
  prompt: string;
  intervalSeconds?: number | null;
  cron?: string | null;
  enabled?: boolean;
  createdBy?: string;
}

export interface ScheduledTaskUpdate {
  title?: string;
  prompt?: string;
  intervalSeconds?: number | null;
  cron?: string | null;
  enabled?: boolean;
}

export interface ScheduledTaskStore {
  list(): Promise<ScheduledTask[]>;
  listDue(atMs: number): Promise<ScheduledTask[]>;
  create(
    input: ScheduledTaskInput,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask>;
  update(
    id: string,
    input: ScheduledTaskUpdate,
    nextRunAtMs: number | null,
  ): Promise<ScheduledTask>;
  remove(id: string): Promise<boolean>;
  markRun(id: string, lastRunAtMs: number, nextRunAtMs: number | null): Promise<void>;
}

/** 用户对回答的显式反馈（/feedback 指令） */
export interface UserFeedbackRecord {
  id: string;
  conversationId: string;
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  content: string;
  createdAt: string;
}

export interface UserFeedbackInput {
  conversationId: string;
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  content: string;
}

export interface FeedbackStore {
  append(input: UserFeedbackInput): Promise<UserFeedbackRecord>;
  list(limit?: number): Promise<UserFeedbackRecord[]>;
}

/** 已接入的钉钉群（用于 ChatOps 群列表与 Web 策略页） */
export interface KnownGroup {
  conversationId: string;
  title: string | null;
  conversationType: '1' | '2';
  bystanderEnabled: boolean | null;
  proactiveReplyEnabled: boolean | null;
  lastActiveAt: number | null;
}

export interface GroupDirectory {
  listGroups(): Promise<KnownGroup[]>;
}

/** 单个 MCP 节点的连通性探测结果 */
export interface McpServerTestResult {
  serverId: string;
  ok: boolean;
  latencyMs: number;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  error?: string;
}

export interface McpServerStatusView {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  lastError: string | null;
}

/** ChatOps / Web 共用的 MCP 管控端口 */
export interface McpAdminPort {
  status(): McpServerStatusView[];
  healthCheck(): Promise<
    Array<{ serverId: string; healthy: boolean; latencyMs: number; error?: string }>
  >;
  reloadServer(serverId: string): Promise<
    Array<{
      serverId: string;
      originalName: string;
      namespacedName: string;
      description: string;
    }>
  >;
  applyServers(
    servers: EnterpriseMcpServerConfig[],
  ): Promise<
    Array<{
      serverId: string;
      originalName: string;
      namespacedName: string;
      description: string;
    }>
  >;
  /** 一键连通性测试（Web 管理台专用） */
  testServer?(serverId: string): Promise<McpServerTestResult>;
}

/** 沙盒对话测试结果（Web LLM 页面在线调试） */
export interface LlmSandboxTestResult {
  answer: string;
  reasoning: string;
  usage: { totalTokens: number; durationMs: number };
}

/** 管理后台仪表盘状态 */
export interface AdminDashboardStatus {
  stream: { connected: boolean; startedAt: number | null };
  model: string;
  mcpServers: McpServerStatusView[];
  today: TraceDailyStats;
  knownGroups: number;
}
