import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingClient } from '../memory/EmbeddingClient.js';
import type {
  GithubIssueInfo,
  HandbookContent,
  HandbookSection,
  ProjectBrief,
  ProjectBriefInput,
  ProjectCreateInput,
  ProjectDocument,
  ProjectHandbookDraftInput,
  ProjectHandbookRecord,
  ProjectHandbookResult,
  ProjectHistoryResult,
  ProjectManualEntry,
  ProjectManualEntryInput,
  ProjectManualEntryPatch,
  ProjectMapResult,
  ProjectMemberContextInput,
  ProjectReadResult,
  ProjectRecord,
  ProjectSearchResult,
  ProjectSnapshot,
  ProjectStatus,
  ProjectSymbol,
  ProjectSymbolResult,
  ProjectSyncJob,
  ProjectSyncResult,
  ProjectSyncStats,
  ProjectUpdateInput,
} from '../types/skills-plugins-projects.js';
import {
  HANDBOOK_SECTION_TITLES,
  isHandbookSectionKey,
  isProjectSensitivity,
  isProjectVisibility,
  PROJECT_ID_PATTERN,
} from '../types/skills-plugins-projects.js';
import {
  buildChunks,
  buildRepoMap,
  extractSymbols,
  renderRepoMap,
} from './CodeIndexer.js';
import { buildHandbook } from './HandbookBuilder.js';
import {
  canReadProjectContent,
  hasCodeHint,
  isProjectVisible,
  matchProjectsByText,
  ProjectResolutionError,
  resolveProject,
} from './ProjectRegistry.js';
import { RepoSource, ProjectSourceError } from './RepoSource.js';
import { scanRepository, type RepoScanOptions } from './RepoScanner.js';
import {
  ProjectSearchService,
  type ProjectSearchServiceLogger,
} from './ProjectSearchService.js';
import type {
  ProjectDocumentMeta,
  ProjectSearchCandidateInput,
  ProjectStore,
} from './ProjectStore.js';

const DEFAULT_KEEP_SNAPSHOTS = 3;
const DEFAULT_BRIEF_MAX_CHARS = 2_000;
const MAX_ALIASES = 10;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const LOCKFILE_PATTERN =
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/u;

export interface ProjectServiceLogger extends ProjectSearchServiceLogger {
  info?(obj: Record<string, unknown>, message: string): void;
}

export interface ProjectGithubHistoryPort {
  search(
    repoRef: string,
    query: string,
    options: { kind: 'issues' | 'prs'; limit?: number },
  ): Promise<{ items: GithubIssueInfo[]; total: number }>;
}

export interface ProjectServiceOptions {
  store: ProjectStore;
  repoSource: RepoSource;
  searchService?: ProjectSearchService;
  embedder?: EmbeddingClient;
  github?: ProjectGithubHistoryPort;
  defaultProjectId?: () => string | Promise<string>;
  logger?: ProjectServiceLogger;
  now?: () => number;
  keepSnapshots?: number;
  briefMaxChars?: number;
  scanOptions?: RepoScanOptions;
}

export class ProjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectNotIndexedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectNotIndexedError';
  }
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

export interface ProjectListEntry {
  project: ProjectRecord;
  snapshot: ProjectSnapshot | null;
  stale: boolean;
}

export interface ProjectReadInput {
  projectRef?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  member: ProjectMemberContextInput;
}

export interface ProjectMapInput {
  projectRef?: string;
  path?: string;
  maxTokens?: number;
  member: ProjectMemberContextInput;
}

export interface ProjectSearchToolInput {
  projectRef?: string;
  query: string;
  kind?: 'all' | 'code' | 'doc' | 'symbol';
  pathGlob?: string;
  language?: string;
  limit?: number;
  member: ProjectMemberContextInput;
}

export interface ProjectSymbolInput {
  projectRef?: string;
  name: string;
  kind?: string;
  pathGlob?: string;
  limit?: number;
  member: ProjectMemberContextInput;
}

export interface ProjectHistoryInput {
  projectRef?: string;
  path?: string;
  kind?: 'commits' | 'blame' | 'issues' | 'prs';
  /** issues/prs 关键词；留空看最近更新 */
  query?: string;
  limit?: number;
  member: ProjectMemberContextInput;
}

export interface ProjectHandbookInput {
  projectRef?: string;
  section?: string;
  format?: 'summary' | 'full';
  member: ProjectMemberContextInput;
}

export interface ProjectHandbookToolResult extends ProjectHandbookResult {
  project: ProjectRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function normalizeAliases(
  aliases: string[] | undefined,
  projectId: string,
  name: string,
): string[] {
  const seen = new Set([projectId.toLowerCase(), name.toLowerCase()]);
  const normalized: string[] = [];
  for (const alias of aliases ?? []) {
    const value = alias.trim();
    if (!value || value.length > 64) continue;
    const lower = value.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalized.push(value);
    if (normalized.length >= MAX_ALIASES) break;
  }
  return normalized;
}

function normalizeStaffIds(ids: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (ids ?? [])
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 128),
    ),
  ).slice(0, 50);
}

function normalizeSource(
  source: ProjectCreateInput['source'],
): ProjectCreateInput['source'] {
  if (source.type === 'manual') return { type: 'manual' };
  if (source.type === 'local') {
    const sourcePath = source.path.trim();
    if (!sourcePath) throw new ProjectValidationError('本地项目必须填写路径');
    return {
      type: 'local',
      path: sourcePath,
      ...(source.branch?.trim() ? { branch: source.branch.trim() } : {}),
    };
  }
  if (source.type === 'github') {
    const repo = source.repo.trim();
    if (!GITHUB_REPO_PATTERN.test(repo)) {
      throw new ProjectValidationError(
        'GitHub 仓库格式应为 owner/name',
      );
    }
    return {
      type: 'github',
      repo,
      ...(source.ref?.trim() ? { ref: source.ref.trim() } : {}),
      ...(source.depth !== undefined
        ? { depth: Math.min(Math.max(Math.trunc(source.depth), 1), 50) }
        : {}),
    };
  }
  throw new ProjectValidationError('未支持的项目来源类型');
}

