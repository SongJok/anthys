import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingClient } from '../memory/EmbeddingClient.js';
import type { ExecutionContext } from '../types/core.js';
import type {
  HandbookSectionKey,
  ProjectDocument,
  ProjectDocumentKind,
  ProjectHandbookRecord,
  ProjectManualEntry,
  ProjectManualEntryInput,
  ProjectManualEntryPatch,
  ProjectRecord,
  ProjectSnapshot,
  ProjectSyncJob,
  ProjectSymbol,
  ProjectVisibility,
  ProjectSensitivity,
} from '../types/skills-plugins-projects.js';
import type {
  ProjectDocumentMeta,
  ProjectHandbookCreateInput,
  ProjectReferenceCandidate,
  ProjectSearchCandidate,
  ProjectSearchCandidateInput,
  ProjectSearchQuery,
  ProjectStore,
  ProjectVectorQuery,
} from './ProjectStore.js';
import { ProjectService } from './ProjectService.js';
import { RepoSource } from './RepoSource.js';
import { ProjectToolProvider } from '../tools/projects/ProjectToolProvider.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryProjectStore implements ProjectStore {
  private projects = new Map<string, ProjectRecord>();
  private snapshots: ProjectSnapshot[] = [];
  private documents: ProjectDocument[] = [];
  private chunkRows: Array<ProjectSearchCandidateInput & { id: string }> = [];
  private symbols: ProjectSymbol[] = [];
  private jobs: ProjectSyncJob[] = [];
  private handbookRows: ProjectHandbookRecord[] = [];
  private manualRows: ProjectManualEntry[] = [];
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  public async listProjects(): Promise<ProjectRecord[]> {
    return Array.from(this.projects.values());
  }

  public async getProject(id: string): Promise<ProjectRecord | null> {
    return this.projects.get(id) ?? null;
  }

  public async createProject(record: ProjectRecord): Promise<ProjectRecord> {
    this.projects.set(record.id, { ...record });
    return record;
  }

  public async updateProject(
    id: string,
    patch: Partial<ProjectRecord>,
  ): Promise<ProjectRecord> {
    const existing = this.projects.get(id);
    if (!existing) throw new Error(`missing project ${id}`);
    const next = { ...existing, ...patch };
    this.projects.set(id, next);
    return next;
  }

  public async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.projectId !== id);
    this.documents = this.documents.filter((document) => document.projectId !== id);
    this.chunkRows = this.chunkRows.filter((chunk) => chunk.projectId !== id);
    this.symbols = this.symbols.filter((symbol) => symbol.projectId !== id);
    this.jobs = this.jobs.filter((job) => job.projectId !== id);
  }

  public async clearDefaultProject(exceptId?: string): Promise<void> {
    for (const [id, project] of this.projects) {
      if (id === exceptId) continue;
      this.projects.set(id, { ...project, isDefault: false });
    }
  }

  public async listSnapshots(
    projectId: string,
    limit = 10,
  ): Promise<ProjectSnapshot[]> {
    return this.snapshots
      .filter((snapshot) => snapshot.projectId === projectId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit);
  }

  public async getSnapshot(id: string): Promise<ProjectSnapshot | null> {
    return this.snapshots.find((snapshot) => snapshot.id === id) ?? null;
  }

  public async findSnapshotByCommit(
    projectId: string,
    commitSha: string,
  ): Promise<ProjectSnapshot | null> {
    return (
      this.snapshots.find(
        (snapshot) =>
          snapshot.projectId === projectId && snapshot.commitSha === commitSha,
      ) ?? null
    );
  }

  public async createSnapshot(
    input: Pick<ProjectSnapshot, 'projectId' | 'commitSha' | 'branch'>,
  ): Promise<ProjectSnapshot> {
    const snapshot: ProjectSnapshot = {
      id: this.nextId('snapshot'),
      projectId: input.projectId,
      commitSha: input.commitSha,
      branch: input.branch,
      status: 'building',
      fileCount: 0,
      totalBytes: 0,
      symbolCount: 0,
      chunkCount: 0,
      stats: {},
      error: '',
      startedAt: Date.now(),
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  public async updateSnapshot(
    id: string,
    patch: Partial<
      Pick<
        ProjectSnapshot,
        | 'status'
        | 'fileCount'
        | 'totalBytes'
        | 'symbolCount'
        | 'chunkCount'
        | 'stats'
        | 'error'
        | 'finishedAt'
      >
    >,
  ): Promise<void> {
    this.snapshots = this.snapshots.map((snapshot) =>
      snapshot.id === id ? { ...snapshot, ...patch } : snapshot,
    );
  }

  public async deleteSnapshot(id: string): Promise<void> {
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.id !== id);
    this.documents = this.documents.filter((document) => document.snapshotId !== id);
    this.chunkRows = this.chunkRows.filter((chunk) => chunk.snapshotId !== id);
    this.symbols = this.symbols.filter((symbol) => symbol.snapshotId !== id);
  }

  public async setActiveSnapshot(
    project: ProjectRecord,
    snapshot: ProjectSnapshot,
  ): Promise<void> {
    this.snapshots = this.snapshots.map((item) =>
      item.projectId === project.id && item.id !== snapshot.id && item.status === 'ready'
        ? { ...item, status: 'superseded' }
        : item,
    );
    const existing = this.projects.get(project.id);
    if (existing) {
      this.projects.set(project.id, {
        ...existing,
        activeSnapshotId: snapshot.id,
        lastCommit: snapshot.commitSha,
        lastSyncedAt: Date.now(),
        lastError: '',
      });
    }
  }

  public async pruneSnapshots(projectId: string, keep: number): Promise<number> {
    const project = this.projects.get(projectId);
    const rows = this.snapshots
      .filter((snapshot) => snapshot.projectId === projectId)
      .sort((left, right) => right.startedAt - left.startedAt);
    const keepIds = new Set(rows.slice(0, keep).map((snapshot) => snapshot.id));
    if (project?.activeSnapshotId) keepIds.add(project.activeSnapshotId);
    let removed = 0;
    for (const row of rows) {
      if (keepIds.has(row.id)) continue;
      await this.deleteSnapshot(row.id);
      removed += 1;
    }
    return removed;
  }

  public async insertDocuments(documents: ProjectDocument[]): Promise<void> {
    this.documents.push(...documents);
  }

  public async insertChunks(chunks: ProjectSearchCandidateInput[]): Promise<void> {
    this.chunkRows.push(
      ...chunks.map((chunk) => ({ ...chunk, id: this.nextId('chunk') })),
    );
  }

  public async insertSymbols(symbols: ProjectSymbol[]): Promise<void> {
    this.symbols.push(...symbols);
  }

  public async listDocumentMetas(snapshotId: string): Promise<ProjectDocumentMeta[]> {
    return this.documents
      .filter((document) => document.snapshotId === snapshotId)
      .map(({ path: filePath, language, kind, sizeBytes, lineCount }) => ({
        path: filePath,
        language,
        kind,
        sizeBytes,
        lineCount,
      }));
  }

  public async getDocument(snapshotId: string, filePath: string): Promise<ProjectDocument | null> {
    return (
      this.documents.find(
        (document) => document.snapshotId === snapshotId && document.path === filePath,
      ) ?? null
    );
  }

  public async getSymbols(snapshotId: string): Promise<ProjectSymbol[]> {
    return this.symbols.filter((symbol) => symbol.snapshotId === snapshotId);
  }

  public async findSymbols(
    snapshotId: string,
    name: string,
    kind: string | undefined,
    _pathLike: string | undefined,
    limit: number,
  ): Promise<ProjectSymbol[]> {
    const lower = name.toLowerCase();
    return this.symbols
      .filter(
        (symbol) =>
          symbol.snapshotId === snapshotId &&
          symbol.name.toLowerCase().startsWith(lower) &&
          (!kind || symbol.kind === kind),
      )
      .slice(0, limit);
  }

  public async findReferences(
    snapshotId: string,
    name: string,
    excludePath: string | undefined,
    limit: number,
  ): Promise<ProjectReferenceCandidate[]> {
    const references: ProjectReferenceCandidate[] = [];
    for (const chunk of this.chunkRows) {
      if (chunk.snapshotId !== snapshotId || chunk.path === excludePath) continue;
      const lines = chunk.content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!(lines[index] ?? '').includes(name)) continue;
        references.push({
          path: chunk.path,
          line: chunk.startLine + index,
          snippet: (lines[index] ?? '').trim(),
        });
        if (references.length >= limit) return references;
      }
    }
    return references;
  }

  public async searchChunks(
    input: ProjectSearchQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[] }> {
    const query = input.query.toLowerCase();
    const documents = new Map(
      this.documents
        .filter((document) => document.snapshotId === input.snapshotId)
        .map((document) => [document.path, document]),
    );
    const candidates = this.chunkRows
      .filter((chunk) => {
        if (chunk.snapshotId !== input.snapshotId) return false;
        if (input.kinds && !input.kinds.includes(chunk.kind)) return false;
        const document = documents.get(chunk.path);
        if (input.language && document?.language !== input.language) return false;
        return (
          chunk.content.toLowerCase().includes(query) ||
          chunk.path.toLowerCase().includes(query) ||
          chunk.symbol.toLowerCase().includes(query)
        );
      })
      .slice(0, input.limit)
      .map((chunk) => ({
        id: chunk.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbol: chunk.symbol,
        kind: chunk.kind,
        language: documents.get(chunk.path)?.language ?? 'other',
        content: chunk.content,
        ftsScore: 1,
        trigramScore: 0,
        vectorScore: 0,
      }));
    return { candidates };
  }

  public async searchVectors(
    input: ProjectVectorQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[] }> {
    const documents = new Map(
      this.documents
        .filter((document) => document.snapshotId === input.snapshotId)
        .map((document) => [document.path, document]),
    );
    const scored = this.chunkRows
      .filter(
        (chunk) =>
          chunk.snapshotId === input.snapshotId &&
          Boolean(chunk.embedding && chunk.embedding.length > 0),
      )
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(chunk.embedding ?? [], input.vector),
      }))
      .filter((item) => item.score > 0.5)
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit);
    return {
      candidates: scored.map(({ chunk, score }) => ({
        id: chunk.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbol: chunk.symbol,
        kind: chunk.kind,
        language: documents.get(chunk.path)?.language ?? 'other',
        content: chunk.content,
        ftsScore: 0,
        trigramScore: 0,
        vectorScore: score,
      })),
    };
  }

  public async createSyncJob(
    projectId: string,
    trigger: ProjectSyncJob['trigger'],
  ): Promise<ProjectSyncJob> {
    const job: ProjectSyncJob = {
      id: this.nextId('job'),
      projectId,
      status: 'running',
      trigger,
      error: '',
      createdAt: Date.now(),
      startedAt: Date.now(),
    };
    this.jobs.push(job);
    return job;
  }

  public async updateSyncJob(
    id: string,
    patch: Partial<
      Pick<
        ProjectSyncJob,
        'status' | 'snapshotId' | 'stats' | 'error' | 'startedAt' | 'finishedAt'
      >
    >,
  ): Promise<void> {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
  }

  public async listSyncJobs(projectId: string, limit = 20): Promise<ProjectSyncJob[]> {
    return this.jobs.filter((job) => job.projectId === projectId).slice(0, limit);
  }

  public async getLatestHandbook(
    projectId: string,
    status?: 'draft' | 'published' | 'archived',
  ): Promise<ProjectHandbookRecord | null> {
    return (
      this.handbookRows.find(
        (row) =>
          row.projectId === projectId && (status === undefined || row.status === status),
      ) ?? null
    );
  }

  public async getHandbook(
    projectId: string,
    version: number,
  ): Promise<ProjectHandbookRecord | null> {
    return (
      this.handbookRows.find(
        (row) => row.projectId === projectId && row.version === version,
      ) ?? null
    );
  }

  public async listHandbooks(
    projectId: string,
    limit = 10,
  ): Promise<ProjectHandbookRecord[]> {
    return this.handbookRows
      .filter((row) => row.projectId === projectId)
      .sort((left, right) => right.version - left.version)
      .slice(0, limit);
  }

  public async nextHandbookVersion(projectId: string): Promise<number> {
    const versions = this.handbookRows
      .filter((row) => row.projectId === projectId)
      .map((row) => row.version);
    return (versions.length > 0 ? Math.max(...versions) : 0) + 1;
  }

  public async createHandbook(
    input: ProjectHandbookCreateInput,
  ): Promise<ProjectHandbookRecord> {
    const record: ProjectHandbookRecord = {
      id: this.nextId('handbook'),
      ...input,
      createdAt: Date.now(),
      ...(input.status === 'published' ? { publishedAt: Date.now() } : {}),
    };
    this.handbookRows.push(record);
    return record;
  }

  public async publishHandbook(
    projectId: string,
    version: number,
  ): Promise<ProjectHandbookRecord | null> {
    this.handbookRows = this.handbookRows.map((row) =>
      row.projectId === projectId && row.status === 'published'
        ? { ...row, status: 'archived' as const }
        : row,
    );
    const target = this.handbookRows.find(
      (row) => row.projectId === projectId && row.version === version,
    );
    if (!target) return null;
    target.status = 'published';
    target.publishedAt = Date.now();
    return target;
  }

  public async listManualEntries(projectId: string): Promise<ProjectManualEntry[]> {
    return this.manualRows.filter((row) => row.projectId === projectId);
  }

  public async getManualEntry(
    projectId: string,
    id: string,
  ): Promise<ProjectManualEntry | null> {
    return (
      this.manualRows.find((row) => row.projectId === projectId && row.id === id) ??
      null
    );
  }

  public async createManualEntry(
    projectId: string,
    input: ProjectManualEntryInput,
    updatedBy: string,
  ): Promise<ProjectManualEntry> {
    const entry: ProjectManualEntry = {
      id: this.nextId('manual'),
      projectId,
      section: input.section,
      title: input.title,
      markdown: input.markdown,
      visibility: input.visibility ?? 'team',
      sensitivity: input.sensitivity ?? 'team',
      injectToBrief: input.injectToBrief ?? false,
      priority: input.priority ?? 0,
      updatedBy,
      updatedAt: Date.now(),
    };
    this.manualRows.push(entry);
    return entry;
  }

  public async updateManualEntry(
    projectId: string,
    id: string,
    patch: ProjectManualEntryPatch,
    updatedBy: string,
  ): Promise<ProjectManualEntry | null> {
    const entry = this.manualRows.find(
      (row) => row.projectId === projectId && row.id === id,
    );
    if (!entry) return null;
    Object.assign(entry, patch, { updatedBy, updatedAt: Date.now() });
    return entry;
  }

  public async deleteManualEntry(projectId: string, id: string): Promise<boolean> {
    const before = this.manualRows.length;
    this.manualRows = this.manualRows.filter(
      (row) => !(row.projectId === projectId && row.id === id),
    );
    return this.manualRows.length < before;
  }
}

