import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  projectChunks,
  projectDocuments,
  projectHandbooks,
  projectManualEntries,
  projectSnapshots,
  projectSyncJobs,
  projectSymbols,
  projects,
} from '../db/projectSchema.js';
import type {
  HandbookSectionKey,
  ProjectDocument,
  ProjectDocumentKind,
  ProjectHandbookRecord,
  ProjectManualEntry,
  ProjectRecord,
  ProjectSnapshot,
  ProjectSnapshotStatus,
  ProjectSyncJob,
  ProjectSyncStats,
  ProjectSyncStatus,
  ProjectSymbol,
  ProjectVisibility,
  ProjectSensitivity,
} from '../types/skills-plugins-projects.js';

export interface ProjectDocumentMeta {
  path: string;
  language: string;
  kind: ProjectDocumentKind;
  sizeBytes: number;
  lineCount: number;
}

export interface ProjectSearchQuery {
  snapshotId: string;
  query: string;
  pathLike?: string;
  language?: string;
  kinds?: string[];
  limit: number;
}

export interface ProjectVectorQuery extends ProjectSearchQuery {
  vector: number[];
}

export interface ProjectSearchCandidate {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  kind: string;
  language: string;
  content: string;
  ftsScore: number;
  trigramScore: number;
  vectorScore: number;
}

export interface ProjectReferenceCandidate {
  path: string;
  line: number;
  snippet: string;
}

export interface ProjectStoreLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

function toMs(value: Date | null | undefined): number | undefined {
  return value ? new Date(value).getTime() : undefined;
}

function toProjectRecord(
  row: typeof projects.$inferSelect,
): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    description: row.description,
    source: row.sourceConfig,
    defaultBranch: row.defaultBranch,
    ownerStaffIds: row.ownerStaffIds ?? [],
    visibility: row.visibility as ProjectVisibility,
    sensitivity: row.sensitivity as ProjectSensitivity,
    isDefault: row.isDefault,
    enabled: row.enabled,
    autoSyncMinutes: row.autoSyncMinutes,
    ...(row.activeSnapshotId ? { activeSnapshotId: row.activeSnapshotId } : {}),
    lastCommit: row.lastCommit,
    ...(row.lastSyncedAt
      ? { lastSyncedAt: new Date(row.lastSyncedAt).getTime() }
      : {}),
    handbookVersion: row.handbookVersion,
    lastError: row.lastError,
  };
}

function toSnapshot(row: typeof projectSnapshots.$inferSelect): ProjectSnapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    commitSha: row.commitSha,
    branch: row.branch,
    status: row.status as ProjectSnapshotStatus,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    symbolCount: row.symbolCount,
    chunkCount: row.chunkCount,
    stats: row.stats ?? {},
    error: row.error,
    startedAt: new Date(row.startedAt).getTime(),
    ...(row.finishedAt
      ? { finishedAt: new Date(row.finishedAt).getTime() }
      : {}),
  };
}

function toSyncJob(row: typeof projectSyncJobs.$inferSelect): ProjectSyncJob {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as ProjectSyncStatus,
    trigger: row.trigger as ProjectSyncJob['trigger'],
    ...(row.snapshotId ? { snapshotId: row.snapshotId } : {}),
    ...(row.stats ? { stats: row.stats } : {}),
    error: row.error,
    createdAt: new Date(row.createdAt).getTime(),
    ...(row.startedAt ? { startedAt: new Date(row.startedAt).getTime() } : {}),
    ...(row.finishedAt
      ? { finishedAt: new Date(row.finishedAt).getTime() }
      : {}),
  };
}

