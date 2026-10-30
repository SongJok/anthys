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
  | 'RELOAD_MCP'
  | 'UPDATE_GROUP_POLICY'
  | 'EMERGENCY_MUTE'
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
export type ReActTraceStepType = 'reasoning' | 'tool' | 'sandbox' | 'answer';

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
