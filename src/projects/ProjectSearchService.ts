import type { EmbeddingClient } from '../memory/EmbeddingClient.js';
import type {
  ProjectMemberContextInput,
  ProjectRecord,
  ProjectSearchHit,
  ProjectSearchResult,
  ProjectSnapshot,
  ProjectSymbol,
} from '../types/skills-plugins-projects.js';
import type {
  ProjectSearchCandidate,
  ProjectStore,
} from './ProjectStore.js';
import { canReadProjectContent } from './ProjectRegistry.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_SNIPPET_CHARS = 800;
export const RRF_K = 60;

export interface ProjectSearchServiceLogger {
  warn(obj: Record<string, unknown>, message: string): void;
}

export interface ProjectSearchServiceOptions {
  store: ProjectStore;
  embedder?: EmbeddingClient;
  logger?: ProjectSearchServiceLogger;
}

export interface ProjectSearchInput {
  project: ProjectRecord;
  snapshot: ProjectSnapshot;
  query: string;
  kind?: 'all' | 'code' | 'doc' | 'symbol';
  pathGlob?: string;
  language?: string;
  limit?: number;
  member: ProjectMemberContextInput;
}

export function pathGlobToLike(glob: string): string {
  let output = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*') {
      if (glob[index + 1] === '*') {
        output += '%';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else {
        output += '%';
      }
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

function queryTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function snippetOf(content: string, query: string, maxChars = MAX_SNIPPET_CHARS): string {
  if (content.length <= maxChars) return content;
  const lower = content.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) return `${content.slice(0, maxChars)}…`;
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  return `${start > 0 ? '…' : ''}${content.slice(start, start + maxChars)}…`;
}

function rangesOverlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

interface MergedCandidate extends ProjectSearchCandidate {
  matchedBy: Set<'fts' | 'trigram' | 'vector' | 'path' | 'symbol'>;
  score: number;
}

interface WeightedToken {
  token: string;
  weight: number;
}

export class ProjectSearchService {
  private readonly store: ProjectStore;
  private readonly embedder?: EmbeddingClient;
  private readonly logger?: ProjectSearchServiceLogger;

  constructor(options: ProjectSearchServiceOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.logger = options.logger;
  }

  public async search(input: ProjectSearchInput): Promise<ProjectSearchResult> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const query = input.query.trim();
    if (!query) {
      return {
        projectId: input.project.id,
        commit: input.snapshot.commitSha,
        hits: [],
        total: 0,
        truncated: false,
        warning: '查询为空',
      };
    }
    if (!canReadProjectContent(input.project, input.member)) {
      return {
        projectId: input.project.id,
        commit: input.snapshot.commitSha,
        hits: [],
        total: 0,
        truncated: false,
        warning: '该项目内容为 private，不能在此会话中读取',
      };
    }
    const warnings: string[] = [];
    const pathLike = input.pathGlob
      ? pathGlobToLike(input.pathGlob)
      : undefined;
    const kind = input.kind ?? 'all';
    const kindFilter = this.kindsOf(kind);
    const symbolHits =
      kind === 'all' || kind === 'symbol'
        ? await this.symbolHits(input, query, pathLike, limit, warnings)
        : [];
    if (kind === 'symbol') {
      const deduped = this.dedupe(symbolHits.map((hit) => ({ hit, candidate: null })));
      return {
        projectId: input.project.id,
        commit: input.snapshot.commitSha,
        hits: deduped.slice(0, limit),
        total: deduped.length,
        truncated: deduped.length > limit,
        ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
      };
    }

    const keywordPromise = this.store.searchChunks({
      snapshotId: input.snapshot.id,
      query,
      ...(pathLike ? { pathLike } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(kindFilter ? { kinds: kindFilter } : {}),
      limit: limit * 8,
    });
    const vectorPromise = this.vectorSearch(input, query, pathLike, kindFilter, limit);
    const [keywordResult, vectorResult] = await Promise.all([
      keywordPromise,
      vectorPromise,
    ]);
    if (keywordResult.warning) warnings.push(keywordResult.warning);
    if (vectorResult.warning) warnings.push(vectorResult.warning);

    const merged = new Map<string, MergedCandidate>();
    for (const candidate of keywordResult.candidates) {
      merged.set(candidate.id, {
        ...candidate,
        matchedBy: new Set([
          ...(candidate.ftsScore > 0 ? (['fts'] as const) : []),
          ...(candidate.trigramScore > 0 ? (['trigram'] as const) : []),
        ]),
        score: 0,
      });
    }
    for (const candidate of vectorResult.candidates) {
      const existing = merged.get(candidate.id);
      if (existing) {
        existing.vectorScore = Math.max(existing.vectorScore, candidate.vectorScore);
        existing.matchedBy.add('vector');
      } else {
        merged.set(candidate.id, {
          ...candidate,
          matchedBy: new Set(['vector']),
          score: 0,
        });
      }
    }

    const tokens = queryTokens(query);
    const candidates = Array.from(merged.values());
    const weightedTokens = this.weightTokens(tokens, candidates);
    const lowerQuery = query.toLowerCase();

    const ftsRanked = candidates
      .filter((candidate) => candidate.ftsScore > 0)
      .sort(
        (a, b) => b.ftsScore - a.ftsScore || a.id.localeCompare(b.id),
      );
    this.applyRrfRank(ftsRanked, 1);

    const trigramRanked = candidates
      .filter((candidate) => candidate.trigramScore > 0)
      .sort(
        (a, b) => b.trigramScore - a.trigramScore || a.id.localeCompare(b.id),
      );
    this.applyRrfRank(trigramRanked, 0.9);

    const vectorRanked = candidates
      .filter((candidate) => candidate.vectorScore > 0)
      .sort(
        (a, b) => b.vectorScore - a.vectorScore || a.id.localeCompare(b.id),
      );
    this.applyRrfRank(vectorRanked, 1.2);

    const structuralRanked = candidates
      .map((candidate) => {
        const contentCoverage = this.tokenBoost(candidate.content, weightedTokens);
        const substring = candidate.content.toLowerCase().includes(lowerQuery);
        const pathBoost = this.tokenBoost(candidate.path, weightedTokens);
        const symbolBoost = this.tokenBoost(candidate.symbol, weightedTokens);
        if (pathBoost > 0) candidate.matchedBy.add('path');
        const strength =
          (substring ? 1.5 : 0) +
          contentCoverage * 0.6 +
          pathBoost * 0.9 +
          symbolBoost * 1.1;
        return { candidate, strength };
      })
      .filter((item) => item.strength > 0)
      .sort(
        (a, b) =>
          b.strength - a.strength || a.candidate.id.localeCompare(b.candidate.id),
      )
      .map((item) => item.candidate);
    this.applyRrfRank(structuralRanked, 0.8);

    const sorted = candidates.sort((left, right) => {
      return (
        right.score - left.score ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine
      );
    });
    const entries: Array<{
      hit: ProjectSearchHit;
      candidate: ProjectSearchCandidate | null;
    }> = sorted.map((candidate) => ({
      hit: this.toHit(candidate, query),
      candidate,
    }));
    for (const symbolHit of symbolHits) {
      entries.push({ hit: symbolHit, candidate: null });
    }
    const deduped = this.dedupe(entries);
    return {
      projectId: input.project.id,
      commit: input.snapshot.commitSha,
      hits: deduped.slice(0, limit),
      total: deduped.length,
      truncated: deduped.length > limit,
      ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
    };
  }

  private async vectorSearch(
    input: ProjectSearchInput,
    query: string,
    pathLike: string | undefined,
    kindFilter: string[] | undefined,
    limit: number,
  ): Promise<{ candidates: ProjectSearchCandidate[]; warning?: string }> {
    if (!this.embedder) return { candidates: [] };
    try {
      const [vector] = await this.embedder.embed([query]);
      if (!vector || vector.length === 0) return { candidates: [] };
      return this.store.searchVectors({
        snapshotId: input.snapshot.id,
        query,
        vector,
        ...(pathLike ? { pathLike } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(kindFilter ? { kinds: kindFilter } : {}),
        limit: limit * 3,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ error: message }, 'project vector search failed');
      return { candidates: [], warning: `向量检索失败：${message}` };
    }
  }

  private async symbolHits(
    input: ProjectSearchInput,
    query: string,
    pathLike: string | undefined,
    limit: number,
    warnings: string[],
  ): Promise<ProjectSearchHit[]> {
    let symbols: ProjectSymbol[];
    try {
      symbols = await this.store.findSymbols(
        input.snapshot.id,
        query,
        undefined,
        pathLike,
        limit * 2,
      );
    } catch (error) {
      warnings.push(
        `符号检索失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    if (symbols.length === 0) return [];
    const documents = new Map<string, { text: string; language: string }>();
    const hits: ProjectSearchHit[] = [];
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index]!;
      let document = documents.get(symbol.path);
      if (document === undefined) {
        const row = await this.store.getDocument(input.snapshot.id, symbol.path);
        document = { text: row?.text ?? '', language: row?.language ?? '' };
        documents.set(symbol.path, document);
      }
      if (input.language && document.language !== input.language) continue;
      const content = document.text
        .split('\n')
        .slice(symbol.startLine - 1, symbol.endLine)
        .join('\n');
      hits.push({
        path: symbol.path,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        symbol: symbol.name,
        language: document.language,
        // Align symbol hit scores onto the same RRF scale so multi-channel chunk hits outrank single-signal symbol matches
        score: 1.1 / (RRF_K + index + 1),
        content: snippetOf(content, query),
        match: 'symbol',
      });
    }
    return hits;
  }

  private applyRrfRank(candidates: MergedCandidate[], weight: number): void {
    for (let index = 0; index < candidates.length; index += 1) {
      candidates[index]!.score += weight / (RRF_K + index + 1);
    }
  }

  private kindsOf(kind: 'all' | 'code' | 'doc' | 'symbol'): string[] | undefined {
    if (kind === 'code') return ['code', 'test', 'config'];
    if (kind === 'doc') return ['doc'];
    return undefined;
  }

  private weightTokens(
    tokens: string[],
    candidates: MergedCandidate[],
  ): WeightedToken[] {
    const total = Math.max(1, candidates.length);
    return tokens.map((token) => {
      const documentFrequency = candidates.reduce((count, candidate) => {
        const haystack =
          `${candidate.path}\n${candidate.symbol}\n${candidate.content}`.toLowerCase();
        return count + (haystack.includes(token) ? 1 : 0);
      }, 0);
      return {
        token,
        weight: Math.log((total + 1) / (documentFrequency + 1)) + 0.5,
      };
    });
  }

  private tokenBoost(value: string, tokens: WeightedToken[]): number {
    if (!value) return 0;
    const lower = value.toLowerCase();
    const total = tokens.reduce((sum, item) => sum + item.weight, 0);
    if (total <= 0) return 0;
    const hits = tokens.reduce(
      (sum, item) => sum + (lower.includes(item.token) ? item.weight : 0),
      0,
    );
    return Math.min(1, hits / total);
  }

  private toHit(candidate: MergedCandidate, query: string): ProjectSearchHit {
    const match = candidate.vectorScore > 0
      ? 'vector'
      : candidate.ftsScore > 0
        ? 'fts'
        : candidate.trigramScore > 0
          ? 'trigram'
          : candidate.matchedBy.has('path')
            ? 'path'
            : 'fts';
    return {
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      symbol: candidate.symbol,
      language: candidate.language,
      score:
        candidate.score,
      content: snippetOf(candidate.content, query),
      match,
    };
  }

  private dedupe(
    entries: Array<{
      hit: ProjectSearchHit;
      candidate: ProjectSearchCandidate | null;
    }>,
  ): ProjectSearchHit[] {
    const sorted = entries
      .slice()
      .sort(
        (left, right) =>
          right.hit.score - left.hit.score ||
          left.hit.path.localeCompare(right.hit.path) ||
          left.hit.startLine - right.hit.startLine,
      );
    const kept: ProjectSearchHit[] = [];
    for (const entry of sorted) {
      const duplicate = kept.some(
        (hit) => hit.path === entry.hit.path && rangesOverlap(hit, entry.hit),
      );
      if (!duplicate) kept.push(entry.hit);
    }
    return kept;
  }
}
