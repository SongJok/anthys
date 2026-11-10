/**
 * 技能、声明式插件与项目手册的公共契约。
 *
 * 约束：
 * - 插件只允许声明式内容（技能 + MCP + 资源 + 密钥引用），不执行任意代码；
 * - 技能正文只能通过 ToolExecutionOutput.instructions 进入系统提示词；
 * - 项目快照不可变，所有索引数据都归属某个 snapshot。
 */

export type SkillSource = 'builtin' | 'market' | 'local' | 'plugin';
export type SkillVisibility = 'public' | 'admin';
export type SkillRisk = 'read' | 'write' | 'destructive';

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  when_to_use?: string;
  tags?: string[];
  allowed_tools?: string[];
  risk?: SkillRisk;
  visibility?: SkillVisibility;
  max_instruction_chars?: number;
  /** 目录名已经是模块真相时，这里只作声明；两者冲突以目录名为准 */
  module?: string;
}

export interface SkillResourceInfo {
  /** 相对技能目录的路径，例如 references/checklist.md */
  path: string;
  sizeBytes: number;
}

export interface SkillDefinition {
  /** builtin:name | market:name | local:name | plugin:pluginId:name */
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
  /** 模块归属；不进 id，所以调整模块划分不会丢启用状态 */
  module: string;
  pluginId?: string;
  dir: string;
  /** 已解析的 Markdown 正文 */
  body: string;
  bodyHash: string;
  maxInstructionChars: number;
  enabled: boolean;
  resources: SkillResourceInfo[];
  loadError?: string;
}

/** 常驻在系统提示词里的技能目录条目 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  source: SkillSource;
  module: string;
  score?: number;
}

export interface SkillSearchMatch extends SkillCatalogEntry {
  tags: string[];
  allowedTools: string[];
  score: number;
}

export interface SkillSearchResult {
  matches: SkillSearchMatch[];
  total: number;
}

export interface SkillCatalogResult {
  /** 已渲染的“可用技能”提示词片段，未命中时为空字符串 */
  prompt: string;
  entries: SkillCatalogEntry[];
  total: number;
  truncated: boolean;
}

export interface SkillContextInput {
  query?: string;
  conversationType: '1' | '2';
  isAdmin: boolean;
  projectId?: string;
  limit?: number;
}

export type SkillUsageAction = 'search' | 'load' | 'read';

export interface SkillUsageRecord {
  skillId: string;
  conversationId: string;
  senderStaffId: string;
  action: SkillUsageAction;
  createdAt: number;
}

export interface SkillUsageSummary {
  skillId: string;
  uses: number;
  lastUsedAt: number | null;
}

export interface SkillLoadResult {
  skill: SkillDefinition;
  /** 受控注入正文；超长时为空，需要继续 skill_read */
  instructions?: string;
  /** 超长时返回的目录与资源清单 */
  outline: string;
  truncated: boolean;
  resources: SkillResourceInfo[];
}

