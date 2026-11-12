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
  webSearchEnabled: boolean;
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
  /** 对 SILENT 消息做只读后台调查，证据达标才浮出 */
  silentInvestigationEnabled: boolean;
  slidingWindowSize: number;
  cooldownSeconds: number;
  confidenceThreshold: number;
  triggerTopics: string[];
}

export type DefaultGroupPolicy = Omit<GroupPolicy, 'conversationId'>;

export interface GroupBotEntry {
  name: string;
  openBotId: string;
}

export interface GroupDirectoryEntry {
  conversationId: string;
  name: string;
  bots: GroupBotEntry[];
  botCount: number;
  source: 'dws' | 'stream' | 'manual';
  syncedAt: string;
  updatedAt: string;
}

export interface GroupDirectorySyncResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  withBots: number;
  syncedAt: string;
}

export interface KnownGroup {
  conversationId: string;
  title: string | null;
  conversationType: '1' | '2';
  bystanderEnabled: boolean | null;
  proactiveReplyEnabled: boolean | null;
  lastActiveAt: number | null;
  bots?: GroupBotEntry[];
  botCount?: number;
  /** 是否已订阅旁听长连接（决定能否收到非 @ 消息） */
  listening?: boolean;
  /** 该群是否有独立策略行；false 表示用全局默认 */
  policyOverridden?: boolean;
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

export interface UsageBreakdownRow {
  key: string;
  label: string;
  tokens: number;
  turns: number;
  costMicros: number;
}

export interface UsageSummary {
  sinceMs: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  totalCostMicros: number;
  pricedTurns: number;
  byUser: UsageBreakdownRow[];
  byConversation: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byWorker: UsageBreakdownRow[];
  byJobKind: UsageBreakdownRow[];
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
    | 'UPDATE_SCHEDULES'
    | 'UPDATE_RETENTION'
    | 'PURGE_DATA'
    | 'DELETE_USER_DATA'
    | 'UPDATE_GLOSSARY'
    | 'QUERY_STATS'
    | 'UPDATE_EXTENSIONS'
    | 'UPDATE_SKILL'
    | 'RELOAD_SKILLS'
    | 'INSTALL_PLUGIN'
    | 'ENABLE_PLUGIN'
    | 'DISABLE_PLUGIN'
    | 'UPGRADE_PLUGIN'
    | 'ROLLBACK_PLUGIN'
    | 'UNINSTALL_PLUGIN'
    | 'CREATE_PROJECT'
    | 'UPDATE_PROJECT'
    | 'SYNC_PROJECT'
    | 'DELETE_PROJECT'
    | 'GENERATE_PROJECT_HANDBOOK'
    | 'UPDATE_PROJECT_HANDBOOK'
    | 'PUBLISH_PROJECT_HANDBOOK'
    | 'UPDATE_PROJECT_MANUAL'
    | 'UPDATE_PERSONA'
    | 'DELETE_PERSONA'
    | 'BIND_PERSON_IDENTITY'
    | 'UPDATE_SEMANTIC_MEMORY'
    | 'DELETE_SEMANTIC_MEMORY'
    | 'TEST_GITHUB';
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

export type GlossaryTimeliness = 'long_term' | 'project' | 'retired';
export type GlossarySensitivity = 'public' | 'team' | 'sensitive';

export interface GlossaryTerm {
  id: string;
  standardName: string;
  aliases: string[];
  definition: string;
  usageScenarios: string;
  examples: string[];
  misconceptions: string;
  department: string;
  timeliness: GlossaryTimeliness;
  sensitivity: GlossarySensitivity;
  docLinks: string[];
  injectToPrompt: boolean;
  promptPriority: number;
  hitCount: number;
  lastUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface GlossaryStats {
  total: number;
  injected: number;
  retired: number;
  sensitive: number;
  missingDefinition: number;
  byTimeliness: Record<GlossaryTimeliness, number>;
  bySensitivity: Record<GlossarySensitivity, number>;
}

export type GlossaryValidationSeverity = 'error' | 'warning' | 'info';

export interface GlossaryValidationIssue {
  termId: string;
  standardName: string;
  severity: GlossaryValidationSeverity;
  field: string;
  message: string;
}

export interface GlossaryValidationReport {
  checked: number;
  errors: number;
  warnings: number;
  infos: number;
  issues: GlossaryValidationIssue[];
}

export interface GlossaryPromptPreview {
  prompt: string;
  terms: GlossaryTerm[];
}

export type GlossaryCandidateStatus = 'pending' | 'approved' | 'rejected';

/** 黑话候选：技能归纳的术语草稿，需管理员通过后才入库 */
export interface GlossaryCandidate {
  id: string;
  status: GlossaryCandidateStatus;
  standardName: string;
  aliases: string[];
  definition: string;
  usageScenarios: string;
  examples: string[];
  misconceptions: string;
  department: string;
  timeliness: GlossaryTimeliness;
  sensitivity: GlossarySensitivity;
  docLinks: string[];
  injectToPrompt: boolean;
  promptPriority: number;
  sourceConversationId: string;
  evidence: string;
  submittedBy: string;
  reviewedBy: string;
  reviewedAt: number | null;
  reviewNote: string;
  glossaryTermId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type GlossaryCandidateStats = Record<GlossaryCandidateStatus, number>;

/* ------------------------------------------------------------------ */
/* 技能、插件与项目手册                                                */
/* ------------------------------------------------------------------ */

export type SkillSource = 'builtin' | 'market' | 'local' | 'plugin';
export type SkillRisk = 'read' | 'write' | 'destructive';
export type SkillVisibility = 'public' | 'admin';

export interface SkillResourceInfo {
  path: string;
  sizeBytes: number;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  whenToUse: string;
  tags: string[];
  allowedTools: string[];
  risk: SkillRisk;
  visibility: SkillVisibility;
  source: SkillSource;
  /** 模块归属；builtin/market 由目录名决定，local/plugin 落 other */
  module: string;
  pluginId?: string;
  dir: string;
  body: string;
  bodyHash: string;
  maxInstructionChars: number;
  enabled: boolean;
  resources: SkillResourceInfo[];
  loadError?: string;
}

export interface SkillAdminView extends SkillDefinition {
  lastUsedAt: number | null;
  uses: number;
}

/** 分组头计数：total 是扫描到的数量，enabled 是数据库里真实生效的数量 */
export interface SkillModuleSummary {
  module: string;
  total: number;
  enabled: number;
  sources: SkillSource[];
}

export interface SkillDraftInput {
  name: string;
  description: string;
  version?: string;
  whenToUse: string;
  tags?: string[];
  allowedTools?: string[];
  risk?: SkillRisk;
  visibility?: SkillVisibility;
  maxInstructionChars?: number;
  body: string;
}

export interface SkillValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  bodyBytes: number;
  frontmatter?: {
    name: string;
    description: string;
    version?: string;
    when_to_use?: string;
    tags?: string[];
    allowed_tools?: string[];
    risk?: SkillRisk;
    visibility?: SkillVisibility;
    max_instruction_chars?: number;
    module?: string;
  };
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  source: SkillSource;
  module: string;
  score?: number;
}

export interface SkillPreviewEntry {
  skill: SkillCatalogEntry;
  score: number;
  matched: boolean;
  /** 名字是否真的出现在注入的提示词里；候选不等于已注入 */
  injected: boolean;
}

export interface SkillPreviewResult {
  prompt: string;
  entries: SkillPreviewEntry[];
  truncated: boolean;
}

export interface SkillUsageSummary {
  skillId: string;
  uses: number;
  lastUsedAt: number | null;
}

export interface SkillResourceReadResult {
  skillId: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine?: number;
  content: string;
  truncated: boolean;
}

export type PluginStatus =
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'error'
  | 'degraded';
export type PluginVersionStatus = PluginStatus | 'superseded';
export type PluginMcpDomain =
  | 'code'
  | 'data'
  | 'log'
  | 'apidoc'
  | 'business'
  | 'general';
export type PluginMcpTransport = 'stdio' | 'sse' | 'streamable-http';

export interface PluginMcpServerDecl {
  id: string;
  name: string;
  domain: PluginMcpDomain;
  transport: PluginMcpTransport;
  endpointOrCommand: string;
  args?: string[];
  envOrHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxResultChars?: number;
  enabled?: boolean;
}

export interface PluginSecretDecl {
  key: string;
  description?: string;
  required?: boolean;
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: string;
  homepage?: string;
  license?: string;
  engines: { agent: string };
  trust: 'declarative';
  skills?: string[];
  mcpServers?: PluginMcpServerDecl[];
  secrets?: PluginSecretDecl[];
  permissions?: { network?: string[]; filesystem?: 'none' };
  config?: Record<string, unknown>;
}

export interface PluginAdminView {
  id: string;
  name: string;
  activeVersion: string;
  status: PluginStatus;
  manifest: PluginManifest;
  installedBy: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  skills: Array<{
    id: string;
    name: string;
    enabled: boolean;
    loadError?: string;
  }>;
  mcpServerIds: string[];
  missingSecrets: string[];
  runtimeApplied: boolean;
}

export interface PluginVersionRecord {
  pluginId: string;
  version: string;
  manifest: PluginManifest;
  dir: string;
  checksum: string;
  status: PluginVersionStatus;
  installedAt: number;
}

export interface PluginValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface PluginSkillPreview {
  id: string;
  name: string;
  description: string;
  version: string;
  path: string;
  error?: string;
}

export interface PluginMcpPreview {
  id: string;
  name: string;
  transport: PluginMcpTransport;
  domain: PluginMcpDomain;
}

export interface PluginPackagePreview {
  manifest: PluginManifest;
  checksum: string;
  skills: PluginSkillPreview[];
  mcpServers: PluginMcpPreview[];
  warnings: PluginValidationIssue[];
  conflicts: PluginValidationIssue[];
  missingSecrets: string[];
  alreadyInstalled: { version: string; status: PluginStatus } | null;
  packageBytes: number;
}

export type ProjectSourceType = 'local' | 'github' | 'manual';
export type ProjectVisibility = 'team' | 'private' | 'admin';
export type ProjectSensitivity = 'team' | 'private';
export type ProjectSnapshotStatus =
  | 'building'
  | 'ready'
  | 'failed'
  | 'superseded';
export type ProjectSyncStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ProjectSource {
  type: ProjectSourceType;
  path?: string;
  branch?: string;
  repo?: string;
  ref?: string;
  depth?: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  source: ProjectSource;
  defaultBranch: string;
  ownerStaffIds: string[];
  visibility: ProjectVisibility;
  sensitivity: ProjectSensitivity;
  isDefault: boolean;
  enabled: boolean;
  autoSyncMinutes: number;
  activeSnapshotId?: string;
  lastCommit: string;
  lastSyncedAt?: number;
  handbookVersion: number;
  lastError?: string;
}

export interface ProjectSnapshot {
  id: string;
  projectId: string;
  commitSha: string;
  branch: string;
  status: ProjectSnapshotStatus;
  fileCount: number;
  totalBytes: number;
  symbolCount: number;
  chunkCount: number;
  stats: Record<string, unknown>;
  error: string;
  startedAt: number;
  finishedAt?: number;
}

export interface ProjectSyncJob {
  id: string;
  projectId: string;
  status: ProjectSyncStatus;
  trigger: 'manual' | 'schedule' | 'startup';
  snapshotId?: string;
  stats?: {
    files: number;
    bytes: number;
    symbols: number;
    chunks: number;
    skipped: number;
    durationMs: number;
    embeddedChunks?: number;
    embeddingError?: string;
  };
  error: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ProjectAdminEntry {
  project: ProjectRecord;
  snapshot: ProjectSnapshot | null;
  stale: boolean;
}

export interface ProjectIndexStatus {
  files: number;
  bytes: number;
  symbols: number;
  chunks: number;
  embeddedChunks: number;
  truncated: boolean;
  branch: string;
}

export interface ProjectStatus {
  project: ProjectRecord;
  snapshot: ProjectSnapshot | null;
  stale: boolean;
  embeddingEnabled: boolean;
  index: ProjectIndexStatus | null;
  latestJob: ProjectSyncJob | null;
  recentJobs: ProjectSyncJob[];
  handbook: {
    publishedVersion: number;
    draftVersion: number | null;
    stale: boolean;
  };
}

export interface GithubAdminStatus {
  enabled: boolean;
  ready: boolean;
  tokenConfigured: boolean;
  providerRegistered: boolean;
  toolsActive: boolean;
  apiBase: string;
  allowedHosts: string[];
  cacheTtlSeconds: number;
  defaultRepo: string;
  initError?: string;
  defaultRepoError?: string;
  hint: string;
}

export interface GithubConnectionTestResult {
  ok: boolean;
  repo: string;
  checkedAt: number;
  latencyMs: number;
  tokenConfigured: boolean;
  fullName?: string;
  defaultBranch?: string;
  private?: boolean;
  status?: number;
  rateLimited?: boolean;
  error?: string;
}

export interface ProjectSearchHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  language: string;
  score: number;
  content: string;
  match: 'fts' | 'trigram' | 'vector' | 'symbol' | 'path';
}

export interface ProjectSearchResult {
  projectId: string;
  commit: string;
  hits: ProjectSearchHit[];
  total: number;
  truncated: boolean;
  warning?: string;
  stale?: boolean;
}

export type HandbookSectionKey =
  | 'overview'
  | 'architecture'
  | 'modules'
  | 'data_model'
  | 'config'
  | 'deploy'
  | 'operations'
  | 'conventions'
  | 'testing'
  | 'decisions'
  | 'faq'
  | 'risks';

export interface HandbookSection {
  key: HandbookSectionKey;
  title: string;
  markdown: string;
  origin: 'deterministic' | 'curated' | 'generated';
  sources: Array<Record<string, unknown>>;
  updatedAt?: number;
}

export type HandbookStatus = 'draft' | 'published' | 'archived';
export type HandbookGeneratedBy = 'manual' | 'facts' | 'llm';

export interface ProjectHandbookRecord {
  id: string;
  projectId: string;
  version: number;
  status: HandbookStatus;
  commitSha: string;
  content: {
    sections: HandbookSection[];
    generatedAt: number;
    commit: string;
  };
  sources: Array<Record<string, unknown>>;
  generatedBy: HandbookGeneratedBy;
  createdBy: string;
  createdAt: number;
  publishedAt?: number;
}

export interface ProjectManualEntry {
  id: string;
  projectId: string;
  section: HandbookSectionKey;
  title: string;
  markdown: string;
  visibility: ProjectVisibility;
  sensitivity: ProjectSensitivity;
  injectToBrief: boolean;
  priority: number;
  updatedBy: string;
  updatedAt: number;
}

export interface ProjectManualEntryInput {
  section: HandbookSectionKey;
  title: string;
  markdown: string;
  visibility?: ProjectVisibility;
  sensitivity?: ProjectSensitivity;
  injectToBrief?: boolean;
  priority?: number;
}

export interface HandbookSectionPatch {
  key: HandbookSectionKey;
  title?: string;
  markdown: string;
}

export interface ProjectHandbookResult {
  projectId: string;
  version: number;
  status: HandbookStatus;
  commit: string;
  stale: boolean;
  content: {
    sections: HandbookSection[];
    generatedAt: number;
    commit: string;
  };
  manualEntries: ProjectManualEntry[];
}

export type PersonaScope = 'group' | 'user';

export interface PersonaProfile {
  scope: PersonaScope;
  subjectKey: string;
  name: string;
  rolePrompt: string;
  speakingStyle: string;
  enabled: boolean;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export type PersonIdentityAliasSource = 'staff' | 'open' | 'external' | 'manual';

export interface PersonIdentityAlias {
  alias: string;
  personKey: string;
  source: PersonIdentityAliasSource;
  displayName: string;
  updatedAt: number;
}

export interface PersonIdentity {
  personKey: string;
  displayName: string;
  aliases: PersonIdentityAlias[];
  mergedInto: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PersonIdentityBindResult {
  personKey: string;
  previousPersonKey: string | null;
  migratedMemories: number;
  migratedPersonas: number;
}

export type SemanticMemoryScope = 'global' | 'group' | 'user';
export type SemanticMemoryKind = 'terminology' | 'profile';
export type SemanticMemoryStatus = 'active' | 'retired';
export type SemanticMemorySensitivity = 'normal' | 'private' | 'sensitive';

export interface SemanticMemory {
  id: string;
  scope: SemanticMemoryScope;
  subjectKey: string;
  kind: SemanticMemoryKind;
  content: string;
  keywords: string[];
  embedding: number[] | null;
  shareableInGroup: boolean;
  sensitivity: SemanticMemorySensitivity;
  status: SemanticMemoryStatus;
  sourceConversationId: string | null;
  sourceConversationType: '1' | '2' | null;
  sourceMessageId: string | null;
  confidence: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SemanticMemoryPage {
  total: number;
  items: SemanticMemory[];
}

export type GroupGoalStatus = 'active' | 'achieved' | 'paused' | 'archived';
export type GroupTaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';

export interface GroupWorkspaceRecord {
  conversationId: string;
  title: string;
  purpose: string;
  responsibilities: string[];
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupGoalRecord {
  id: string;
  conversationId: string;
  title: string;
  detail: string;
  status: GroupGoalStatus;
  progress: number;
  ownerPersonKey: string | null;
  ownerName: string;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupTaskRecord {
  id: string;
  conversationId: string;
  goalId: string | null;
  title: string;
  detail: string;
  status: GroupTaskStatus;
  assigneePersonKey: string | null;
  assigneeName: string;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface GroupWorkspaceSnapshot {
  workspace: GroupWorkspaceRecord;
  goals: GroupGoalRecord[];
  tasks: GroupTaskRecord[];
}

export type GroupModelProvider = '' | 'openai-compatible' | 'anthropic';

export interface GroupModelRoute {
  conversationId: string;
  enabled: boolean;
  provider: GroupModelProvider;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  temperature: number | null;
  thinking: '' | 'off' | 'auto' | 'low' | 'high' | 'max';
  maxTokens: number | null;
  updatedBy: string;
  updatedAt: number;
}

export type ReplyLength = 'concise' | 'balanced' | 'detailed';
export type PreferenceLanguage = 'auto' | 'zh' | 'en';
export type GroupMemorySharing = 'off' | 'shareable' | 'all';

export interface PersonPreferences {
  personKey: string;
  replyLength: ReplyLength;
  language: PreferenceLanguage;
  addressAs: string;
  extraInstructions: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: number;
}

export interface PersonMemoryConsent {
  personKey: string;
  groupSharing: GroupMemorySharing;
  allowedConversationIds: string[];
  updatedBy: string;
  updatedAt: number;
}

export type WhitelistStatus = 'pending' | 'approved' | 'rejected' | 'left';
export type WhitelistSource = 'directory' | 'dws' | 'auto' | 'manual';

export interface WhitelistEntry {
  staffId: string;
  name: string;
  deptPath: string;
  status: WhitelistStatus;
  source: WhitelistSource;
  openDingTalkId: string | null;
  note: string;
  approvedBy: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhitelistStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  left: number;
  syncedAt: string | null;
}

export interface WhitelistPage {
  items: WhitelistEntry[];
  total: number;
  page: number;
  pageSize: number;
  stats: WhitelistStats;
}

export interface WhitelistSyncResult {
  source: 'dingtalk-api' | 'dws';
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  left: number;
  skipped: number;
  warnings: string[];
  syncedAt: string;
}

export type ScheduledTaskKind =
  | 'prompt'
  | 'reminder'
  | 'daily_report'
  | 'weekly_report'
  | 'monthly_report'
  | 'group_report';

export interface ScheduledTask {
  id: string;
  conversationId: string;
  conversationType: '1' | '2';
  kind: ScheduledTaskKind;
  title: string;
  prompt: string;
  intervalSeconds: number | null;
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
  kind?: ScheduledTaskKind;
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

/** 系统级周期循环（只读展示，由 env/内置默认驱动，非用户定时任务） */
export interface SystemLoopStatus {
  id: string;
  name: string;
  purpose: string;
  intervalSeconds: number | null;
  intervalLabel: string;
  source: string;
  running: boolean;
  leaderGated: boolean;
  notes?: string;
}
