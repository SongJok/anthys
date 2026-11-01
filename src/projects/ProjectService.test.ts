import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../types/core.js';
import type {
  HandbookSectionKey,
  ProjectDocument,
  ProjectDocumentKind,
  ProjectHandbookRecord,
  ProjectManualEntry,
  ProjectRecord,
  ProjectSnapshot,
  ProjectSyncJob,
  ProjectSymbol,
  ProjectVisibility,
  ProjectSensitivity,
} from '../types/skills-plugins-projects.js';
import type {
  ProjectDocumentMeta,
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
    _input: ProjectVectorQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[] }> {
    return { candidates: [] };
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
    _projectId: string,
    _status?: 'draft' | 'published' | 'archived',
  ): Promise<ProjectHandbookRecord | null> {
    return this.handbookRows[0] ?? null;
  }

  public async listManualEntries(_projectId: string): Promise<ProjectManualEntry[]> {
    return this.manualRows;
  }
}

async function createFixture(): Promise<{
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
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  );
  await writeFile(path.join(repoRoot, '.env'), 'TOKEN=secret\n');
  const store = new MemoryProjectStore();
  const service = new ProjectService({
    store,
    repoSource: new RepoSource({
      allowedRoots: [root],
      stateDir: path.join(root, '.state'),
    }),
  });
  return { root, repoRoot, store, service };
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
    expect(brief?.commit).toBe(result.snapshot.commitSha);
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