function normalizeCreateInput(input: ProjectCreateInput): ProjectRecord {
  const id = input.id.trim().toLowerCase();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new ProjectValidationError(
      '项目 ID 只能包含小写字母、数字、下划线和短横线（2-64 位）',
    );
  }
  const name = input.name.trim();
  if (!name || name.length > 100) {
    throw new ProjectValidationError('项目名称不能为空且不能超过 100 字符');
  }
  const description = (input.description ?? '').trim().slice(0, 2_000);
  const visibility = isProjectVisibility(input.visibility)
    ? input.visibility
    : 'team';
  const sensitivity = isProjectSensitivity(input.sensitivity)
    ? input.sensitivity
    : 'team';
  const autoSyncMinutes = Math.min(
    Math.max(Math.trunc(input.autoSyncMinutes ?? 0), 0),
    1_440,
  );
  return {
    id,
    name,
    aliases: normalizeAliases(input.aliases, id, name),
    description,
    source: normalizeSource(input.source),
    defaultBranch: (input.defaultBranch ?? 'main').trim() || 'main',
    ownerStaffIds: normalizeStaffIds(input.ownerStaffIds),
    visibility,
    sensitivity,
    isDefault: input.isDefault ?? false,
    enabled: input.enabled ?? true,
    autoSyncMinutes,
    lastCommit: '',
    handbookVersion: 0,
    lastError: '',
  };
}