export interface ProjectStore {
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | null>;
  createProject(record: ProjectRecord): Promise<ProjectRecord>;
  updateProject(id: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord>;
  deleteProject(id: string): Promise<void>;
  clearDefaultProject(exceptId?: string): Promise<void>;

  listSnapshots(projectId: string, limit?: number): Promise<ProjectSnapshot[]>;
  getSnapshot(id: string): Promise<ProjectSnapshot | null>;
  findSnapshotByCommit(
    projectId: string,
    commitSha: string,
  ): Promise<ProjectSnapshot | null>;
  createSnapshot(
    input: Pick<ProjectSnapshot, 'projectId' | 'commitSha' | 'branch'>,
  ): Promise<ProjectSnapshot>;
  updateSnapshot(
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
  ): Promise<void>;
  deleteSnapshot(id: string): Promise<void>;
  setActiveSnapshot(project: ProjectRecord, snapshot: ProjectSnapshot): Promise<void>;
  pruneSnapshots(projectId: string, keep: number): Promise<number>;

  insertDocuments(documents: ProjectDocument[]): Promise<void>;
  insertChunks(chunks: ProjectSearchCandidateInput[]): Promise<void>;
  insertSymbols(symbols: ProjectSymbol[]): Promise<void>;
  listDocumentMetas(snapshotId: string): Promise<ProjectDocumentMeta[]>;
  getDocument(snapshotId: string, path: string): Promise<ProjectDocument | null>;
  getSymbols(snapshotId: string): Promise<ProjectSymbol[]>;
  findSymbols(
    snapshotId: string,
    name: string,
    kind: string | undefined,
    pathLike: string | undefined,
    limit: number,
  ): Promise<ProjectSymbol[]>;
  findReferences(
    snapshotId: string,
    name: string,
    excludePath: string | undefined,
    limit: number,
  ): Promise<ProjectReferenceCandidate[]>;

  searchChunks(
    input: ProjectSearchQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[]; warning?: string }>;
  searchVectors(
    input: ProjectVectorQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[]; warning?: string }>;

  createSyncJob(
    projectId: string,
    trigger: ProjectSyncJob['trigger'],
    status?: ProjectSyncStatus,
  ): Promise<ProjectSyncJob>;
  updateSyncJob(
    id: string,
    patch: Partial<
      Pick<
        ProjectSyncJob,
        'status' | 'snapshotId' | 'stats' | 'error' | 'startedAt' | 'finishedAt'
      >
    >,
  ): Promise<void>;
  listSyncJobs(projectId: string, limit?: number): Promise<ProjectSyncJob[]>;

  getLatestHandbook(
    projectId: string,
    status?: 'draft' | 'published' | 'archived',
  ): Promise<ProjectHandbookRecord | null>;
  listManualEntries(projectId: string): Promise<ProjectManualEntry[]>;
}

export interface ProjectSearchCandidateInput {
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
  embedding?: number[] | null;
}

const INSERT_BATCH = 100;

function chunksOf<T>(items: T[], size = INSERT_BATCH): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function csvTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
        .slice(0, 6),
    ),
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

export class DrizzleProjectStore implements ProjectStore {
  private keywordIndexAvailable: boolean | null = null;

  constructor(
    private readonly db: Database,
    private readonly logger?: ProjectStoreLogger,
  ) {}