async function createFixture(embedder?: EmbeddingClient): Promise<{
  root: string;
  repoRoot: string;
  store: MemoryProjectStore;
  service: ProjectService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'anthys-project-'));
  roots.push(root);
  const repoRoot = path.join(root, 'repo');
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src', 'app.ts'),
    [
      'export class Greeter {',
      '  greet(name: string): string {',
      '    return `hello ${name}`;',
      '  }',
      '}',
      '',
      'export function greetAll(names: string[]): string[] {',
      '  return names.map((name) => new Greeter().greet(name));',
      '}',
    ].join('\n'),
  );
  await writeFile(path.join(repoRoot, 'README.md'), '# Demo\n\n示例项目。\n');
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      repository: 'https://github.com/SongJok/anthys.git',
    }),
  );
  await writeFile(path.join(repoRoot, '.env'), 'TOKEN=secret\n');
  const store = new MemoryProjectStore();
  const service = new ProjectService({
    store,
    repoSource: new RepoSource({
      allowedRoots: [root],
      stateDir: path.join(root, '.state'),
    }),
    ...(embedder ? { embedder } : {}),
  });
  return { root, repoRoot, store, service };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

const singleChatEmployee = {
  senderStaffId: 'user-1',
  isAdmin: false,
  conversationType: '1',
} as const;

