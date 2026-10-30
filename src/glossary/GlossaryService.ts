import type { EmbeddingClient } from '../memory/EmbeddingClient.js';
import {
  GLOSSARY_SENSITIVITY_LABELS,
  GLOSSARY_TIMELINESS_LABELS,
  GlossaryConflictError,
  GlossaryNotFoundError,
  GlossaryValidationError,
  glossaryNameKey,
  isGlossarySensitivity,
  isGlossaryTimeliness,
  normalizeGlossaryList,
  type GlossaryAdminPort,
  type GlossaryContextInput,
  type GlossaryContextProvider,
  type GlossaryContextResult,
  type GlossaryListFilter,
  type GlossaryListResult,
  type GlossaryLookupInput,
  type GlossaryLookupProvider,
  type GlossaryLookupResult,
  type GlossaryPromptPreview,
  type GlossaryStats,
  type GlossaryStore,
  type GlossaryTerm,
  type GlossaryTermInput,
  type GlossaryTermPatch,
  type GlossaryTermWrite,
  type GlossaryValidationIssue,
  type GlossaryValidationReport,
} from '../types/glossary.js';

export interface GlossaryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GlossaryServiceOptions {
  store: GlossaryStore;
  embedding?: EmbeddingClient;
  logger?: GlossaryLogger;
  now?: () => number;
  /** 是否把高频术语注入系统提示，默认开启 */
  promptEnabled?: boolean;
  /** 系统提示注入条数上限，默认 80，最大 100 */
  promptLimit?: number;
  /** 按问检索条数，默认 4，最大 10 */
  retrievalLimit?: number;
  /** 术语缓存时间，默认 30 秒 */
  cacheTtlMs?: number;
  /** 项目期术语多久未更新提示需要复核，默认 180 天 */
  staleProjectDays?: number;
  /** 向量召回的最大余弦距离，默认 0.45 */
  vectorMaxDistance?: number;
}

const DEFAULT_PROMPT_LIMIT = 80;
const MAX_PROMPT_LIMIT = 100;
const DEFAULT_RETRIEVAL_LIMIT = 4;
const MAX_RETRIEVAL_LIMIT = 10;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_STALE_PROJECT_DAYS = 180;
const DEFAULT_VECTOR_MAX_DISTANCE = 0.45;
const DAY_MS = 24 * 60 * 60 * 1_000;