  public async listProjects(): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .orderBy(desc(projects.isDefault), projects.name);
    return rows.map(toProjectRecord);
  }

  public async getProject(id: string): Promise<ProjectRecord | null> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return row ? toProjectRecord(row) : null;
  }

  public async createProject(record: ProjectRecord): Promise<ProjectRecord> {
    const [row] = await this.db
      .insert(projects)
      .values({
        id: record.id,
        name: record.name,
        aliases: record.aliases,
        description: record.description,
        sourceType: record.source.type,
        sourceConfig: record.source,
        defaultBranch: record.defaultBranch,
        ownerStaffIds: record.ownerStaffIds,
        visibility: record.visibility,
        sensitivity: record.sensitivity,
        isDefault: record.isDefault,
        enabled: record.enabled,
        autoSyncMinutes: record.autoSyncMinutes,
        lastCommit: record.lastCommit,
        lastError: record.lastError ?? '',
      })
      .returning();
    return toProjectRecord(row);
  }

  public async updateProject(
    id: string,
    patch: Partial<ProjectRecord>,
  ): Promise<ProjectRecord> {
    const [row] = await this.db
      .update(projects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.source !== undefined
          ? { sourceType: patch.source.type, sourceConfig: patch.source }
          : {}),
        ...(patch.defaultBranch !== undefined
          ? { defaultBranch: patch.defaultBranch }
          : {}),
        ...(patch.ownerStaffIds !== undefined
          ? { ownerStaffIds: patch.ownerStaffIds }
          : {}),
        ...(patch.visibility !== undefined
          ? { visibility: patch.visibility }
          : {}),
        ...(patch.sensitivity !== undefined
          ? { sensitivity: patch.sensitivity }
          : {}),
        ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.autoSyncMinutes !== undefined
          ? { autoSyncMinutes: patch.autoSyncMinutes }
          : {}),
        ...(patch.activeSnapshotId !== undefined
          ? { activeSnapshotId: patch.activeSnapshotId }
          : {}),
        ...(patch.lastCommit !== undefined
          ? { lastCommit: patch.lastCommit }
          : {}),
        ...(patch.lastSyncedAt !== undefined
          ? { lastSyncedAt: new Date(patch.lastSyncedAt) }
          : {}),
        ...(patch.handbookVersion !== undefined
          ? { handbookVersion: patch.handbookVersion }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();
    if (!row) throw new Error(`项目不存在：${id}`);
    return toProjectRecord(row);
  }

  public async deleteProject(id: string): Promise<void> {
    const snapshotIds = await this.db
      .select({ id: projectSnapshots.id })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, id));
    for (const snapshot of snapshotIds) {
      await this.deleteSnapshot(snapshot.id);
    }
    await this.db
      .delete(projectSyncJobs)
      .where(eq(projectSyncJobs.projectId, id));
    await this.db
      .delete(projectHandbooks)
      .where(eq(projectHandbooks.projectId, id));
    await this.db
      .delete(projectManualEntries)
      .where(eq(projectManualEntries.projectId, id));
    await this.db.delete(projects).where(eq(projects.id, id));
  }

  public async clearDefaultProject(exceptId?: string): Promise<void> {
    await this.db
      .update(projects)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        exceptId
          ? and(eq(projects.isDefault, true), ne(projects.id, exceptId))
          : eq(projects.isDefault, true),
      );
  }

  public async listSnapshots(
    projectId: string,
    limit = 10,
  ): Promise<ProjectSnapshot[]> {
    const rows = await this.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, projectId))
      .orderBy(desc(projectSnapshots.startedAt))
      .limit(Math.max(1, limit));
    return rows.map(toSnapshot);
  }

  public async getSnapshot(id: string): Promise<ProjectSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.id, id))
      .limit(1);
    return row ? toSnapshot(row) : null;
  }

  public async findSnapshotByCommit(
    projectId: string,
    commitSha: string,
  ): Promise<ProjectSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(projectSnapshots)
      .where(
        and(
          eq(projectSnapshots.projectId, projectId),
          eq(projectSnapshots.commitSha, commitSha),
        ),
      )
      .limit(1);
    return row ? toSnapshot(row) : null;
  }

  public async createSnapshot(
    input: Pick<ProjectSnapshot, 'projectId' | 'commitSha' | 'branch'>,
  ): Promise<ProjectSnapshot> {
    const [row] = await this.db
      .insert(projectSnapshots)
      .values({
        projectId: input.projectId,
        commitSha: input.commitSha,
        branch: input.branch,
        status: 'building',
      })
      .returning();
    return toSnapshot(row);
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
    await this.db
      .update(projectSnapshots)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.fileCount !== undefined ? { fileCount: patch.fileCount } : {}),
        ...(patch.totalBytes !== undefined
          ? { totalBytes: patch.totalBytes }
          : {}),
        ...(patch.symbolCount !== undefined
          ? { symbolCount: patch.symbolCount }
          : {}),
        ...(patch.chunkCount !== undefined
          ? { chunkCount: patch.chunkCount }
          : {}),
        ...(patch.stats !== undefined ? { stats: patch.stats } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.finishedAt !== undefined
          ? { finishedAt: new Date(patch.finishedAt) }
          : {}),
      })
      .where(eq(projectSnapshots.id, id));
  }

  public async deleteSnapshot(id: string): Promise<void> {
    await this.db
      .delete(projectChunks)
      .where(eq(projectChunks.snapshotId, id));
    await this.db
      .delete(projectDocuments)
      .where(eq(projectDocuments.snapshotId, id));
    await this.db
      .delete(projectSymbols)
      .where(eq(projectSymbols.snapshotId, id));
    await this.db
      .delete(projectSnapshots)
      .where(eq(projectSnapshots.id, id));
  }

  public async setActiveSnapshot(
    project: ProjectRecord,
    snapshot: ProjectSnapshot,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(projectSnapshots)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(projectSnapshots.projectId, project.id),
            ne(projectSnapshots.id, snapshot.id),
            eq(projectSnapshots.status, 'ready'),
          ),
        );
      await tx
        .update(projects)
        .set({
          activeSnapshotId: snapshot.id,
          lastCommit: snapshot.commitSha,
          lastSyncedAt: new Date(),
          lastError: '',
          updatedAt: new Date(),
        })
        .where(eq(projects.id, project.id));
    });
  }

  /** 保留最近 N 个快照（活动快照始终保留），返回清理数量 */
  public async pruneSnapshots(projectId: string, keep: number): Promise<number> {
    const project = await this.getProject(projectId);
    const rows = await this.db
      .select({ id: projectSnapshots.id })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, projectId))
      .orderBy(desc(projectSnapshots.startedAt));
    const keepIds = new Set(rows.slice(0, Math.max(1, keep)).map((row) => row.id));
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
    for (const batch of chunksOf(documents)) {
      await this.db.insert(projectDocuments).values(
        batch.map((document) => ({
          projectId: document.projectId,
          snapshotId: document.snapshotId,
          path: document.path,
          language: document.language,
          kind: document.kind,
          contentHash: document.contentHash,
          sizeBytes: document.sizeBytes,
          lineCount: document.lineCount,
          text: document.text,
        })),
      );
    }
  }

  public async insertChunks(
    chunks: ProjectSearchCandidateInput[],
  ): Promise<void> {
    for (const batch of chunksOf(chunks, 50)) {
      await this.db.insert(projectChunks).values(
        batch.map((chunk) => ({
          projectId: chunk.projectId,
          snapshotId: chunk.snapshotId,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
          kind: chunk.kind,
          content: chunk.content,
          contentHash: chunk.contentHash,
          tokenCount: chunk.tokenCount,
          ...(chunk.embedding && chunk.embedding.length > 0
            ? { embedding: chunk.embedding }
            : {}),
        })),
      );
    }
  }

  public async insertSymbols(symbols: ProjectSymbol[]): Promise<void> {
    for (const batch of chunksOf(symbols, 200)) {
      await this.db.insert(projectSymbols).values(
        batch.map((symbol) => ({
          projectId: symbol.projectId,
          snapshotId: symbol.snapshotId,
          path: symbol.path,
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature,
          parent: symbol.parent,
          exported: symbol.exported,
        })),
      );
    }
  }

  public async listDocumentMetas(
    snapshotId: string,
  ): Promise<ProjectDocumentMeta[]> {
    return this.db
      .select({
        path: projectDocuments.path,
        language: projectDocuments.language,
        kind: projectDocuments.kind,
        sizeBytes: projectDocuments.sizeBytes,
        lineCount: projectDocuments.lineCount,
      })
      .from(projectDocuments)
      .where(eq(projectDocuments.snapshotId, snapshotId))
      .orderBy(projectDocuments.path) as Promise<ProjectDocumentMeta[]>;
  }

  public async getDocument(
    snapshotId: string,
    path: string,
  ): Promise<ProjectDocument | null> {
    const [row] = await this.db
      .select()
      .from(projectDocuments)
      .where(
        and(
          eq(projectDocuments.snapshotId, snapshotId),
          eq(projectDocuments.path, path),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      snapshotId: row.snapshotId,
      path: row.path,
      language: row.language,
      kind: row.kind as ProjectDocumentKind,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      lineCount: row.lineCount,
      text: row.text,
    };
  }

  public async getSymbols(snapshotId: string): Promise<ProjectSymbol[]> {
    const rows = await this.db
      .select()
      .from(projectSymbols)
      .where(eq(projectSymbols.snapshotId, snapshotId))
      .orderBy(projectSymbols.path, projectSymbols.startLine);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      snapshotId: row.snapshotId,
      path: row.path,
      name: row.name,
      kind: row.kind,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature,
      parent: row.parent,
      exported: row.exported,
    }));
  }

  public async findSymbols(
    snapshotId: string,
    name: string,
    kind: string | undefined,
    pathLike: string | undefined,
    limit: number,
  ): Promise<ProjectSymbol[]> {
    const normalized = name.toLowerCase();
    const rows = await this.db
      .select()
      .from(projectSymbols)
      .where(
        and(
          eq(projectSymbols.snapshotId, snapshotId),
          sql`(lower(${projectSymbols.name}) = ${normalized} or lower(${projectSymbols.name}) like ${`${escapeLike(normalized)}%`})`,
          ...(kind ? [eq(projectSymbols.kind, kind)] : []),
          ...(pathLike ? [sql`${projectSymbols.path} like ${pathLike}`] : []),
        ),
      )
      .orderBy(
        sql`case when lower(${projectSymbols.name}) = ${normalized} then 0 else 1 end`,
        projectSymbols.name,
        projectSymbols.startLine,
      )
      .limit(Math.max(1, limit));
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      snapshotId: row.snapshotId,
      path: row.path,
      name: row.name,
      kind: row.kind,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature,
      parent: row.parent,
      exported: row.exported,
    }));
  }

  public async findReferences(
    snapshotId: string,
    name: string,
    excludePath: string | undefined,
    limit: number,
  ): Promise<ProjectReferenceCandidate[]> {
    const pattern = `%${escapeLike(name)}%`;
    const rows = await this.db
      .select({
        path: projectChunks.path,
        startLine: projectChunks.startLine,
        content: projectChunks.content,
      })
      .from(projectChunks)
      .where(
        and(
          eq(projectChunks.snapshotId, snapshotId),
          sql`${projectChunks.content} ilike ${pattern}`,
          ...(excludePath ? [ne(projectChunks.path, excludePath)] : []),
        ),
      )
      .orderBy(projectChunks.path, projectChunks.startLine)
      .limit(40);
    const references: ProjectReferenceCandidate[] = [];
    for (const row of rows) {
      const lines = row.content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.toLowerCase().includes(name.toLowerCase())) continue;
        references.push({
          path: row.path,
          line: row.startLine + index,
          snippet: line.trim().slice(0, 200),
        });
        if (references.length >= limit) return references;
      }
    }
    return references;
  }

  public async searchChunks(
    input: ProjectSearchQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[]; warning?: string }> {
    const query = input.query.trim();
    if (!query) return { candidates: [] };
    const pathLike = input.pathLike ?? null;
    const language = input.language ?? null;
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
    if (this.keywordIndexAvailable !== false) {
      try {
        const result = await this.db.execute(sql`
          select s.*
          from (
            select
              c.id,
              c.path,
              c.start_line,
              c.end_line,
              c.symbol,
              c.kind,
              d.language,
              c.content,
              ts_rank(c.tsv, plainto_tsquery('simple', ${query}))::float8 as fts,
              similarity(c.content, ${query})::float8 as trgm
            from project_chunks c
            join project_documents d
              on d.snapshot_id = c.snapshot_id and d.path = c.path
            where c.snapshot_id = ${input.snapshotId}
              and (${pathLike}::text is null or c.path like ${pathLike})
              and (${language}::text is null or d.language = ${language})
              and (${kinds}::text[] is null or c.kind = any(${kinds}::text[]))
              and (
                c.tsv @@ plainto_tsquery('simple', ${query})
                or c.content ilike ${`%${escapeLike(query)}%`}
                or c.path ilike ${`%${escapeLike(query)}%`}
                or c.symbol ilike ${`%${escapeLike(query)}%`}
                or similarity(c.content, ${query}) > 0.05
              )
          ) s
          order by greatest(s.fts, s.trgm) desc, s.path asc, s.start_line asc
          limit ${Math.max(1, input.limit)}
        `);
        this.keywordIndexAvailable = true;
        return { candidates: this.mapSearchRows(result.rows) };
      } catch (error) {
        this.keywordIndexAvailable = false;
        this.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'project keyword index unavailable, falling back to ILIKE',
        );
      }
    }
    return this.searchChunksFallback(input);
  }

  public async searchVectors(
    input: ProjectVectorQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[]; warning?: string }> {
    if (input.vector.length === 0) return { candidates: [] };
    const vectorLiteral = `[${input.vector.join(',')}]`;
    const pathLike = input.pathLike ?? null;
    const language = input.language ?? null;
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
    try {
      const result = await this.db.execute(sql`
        select
          c.id,
          c.path,
          c.start_line,
          c.end_line,
          c.symbol,
          c.kind,
          d.language,
          c.content,
          (1 - (c.embedding <=> ${vectorLiteral}::vector))::float8 as vector_score
        from project_chunks c
        join project_documents d
          on d.snapshot_id = c.snapshot_id and d.path = c.path
        where c.snapshot_id = ${input.snapshotId}
          and c.embedding is not null
          and (${pathLike}::text is null or c.path like ${pathLike})
          and (${language}::text is null or d.language = ${language})
          and (${kinds}::text[] is null or c.kind = any(${kinds}::text[]))
        order by c.embedding <=> ${vectorLiteral}::vector asc
        limit ${Math.max(1, input.limit)}
      `);
      return {
        candidates: result.rows.map((row) => ({
          ...this.mapSearchRow(row),
          vectorScore: Number(row.vector_score ?? 0),
        })),
      };
    } catch (error) {
      return {
        candidates: [],
        warning: `向量检索不可用：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async searchChunksFallback(
    input: ProjectSearchQuery,
  ): Promise<{ candidates: ProjectSearchCandidate[]; warning?: string }> {
    const tokens = csvTokens(input.query);
    if (tokens.length === 0) tokens.push(input.query.toLowerCase());
    const tokenConds = tokens.map(
      (token) =>
        sql`(c.content ilike ${`%${escapeLike(token)}%`} or c.path ilike ${`%${escapeLike(token)}%`} or c.symbol ilike ${`%${escapeLike(token)}%`})`,
    );
    const pathLike = input.pathLike ?? null;
    const language = input.language ?? null;
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
    try {
      const result = await this.db.execute(sql`
        select
          c.id,
          c.path,
          c.start_line,
          c.end_line,
          c.symbol,
          c.kind,
          d.language,
          c.content,
          0::float8 as fts,
          0::float8 as trgm
        from project_chunks c
        join project_documents d
          on d.snapshot_id = c.snapshot_id and d.path = c.path
        where c.snapshot_id = ${input.snapshotId}
          and (${pathLike}::text is null or c.path like ${pathLike})
          and (${language}::text is null or d.language = ${language})
          and (${kinds}::text[] is null or c.kind = any(${kinds}::text[]))
          and (${sql.join(tokenConds, sql` or `)})
        order by c.path asc, c.start_line asc
        limit ${Math.max(1, input.limit)}
      `);
      return {
        candidates: this.mapSearchRows(result.rows),
        warning:
          this.keywordIndexAvailable === false
            ? '关键词索引未初始化，已降级为 LIKE 检索（可运行 pnpm db:extend）'
            : undefined,
      };
    } catch (error) {
      return {
        candidates: [],
        warning: `代码检索失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private mapSearchRows(rows: Record<string, unknown>[]): ProjectSearchCandidate[] {
    return rows.map((row) => this.mapSearchRow(row));
  }

  private mapSearchRow(row: Record<string, unknown>): ProjectSearchCandidate {
    return {
      id: String(row.id),
      path: String(row.path),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      symbol: String(row.symbol ?? ''),
      kind: String(row.kind ?? 'code'),
      language: String(row.language ?? 'other'),
      content: String(row.content ?? ''),
      ftsScore: Number(row.fts ?? 0),
      trigramScore: Number(row.trgm ?? 0),
      vectorScore: 0,
    };
  }

  public async createSyncJob(
    projectId: string,
    trigger: ProjectSyncJob['trigger'],
    status: ProjectSyncStatus = 'running',
  ): Promise<ProjectSyncJob> {
    const [row] = await this.db
      .insert(projectSyncJobs)
      .values({
        projectId,
        status,
        trigger,
        ...(status === 'queued' ? {} : { startedAt: new Date() }),
      })
      .returning();
    return toSyncJob(row);
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
    await this.db
      .update(projectSyncJobs)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.snapshotId !== undefined
          ? { snapshotId: patch.snapshotId }
          : {}),
        ...(patch.stats !== undefined ? { stats: patch.stats } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.startedAt !== undefined
          ? { startedAt: new Date(patch.startedAt) }
          : {}),
        ...(patch.finishedAt !== undefined
          ? { finishedAt: new Date(patch.finishedAt) }
          : {}),
      })
      .where(eq(projectSyncJobs.id, id));
  }

  public async listSyncJobs(
    projectId: string,
    limit = 20,
  ): Promise<ProjectSyncJob[]> {
    const rows = await this.db
      .select()
      .from(projectSyncJobs)
      .where(eq(projectSyncJobs.projectId, projectId))
      .orderBy(desc(projectSyncJobs.createdAt))
      .limit(Math.max(1, limit));
    return rows.map(toSyncJob);
  }

  public async getLatestHandbook(
    projectId: string,
    status: 'draft' | 'published' | 'archived' = 'published',
  ): Promise<ProjectHandbookRecord | null> {
    const [row] = await this.db
      .select()
      .from(projectHandbooks)
      .where(
        and(
          eq(projectHandbooks.projectId, projectId),
          eq(projectHandbooks.status, status),
        ),
      )
      .orderBy(desc(projectHandbooks.version))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      status: row.status as ProjectHandbookRecord['status'],
      commitSha: row.commitSha,
      content: row.content,
      sources: row.sources ?? [],
      generatedBy: row.generatedBy as ProjectHandbookRecord['generatedBy'],
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt).getTime(),
      ...(row.publishedAt
        ? { publishedAt: new Date(row.publishedAt).getTime() }
        : {}),
    };
  }

  public async listManualEntries(
    projectId: string,
  ): Promise<ProjectManualEntry[]> {
    const rows = await this.db
      .select()
      .from(projectManualEntries)
      .where(eq(projectManualEntries.projectId, projectId))
      .orderBy(
        desc(projectManualEntries.priority),
        projectManualEntries.section,
        projectManualEntries.title,
      );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      section: row.section as HandbookSectionKey,
      title: row.title,
      markdown: row.markdown,
      visibility: row.visibility as ProjectVisibility,
      sensitivity: row.sensitivity as ProjectSensitivity,
      injectToBrief: row.injectToBrief,
      priority: row.priority,
      updatedBy: row.updatedBy,
      updatedAt: new Date(row.updatedAt).getTime(),
    }));
  }
}

export { toMs, escapeLike };