const groupEmployee = {
  senderStaffId: 'user-1',
  isAdmin: false,
  conversationType: '2',
} as const;

function context(senderStaffId = 'user-1'): ExecutionContext {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderStaffId,
    senderNick: 'Tester',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: Date.now,
  };
}

describe('ProjectService 同步与读取', () => {
  it('创建项目、同步快照、索引符号并排除敏感文件', async () => {
    const { repoRoot, service } = await createFixture();
    const project = await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      aliases: ['dingtalk-agent'],
      source: { type: 'local', path: repoRoot },
      isDefault: true,
    });
    expect(project.isDefault).toBe(true);

    const result = await service.sync('anthys');
    expect(result.snapshot.status).toBe('ready');
    expect(result.snapshot.fileCount).toBe(3);
    expect(result.stats.symbols).toBeGreaterThan(0);
    expect(result.stats.chunks).toBeGreaterThan(0);
    expect(result.project.lastCommit).toBe(result.snapshot.commitSha);

    const read = await service.readProject({
      projectRef: 'anthys',
      path: 'src/app.ts',
      startLine: 1,
      maxLines: 3,
      member: singleChatEmployee,
    });
    expect(read.content).toContain('export class Greeter');
    expect(read.endLine).toBe(3);
    expect(read.nextStartLine).toBe(4);

    const search = await service.searchProject({
      projectRef: 'anthys',
      query: 'greet',
      member: singleChatEmployee,
    });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]?.path).toBe('src/app.ts');

    const map = await service.mapProject({
      projectRef: 'anthys',
      member: singleChatEmployee,
    });
    expect(map.text).toContain('app.ts');
    expect(map.text).toContain('Greeter');

    const symbol = await service.symbolProject({
      projectRef: 'anthys',
      name: 'Greeter',
      member: singleChatEmployee,
    });
    expect(symbol.definitions[0]?.kind).toBe('class');

    const brief = await service.buildBrief({
      text: '帮我看下 dingtalk-agent 的代码结构',
      senderStaffId: 'user-1',
      isAdmin: false,
      conversationType: '1',
    });
    expect(brief?.projectId).toBe('anthys');
    expect(brief?.text).toContain('project_map');
    expect(brief?.text).not.toContain(repoRoot);
    expect(brief?.commit).toBe(result.snapshot.commitSha);
  });

  it('同步时写入分块向量并支持纯向量检索', async () => {
    const embedder: EmbeddingClient = {
      dimensions: 2,
      async embed(texts) {
        return texts.map((text) => (/entry|handle/iu.test(text) ? [1, 0] : [0, 1]));
      },
    };
    const { repoRoot, service } = await createFixture(embedder);
    await writeFile(
      path.join(repoRoot, 'src', 'entry.ts'),
      [
        'export function handleEntry(): string {',
        "  return 'entry';",
        '}',
      ].join('\n'),
    );
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
    });
    const result = await service.sync('anthys');
    expect(result.stats.embeddedChunks).toBe(result.stats.chunks);
    expect(result.stats.embeddingError).toBeUndefined();

    const search = await service.searchProject({
      projectRef: 'anthys',
      query: 'entryhandler',
      member: singleChatEmployee,
    });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]).toMatchObject({
      path: 'src/entry.ts',
      match: 'vector',
    });

    const status = await service.getProjectStatus('anthys');
    expect(status.embeddingEnabled).toBe(true);
    expect(status.index?.chunks).toBeGreaterThan(0);
    expect(status.index?.embeddedChunks).toBe(status.index?.chunks);
    expect(status.latestJob?.status).toBe('succeeded');
    expect(status.handbook).toEqual({
      publishedVersion: 0,
      draftVersion: null,
      stale: false,
    });
  });

  it('向量生成失败时降级为关键字检索并记录错误', async () => {
    const embedder: EmbeddingClient = {
      dimensions: 2,
      async embed() {
        throw new Error('embedding service unavailable');
      },
    };
    const { repoRoot, service } = await createFixture(embedder);
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
    });
    const result = await service.sync('anthys');
    expect(result.stats.embeddedChunks).toBe(0);
    expect(result.stats.embeddingError).toContain('embedding service unavailable');

    const search = await service.searchProject({
      projectRef: 'anthys',
      query: 'greet',
      member: singleChatEmployee,
    });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]?.path).toBe('src/app.ts');
    expect(search.warning).toContain('向量检索失败');

    const status = await service.getProjectStatus('anthys');
    expect(status.index?.embeddedChunks).toBe(0);
    expect(status.latestJob?.status).toBe('succeeded');
  });

  it('保存章节修改生成新草稿并保留已发布版本', async () => {
    const { repoRoot, store, service } = await createFixture();
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
    });
    await service.sync('anthys');

    const draft = await service.generateHandbook('anthys');
    expect(draft.version).toBe(1);
    await service.publishHandbook('anthys', draft.version);

    const saved = await service.saveHandbookDraft(
      'anthys',
      {
        sections: [
          { key: 'overview', title: '项目概述', markdown: '人工补充的概述' },
        ],
      },
      'admin-1',
    );
    expect(saved.version).toBe(2);
    expect(saved.status).toBe('draft');
    expect(saved.generatedBy).toBe('manual');
    expect(saved.createdBy).toBe('admin-1');
    expect(
      saved.content.sections.find((section) => section.key === 'overview'),
    ).toMatchObject({
      title: '项目概述',
      markdown: '人工补充的概述',
      origin: 'curated',
    });
    expect((await store.getHandbook('anthys', 1))?.status).toBe('published');
    expect((await service.getHandbookDraft('anthys'))?.version).toBe(2);

    const beforePublish = await service.getProjectStatus('anthys');
    expect(beforePublish.handbook).toMatchObject({
      publishedVersion: 1,
      draftVersion: 2,
    });

    const published = await service.publishHandbook('anthys');
    expect(published.version).toBe(2);
    const afterPublish = await service.getProjectStatus('anthys');
    expect(afterPublish.handbook).toMatchObject({
      publishedVersion: 2,
      draftVersion: null,
    });

    await expect(
      service.saveHandbookDraft('anthys', {
        sections: [{ key: 'overview', markdown: '   ' }],
      }),
    ).rejects.toThrow(/不能为空/u);
  });

  it('敏感文件不会被索引，不存在文件读取会报错', async () => {
    const { repoRoot, service } = await createFixture();
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
    });
    await service.sync('anthys');
    await expect(
      service.readProject({
        projectRef: 'anthys',
        path: '.env',
        member: singleChatEmployee,
      }),
    ).rejects.toThrow(/不在当前快照/u);
  });

  it('private 敏感度项目拒绝在群聊中读取内容', async () => {
    const { repoRoot, service } = await createFixture();
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
      sensitivity: 'private',
    });
    await service.sync('anthys');
    await expect(
      service.searchProject({
        projectRef: 'anthys',
        query: 'greet',
        member: groupEmployee,
      }),
    ).rejects.toThrow(/private/u);
  });

  it('生成手册草稿、发布版本并保护人工改过的条目', async () => {
    const { repoRoot, service } = await createFixture();
    await writeFile(
      path.join(repoRoot, '.env.example'),
      'LLM_API_KEY=sk-secret-value\nDATABASE_URL=postgres://demo:CHANGE_ME@db\n',
    );
    await mkdir(path.join(repoRoot, 'deploy'), { recursive: true });
    await writeFile(
      path.join(repoRoot, 'deploy', 'dingtalk-agent.service'),
      'ExecStart=/usr/bin/env node dist/index.js\n',
    );
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
    });
    await service.sync('anthys');

    const seeded = await service.importManualEntries(
      'anthys',
      [
        {
          section: 'overview',
          title: '值班安排',
          markdown: '值班说明',
          injectToBrief: true,
        },
      ],
      'seed:test',
    );
    expect(seeded).toEqual({ created: 1, updated: 0, skipped: 0 });
    const manual = await service.createManualEntry(
      'anthys',
      { section: 'operations', title: '发布步骤', markdown: '先备份再发布' },
      'admin-1',
    );
    expect(manual.updatedBy).toBe('admin-1');

    const draft = await service.generateHandbook('anthys');
    expect(draft).toMatchObject({
      version: 1,
      status: 'draft',
      generatedBy: 'facts',
    });
    const config = draft.content.sections.find(
      (section) => section.key === 'config',
    );
    expect(config?.markdown).toContain('LLM_API_KEY');
    expect(config?.markdown).not.toContain('sk-secret-value');
    expect(config?.markdown).not.toContain('postgres://demo:secret');

    const overview = draft.content.sections.find(
      (section) => section.key === 'overview',
    );
    expect(overview?.markdown).toContain('https://github.com/SongJok/anthys');
    expect(overview?.markdown).toContain('点个 Star');
    expect(overview?.markdown).not.toContain(repoRoot);

    const published = await service.publishHandbook('anthys', draft.version);
    expect(published.status).toBe('published');
    const fetched = await service.getHandbook({
      projectRef: 'anthys',
      member: singleChatEmployee,
    });
    expect(fetched.version).toBe(1);
    expect(fetched.manualEntries.map((entry) => entry.title)).toEqual(
      expect.arrayContaining(['值班安排', '发布步骤']),
    );
    const operationsOnly = await service.getHandbook({
      projectRef: 'anthys',
      section: 'operations',
      member: singleChatEmployee,
    });
    expect(operationsOnly.manualEntries.map((entry) => entry.title)).toEqual([
      '发布步骤',
    ]);

    const seededEntry = (await service.listManualEntries('anthys')).find(
      (entry) => entry.title === '值班安排',
    );
    expect(seededEntry).toBeDefined();
    await service.updateManualEntry(
      'anthys',
      seededEntry?.id ?? '',
      { markdown: '人工改过' },
      'admin-1',
    );
    const again = await service.importManualEntries(
      'anthys',
      [
        { section: 'overview', title: '值班安排', markdown: '种子更新' },
        { section: 'overview', title: '新增条目', markdown: '新内容' },
      ],
      'seed:test',
    );
    expect(again).toEqual({ created: 1, updated: 0, skipped: 1 });
    const rows = await service.listManualEntries('anthys');
    expect(rows.find((entry) => entry.title === '值班安排')?.markdown).toBe(
      '人工改过',
    );

    await service.deleteManualEntry('anthys', manual.id);
    expect(
      (await service.listManualEntries('anthys')).some(
        (entry) => entry.id === manual.id,
      ),
    ).toBe(false);
  });

  it('GitHub 项目的 issues/prs 通过注入的客户端查询', async () => {
    const { root, repoRoot, store } = await createFixture();
    const requests: Array<Record<string, unknown>> = [];
    const service = new ProjectService({
      store,
      repoSource: new RepoSource({
        allowedRoots: [root],
        stateDir: path.join(root, '.state-github'),
      }),
      github: {
        search: async (repoRef, query, options) => {
          requests.push({ repoRef, query, ...options });
          return {
            items: [
              {
                number: 7,
                title: '修复卡片刷新',
                state: 'open',
                author: 'joony',
                labels: ['bug'],
                htmlUrl: 'https://github.com/SongJok/anthys/issues/7',
                body: '',
                createdAt: '',
                updatedAt: '2026-10-01T00:00:00Z',
              },
            ],
            total: 3,
          };
        },
      },
    });
    await service.createProject({
      id: 'github-demo',
      name: 'GitHub Demo',
      source: { type: 'github', repo: 'SongJok/anthys' },
    });
    await service.createProject({
      id: 'local-demo',
      name: 'Local Demo',
      source: { type: 'local', path: repoRoot },
    });

    const issues = await service.historyProject({
      projectRef: 'github-demo',
      kind: 'issues',
      query: '卡片',
      limit: 5,
      member: singleChatEmployee,
    });
    expect(issues.issues?.[0]).toMatchObject({ number: 7, title: '修复卡片刷新' });
    expect(issues.total).toBe(3);
    expect(requests[0]).toEqual({
      repoRef: 'SongJok/anthys',
      query: '卡片',
      kind: 'issues',
      limit: 5,
    });

    const prs = await service.historyProject({
      projectRef: 'github-demo',
      kind: 'prs',
      member: singleChatEmployee,
    });
    expect(prs.issues?.length).toBe(1);
    expect(requests[1]).toMatchObject({ kind: 'prs', limit: 10 });

    const local = await service.historyProject({
      projectRef: 'local-demo',
      kind: 'issues',
      member: singleChatEmployee,
    });
    expect(local.issues).toBeUndefined();
    expect(local.note).toContain('GitHub 来源');
  });

  it('工具 Provider 返回带行号的读取结果和检索引用', async () => {
    const { repoRoot, service } = await createFixture();
    await service.createProject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: repoRoot },
    });
    await service.sync('anthys');
    const provider = new ProjectToolProvider({
      service,
      isAdmin: () => false,
    });
    const tools = await provider.getTools(context());
    expect(tools.map((tool) => tool.name)).toEqual([
      'project_list',
      'project_handbook',
      'project_map',
      'project_search',
      'project_read',
      'project_symbol',
      'project_history',
    ]);
    const readTool = tools.find((tool) => tool.name === 'project_read');
    const readOutput = await readTool?.executeStructured?.(
      { project: 'anthys', path: 'src/app.ts', maxLines: 2 },
      context(),
    );
    expect(readOutput?.text).toContain('1| export class Greeter');
    expect(readOutput?.citations?.[0]?.source).toContain('project:anthys@');

    const searchTool = tools.find((tool) => tool.name === 'project_search');
    const searchOutput = await searchTool?.executeStructured?.(
      { project: 'anthys', query: 'greet' },
      context(),
    );
    expect(searchOutput?.text).toContain('src/app.ts');
    expect(searchOutput?.citations?.length).toBeGreaterThan(0);
  });
});