export interface SkillResourceReadRequest {
  name: string;
  path: string;
  startLine?: number;
  endLine?: number;
  isAdmin: boolean;
  conversationId?: string;
  senderStaffId?: string;
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

export interface SkillAdminView extends SkillDefinition {
  lastUsedAt: number | null;
  uses: number;
}

/** 控制台分组头；计数按数据库里真实的 enabled 算，不是扫描总数 */
export interface SkillModuleSummary {
  module: string;
  total: number;
  enabled: number;
  sources: SkillSource[];
}

export interface SkillAdminPort {
  list(): Promise<SkillAdminView[]>;
  listModules(): Promise<SkillModuleSummary[]>;
  reload(): Promise<{ loaded: number; errors: string[] }>;
  setEnabled(id: string, enabled: boolean): Promise<SkillDefinition>;
  preview(input: SkillContextInput): Promise<SkillPreviewResult>;
  readResource(
    input: Omit<SkillResourceReadRequest, 'isAdmin'>,
  ): Promise<SkillResourceReadResult>;
  usage?(days?: number): Promise<Record<string, SkillUsageSummary>>;
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
  frontmatter?: SkillFrontmatter;
  bodyBytes: number;
}

export interface SkillResourceWriteInput {
  path: string;
  content: string;
}

/** 管理员维护 skills/local 下的技能文件；内置与插件技能只读 */
export interface SkillFileAdminPort {
  create(input: SkillDraftInput): Promise<SkillDefinition>;
  update(id: string, input: SkillDraftInput): Promise<SkillDefinition>;
  remove(id: string): Promise<void>;
  validate(input: SkillDraftInput): SkillValidationResult;
  writeResource(
    id: string,
    input: SkillResourceWriteInput,
  ): Promise<SkillResourceInfo>;
  removeResource(id: string, path: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 声明式插件                                                          */
/* ------------------------------------------------------------------ */

export type PluginStatus =
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'error'
  | 'degraded';
export type PluginVersionStatus = PluginStatus | 'superseded';
export type PluginTrust = 'declarative';

export interface PluginMcpServerDecl {
  id: string;
  name: string;
  domain: 'code' | 'data' | 'log' | 'apidoc' | 'business' | 'general';
  transport: 'stdio' | 'sse' | 'streamable-http';
  endpointOrCommand: string;
  args?: string[];
  envOrHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxResultChars?: number;
  enabled?: boolean;
}

export interface PluginSecretDecl {
  /** 环境变量名，例如 GITHUB_TOKEN */
  key: string;
  description?: string;
  required?: boolean;
}

export interface PluginPermissions {
  /** 允许访问的主机名；仅作展示与审计，不改变运行时权限 */
  network?: string[];
  filesystem?: 'none';
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
  trust: PluginTrust;
  /** 相对插件根目录的技能目录，默认 skills */
  skills?: string[];
  mcpServers?: PluginMcpServerDecl[];
  secrets?: PluginSecretDecl[];
  permissions?: PluginPermissions;
  /** 可选 JSON Schema；第一期只展示，不注入提示词 */
  config?: Record<string, unknown>;
}

export interface PluginRecord {
  id: string;
  name: string;
  activeVersion: string;
  status: PluginStatus;
  manifest: PluginManifest;
  installedBy: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
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

export interface PluginInstallInput {
  /** 已落盘的插件目录（zip 解包后） */
  dir: string;
  installedBy: string;
  /** 覆盖安装时允许同版本重装 */
  force?: boolean;
  /** 允许缺失必需密钥先装后配；插件保持禁用 */
  allowMissingSecrets?: boolean;
}

export interface PluginInstallResult {
  plugin: PluginAdminView;
  version: PluginVersionRecord;
  skills: string[];
  mcpServers: string[];
  warnings: PluginValidationIssue[];
}

export interface PluginAdminView extends PluginRecord {
  skills: Array<{ id: string; name: string; enabled: boolean; loadError?: string }>;
  mcpServerIds: string[];
  missingSecrets: string[];
  /** 当前生效的 MCP 是否已连接到运行时 */
  runtimeApplied: boolean;
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
  transport: PluginMcpServerDecl['transport'];
  domain: PluginMcpServerDecl['domain'];
}

export interface PluginPackagePreview {
  manifest: PluginManifest;
  checksum: string;
  skills: PluginSkillPreview[];
  mcpServers: PluginMcpPreview[];
  warnings: PluginValidationIssue[];
  /** 命名空间或技能名冲突；存在 error 级问题时不能安装 */
  conflicts: PluginValidationIssue[];
  missingSecrets: string[];
  alreadyInstalled: { version: string; status: PluginStatus } | null;
  packageBytes: number;
}

export interface PluginValidateInput {
  /** 已解包的插件目录；与 zipPath 二选一 */
  dir?: string;
  zipPath?: string;
  allowMissingSecrets?: boolean;
}

export interface PluginZipInstallInput {
  zipPath: string;
  installedBy: string;
  force?: boolean;
  allowMissingSecrets?: boolean;
  mode?: 'install' | 'upgrade';
}

export interface PluginAdminPort {
  list(): Promise<PluginAdminView[]>;
  get?(id: string): Promise<PluginAdminView>;
  versions?(id: string): Promise<PluginVersionRecord[]>;
  validatePackage?(input: PluginValidateInput): Promise<PluginPackagePreview>;
  install(input: PluginInstallInput): Promise<PluginInstallResult>;
  installFromZip?(input: PluginZipInstallInput): Promise<PluginInstallResult>;
  enable(id: string): Promise<PluginAdminView>;
  disable(id: string): Promise<PluginAdminView>;
  upgrade(input: PluginInstallInput): Promise<PluginInstallResult>;
  rollback(id: string, version: string): Promise<PluginAdminView>;
  uninstall(id: string, options?: { deleteFiles?: boolean }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 项目与代码索引                                                      */
/* ------------------------------------------------------------------ */

export type ProjectSourceType = 'local' | 'github' | 'manual';
export type ProjectVisibility = 'team' | 'private' | 'admin';
export type ProjectSensitivity = 'team' | 'private';
export type ProjectSnapshotStatus = 'building' | 'ready' | 'failed' | 'superseded';
export type ProjectSyncStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type ProjectDocumentKind = 'code' | 'doc' | 'config' | 'test' | 'other';

export type ProjectSource =
  | { type: 'local'; path: string; branch?: string }
  | { type: 'github'; repo: string; ref?: string; depth?: number }
  | { type: 'manual' };

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

export interface ProjectCreateInput {
  id: string;
  name: string;
  aliases?: string[];
  description?: string;
  source: ProjectSource;
  defaultBranch?: string;
  ownerStaffIds?: string[];
  visibility?: ProjectVisibility;
  sensitivity?: ProjectSensitivity;
  isDefault?: boolean;
  enabled?: boolean;
  autoSyncMinutes?: number;
}

export type ProjectUpdateInput = Partial<
  Omit<ProjectCreateInput, 'id'>
>;

export interface ProjectMemberContextInput {
  senderStaffId: string;
  isAdmin: boolean;
  conversationType: '1' | '2';
}

export interface ProjectBriefInput extends ProjectMemberContextInput {
  text: string;
  maxChars?: number;
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

export interface ProjectDocument {
  id: string;
  projectId: string;
  snapshotId: string;
  path: string;
  language: string;
  kind: ProjectDocumentKind;
  contentHash: string;
  sizeBytes: number;
  lineCount: number;
  text: string;
}

export interface ProjectChunk {
  id: string;
  projectId: string;
  snapshotId: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  kind: ProjectDocumentKind;
  content: string;
  contentHash: string;
  tokenCount: number;
}

export interface ProjectSymbol {
  id: string;
  projectId: string;
  snapshotId: string;
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
  parent: string;
  exported: boolean;
}

export interface ProjectSyncStats {
  files: number;
  bytes: number;
  symbols: number;
  chunks: number;
  skipped: number;
  durationMs: number;
  /** 已写入向量的分块数；未配置 embedding 时为 0 */
  embeddedChunks?: number;
  /** 向量化失败原因；失败时同步仍成功，检索自动退回关键词 */
  embeddingError?: string;
}

export interface ProjectSyncJob {
  id: string;
  projectId: string;
  status: ProjectSyncStatus;
  trigger: 'manual' | 'schedule' | 'startup';
  snapshotId?: string;
  stats?: ProjectSyncStats;
  error: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ProjectSyncResult {
  project: ProjectRecord;
  snapshot: ProjectSnapshot;
  stats: ProjectSyncStats;
}

export type ProjectSearchMode =
  | 'hybrid'
  | 'keyword'
  | 'symbol'
  | 'path';

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

export interface ProjectFileEntry {
  path: string;
  language: string;
  kind: ProjectDocumentKind;
  sizeBytes: number;
  lineCount: number;
}

export interface ProjectReadResult {
  projectId: string;
  commit: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine?: number;
  content: string;
  truncated: boolean;
  stale?: boolean;
}

export interface ProjectSymbolResult {
  projectId: string;
  commit: string;
  symbol: string;
  definitions: ProjectSymbol[];
  references: Array<{ path: string; line: number; snippet: string }>;
}

export interface ProjectMapNode {
  path: string;
  language: string;
  symbols: Array<{ name: string; kind: string; startLine: number; exported: boolean }>;
}

export interface ProjectMapResult {
  projectId: string;
  commit: string;
  modules: ProjectMapNode[];
  totalFiles: number;
  truncated: boolean;
  /** 已渲染的目录树文本；模块列表用于结构化展示 */
  text: string;
  stale?: boolean;
}

export interface ProjectCommitEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface ProjectHistoryResult {
  projectId: string;
  commit: string;
  kind: 'commits' | 'blame' | 'issues' | 'prs';
  commits: ProjectCommitEntry[];
  /** kind 为 issues/prs 时的 GitHub 条目 */
  issues?: GithubIssueInfo[];
  total?: number;
  note?: string;
}

export interface ProjectBrief {
  projectId: string;
  text: string;
  commit: string;
  handbookVersion: number;
  stale: boolean;
}

export interface ProjectMemberContext {
  senderStaffId: string;
  isAdmin: boolean;
}

/* ------------------------------------------------------------------ */
/* 项目手册                                                            */
/* ------------------------------------------------------------------ */

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

export interface HandbookSource {
  path?: string;
  startLine?: number;
  endLine?: number;
  url?: string;
  commit?: string;
  note?: string;
}

export interface HandbookSection {
  key: HandbookSectionKey;
  title: string;
  markdown: string;
  /** deterministic：扫描器生成；curated：人工维护；generated：模型生成后发布 */
  origin: 'deterministic' | 'curated' | 'generated';
  sources: HandbookSource[];
  updatedAt?: number;
}

export interface HandbookContent {
  sections: HandbookSection[];
  generatedAt: number;
  commit: string;
}

export type HandbookStatus = 'draft' | 'published' | 'archived';
export type HandbookGeneratedBy = 'manual' | 'facts' | 'llm';

export interface ProjectHandbookRecord {
  id: string;
  projectId: string;
  version: number;
  status: HandbookStatus;
  commitSha: string;
  content: HandbookContent;
  sources: HandbookSource[];
  generatedBy: HandbookGeneratedBy;
  createdBy: string;
  createdAt: number;
  publishedAt?: number;
}

export interface ProjectHandbookResult {
  projectId: string;
  version: number;
  status: HandbookStatus;
  commit: string;
  stale: boolean;
  content: HandbookContent;
  manualEntries: ProjectManualEntry[];
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

export type ProjectManualEntryPatch = Partial<ProjectManualEntryInput>;

export interface HandbookSectionPatch {
  key: HandbookSectionKey;
  title?: string;
  markdown: string;
}

export interface ProjectHandbookDraftInput {
  /** 以指定版本为基线；省略时优先最新草稿，其次最新发布版 */
  version?: number;
  sections: HandbookSectionPatch[];
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

/** 管理控制台使用的项目端口；成员过滤由适配器以管理员上下文处理 */
export interface ProjectAdminPort {
  list(includeUnavailable?: boolean): Promise<ProjectAdminEntry[]>;
  get(id: string): Promise<ProjectRecord | null>;
  create(input: ProjectCreateInput): Promise<ProjectRecord>;
  update(id: string, patch: ProjectUpdateInput): Promise<ProjectRecord>;
  remove(id: string): Promise<void>;
  /** 创建排队任务并异步执行，立即返回任务记录 */
  queueSync(id: string, trigger?: ProjectSyncJob['trigger']): Promise<ProjectSyncJob>;
  listSyncJobs(id: string, limit?: number): Promise<ProjectSyncJob[]>;
  listSnapshots(id: string, limit?: number): Promise<ProjectSnapshot[]>;
  search(id: string, query: string, limit?: number): Promise<ProjectSearchResult>;
  status?(id: string): Promise<ProjectStatus>;
  handbook?(id: string): Promise<ProjectHandbookResult>;
  handbookDraft?(id: string): Promise<ProjectHandbookRecord | null>;
  manualEntries?(id: string): Promise<ProjectManualEntry[]>;
  handbookVersions?(id: string, limit?: number): Promise<ProjectHandbookRecord[]>;
  generateHandbook?(id: string): Promise<ProjectHandbookRecord>;
  saveHandbookDraft?(
    id: string,
    input: ProjectHandbookDraftInput,
  ): Promise<ProjectHandbookRecord>;
  publishHandbook?(id: string, version?: number): Promise<ProjectHandbookRecord>;
  createManualEntry?(
    id: string,
    input: ProjectManualEntryInput,
  ): Promise<ProjectManualEntry>;
  updateManualEntry?(
    id: string,
    entryId: string,
    patch: ProjectManualEntryPatch,
  ): Promise<ProjectManualEntry>;
  deleteManualEntry?(id: string, entryId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export interface GithubRepoInfo {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  stars: number;
  updatedAt: string;
  topics: string[];
  language: string;
  license: string;
}

export interface GithubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
}

export interface GithubFileResult {
  path: string;
  sha: string;
  size: number;
  encoding: string;
  content: string;
  truncated: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine?: number;
}

export interface GithubTreeResult {
  entries: GithubTreeEntry[];
  truncated: boolean;
  ref: string;
}

export interface GithubCodeSearchItem {
  path: string;
  name: string;
  htmlUrl: string;
  textMatches: string[];
}

export interface GithubCodeSearchResult {
  items: GithubCodeSearchItem[];
  total: number;
  truncated: boolean;
}

export interface GithubIssueSearchResult {
  kind: 'issues' | 'prs';
  items: GithubIssueInfo[];
  total: number;
}

export interface GithubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GithubPullRequestResult {
  info: GithubPullRequestInfo;
  files: GithubPullRequestFile[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface GithubHistoryItem {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  updatedAt: string;
  kind: 'issue' | 'pr';
}

export interface GithubPullRequestInfo {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  author: string;
  head: string;
  base: string;
  htmlUrl: string;
  body: string;
  comments: number;
  reviewComments: number;
  commits: number;
  createdAt: string;
  updatedAt: string;
}

export interface GithubIssueInfo {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  htmlUrl: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubSearchItem {
  name: string;
  fullName: string;
  description: string;
  stars: number;
  language: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface GithubSearchResult {
  items: GithubSearchItem[];
  total: number;
}

/** 进程内 GitHub 运行状态；enabled 与 ready 分离，避免把 .env 默认值当成已生效 */
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

export interface GithubAdminPort {
  status(): Promise<GithubAdminStatus>;
  /** repo 省略时使用默认项目的 GitHub 仓库；返回结构化失败而不是抛错 */
  test(repo?: string): Promise<GithubConnectionTestResult>;
}

/* ------------------------------------------------------------------ */
/* 配置与校验辅助                                                      */
/* ------------------------------------------------------------------ */

export interface ExtensionsConfig {
  skillsEnabled: boolean;
  pluginsEnabled: boolean;
  projectsEnabled: boolean;
  defaultProjectId: string;
  skillCatalogLimit: number;
  /** 注入系统提示的"## 可用技能"段总字符预算；模块摘要占 40%，明细占 60% */
  skillCatalogMaxChars: number;
  projectBriefMaxChars: number;
}

export const DEFAULT_EXTENSIONS_CONFIG: ExtensionsConfig = {
  skillsEnabled: true,
  pluginsEnabled: true,
  projectsEnabled: true,
  defaultProjectId: '',
  skillCatalogLimit: 20,
  skillCatalogMaxChars: 1_600,
  projectBriefMaxChars: 2_000,
};

export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
export const SKILL_MODULE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
/** 与 SkillSource 同名的模块名会与 source 语义混淆，禁止使用 */
export const RESERVED_SKILL_MODULES: readonly string[] = [
  'builtin',
  'market',
  'local',
  'plugin',
];
export const DEFAULT_SKILL_MODULE = 'other';

const SKILL_SOURCES: readonly SkillSource[] = [
  'builtin',
  'market',
  'local',
  'plugin',
];
const SKILL_VISIBILITIES: readonly SkillVisibility[] = ['public', 'admin'];
const SKILL_RISKS: readonly SkillRisk[] = ['read', 'write', 'destructive'];
const PROJECT_VISIBILITIES: readonly ProjectVisibility[] = [
  'team',
  'private',
  'admin',
];
const PROJECT_SENSITIVITIES: readonly ProjectSensitivity[] = ['team', 'private'];
const HANDBOOK_SECTIONS: readonly HandbookSectionKey[] = [
  'overview',
  'architecture',
  'modules',
  'data_model',
  'config',
  'deploy',
  'operations',
  'conventions',
  'testing',
  'decisions',
  'faq',
  'risks',
];

export function isSkillSource(value: unknown): value is SkillSource {
  return SKILL_SOURCES.includes(value as SkillSource);
}

export function isSkillModule(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SKILL_MODULE_PATTERN.test(value) &&
    !RESERVED_SKILL_MODULES.includes(value)
  );
}

export function isSkillVisibility(value: unknown): value is SkillVisibility {
  return SKILL_VISIBILITIES.includes(value as SkillVisibility);
}

export function isSkillRisk(value: unknown): value is SkillRisk {
  return SKILL_RISKS.includes(value as SkillRisk);
}

export function isProjectVisibility(
  value: unknown,
): value is ProjectVisibility {
  return PROJECT_VISIBILITIES.includes(value as ProjectVisibility);
}

export function isProjectSensitivity(
  value: unknown,
): value is ProjectSensitivity {
  return PROJECT_SENSITIVITIES.includes(value as ProjectSensitivity);
}

export function isHandbookSectionKey(
  value: unknown,
): value is HandbookSectionKey {
  return HANDBOOK_SECTIONS.includes(value as HandbookSectionKey);
}

export const HANDBOOK_SECTION_TITLES: Record<HandbookSectionKey, string> = {
  overview: '项目概览',
  architecture: '架构设计',
  modules: '模块地图',
  data_model: '数据模型',
  config: '配置与密钥',
  deploy: '构建与部署',
  operations: '运维与故障',
  conventions: '编码约定',
  testing: '测试与验收',
  decisions: '历史决策',
  faq: '常见问题',
  risks: '风险与边界',
};

export function buildSkillId(
  source: SkillSource,
  name: string,
  pluginId?: string,
): string {
  if (source === 'plugin') {
    if (!pluginId) throw new Error('插件技能缺少 pluginId');
    return `plugin:${pluginId}:${name}`;
  }
  return `${source}:${name}`;
}
