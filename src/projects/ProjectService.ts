import { createHash, randomUUID } from 'node:crypto';
import type {
  ProjectBrief,
  ProjectBriefInput,
  ProjectCreateInput,
  ProjectDocument,
  ProjectHandbookResult,
  ProjectHistoryResult,
  ProjectMapResult,
  ProjectMemberContextInput,
  ProjectReadResult,
  ProjectRecord,
  ProjectSearchResult,
  ProjectSnapshot,
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

export interface ProjectServiceOptions {
  store: ProjectStore;
  repoSource: RepoSource;
  searchService?: ProjectSearchService;
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
    this.searchService =
      options.searchService ??
      new ProjectSearchService({ store: options.store, logger: options.logger });
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
    if (kind !== 'commits') {
      return {
        projectId: project.id,
        commit,
        kind,
        commits: [],
        note:
          kind === 'blame'
            ? 'blame 需要完整 Git 历史，当前阶段未启用'
            : 'issues/prs 需要 GitHub 客户端，将在 GitHub 集成阶段提供',
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

  public async getHandbook(
    input: ProjectHandbookInput,
  ): Promise<ProjectHandbookToolResult> {
    const project = await this.resolveForRead(input.projectRef, input.member);
    if (input.section && !isHandbookSectionKey(input.section)) {
      throw new ProjectValidationError(`未知的手册章节：${input.section}`);
    }
    const snapshot = await this.findActiveSnapshot(project);
    const record = await this.store.getLatestHandbook(project.id, 'published');
    const manualEntries = (await this.store.listManualEntries(project.id)).filter(
      (entry) => this.isEntryVisible(entry.visibility, entry.sensitivity, project, input.member),
    );
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
          ? `本地路径 ${project.source.path}`
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
  ): Promise<ProjectSyncResult> {
    const startedAt = this.now();
    const initial = await this.store.getProject(projectId);
    if (!initial) throw new ProjectNotFoundError(`未找到项目：${projectId}`);
    if (initial.source.type === 'manual') {
      throw new ProjectSourceError('manual 项目没有代码仓库，无需同步');
    }
    const job = await this.store.createSyncJob(projectId, trigger);
    let snapshot: ProjectSnapshot | undefined;
    try {
      const prepared = await this.repoSource.prepare(initial);
      const existing = await this.store.findSnapshotByCommit(
        projectId,
        prepared.commit,
      );
      if (existing?.status === 'ready') {
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
      if (existing) await this.store.deleteSnapshot(existing.id);
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
      await this.store.insertChunks(chunks);
      const stats: ProjectSyncStats = {
        files: scan.files.length,
        bytes: scan.totalBytes,
        symbols: symbols.length,
        chunks: chunks.length,
        skipped: scan.skipped,
        durationMs: this.now() - startedAt,
      };
      await this.store.updateSnapshot(created.id, {
        status: 'ready',
        fileCount: stats.files,
        totalBytes: stats.bytes,
        symbolCount: stats.symbols,
        chunkCount: stats.chunks,
        stats: {
          ...stats,
          truncated: scan.truncated,
          skippedReasons: scan.skippedReasons,
          branch: prepared.branch,
        } as Record<string, unknown>,
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
        stats: {
          ...stats,
          truncated: scan.truncated,
          skippedReasons: scan.skippedReasons,
          branch: prepared.branch,
        },
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
