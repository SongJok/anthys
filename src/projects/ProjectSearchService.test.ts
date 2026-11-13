import { describe, expect, it } from 'vitest';
import type { EmbeddingClient } from '../memory/EmbeddingClient.js';
import type {
  ProjectRecord,
  ProjectSnapshot,
} from '../types/skills-plugins-projects.js';
import { ProjectSearchService, RRF_K } from './ProjectSearchService.js';
import type { ProjectSearchCandidate, ProjectStore } from './ProjectStore.js';

function baseProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    name: 'Demo',
    aliases: [],
    description: '',
    source: { type: 'local', path: '/tmp/demo' },
    defaultBranch: 'main',
    ownerStaffIds: [],
    visibility: 'team',
    sensitivity: 'team',
    isDefault: true,
    enabled: true,
    autoSyncMinutes: 0,
    activeSnapshotId: 'snap-1',
    lastCommit: 'abc123',
    lastSyncedAt: Date.now(),
    handbookVersion: 0,
    lastError: '',
    ...overrides,
  };
}

function baseSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: 'snap-1',
    projectId: 'proj-1',
    commitSha: 'abc123',
    branch: 'main',
    status: 'ready',
    fileCount: 2,
    totalBytes: 200,
    symbolCount: 0,
    chunkCount: 2,
    stats: {},
    error: '',
    startedAt: 0,
    finishedAt: 0,
    ...overrides,
  };
}

function candidate(
  id: string,
  overrides: Partial<ProjectSearchCandidate> = {},
): ProjectSearchCandidate {
  return {
    id,
    path: `src/${id}.ts`,
    startLine: 1,
    endLine: 10,
    symbol: '',
    kind: 'code',
    language: 'typescript',
    content: `// ${id}`,
    ftsScore: 0,
    trigramScore: 0,
    vectorScore: 0,
    ...overrides,
  };
}

describe('ProjectSearchService Reciprocal Rank Fusion (RRF)', () => {
  it('ranks multi-channel FTS+vector consensus candidate above single-channel cosine outlier', async () => {
    const keywordCandidate = candidate('multi', {
      path: 'src/auth/verifyWebhook.ts',
      symbol: 'verifyWebhookSignature',
      content: 'export function verifyWebhookSignature(raw: Buffer) { return true; }',
      ftsScore: 0.45,
      trigramScore: 0.35,
      vectorScore: 0,
    });
    const vectorMulti = { ...keywordCandidate, vectorScore: 0.62 };
    const cosineOutlier = candidate('outlier', {
      path: 'src/docs/notes.ts',
      content: 'Unrelated document whose embedding happens to have high cosine score',
      vectorScore: 0.91,
    });

    const store = {
      searchChunks: async () => ({ candidates: [keywordCandidate] }),
      searchVectors: async () => ({ candidates: [cosineOutlier, vectorMulti] }),
      findSymbols: async () => [],
      getDocument: async () => null,
    } as unknown as ProjectStore;

    const embedder: EmbeddingClient = {
      dimensions: 2,
      embed: async () => [[1, 0]],
    };

    const service = new ProjectSearchService({ store, embedder });
    const result = await service.search({
      project: baseProject(),
      snapshot: baseSnapshot(),
      query: 'verifyWebhookSignature',
      member: { senderStaffId: 'u1', isAdmin: false, conversationType: '1' },
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.path).toBe('src/auth/verifyWebhook.ts');
    expect(result.hits[1]?.path).toBe('src/docs/notes.ts');
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
  });

  it('keeps symbol hits on compatible RRF scale so strong multi-channel chunks are not shadowed', async () => {
    const chunkHit = candidate('consensus', {
      path: 'src/handler.ts',
      startLine: 20,
      endLine: 40,
      symbol: 'handleOrder',
      content: 'export async function handleOrder() { return true; }',
      ftsScore: 0.9,
      trigramScore: 0.7,
      vectorScore: 0.85,
    });

    const store = {
      searchChunks: async () => ({ candidates: [chunkHit] }),
      searchVectors: async () => ({ candidates: [chunkHit] }),
      findSymbols: async () => [
        {
          id: 'sym-1',
          projectId: 'proj-1',
          snapshotId: 'snap-1',
          path: 'src/other.ts',
          name: 'handleOrderHelper',
          kind: 'function',
          startLine: 1,
          endLine: 5,
          signature: 'function handleOrderHelper()',
          parent: '',
          exported: true,
        },
      ],
      getDocument: async () => ({
        id: 'doc-1',
        projectId: 'proj-1',
        snapshotId: 'snap-1',
        path: 'src/other.ts',
        language: 'typescript',
        kind: 'code',
        contentHash: 'x',
        sizeBytes: 50,
        lineCount: 5,
        text: 'export function handleOrderHelper() {}',
      }),
    } as unknown as ProjectStore;

    const embedder: EmbeddingClient = {
      dimensions: 2,
      embed: async () => [[0.8, 0.2]],
    };

    const service = new ProjectSearchService({ store, embedder });
    const result = await service.search({
      project: baseProject(),
      snapshot: baseSnapshot(),
      query: 'handleOrder',
      member: { senderStaffId: 'u1', isAdmin: false, conversationType: '1' },
    });

    expect(result.hits[0]?.path).toBe('src/handler.ts');
    expect(result.hits[1]?.match).toBe('symbol');
    expect(result.hits[1]!.score).toBeCloseTo(1.1 / (RRF_K + 1), 6);
  });
});