const PROMPT_RULES = [
  '回答涉及下列术语时，必须按卡片含义理解，不要按字面意思臆造；存在“不要误解为”时严格执行。',
  '标注“已废弃”的术语不要使用，用户使用时应指出规范说法。',
  '敏感级别术语不会出现在系统提示中，仅在单聊按需检索；群聊不要主动展开敏感信息。',
  '遇到未收录术语，可调用 glossary_lookup 工具查询；仍查不到就向提问者确认，不要猜测。',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function singleLine(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}…`
    : normalized;
}

function includesText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

function isValidDocLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/**
 * 术语知识库服务：
 * ① 把高频术语注入系统提示词；② 按用户问题检索术语卡；③ 为 glossary_lookup 提供查询。
 * 所有自动注入都排除敏感与已废弃术语，群聊检索同样排除敏感术语。
 */
export class GlossaryService
  implements GlossaryAdminPort, GlossaryContextProvider, GlossaryLookupProvider
{
  private readonly store: GlossaryStore;
  private readonly embedding?: EmbeddingClient;
  private readonly logger?: GlossaryLogger;
  private readonly now: () => number;
  private readonly promptEnabled: boolean;
  private readonly promptLimit: number;
  private readonly retrievalLimit: number;
  private readonly cacheTtlMs: number;
  private readonly staleProjectDays: number;
  private readonly vectorMaxDistance: number;

  private cache: { terms: GlossaryTerm[]; at: number } | null = null;
  private loading: Promise<GlossaryTerm[]> | null = null;

  constructor(options: GlossaryServiceOptions) {
    this.store = options.store;
    this.embedding = options.embedding;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.promptEnabled = options.promptEnabled ?? true;
    this.promptLimit = clamp(
      Math.trunc(options.promptLimit ?? DEFAULT_PROMPT_LIMIT),
      1,
      MAX_PROMPT_LIMIT,
    );
    this.retrievalLimit = clamp(
      Math.trunc(options.retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT),
      1,
      MAX_RETRIEVAL_LIMIT,
    );
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.staleProjectDays = Math.max(
      1,
      options.staleProjectDays ?? DEFAULT_STALE_PROJECT_DAYS,
    );
    this.vectorMaxDistance = clamp(
      options.vectorMaxDistance ?? DEFAULT_VECTOR_MAX_DISTANCE,
      0,
      2,
    );
  }

  public async hasTerms(): Promise<boolean> {
    try {
      return (await this.loadTerms()).length > 0;
    } catch (error) {
      this.warn(error, 'failed to check glossary terms');
      return false;
    }
  }

  public async list(filter: GlossaryListFilter = {}): Promise<GlossaryListResult> {
    const terms = await this.loadTerms();
    const query = filter.query?.trim().toLowerCase() ?? '';
    const department = filter.department?.trim().toLowerCase() ?? '';
    const filtered = terms.filter((term) => {
      if (filter.timeliness && term.timeliness !== filter.timeliness) {
        return false;
      }
      if (filter.sensitivity && term.sensitivity !== filter.sensitivity) {
        return false;
      }
      if (filter.onlyInjected && !term.injectToPrompt) return false;
      if (
        department &&
        !includesText(term.department, department) &&
        !includesText(term.standardName, department)
      ) {
        return false;
      }
      if (!query) return true;
      return this.matchesQuery(term, query);
    });

    const sort = filter.sort ?? 'updated';
    filtered.sort((left, right) => {
      if (sort === 'priority') {
        return (
          right.promptPriority - left.promptPriority ||
          right.hitCount - left.hitCount ||
          right.lastUpdatedAt - left.lastUpdatedAt
        );
      }
      if (sort === 'hits') {
        return (
          right.hitCount - left.hitCount ||
          right.lastUpdatedAt - left.lastUpdatedAt
        );
      }
      return right.lastUpdatedAt - left.lastUpdatedAt;
    });

    const limit = clamp(Math.trunc(filter.limit ?? 200), 1, 1_000);
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    return {
      total: filtered.length,
      terms: filtered.slice(offset, offset + limit),
    };
  }

  public async get(id: string): Promise<GlossaryTerm | null> {
    const terms = await this.loadTerms();
    return terms.find((term) => term.id === id) ?? null;
  }

  public async create(
    input: GlossaryTermInput,
    updatedBy: string,
  ): Promise<GlossaryTerm> {
    const write = this.normalizeWrite(input, undefined, updatedBy);
    await this.checkNameConflict(write);
    const embedding = await this.embedWrite(write);
    const term = await this.store.insert({
      ...write,
      ...(embedding !== undefined ? { embedding } : {}),
    });
    this.invalidate();
    return term;
  }

  public async update(
    id: string,
    patch: GlossaryTermPatch,
    updatedBy: string,
  ): Promise<GlossaryTerm> {
    const existing = await this.store.getById(id);
    if (!existing) {
      throw new GlossaryNotFoundError(`未找到术语：${id}`);
    }
    const write = this.normalizeWrite(patch, existing, updatedBy);
    await this.checkNameConflict(write, id);
    const embedding = await this.embedWrite(write);
    const updated = await this.store.update(id, {
      ...write,
      ...(embedding !== undefined ? { embedding } : {}),
    });
    if (!updated) {
      throw new GlossaryNotFoundError(`未找到术语：${id}`);
    }
    this.invalidate();
    return updated;
  }

  public async remove(id: string): Promise<boolean> {
    const removed = await this.store.remove(id);
    if (removed) this.invalidate();
    return removed;
  }

  public async stats(): Promise<GlossaryStats> {
    const terms = await this.loadTerms();
    const byTimeliness: GlossaryStats['byTimeliness'] = {
      long_term: 0,
      project: 0,
      retired: 0,
    };
    const bySensitivity: GlossaryStats['bySensitivity'] = {
      public: 0,
      team: 0,
      sensitive: 0,
    };
    for (const term of terms) {
      byTimeliness[term.timeliness] += 1;
      bySensitivity[term.sensitivity] += 1;
    }
    return {
      total: terms.length,
      injected: this.selectInjectable(terms, this.promptLimit).length,
      retired: byTimeliness.retired,
      sensitive: bySensitivity.sensitive,
      missingDefinition: terms.filter((term) => !term.definition.trim()).length,
      byTimeliness,
      bySensitivity,
    };
  }

  public async previewPrompt(limit?: number): Promise<GlossaryPromptPreview> {
    const terms = await this.loadTerms();
    const injected = this.selectInjectable(
      terms,
      clamp(Math.trunc(limit ?? this.promptLimit), 1, MAX_PROMPT_LIMIT),
    );
    return {
      terms: injected,
      prompt: this.renderPromptSection(injected, [], true),
    };
  }

  public async buildContext(
    input: GlossaryContextInput,
  ): Promise<GlossaryContextResult> {
    let terms: GlossaryTerm[];
    try {
      terms = await this.loadTerms();
    } catch (error) {
      this.warn(error, 'failed to load glossary for prompt, skipping');
      return { prompt: '', injected: [], retrieved: [] };
    }

    const injected = this.promptEnabled
      ? this.selectInjectable(
          terms,
          clamp(
            Math.trunc(input.promptLimit ?? this.promptLimit),
            1,
            MAX_PROMPT_LIMIT,
          ),
        )
      : [];
    const query = input.query?.trim() ?? '';
    const retrieved = query
      ? await this.retrieveFrom(
          terms,
          query,
          input.conversationType,
          clamp(
            Math.trunc(input.retrievalLimit ?? this.retrievalLimit),
            1,
            MAX_RETRIEVAL_LIMIT,
          ),
        )
      : [];

    const injectedIds = new Set(injected.map((term) => term.id));
    const uniqueRetrieved = retrieved.filter(
      (term) => !injectedIds.has(term.id),
    );
    const prompt =
      injected.length + uniqueRetrieved.length > 0
        ? this.renderPromptSection(injected, uniqueRetrieved, true)
        : '';
    return { prompt, injected, retrieved: uniqueRetrieved };
  }

  public async lookup(
    term: string,
    input: GlossaryLookupInput,
  ): Promise<GlossaryLookupResult> {
    const terms = (await this.loadTerms()).filter((item) =>
      this.isVisibleInConversation(item, input.conversationType),
    );
    const normalized = term.trim().toLowerCase();
    if (!normalized) return { exact: [], related: [] };

    const exact = terms.filter((item) =>
      [item.standardName, ...item.aliases].some(
        (name) => name.trim().toLowerCase() === normalized,
      ),
    );
    const exactIds = new Set(exact.map((item) => item.id));
    const related = await this.retrieveFrom(
      terms.filter((item) => !exactIds.has(item.id)),
      term,
      input.conversationType,
      clamp(Math.trunc(input.limit ?? this.retrievalLimit), 1, MAX_RETRIEVAL_LIMIT),
    );

    this.recordHits(exact);
    return { exact, related };
  }

  /** 为新启用向量的历史术语补齐 embedding，失败不阻塞启动 */
  public async backfillEmbeddings(
    batchSize = 16,
  ): Promise<{ embedded: number; failed: number }> {
    if (!this.embedding) return { embedded: 0, failed: 0 };
    let embedded = 0;
    let failed = 0;
    for (let round = 0; round < 20; round += 1) {
      const missing = await this.store.listMissingEmbeddings(batchSize);
      if (missing.length === 0) break;
      try {
        const vectors = await this.embedding.embed(
          missing.map((term) => this.buildEmbeddingText(term)),
        );
        for (const [index, term] of missing.entries()) {
          const vector = vectors[index];
          if (vector && vector.length === this.embedding.dimensions) {
            await this.store.setEmbedding(term.id, vector);
            embedded += 1;
          } else {
            failed += 1;
          }
        }
      } catch (error) {
        failed += missing.length;
        this.warn(error, 'glossary embedding backfill failed');
        break;
      }
    }
    if (embedded > 0) {
      this.logger?.info({ embedded, failed }, 'glossary embeddings backfilled');
    }
    return { embedded, failed };
  }

  /** 固定模板卡片：管理页预览、RAG 命中与工具返回共用同一段文字 */
  public formatCard(term: GlossaryTerm): string {
    return [
      `【标准名称】${term.standardName}`,
      `【常见别名/缩写】${term.aliases.join('、') || '无'}`,
      `【定义】${term.definition || '无'}`,
      `【使用场景】${term.usageScenarios || '无'}`,
      `【示例句子】${
        term.examples.length > 0
          ? term.examples.map((item, index) => `${index + 1}. ${item}`).join('；')
          : '无'
      }`,
      `【不要误解为】${term.misconceptions || '无'}`,
      `【所属部门/项目】${term.department || '未标注'}`,
      `【时效性】${GLOSSARY_TIMELINESS_LABELS[term.timeliness]}`,
      `【敏感级别】${GLOSSARY_SENSITIVITY_LABELS[term.sensitivity]}`,
      `【关联文档链接】${term.docLinks.join(' ') || '无'}`,
      `【最后更新时间】${formatTime(term.lastUpdatedAt)}`,
    ].join('\n');
  }

  public async validate(): Promise<GlossaryValidationReport> {
    const terms = await this.loadTerms(true);
    const issues: GlossaryValidationIssue[] = [];
    const nameOwners = new Map<string, Set<string>>();
    const termById = new Map(terms.map((term) => [term.id, term]));

    const push = (
      term: GlossaryTerm,
      severity: GlossaryValidationIssue['severity'],
      field: string,
      message: string,
    ): void => {
      issues.push({
        termId: term.id,
        standardName: term.standardName || '（未命名）',
        severity,
        field,
        message,
      });
    };

    for (const term of terms) {
      if (!term.standardName.trim()) {
        push(term, 'error', 'standardName', '标准名称不能为空');
      }
      if (!term.definition.trim()) {
        push(term, 'error', 'definition', '缺少定义，机器人无法可靠解释该术语');
      }
      if (!isGlossaryTimeliness(term.timeliness)) {
        push(term, 'error', 'timeliness', `非法时效性：${term.timeliness}`);
      }
      if (!isGlossarySensitivity(term.sensitivity)) {
        push(term, 'error', 'sensitivity', `非法敏感级别：${term.sensitivity}`);
      }

      const keys = [
        glossaryNameKey(term.standardName),
        ...term.aliases.map((alias) => glossaryNameKey(alias)),
      ].filter(Boolean);
      for (const key of new Set(keys)) {
        const owners = nameOwners.get(key) ?? new Set<string>();
        owners.add(term.id);
        nameOwners.set(key, owners);
      }

      const ownName = glossaryNameKey(term.standardName);
      if (
        term.aliases.some((alias) => glossaryNameKey(alias) === ownName)
      ) {
        push(term, 'info', 'aliases', '别名与标准名称重复，可以删除该别名');
      }
      if (term.docLinks.some((link) => !isValidDocLink(link))) {
        push(
          term,
          'warning',
          'docLinks',
          '存在不是 http(s) 链接的关联文档地址',
        );
      }
      if (term.timeliness === 'project' && !term.department.trim()) {
        push(
          term,
          'warning',
          'department',
          '项目期术语建议填写所属部门/项目，便于结束后清理',
        );
      }
      if (
        term.timeliness === 'project' &&
        this.now() - term.lastUpdatedAt > this.staleProjectDays * DAY_MS
      ) {
        push(
          term,
          'warning',
          'lastUpdatedAt',
          `项目期术语超过 ${this.staleProjectDays} 天未更新，请复核是否仍然有效`,
        );
      }
      if (term.timeliness === 'retired' && term.injectToPrompt) {
        push(
          term,
          'warning',
          'injectToPrompt',
          '已废弃术语仍开启系统提示注入，实际会被忽略',
        );
      }
      if (term.sensitivity === 'sensitive' && term.injectToPrompt) {
        push(
          term,
          'info',
          'injectToPrompt',
          '敏感术语不会进入系统提示，只在单聊按需检索',
        );
      }
      if (!term.usageScenarios.trim()) {
        push(term, 'info', 'usageScenarios', '缺少使用场景，检索命中率会下降');
      }
      if (term.examples.length === 0) {
        push(term, 'info', 'examples', '缺少示例句子，模型理解成本更高');
      }
      if (term.lastUpdatedAt > this.now() + 5 * 60_000) {
        push(term, 'warning', 'lastUpdatedAt', '最后更新时间晚于当前时间');
      }
    }

    for (const [key, ownerIds] of nameOwners) {
      if (ownerIds.size <= 1) continue;
      for (const id of ownerIds) {
        const term = termById.get(id);
        if (!term) continue;
        push(
          term,
          'warning',
          'aliases',
          `名称或别名「${key}」同时被 ${ownerIds.size} 条术语使用，检索时可能歧义`,
        );
      }
    }

    const weight: Record<GlossaryValidationIssue['severity'], number> = {
      error: 0,
      warning: 1,
      info: 2,
    };
    issues.sort(
      (left, right) =>
        weight[left.severity] - weight[right.severity] ||
        left.standardName.localeCompare(right.standardName, 'zh-CN'),
    );
    return {
      checked: terms.length,
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
      infos: issues.filter((issue) => issue.severity === 'info').length,
      issues,
    };
  }

  private async loadTerms(force = false): Promise<GlossaryTerm[]> {
    const now = this.now();
    if (!force && this.cache && now - this.cache.at < this.cacheTtlMs) {
      return this.cache.terms;
    }
    if (this.loading) return this.loading;
    const loading = (async () => {
      try {
        const terms = await this.store.listAll();
        this.cache = { terms, at: this.now() };
        return terms;
      } finally {
        this.loading = null;
      }
    })();
    this.loading = loading;
    return loading;
  }

  private invalidate(): void {
    this.cache = null;
  }

  private isInjectable(term: GlossaryTerm): boolean {
    return (
      term.injectToPrompt &&
      term.timeliness !== 'retired' &&
      term.sensitivity !== 'sensitive'
    );
  }

  private isVisibleInConversation(
    term: GlossaryTerm,
    conversationType: '1' | '2',
  ): boolean {
    return conversationType === '1' || term.sensitivity !== 'sensitive';
  }

  private selectInjectable(
    terms: GlossaryTerm[],
    limit: number,
  ): GlossaryTerm[] {
    return terms
      .filter((term) => this.isInjectable(term))
      .sort(
        (left, right) =>
          right.promptPriority - left.promptPriority ||
          right.hitCount - left.hitCount ||
          right.lastUpdatedAt - left.lastUpdatedAt ||
          left.standardName.localeCompare(right.standardName, 'zh-CN'),
      )
      .slice(0, limit);
  }

  private matchesQuery(term: GlossaryTerm, query: string): boolean {
    return [
      term.standardName,
      ...term.aliases,
      term.definition,
      term.usageScenarios,
      term.misconceptions,
      term.department,
    ].some((field) => includesText(field, query));
  }

  private async retrieveFrom(
    terms: GlossaryTerm[],
    query: string,
    conversationType: '1' | '2',
    limit: number,
  ): Promise<GlossaryTerm[]> {
    const visible = terms.filter((term) =>
      this.isVisibleInConversation(term, conversationType),
    );
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const tokens = [
      ...new Set(
        normalizedQuery
          .split(/[^\p{L}\p{N}]+/u)
          .map((token) => token.trim())
          .filter((token) => token.length >= 2),
      ),
    ];

    const scored = visible
      .map((term) => ({ term, score: this.scoreTerm(term, normalizedQuery, tokens) }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.term.hitCount - left.term.hitCount ||
          right.term.lastUpdatedAt - left.term.lastUpdatedAt ||
          left.term.standardName.localeCompare(
            right.term.standardName,
            'zh-CN',
          ),
      )
      .slice(0, limit)
      .map((item) => item.term);

    if (scored.length === 0) {
      const vectorHits = await this.vectorRetrieve(
        query,
        conversationType,
        limit,
      );
      this.recordHits(vectorHits);
      return vectorHits;
    }

    this.recordHits(scored);
    return scored;
  }

  private scoreTerm(
    term: GlossaryTerm,
    query: string,
    tokens: string[],
  ): number {
    const names = [term.standardName, ...term.aliases]
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length >= 2);
    let score = 0;
    for (const name of names) {
      if (query.includes(name)) {
        score = Math.max(score, 100 + name.length);
      } else if (name.includes(query)) {
        score = Math.max(score, 60);
      }
    }
    if (score > 0) return score;

    for (const token of tokens) {
      for (const name of names) {
        if (name === token) {
          score = Math.max(score, 70);
        } else if (name.includes(token)) {
          score = Math.max(score, 50);
        }
      }
      if (includesText(term.definition, token)) {
        score = Math.max(score, 25);
      }
      if (includesText(term.usageScenarios, token)) {
        score = Math.max(score, 15);
      }
      if (includesText(term.misconceptions, token)) {
        score = Math.max(score, 15);
      }
      if (includesText(term.department, token)) {
        score = Math.max(score, 10);
      }
    }
    return score;
  }

  private async vectorRetrieve(
    query: string,
    conversationType: '1' | '2',
    limit: number,
  ): Promise<GlossaryTerm[]> {
    if (!this.embedding) return [];
    try {
      const [vector] = await this.embedding.embed([query]);
      if (!vector || vector.length !== this.embedding.dimensions) return [];
      const matches = await this.store.searchSimilar(vector, {
        limit,
        excludeSensitive: conversationType === '2',
        includeRetired: false,
        maxDistance: this.vectorMaxDistance,
      });
      return matches.map((match) => match.term);
    } catch (error) {
      this.warn(error, 'glossary vector recall failed, falling back to none');
      return [];
    }
  }

  private recordHits(terms: GlossaryTerm[]): void {
    const ids = [...new Set(terms.map((term) => term.id))];
    if (ids.length === 0) return;
    void this.store.incrementHits(ids).catch((error) => {
      this.warn(error, 'failed to record glossary hits');
    });
  }

  private renderPromptSection(
    injected: GlossaryTerm[],
    retrieved: GlossaryTerm[],
    includeRules: boolean,
  ): string {
    if (injected.length === 0 && retrieved.length === 0) return '';
    const lines = ['## 企业术语知识库（内部黑话速查）'];
    if (includeRules) {
      lines.push('使用规则：', ...PROMPT_RULES.map((rule) => `- ${rule}`));
    }
    if (injected.length > 0) {
      lines.push(
        '【常驻术语（系统提示注入）】',
        ...injected.map((term) => this.formatCompact(term)),
      );
    }
    if (retrieved.length > 0) {
      lines.push(
        '【本次提问命中术语】',
        ...retrieved.map((term) => this.formatCard(term)),
      );
    }
    return lines.join('\n');
  }

  private formatCompact(term: GlossaryTerm): string {
    const parts: string[] = [`- ${term.standardName}`];
    if (term.aliases.length > 0) {
      parts.push(`（别名：${term.aliases.join('、')}）`);
    }
    parts.push(`：${singleLine(term.definition) || '（待补充定义）'}`);
    if (term.usageScenarios.trim()) {
      parts.push(`；场景：${singleLine(term.usageScenarios, 100)}`);
    }
    if (term.misconceptions.trim()) {
      parts.push(`；勿误解为：${singleLine(term.misconceptions, 100)}`);
    }
    parts.push(
      `；部门/项目：${term.department || '未标注'}；时效：${
        GLOSSARY_TIMELINESS_LABELS[term.timeliness]
      }`,
    );
    return parts.join('');
  }

  private normalizeWrite(
    input: GlossaryTermPatch,
    existing: GlossaryTerm | undefined,
    updatedBy: string,
  ): GlossaryTermWrite {
    const standardName = (
      input.standardName ??
      existing?.standardName ??
      ''
    ).trim();
    if (!standardName) {
      throw new GlossaryValidationError('标准名称不能为空');
    }
    const definition = (input.definition ?? existing?.definition ?? '').trim();
    if (!definition) {
      throw new GlossaryValidationError('定义不能为空');
    }
    const timeliness =
      input.timeliness ?? existing?.timeliness ?? 'long_term';
    if (!isGlossaryTimeliness(timeliness)) {
      throw new GlossaryValidationError(`非法时效性：${String(timeliness)}`);
    }
    const sensitivity = input.sensitivity ?? existing?.sensitivity ?? 'team';
    if (!isGlossarySensitivity(sensitivity)) {
      throw new GlossaryValidationError(`非法敏感级别：${String(sensitivity)}`);
    }
    const promptPriority = Math.trunc(
      input.promptPriority ?? existing?.promptPriority ?? 0,
    );
    if (
      !Number.isFinite(promptPriority) ||
      promptPriority < 0 ||
      promptPriority > 100
    ) {
      throw new GlossaryValidationError('注入权重必须是 0 到 100 的整数');
    }
    const docLinks = normalizeGlossaryList(input.docLinks ?? existing?.docLinks);
    for (const link of docLinks) {
      if (!isValidDocLink(link)) {
        throw new GlossaryValidationError(`关联文档链接不是合法网址：${link}`);
      }
    }

    return {
      standardName,
      aliases: normalizeGlossaryList(input.aliases ?? existing?.aliases),
      definition,
      usageScenarios: (
        input.usageScenarios ??
        existing?.usageScenarios ??
        ''
      ).trim(),
      examples: normalizeGlossaryList(input.examples ?? existing?.examples),
      misconceptions: (
        input.misconceptions ??
        existing?.misconceptions ??
        ''
      ).trim(),
      department: (input.department ?? existing?.department ?? '').trim(),
      timeliness,
      sensitivity,
      docLinks,
      injectToPrompt:
        input.injectToPrompt ?? existing?.injectToPrompt ?? true,
      promptPriority,
      updatedBy,
    };
  }

  private async checkNameConflict(
    write: GlossaryTermWrite,
    excludeId?: string,
  ): Promise<void> {
    const terms = await this.loadTerms();
    const nameKey = glossaryNameKey(write.standardName);
    for (const term of terms) {
      if (term.id === excludeId) continue;
      if (glossaryNameKey(term.standardName) === nameKey) {
        throw new GlossaryConflictError(
          `标准名称「${write.standardName}」已存在`,
        );
      }
      const aliasConflict = term.aliases.find(
        (alias) => glossaryNameKey(alias) === nameKey,
      );
      if (aliasConflict) {
        throw new GlossaryConflictError(
          `标准名称「${write.standardName}」与术语「${term.standardName}」的别名冲突`,
        );
      }
      const standardKey = glossaryNameKey(term.standardName);
      const ownAlias = write.aliases.find(
        (alias) => glossaryNameKey(alias) === standardKey,
      );
      if (ownAlias) {
        throw new GlossaryConflictError(
          `别名「${ownAlias}」与已有术语「${term.standardName}」的标准名称冲突`,
        );
      }
    }
  }

  private async embedWrite(
    write: GlossaryTermWrite,
  ): Promise<number[] | null | undefined> {
    if (!this.embedding) return undefined;
    try {
      const [vector] = await this.embedding.embed([
        this.buildEmbeddingText(write),
      ]);
      if (!vector || vector.length !== this.embedding.dimensions) return null;
      return vector;
    } catch (error) {
      this.warn(error, 'glossary embedding failed, term saved without vector');
      return null;
    }
  }

  private buildEmbeddingText(
    term: Pick<
      GlossaryTermWrite,
      'standardName' | 'aliases' | 'definition' | 'usageScenarios'
    >,
  ): string {
    return [
      term.standardName,
      term.aliases.length > 0 ? `别名：${term.aliases.join('、')}` : '',
      `定义：${term.definition}`,
      term.usageScenarios ? `场景：${term.usageScenarios}` : '',
    ]
      .filter(Boolean)
      .join('；');
  }

  private warn(error: unknown, message: string): void {
    this.logger?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      message,
    );
  }
}