export class ProjectService {
  private readonly store: ProjectStore;
  private readonly repoSource: RepoSource;
  private readonly searchService: ProjectSearchService;
  private readonly embedder?: EmbeddingClient;
  private readonly github?: ProjectGithubHistoryPort;
  private readonly defaultProjectId: () => string | Promise<string>;
  private readonly logger?: ProjectServiceLogger;
  private readonly now: () => number;
  private readonly keepSnapshots: number;
  private readonly briefMaxChars: number;
  private readonly scanOptions: RepoScanOptions;
  private readonly locks = new Map<string, Promise<ProjectSyncResult>>();

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.repoSource = options.repoSource;
    this.embedder = options.embedder;
    this.searchService =
      options.searchService ??
      new ProjectSearchService({
        store: options.store,
        ...(options.embedder ? { embedder: options.embedder } : {}),
        logger: options.logger,
      });
    this.github = options.github;
    this.defaultProjectId = options.defaultProjectId ?? (() => '');
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.keepSnapshots = options.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS;
    this.briefMaxChars = options.briefMaxChars ?? DEFAULT_BRIEF_MAX_CHARS;
    this.scanOptions = options.scanOptions ?? {};
  }

  public async listProjects(
    member: ProjectMemberContextInput,
    includeUnavailable = false,
  ): Promise<ProjectListEntry[]> {
    const projects = await this.store.listProjects();
    const visible = includeUnavailable && member.isAdmin
      ? projects
      : projects.filter((project) => isProjectVisible(project, member));
    const entries: ProjectListEntry[] = [];
    for (const project of visible) {
      const snapshot = await this.findActiveSnapshot(project);
      entries.push({
        project,
        snapshot,
        stale: await this.computeStale(project, snapshot),
      });
    }
    return entries;
  }

  public async createProject(
    input: ProjectCreateInput,
  ): Promise<ProjectRecord> {
    const record = normalizeCreateInput(input);
    const existing = await this.store.getProject(record.id);
    if (existing) {
      throw new ProjectValidationError(`项目 ID 已存在：${record.id}`);
    }
    if (record.source.type === 'local') {
      const resolved = await this.repoSource.assertLocalPathAllowed(
        record.source.path,
      );
      record.source = { ...record.source, path: resolved };
    }
    if (record.isDefault) await this.store.clearDefaultProject(record.id);
    return this.store.createProject(record);
  }

  public async updateProject(
    id: string,
    patch: ProjectUpdateInput,
  ): Promise<ProjectRecord> {
    const existing = await this.store.getProject(id);
    if (!existing) throw new ProjectNotFoundError(`未找到项目：${id}`);
    const next: Partial<ProjectRecord> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 100) {
        throw new ProjectValidationError('项目名称不能为空且不能超过 100 字符');
      }
      next.name = name;
    }
    if (patch.aliases !== undefined) {
      next.aliases = normalizeAliases(
        patch.aliases,
        existing.id,
        next.name ?? existing.name,
      );
    }
    if (patch.description !== undefined) {
      next.description = patch.description.trim().slice(0, 2_000);
    }
    if (patch.source !== undefined) {
      const source = normalizeSource(patch.source);
      if (source.type === 'local') {
        const resolved = await this.repoSource.assertLocalPathAllowed(
          source.path,
        );
        next.source = { ...source, path: resolved };
      } else {
        next.source = source;
      }
      if (JSON.stringify(existing.source) !== JSON.stringify(next.source)) {
        next.lastError = '项目来源已变更，请重新同步以更新索引';
      }
    }
    if (patch.defaultBranch !== undefined) {
      next.defaultBranch = patch.defaultBranch.trim() || 'main';
    }
    if (patch.ownerStaffIds !== undefined) {
      next.ownerStaffIds = normalizeStaffIds(patch.ownerStaffIds);
    }
    if (patch.visibility !== undefined) {
      if (!isProjectVisibility(patch.visibility)) {
        throw new ProjectValidationError('非法的项目可见性');
      }
      next.visibility = patch.visibility;
    }
    if (patch.sensitivity !== undefined) {
      if (!isProjectSensitivity(patch.sensitivity)) {
        throw new ProjectValidationError('非法的项目敏感度');
      }
      next.sensitivity = patch.sensitivity;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.autoSyncMinutes !== undefined) {
      next.autoSyncMinutes = Math.min(
        Math.max(Math.trunc(patch.autoSyncMinutes), 0),
        1_440,
      );
    }
    if (patch.isDefault !== undefined) {
      next.isDefault = patch.isDefault;
      if (patch.isDefault) await this.store.clearDefaultProject(id);
    }
    return this.store.updateProject(id, next);
  }

  public async deleteProject(id: string): Promise<void> {
    const project = await this.store.getProject(id);
    if (!project) throw new ProjectNotFoundError(`未找到项目：${id}`);
    await this.store.deleteProject(id);
  }

  public async getProject(id: string): Promise<ProjectRecord | null> {
    return this.store.getProject(id);
  }

  public async listSnapshots(
    projectId: string,
    limit = 10,
  ): Promise<ProjectSnapshot[]> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(`未找到项目：${projectId}`);
    return this.store.listSnapshots(
      projectId,
      Math.min(Math.max(Math.trunc(limit), 1), 50),
    );
  }

  public async listSyncJobs(
    projectId: string,
    limit = 20,
  ): Promise<ProjectSyncJob[]> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(`未找到项目：${projectId}`);
    return this.store.listSyncJobs(
      projectId,
      Math.min(Math.max(Math.trunc(limit), 1), 100),
    );
  }

  /** 控制台用的聚合状态：索引统计、最近任务、手册版本与过期标记 */
  public async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    const project = await this.requireProject(projectId);
    const snapshot = await this.findActiveSnapshot(project);
    const [recentJobs, published, draft] = await Promise.all([
      this.store.listSyncJobs(projectId, 10),
      this.store.getLatestHandbook(projectId, 'published'),
      this.store.getLatestHandbook(projectId, 'draft'),
    ]);
    const commit = snapshot?.commitSha ?? project.lastCommit;
    return {
      project,
      snapshot,
      stale: await this.computeStale(project, snapshot),
      embeddingEnabled: Boolean(this.embedder),
      index: snapshot
        ? {
            files: snapshot.fileCount,
            bytes: snapshot.totalBytes,
            symbols: snapshot.symbolCount,
            chunks: snapshot.chunkCount,
            embeddedChunks: Number(snapshot.stats.embeddedChunks ?? 0),
            truncated: Boolean(snapshot.stats.truncated),
            branch: snapshot.branch,
          }
        : null,
      latestJob: recentJobs[0] ?? null,
      recentJobs,
      handbook: {
        publishedVersion: published?.version ?? project.handbookVersion ?? 0,
        draftVersion: draft?.version ?? null,
        stale: Boolean(published && commit && published.commitSha !== commit),
      },
    };
  }

  /** 立即返回排队任务，实际同步在后台执行；已有任务在跑时复用 */
  public async queueSync(
    projectId: string,
    trigger: ProjectSyncJob['trigger'] = 'manual',
  ): Promise<ProjectSyncJob> {
    const running = this.locks.get(projectId);
    if (running) {
      const jobs = await this.store.listSyncJobs(projectId, 1);
      const latest = jobs[0];
      if (latest) return latest;
    }
    const project = await this.store.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(`未找到项目：${projectId}`);
    if (project.source.type === 'manual') {
      throw new ProjectSourceError('manual 项目没有代码仓库，无需同步');
    }
    const job = await this.store.createSyncJob(projectId, trigger, 'queued');
    const promise = this.runSync(projectId, trigger, job).finally(() => {
      this.locks.delete(projectId);
    });
    this.locks.set(projectId, promise);
    void promise.catch((error) => {
      this.logger?.warn(
        { projectId, jobId: job.id, error: errorMessage(error) },
        'queued project sync failed',
      );
    });
    return job;
  }

  public async sync(
    projectId: string,
    trigger: ProjectSyncJob['trigger'] = 'manual',
  ): Promise<ProjectSyncResult> {
    const existing = this.locks.get(projectId);
    if (existing) return existing;
    const promise = this.runSync(projectId, trigger).finally(() => {
      this.locks.delete(projectId);
    });
    this.locks.set(projectId, promise);
    return promise;
  }

  public async syncDueProjects(
    trigger: ProjectSyncJob['trigger'] = 'schedule',
  ): Promise<Array<{ projectId: string; ok: boolean; error?: string }>> {
    const projects = await this.store.listProjects();
    const now = this.now();
    const results: Array<{ projectId: string; ok: boolean; error?: string }> = [];
    for (const project of projects) {
      if (
        !project.enabled ||
        project.source.type === 'manual' ||
        project.autoSyncMinutes <= 0
      ) {
        continue;
      }
      const dueAt = (project.lastSyncedAt ?? 0) + project.autoSyncMinutes * 60_000;
      if (project.lastSyncedAt && now < dueAt) continue;
      try {
        await this.sync(project.id, trigger);
        results.push({ projectId: project.id, ok: true });
      } catch (error) {
        const message = errorMessage(error);
        this.logger?.warn({ projectId: project.id, error: message }, 'project auto sync failed');
        results.push({ projectId: project.id, ok: false, error: message });
      }
    }
    return results;
  }

  public async readProject(input: ProjectReadInput): Promise<ProjectReadResult> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    const snapshot = await this.requireActiveSnapshot(project);
    const relativePath = this.normalizeRepoPath(input.path);
    const document = await this.store.getDocument(snapshot.id, relativePath);
    if (!document) {
      throw new ProjectNotFoundError(
        `文件不在当前快照中：${relativePath}（commit ${snapshot.commitSha.slice(0, 8)}）`,
      );
    }
    const totalLines = Math.max(1, document.lineCount);
    const startLine = Math.min(
      Math.max(1, Math.trunc(input.startLine ?? 1)),
      totalLines,
    );
    const maxLines = Math.min(Math.max(1, Math.trunc(input.maxLines ?? 200)), 300);
    const requestedEnd = input.endLine
      ? Math.min(Math.trunc(input.endLine), totalLines)
      : startLine + maxLines - 1;
    const endLine = Math.min(
      totalLines,
      Math.max(startLine, Math.min(requestedEnd, startLine + maxLines - 1)),
    );
    const content = document.text
      .split('\n')
      .slice(startLine - 1, endLine)
      .join('\n');
    const truncated = endLine < totalLines;
    return {
      projectId: project.id,
      commit: snapshot.commitSha,
      path: document.path,
      startLine,
      endLine,
      totalLines,
      ...(truncated ? { nextStartLine: endLine + 1 } : {}),
      content,
      truncated,
      stale: await this.computeStale(project, snapshot),
    };
  }

  public async searchProject(
    input: ProjectSearchToolInput,
  ): Promise<ProjectSearchResult & { project: ProjectRecord }> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    const snapshot = await this.requireActiveSnapshot(project);
    const result = await this.searchService.search({
      project,
      snapshot,
      query: input.query,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.pathGlob ? { pathGlob: input.pathGlob } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      member: input.member,
    });
    return {
      ...result,
      project,
      stale: await this.computeStale(project, snapshot),
    };
  }

  public async mapProject(input: ProjectMapInput): Promise<ProjectMapResult> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    const snapshot = await this.requireActiveSnapshot(project);
    const prefix = input.path ? this.normalizeRepoPath(input.path) : undefined;
    const [documents, symbols] = await Promise.all([
      this.store.listDocumentMetas(snapshot.id),
      this.store.getSymbols(snapshot.id),
    ]);
    const result = buildRepoMap({
      projectId: project.id,
      commit: snapshot.commitSha,
      files: documents,
      symbols,
      maxTokens: Math.min(Math.max(Math.trunc(input.maxTokens ?? 1_500), 500), 2_500),
      ...(prefix ? { pathPrefix: prefix } : {}),
    });
    return {
      ...result,
      text: renderRepoMap(result),
      stale: await this.computeStale(project, snapshot),
    };
  }

  public async symbolProject(
    input: ProjectSymbolInput,
  ): Promise<ProjectSymbolResult & { note?: string }> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    const snapshot = await this.requireActiveSnapshot(project);
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 8), 1), 20);
    const pathLike = input.pathGlob
      ? this.globToLike(input.pathGlob)
      : undefined;
    const definitions = await this.store.findSymbols(
      snapshot.id,
      input.name,
      input.kind,
      pathLike,
      limit,
    );
    const first = definitions[0];
    const references = first
      ? await this.store.findReferences(snapshot.id, input.name, first.path, 5)
      : [];
    return {
      projectId: project.id,
      commit: snapshot.commitSha,
      symbol: input.name,
      definitions,
      references,
      ...(definitions.length === 0
        ? { note: '未找到同名定义；可改用 project_search 做全文检索' }
        : {}),
    };
  }

  public async historyProject(
    input: ProjectHistoryInput,
  ): Promise<ProjectHistoryResult> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    const kind = input.kind ?? 'commits';
    const snapshot = await this.findActiveSnapshot(project);
    const commit = snapshot?.commitSha ?? project.lastCommit;
    if (kind === 'issues' || kind === 'prs') {
      return this.searchGithubIssues(project, commit, kind, input);
    }
    if (kind === 'blame') {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note: 'blame 需要完整 Git 历史，当前阶段未启用',
      };
    }
    if (project.source.type === 'manual') {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note: 'manual 项目没有 Git 历史',
      };
    }
    try {
      const root = await this.repoSource.rootFor(project);
      const commits = await this.repoSource.log(root, {
        ...(input.path ? { path: input.path } : {}),
        limit: input.limit ?? 10,
      });
      return { projectId: project.id, commit, kind, commits };
    } catch (error) {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note: `读取 Git 历史失败：${errorMessage(error)}`,
      };
    }
  }

  private async searchGithubIssues(
    project: ProjectRecord,
    commit: string,
    kind: 'issues' | 'prs',
    input: ProjectHistoryInput,
  ): Promise<ProjectHistoryResult> {
    if (project.source.type !== 'github') {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note: '只有 GitHub 来源的项目支持 issues/prs 查询',
      };
    }
    if (!this.github) {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note: 'GitHub 客户端未启用（需要 GITHUB_ENABLED=true）',
      };
    }
    try {
      const result = await this.github.search(
        project.source.repo,
        input.query ?? '',
        {
          kind,
          limit: Math.min(Math.max(input.limit ?? 10, 1), 30),
        },
      );
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        issues: result.items,
        total: result.total,
        ...(result.items.length === 0 ? { note: '没有匹配的条目' } : {}),
      };
    } catch (error) {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note: `查询 GitHub 失败：${errorMessage(error)}`,
      };
    }
  }

  public async getHandbook(
    input: ProjectHandbookInput,
  ): Promise<ProjectHandbookToolResult> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    if (input.section && !isHandbookSectionKey(input.section)) {
      throw new ProjectValidationError(`未知的手册章节：${input.section}`);
    }
    const snapshot = await this.findActiveSnapshot(project);
    const record = await this.store.getLatestHandbook(project.id, 'published');
    const allManualEntries = (await this.store.listManualEntries(project.id)).filter(
      (entry) => this.isEntryVisible(entry.visibility, entry.sensitivity, project, input.member),
    );
    const manualEntries = input.section
      ? allManualEntries.filter((entry) => entry.section === input.section)
      : allManualEntries;
    const sections = record?.content.sections ?? [];
    const filtered = input.section
      ? sections.filter((section) => section.key === input.section)
      : sections;
    const content = {
      sections: filtered,
      generatedAt: record?.content.generatedAt ?? 0,
      commit: record?.commitSha ?? snapshot?.commitSha ?? '',
    };
    const commit = snapshot?.commitSha ?? project.lastCommit;
    return {
      project,
      projectId: project.id,
      version: record?.version ?? 0,
      status: record?.status ?? 'draft',
      commit,
      stale: Boolean(record && commit && record.commitSha !== commit),
      content,
      manualEntries,
    };
  }

  public async listHandbookVersions(
    projectId: string,
    limit = 10,
  ): Promise<ProjectHandbookRecord[]> {
    await this.requireProject(projectId);
    return this.store.listHandbooks(projectId, limit);
  }

  public async generateHandbook(
    projectId: string,
    createdBy = 'admin-console',
  ): Promise<ProjectHandbookRecord> {
    const project = await this.requireProject(projectId);
    const snapshot = await this.findActiveSnapshot(project);
    const [documents, symbols, manualEntries] = snapshot
      ? await Promise.all([
          this.store.listDocumentMetas(snapshot.id),
          this.store.getSymbols(snapshot.id),
          this.store.listManualEntries(project.id),
        ])
      : [[], [], await this.store.listManualEntries(project.id)];
    const repoMapText = snapshot
      ? renderRepoMap(
          buildRepoMap({
            projectId: project.id,
            commit: snapshot.commitSha,
            files: documents,
            symbols,
            maxTokens: 1_500,
          }),
        )
      : '';
    const fileContents = snapshot
      ? await this.loadHandbookFiles(snapshot.id, documents)
      : new Map<string, string>();
    const content = buildHandbook({
      project,
      snapshot,
      documents,
      symbols,
      repoMapText,
      fileContents,
      manualEntryCount: manualEntries.length,
      now: this.now(),
    });
    const version = await this.store.nextHandbookVersion(project.id);
    const sources = content.sections.flatMap((section) => section.sources);
    const record = await this.store.createHandbook({
      projectId: project.id,
      version,
      status: 'draft',
      commitSha: content.commit,
      content,
      sources,
      generatedBy: 'facts',
      createdBy,
    });
    this.logger?.info?.(
      {
        projectId: project.id,
        version,
        sections: content.sections.length,
        commit: content.commit,
      },
      'project handbook draft generated',
    );
    return record;
  }

  public async publishHandbook(
    projectId: string,
    version?: number,
    _publishedBy = 'admin-console',
  ): Promise<ProjectHandbookRecord> {
    const project = await this.requireProject(projectId);
    const target =
      version !== undefined
        ? await this.store.getHandbook(project.id, version)
        : await this.store.getLatestHandbook(project.id, 'draft');
    if (!target) {
      throw new ProjectValidationError(
        version !== undefined
          ? `未找到手册版本 v${version}`
          : '没有可发布的草稿，请先生成手册',
      );
    }
    const published = await this.store.publishHandbook(project.id, target.version);
    if (!published) {
      throw new ProjectValidationError(`发布手册 v${target.version} 失败`);
    }
    await this.store.updateProject(project.id, {
      handbookVersion: published.version,
    });
    this.logger?.info?.(
      { projectId: project.id, version: published.version },
      'project handbook published',
    );
    return published;
  }

  public async getHandbookDraft(
    projectId: string,
  ): Promise<ProjectHandbookRecord | null> {
    await this.requireProject(projectId);
    return this.store.getLatestHandbook(projectId, 'draft');
  }

  /**
   * 保存章节修改为新草稿：默认以最新草稿为基线，没有草稿时复制最新发布版。
   * 每次保存都会产生新版本，已发布版本保持不变，审核后由 publishHandbook 切换。
   */
  public async saveHandbookDraft(
    projectId: string,
    input: ProjectHandbookDraftInput,
    updatedBy = 'admin-console',
  ): Promise<ProjectHandbookRecord> {
    const project = await this.requireProject(projectId);
    if (!Array.isArray(input.sections) || input.sections.length === 0) {
      throw new ProjectValidationError('至少需要提交一个章节');
    }
    const seen = new Set<string>();
    const patches = input.sections.map((patch) => {
      if (!isHandbookSectionKey(patch.key)) {
        throw new ProjectValidationError(`未知的手册章节：${patch.key}`);
      }
      if (seen.has(patch.key)) {
        throw new ProjectValidationError(`章节重复：${patch.key}`);
      }
      seen.add(patch.key);
      const markdown = patch.markdown.trim();
      if (markdown.length === 0) {
        throw new ProjectValidationError(`章节 ${patch.key} 的内容不能为空`);
      }
      if (markdown.length > 20_000) {
        throw new ProjectValidationError(`章节 ${patch.key} 不能超过 20000 字符`);
      }
      const title = patch.title?.trim();
      if (title !== undefined && (title.length === 0 || title.length > 100)) {
        throw new ProjectValidationError('章节标题长度必须在 1-100 字符之间');
      }
      return { key: patch.key, markdown, ...(title ? { title } : {}) };
    });

    let base: ProjectHandbookRecord | null = null;
    if (input.version !== undefined) {
      base = await this.store.getHandbook(projectId, input.version);
      if (!base) {
        throw new ProjectNotFoundError(`未找到手册版本 v${input.version}`);
      }
      if (base.status === 'archived') {
        throw new ProjectValidationError(`手册 v${base.version} 已归档，不能编辑`);
      }
    } else {
      base =
        (await this.store.getLatestHandbook(projectId, 'draft')) ??
        (await this.store.getLatestHandbook(projectId, 'published'));
    }

    const now = this.now();
    const sections: HandbookSection[] = (base?.content.sections ?? []).map(
      (section) => ({
        ...section,
        sources: [...section.sources],
      }),
    );
    const byKey = new Map(sections.map((section) => [section.key, section]));
    for (const patch of patches) {
      const existing = byKey.get(patch.key);
      if (existing) {
        existing.markdown = patch.markdown;
        if (patch.title) existing.title = patch.title;
        existing.origin = 'curated';
        existing.updatedAt = now;
      } else {
        const section: HandbookSection = {
          key: patch.key,
          title: patch.title ?? HANDBOOK_SECTION_TITLES[patch.key],
          markdown: patch.markdown,
          origin: 'curated',
          sources: [],
          updatedAt: now,
        };
        sections.push(section);
        byKey.set(patch.key, section);
      }
    }
    if (sections.length === 0) {
      throw new ProjectValidationError('没有可保存的手册内容，请先生成草稿');
    }
    const snapshot = await this.findActiveSnapshot(project);
    const content: HandbookContent = {
      sections,
      generatedAt: now,
      commit:
        snapshot?.commitSha ?? base?.content.commit ?? project.lastCommit,
    };
    const version = await this.store.nextHandbookVersion(project.id);
    const record = await this.store.createHandbook({
      projectId: project.id,
      version,
      status: 'draft',
      commitSha: content.commit,
      content,
      sources: sections.flatMap((section) => section.sources),
      generatedBy: 'manual',
      createdBy: updatedBy,
    });
    this.logger?.info?.(
      {
        projectId: project.id,
        version,
        base: base?.version ?? null,
        sections: patches.map((patch) => patch.key),
      },
      'project handbook draft saved',
    );
    return record;
  }

  public async listManualEntries(projectId: string): Promise<ProjectManualEntry[]> {
    await this.requireProject(projectId);
    return this.store.listManualEntries(projectId);
  }

  /**
   * 导入种子人工条目：同 section+title 仅在仍由 seedTag 维护时覆盖，
   * 控制台改过的条目（updatedBy 变为管理员）保持不动。
   */
  public async importManualEntries(
    projectId: string,
    entries: ProjectManualEntryInput[],
    seedTag: string,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    await this.requireProject(projectId);
    const existing = await this.store.listManualEntries(projectId);
    const byKey = new Map(
      existing.map((entry) => [`${entry.section}\u0000${entry.title}`, entry]),
    );
    const result = { created: 0, updated: 0, skipped: 0 };
    for (const input of entries) {
      const normalized = this.normalizeManualEntry(
        input,
      ) as ProjectManualEntryInput;
      const key = `${normalized.section}\u0000${normalized.title}`;
      const current = byKey.get(key);
      if (!current) {
        const created = await this.store.createManualEntry(
          projectId,
          normalized,
          seedTag,
        );
        byKey.set(key, created);
        result.created += 1;
        continue;
      }
      if (current.updatedBy !== seedTag) {
        result.skipped += 1;
        continue;
      }
      await this.store.updateManualEntry(
        projectId,
        current.id,
        normalized,
        seedTag,
      );
      result.updated += 1;
    }
    return result;
  }

  public async createManualEntry(
    projectId: string,
    input: ProjectManualEntryInput,
    updatedBy = 'admin-console',
  ): Promise<ProjectManualEntry> {
    await this.requireProject(projectId);
    const normalized = this.normalizeManualEntry(
      input,
    ) as ProjectManualEntryInput;
    const entry = await this.store.createManualEntry(
      projectId,
      normalized,
      updatedBy,
    );
    this.logger?.info?.(
      { projectId, entryId: entry.id, section: entry.section },
      'project manual entry created',
    );
    return entry;
  }

  public async updateManualEntry(
    projectId: string,
    entryId: string,
    patch: ProjectManualEntryPatch,
    updatedBy = 'admin-console',
  ): Promise<ProjectManualEntry> {
    await this.requireProject(projectId);
    const existing = await this.store.getManualEntry(projectId, entryId);
    if (!existing) {
      throw new ProjectNotFoundError(`未找到人工条目：${entryId}`);
    }
    const normalized = this.normalizeManualEntry(patch, true);
    if (Object.keys(normalized).length === 0) {
      throw new ProjectValidationError('没有需要更新的字段');
    }
    const entry = await this.store.updateManualEntry(
      projectId,
      entryId,
      normalized,
      updatedBy,
    );
    if (!entry) {
      throw new ProjectNotFoundError(`未找到人工条目：${entryId}`);
    }
    this.logger?.info?.(
      { projectId, entryId, section: entry.section },
      'project manual entry updated',
    );
    return entry;
  }

  public async deleteManualEntry(
    projectId: string,
    entryId: string,
  ): Promise<void> {
    await this.requireProject(projectId);
    const removed = await this.store.deleteManualEntry(projectId, entryId);
    if (!removed) {
      throw new ProjectNotFoundError(`未找到人工条目：${entryId}`);
    }
    this.logger?.info?.({ projectId, entryId }, 'project manual entry deleted');
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(`未找到项目：${projectId}`);
    return project;
  }

  private normalizeManualEntry(
    input: ProjectManualEntryInput | ProjectManualEntryPatch,
    partial = false,
  ): ProjectManualEntryInput | ProjectManualEntryPatch {
    const result: ProjectManualEntryInput = {
      section: 'overview',
      title: '',
      markdown: '',
    };
    if (input.section !== undefined) {
      if (!isHandbookSectionKey(input.section)) {
        throw new ProjectValidationError(`未知的手册章节：${input.section}`);
      }
      result.section = input.section;
    } else if (!partial) {
      throw new ProjectValidationError('缺少 section');
    }
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title.length === 0 || title.length > 200) {
        throw new ProjectValidationError('title 长度必须在 1-200 字符之间');
      }
      result.title = title;
    } else if (!partial) {
      throw new ProjectValidationError('缺少 title');
    }
    if (input.markdown !== undefined) {
      const markdown = input.markdown.trim();
      if (markdown.length === 0) {
        throw new ProjectValidationError('markdown 不能为空');
      }
      if (markdown.length > 20_000) {
        throw new ProjectValidationError('markdown 不能超过 20000 字符');
      }
      result.markdown = markdown;
    } else if (!partial) {
      throw new ProjectValidationError('缺少 markdown');
    }
    if (input.visibility !== undefined) {
      if (!isProjectVisibility(input.visibility)) {
        throw new ProjectValidationError(
          'visibility 必须是 team / private / admin',
        );
      }
      result.visibility = input.visibility;
    }
    if (input.sensitivity !== undefined) {
      if (!isProjectSensitivity(input.sensitivity)) {
        throw new ProjectValidationError('sensitivity 必须是 team / private');
      }
      result.sensitivity = input.sensitivity;
    }
    if (input.injectToBrief !== undefined) {
      result.injectToBrief = input.injectToBrief;
    }
    if (input.priority !== undefined) {
      if (
        !Number.isFinite(input.priority) ||
        input.priority < -100 ||
        input.priority > 100
      ) {
        throw new ProjectValidationError('priority 必须在 -100 到 100 之间');
      }
      result.priority = Math.trunc(input.priority);
    }
    if (partial) {
      const patch: ProjectManualEntryPatch = {};
      if (input.section !== undefined) patch.section = result.section;
      if (input.title !== undefined) patch.title = result.title;
      if (input.markdown !== undefined) patch.markdown = result.markdown;
      if (input.visibility !== undefined) patch.visibility = result.visibility;
      if (input.sensitivity !== undefined) patch.sensitivity = result.sensitivity;
      if (input.injectToBrief !== undefined) {
        patch.injectToBrief = result.injectToBrief;
      }
      if (input.priority !== undefined) patch.priority = result.priority;
      return patch;
    }
    return result;
  }

  private async loadHandbookFiles(
    snapshotId: string,
    documents: ProjectDocumentMeta[],
  ): Promise<Map<string, string>> {
    const priority = (path: string): number => {
      if (/^README(\.[^/]*)?$/iu.test(path)) return 0;
      if (path === 'package.json') return 1;
      if (/(^|\/)(AGENTS|CLAUDE|CONTRIBUTING)\.md$/iu.test(path)) return 2;
      if (/(^|\/)\.env(\.example|\.sample|\.template)?$/iu.test(path)) return 3;
      if (/(^|\/)(config|conf)\//u.test(path)) return 4;
      if (/(^|\/)(schema|schemas|migrations?|db)\//u.test(path)) return 5;
      if (/(^|\/)(deploy|deployment|ops|infra)\//u.test(path)) return 6;
      if (/(^|\/)(adr|decisions?|design|operations?|runbook|faq)\b/iu.test(path)) {
        return 7;
      }
      if (/\.(md|mdx|rst)$/iu.test(path)) return 8;
      return 9;
    };
    const selected = documents
      .filter(
        (document) =>
          document.sizeBytes <= 64 * 1024 && priority(document.path) < 9,
      )
      .sort(
        (left, right) =>
          priority(left.path) - priority(right.path) ||
          left.path.localeCompare(right.path),
      )
      .slice(0, 48);
    const entries = await Promise.all(
      selected.map(async (document) => {
        const row = await this.store.getDocument(snapshotId, document.path);
        return [document.path, row?.text ?? ''] as const;
      }),
    );
    const files = new Map<string, string>();
    for (const [path, text] of entries) {
      if (text) files.set(path, text.slice(0, 24_000));
    }
    return files;
  }

  public async buildBrief(input: ProjectBriefInput): Promise<ProjectBrief | null> {
    const member: ProjectMemberContextInput = {
      senderStaffId: input.senderStaffId,
      isAdmin: input.isAdmin,
      conversationType: input.conversationType,
    };
    const projects = await this.store.listProjects();
    const matched = matchProjectsByText(projects, input.text, member);
    let project: ProjectRecord | undefined = matched[0];
    if (!project) {
      const fallbackId = (await this.defaultProjectId()).trim();
      if (fallbackId && hasCodeHint(input.text)) {
        try {
          project = resolveProject(
            projects,
            fallbackId,
            member,
            fallbackId,
          );
        } catch {
          project = undefined;
        }
      }
    }
    if (!project) return null;
    const snapshot = await this.findActiveSnapshot(project);
    const stale = await this.computeStale(project, snapshot);
    const handbook = await this.store.getLatestHandbook(project.id, 'published');
    const maxChars = Math.min(
      Math.max(Math.trunc(input.maxChars ?? this.briefMaxChars), 400),
      4_000,
    );
    const names = [project.name];
    if (project.aliases.length > 0) {
      names.push(`（别名：${project.aliases.join('、')}）`);
    }
    const repoLine =
      project.source.type === 'github'
        ? `https://github.com/${project.source.repo}`
        : project.source.type === 'local'
          ? '本地已登记仓库（服务器路径不写入上下文）'
          : '仅手册项目';
    const core = [
      '## 项目上下文',
      `当前问题可能涉及项目「${names.join('')}」。`,
      `- 仓库：${repoLine}`,
      snapshot
        ? `- 当前索引：commit ${snapshot.commitSha.slice(0, 12)}${stale ? '（仓库有新提交，索引可能过期）' : ''}；手册版本 v${project.handbookVersion || handbook?.version || 0}`
        : '- 当前索引：尚未同步，只能使用手册人工条目',
    ];
    const hint =
      '需要细节时调用 project_handbook / project_map / project_search / project_read。';
    const optional: string[] = [];
    if (project.description) {
      optional.push(`- 项目说明：${project.description.slice(0, 200)}`);
    }
    const entries = (await this.store.listManualEntries(project.id))
      .filter(
        (entry) =>
          entry.injectToBrief &&
          this.isEntryVisible(
            entry.visibility,
            entry.sensitivity,
            project,
            member,
          ),
      )
      .slice(0, 5);
    for (const entry of entries) {
      optional.push(`- ${entry.title}：${entry.markdown.replace(/\s+/gu, ' ').slice(0, 240)}`);
    }
    let budget = maxChars - core.join('\n').length - hint.length - 2;
    const kept: string[] = [];
    for (const line of optional) {
      if (line.length + 1 > budget) break;
      kept.push(line);
      budget -= line.length + 1;
    }
    const text = [...core, ...kept, hint].join('\n');
    return {
      projectId: project.id,
      text: text.length > maxChars ? `${text.slice(0, maxChars - 12)}…（已截断）` : text,
      commit: snapshot?.commitSha ?? project.lastCommit,
      handbookVersion: project.handbookVersion || handbook?.version || 0,
      stale,
    };
  }

  public async handbookSectionTitle(key: string): Promise<string> {
    return isHandbookSectionKey(key) ? HANDBOOK_SECTION_TITLES[key] : key;
  }

  private async runSync(
    projectId: string,
    trigger: ProjectSyncJob['trigger'],
    queuedJob?: ProjectSyncJob,
  ): Promise<ProjectSyncResult> {
    const startedAt = this.now();
    const initial = await this.store.getProject(projectId);
    if (!initial) throw new ProjectNotFoundError(`未找到项目：${projectId}`);
    if (initial.source.type === 'manual') {
      throw new ProjectSourceError('manual 项目没有代码仓库，无需同步');
    }
    const job =
      queuedJob ?? (await this.store.createSyncJob(projectId, trigger));
    if (queuedJob) {
      await this.store.updateSyncJob(job.id, {
        status: 'running',
        startedAt,
      });
    }
    let snapshot: ProjectSnapshot | undefined;
    try {
      const prepared = await this.repoSource.prepare(initial);
      const existing = await this.store.findSnapshotByCommit(
        projectId,
        prepared.commit,
      );
      // 旧快照可能建立于未启用 embedding 时；首次启用后重建一次以补齐向量
      const needsEmbeddingBackfill =
        existing?.status === 'ready' &&
        Boolean(this.embedder) &&
        existing.chunkCount > 0 &&
        typeof existing.stats.embeddedChunks !== 'number';
      if (existing?.status === 'ready' && !needsEmbeddingBackfill) {
        await this.store.setActiveSnapshot(initial, existing);
        const project = (await this.store.getProject(projectId)) ?? initial;
        const stats = this.statsOfSnapshot(existing, this.now() - startedAt);
        await this.store.updateSyncJob(job.id, {
          status: 'succeeded',
          snapshotId: existing.id,
          stats,
          finishedAt: this.now(),
        });
        return { project, snapshot: existing, stats };
      }
      if (existing) {
        if (needsEmbeddingBackfill) {
          this.logger?.info?.(
            { projectId, commit: existing.commitSha },
            'rebuilding snapshot to backfill chunk embeddings',
          );
        }
        await this.store.deleteSnapshot(existing.id);
      }
      const created = await this.store.createSnapshot({
        projectId,
        commitSha: prepared.commit,
        branch: prepared.branch,
      });
      snapshot = created;
      const scan = await scanRepository(prepared.root, this.scanOptions);
      const documents: ProjectDocument[] = [];
      const symbols: ProjectSymbol[] = [];
      const chunks: ProjectSearchCandidateInput[] = [];
      for (const file of scan.files) {
        documents.push({
          id: randomUUID(),
          projectId,
          snapshotId: created.id,
          path: file.path,
          language: file.language,
          kind: file.kind,
          contentHash: hashText(file.text),
          sizeBytes: file.sizeBytes,
          lineCount: file.lineCount,
          text: file.text,
        });
        const isLockfile = LOCKFILE_PATTERN.test(file.path);
        if (isLockfile) continue;
        const fileSymbols = extractSymbols(file.path, file.language, file.text);
        for (const symbol of fileSymbols) {
          symbols.push({
            id: randomUUID(),
            projectId,
            snapshotId: created.id,
            path: symbol.path,
            name: symbol.name,
            kind: symbol.kind,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            signature: symbol.signature,
            parent: symbol.parent,
            exported: symbol.exported,
          });
        }
        const fileChunks = buildChunks(
          {
            path: file.path,
            language: file.language,
            kind: file.kind,
            text: file.text,
            lineCount: file.lineCount,
          },
          fileSymbols,
        );
        for (const chunk of fileChunks) {
          chunks.push({
            projectId,
            snapshotId: created.id,
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            symbol: chunk.symbol,
            kind: chunk.kind,
            content: chunk.content,
            contentHash: chunk.contentHash,
            tokenCount: chunk.tokenCount,
          });
        }
      }
      await this.store.insertDocuments(documents);
      await this.store.insertSymbols(symbols);
      const embeddingResult = await this.embedChunks(projectId, chunks);
      await this.store.insertChunks(chunks);
      const stats: ProjectSyncStats = {
        files: scan.files.length,
        bytes: scan.totalBytes,
        symbols: symbols.length,
        chunks: chunks.length,
        skipped: scan.skipped,
        durationMs: this.now() - startedAt,
        ...(this.embedder
          ? { embeddedChunks: embeddingResult.embedded }
          : {}),
        ...(embeddingResult.error
          ? { embeddingError: embeddingResult.error }
          : {}),
      };
      const snapshotStats: Record<string, unknown> = {
        ...stats,
        truncated: scan.truncated,
        skippedReasons: scan.skippedReasons,
        branch: prepared.branch,
      };
      await this.store.updateSnapshot(created.id, {
        status: 'ready',
        fileCount: stats.files,
        totalBytes: stats.bytes,
        symbolCount: stats.symbols,
        chunkCount: stats.chunks,
        stats: snapshotStats,
        error: '',
        finishedAt: this.now(),
      });
      const ready: ProjectSnapshot = {
        ...created,
        status: 'ready',
        fileCount: stats.files,
        totalBytes: stats.bytes,
        symbolCount: stats.symbols,
        chunkCount: stats.chunks,
        stats: snapshotStats,
        finishedAt: this.now(),
      };
      snapshot = ready;
      await this.store.setActiveSnapshot(initial, ready);
      await this.store.pruneSnapshots(projectId, this.keepSnapshots);
      await this.store.updateSyncJob(job.id, {
        status: 'succeeded',
        snapshotId: ready.id,
        stats,
        finishedAt: this.now(),
      });
      const project = (await this.store.getProject(projectId)) ?? initial;
      if (scan.truncated) {
        this.logger?.warn(
          { projectId, skipped: scan.skippedReasons },
          'project scan truncated by limits',
        );
      }
      return { project, snapshot: ready, stats };
    } catch (error) {
      const message = errorMessage(error);
      if (snapshot) {
        await this.store.updateSnapshot(snapshot.id, {
          status: 'failed',
          error: message,
          finishedAt: this.now(),
        });
      }
      await this.store.updateProject(projectId, { lastError: message });
      await this.store.updateSyncJob(job.id, {
        status: 'failed',
        error: message,
        finishedAt: this.now(),
      });
      throw error;
    }
  }

  /**
   * 批量写入分块向量；失败只记录并停止后续批次，不让同步失败，
   * 检索会自动退回 FTS/trigram，下次同步会重新尝试。
   */
  private async embedChunks(
    projectId: string,
    chunks: ProjectSearchCandidateInput[],
  ): Promise<{ embedded: number; error?: string }> {
    if (!this.embedder || chunks.length === 0) return { embedded: 0 };
    const batchSize = 32;
    const maxChars = 6_000;
    let embedded = 0;
    for (let index = 0; index < chunks.length; index += batchSize) {
      const batch = chunks.slice(index, index + batchSize);
      try {
        const vectors = await this.embedder.embed(
          batch.map((chunk) => chunk.content.slice(0, maxChars)),
        );
        for (let offset = 0; offset < batch.length; offset += 1) {
          const vector = vectors[offset];
          const chunk = batch[offset];
          if (!chunk || !vector || vector.length === 0) continue;
          chunk.embedding = vector;
          embedded += 1;
        }
      } catch (error) {
        const message = errorMessage(error);
        this.logger?.warn?.(
          {
            projectId,
            batchStart: index,
            batchSize: batch.length,
            embedded,
            error: message,
          },
          'project chunk embedding failed; falling back to keyword search',
        );
        return { embedded, error: message };
      }
    }
    return { embedded };
  }

  private statsOfSnapshot(
    snapshot: ProjectSnapshot,
    durationMs: number,
  ): ProjectSyncStats {
    return {
      files: snapshot.fileCount,
      bytes: snapshot.totalBytes,
      symbols: snapshot.symbolCount,
      chunks: snapshot.chunkCount,
      skipped: Number(snapshot.stats.skipped ?? 0),
      durationMs,
      ...(typeof snapshot.stats.embeddedChunks === 'number'
        ? { embeddedChunks: snapshot.stats.embeddedChunks }
        : {}),
      ...(typeof snapshot.stats.embeddingError === 'string'
        ? { embeddingError: snapshot.stats.embeddingError }
        : {}),
    };
  }

  private async resolveForRead(
    projectRef: string | undefined,
    member: ProjectMemberContextInput,
  ): Promise<ProjectRecord> {
    const projects = await this.store.listProjects();
    const defaultProjectId = await this.defaultProjectId();
    let project: ProjectRecord;
    try {
      project = resolveProject(projects, projectRef, member, defaultProjectId);
    } catch (error) {
      if (error instanceof ProjectResolutionError) {
        throw new ProjectNotFoundError(error.message);
      }
      throw error;
    }
    if (!canReadProjectContent(project, member)) {
      throw new ProjectNotFoundError(
        `项目 ${project.id} 为 private 敏感度，不能在此会话中读取代码内容`,
      );
    }
    return project;
  }

  private async findActiveSnapshot(
    project: ProjectRecord,
  ): Promise<ProjectSnapshot | null> {
    if (project.activeSnapshotId) {
      const snapshot = await this.store.getSnapshot(project.activeSnapshotId);
      if (snapshot && snapshot.status === 'ready') return snapshot;
    }
    const snapshots = await this.store.listSnapshots(project.id, 5);
    return snapshots.find((snapshot) => snapshot.status === 'ready') ?? null;
  }

  private async requireActiveSnapshot(
    project: ProjectRecord,
  ): Promise<ProjectSnapshot> {
    const snapshot = await this.findActiveSnapshot(project);
    if (!snapshot) {
      throw new ProjectNotIndexedError(
        `项目 ${project.id} 尚未建立索引，请管理员先执行同步`,
      );
    }
    return snapshot;
  }

  private async computeStale(
    project: ProjectRecord,
    snapshot: ProjectSnapshot | null,
  ): Promise<boolean> {
    if (!snapshot || project.source.type === 'manual') return false;
    if (snapshot.commitSha.startsWith('local-')) return false;
    const head = await this.repoSource.peekHead(project);
    return Boolean(head && head !== snapshot.commitSha);
  }

  private normalizeRepoPath(value: string): string {
    const normalized = value.replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (
      !normalized ||
      normalized.split('/').some((segment) => segment === '..' || segment === '')
    ) {
      throw new ProjectValidationError(`非法仓库路径：${value}`);
    }
    return normalized;
  }

  private globToLike(glob: string): string {
    let output = '';
    for (let index = 0; index < glob.length; index += 1) {
      const char = glob[index] ?? '';
      if (char === '*') {
        output += '%';
        if (glob[index + 1] === '*') index += 1;
        if (glob[index + 1] === '/') index += 1;
        continue;
      }
      if (char === '?') {
        output += '_';
        continue;
      }
      if (char === '\\' || char === '%' || char === '_') {
        output += `\\${char}`;
        continue;
      }
      output += char;
    }
    return output;
  }

  private isEntryVisible(
    visibility: ProjectRecord['visibility'],
    sensitivity: ProjectRecord['sensitivity'],
    project: ProjectRecord,
    member: ProjectMemberContextInput,
  ): boolean {
    if (sensitivity === 'private' && member.conversationType === '2') return false;
    if (visibility === 'team') return true;
    if (member.conversationType !== '1') return false;
    if (visibility === 'admin') return member.isAdmin;
    return member.isAdmin || project.ownerStaffIds.includes(member.senderStaffId);
  }
}
