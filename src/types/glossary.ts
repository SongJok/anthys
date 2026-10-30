/**
 * 术语知识库（企业黑话）的公共契约。
 * 每条术语固定使用同一套模板字段，便于检索、校验与持续更新。
 */

export type GlossaryTimeliness = 'long_term' | 'project' | 'retired';
export type GlossarySensitivity = 'public' | 'team' | 'sensitive';

export const GLOSSARY_TIMELINESS_LABELS: Record<GlossaryTimeliness, string> = {
  long_term: '长期',
  project: '项目期',
  retired: '已废弃',
};

export const GLOSSARY_SENSITIVITY_LABELS: Record<GlossarySensitivity, string> = {
  public: '公开',
  team: '团队内',
  sensitive: '敏感',
};

export function isGlossaryTimeliness(
  value: unknown,
): value is GlossaryTimeliness {
  return value === 'long_term' || value === 'project' || value === 'retired';
}

export function isGlossarySensitivity(
  value: unknown,
): value is GlossarySensitivity {
  return value === 'public' || value === 'team' || value === 'sensitive';
}

/** 管理后台与机器人共用的术语卡片 */
export interface GlossaryTerm {
  id: string;
  /** 标准名称 */
  standardName: string;
  /** 常见别名 / 缩写 */
  aliases: string[];
  /** 定义 */
  definition: string;
  /** 使用场景 */
  usageScenarios: string;
  /** 示例句子 */
  examples: string[];
  /** 不要误解为 */
  misconceptions: string;
  /** 所属部门 / 项目 */
  department: string;
  timeliness: GlossaryTimeliness;
  sensitivity: GlossarySensitivity;
  /** 关联文档链接 */
  docLinks: string[];
  /** 是否加入系统提示词的高频术语池 */
  injectToPrompt: boolean;
  /** 注入排序权重，越大越靠前 */
  promptPriority: number;
  /** 被检索 / 查询工具命中的次数，用于发现真正的高频黑话 */
  hitCount: number;
  /** 最后更新时间（epoch ms） */
  lastUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

/** 新建术语的输入 */
export interface GlossaryTermInput {
  standardName: string;
  aliases?: string[];
  definition: string;
  usageScenarios?: string;
  examples?: string[];
  misconceptions?: string;
  department?: string;
  timeliness?: GlossaryTimeliness;
  sensitivity?: GlossarySensitivity;
  docLinks?: string[];
  injectToPrompt?: boolean;
  promptPriority?: number;
}

/** 更新术语的输入，只传需要改的字段 */
export type GlossaryTermPatch = Partial<GlossaryTermInput>;

/** 落库时的完整字段 */
export interface GlossaryTermWrite {
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
  updatedBy: string;
  embedding?: number[] | null;
}

export interface GlossarySimilarMatch {
  term: GlossaryTerm;
  /** pgvector 余弦距离，越小越相似 */
  distance: number;
}

/** 术语持久化端口 */
export interface GlossaryStore {
  listAll(): Promise<GlossaryTerm[]>;
  getById(id: string): Promise<GlossaryTerm | null>;
  insert(input: GlossaryTermWrite): Promise<GlossaryTerm>;
  update(id: string, input: GlossaryTermWrite): Promise<GlossaryTerm | null>;
  remove(id: string): Promise<boolean>;
  incrementHits(ids: string[]): Promise<void>;
  searchSimilar(
    embedding: number[],
    options: {
      limit: number;
      excludeSensitive: boolean;
      includeRetired: boolean;
      maxDistance: number;
    },
  ): Promise<GlossarySimilarMatch[]>;
  listMissingEmbeddings(limit: number): Promise<GlossaryTerm[]>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
}

export interface GlossaryListFilter {
  query?: string;
  timeliness?: GlossaryTimeliness;
  sensitivity?: GlossarySensitivity;
  department?: string;
  onlyInjected?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'updated' | 'hits' | 'priority';
}

export interface GlossaryListResult {
  terms: GlossaryTerm[];
  total: number;
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

export interface GlossaryContextInput {
  conversationType: '1' | '2';
  query?: string;
  promptLimit?: number;
  retrievalLimit?: number;
}

export interface GlossaryContextResult {
  prompt: string;
  injected: GlossaryTerm[];
  retrieved: GlossaryTerm[];
}

export interface GlossaryLookupInput {
  conversationType: '1' | '2';
  limit?: number;
}

export interface GlossaryLookupResult {
  exact: GlossaryTerm[];
  related: GlossaryTerm[];
}

export interface GlossaryPromptPreview {
  prompt: string;
  terms: GlossaryTerm[];
}

/** 机器人上下文接入的最小端口 */
export interface GlossaryContextProvider {
  buildContext(input: GlossaryContextInput): Promise<GlossaryContextResult>;
}

/** 术语查询工具的最小端口 */
export interface GlossaryLookupProvider {
  hasTerms(): Promise<boolean>;
  lookup(
    term: string,
    input: GlossaryLookupInput,
  ): Promise<GlossaryLookupResult>;
}

/** 管理后台接入的最小端口 */
export interface GlossaryAdminPort {
  list(filter: GlossaryListFilter): Promise<GlossaryListResult>;
  get(id: string): Promise<GlossaryTerm | null>;
  create(input: GlossaryTermInput, updatedBy: string): Promise<GlossaryTerm>;
  update(
    id: string,
    patch: GlossaryTermPatch,
    updatedBy: string,
  ): Promise<GlossaryTerm>;
  remove(id: string): Promise<boolean>;
  validate(): Promise<GlossaryValidationReport>;
  stats(): Promise<GlossaryStats>;
  previewPrompt(limit?: number): Promise<GlossaryPromptPreview>;
}

export class GlossaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryValidationError';
  }
}

export class GlossaryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryConflictError';
  }
}

export class GlossaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryNotFoundError';
  }
}

/** 标准名称去重键：忽略大小写与多余空白 */
export function glossaryNameKey(name: string): string {
  return name.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** 去空、去重（忽略大小写），保留首次出现的写法 */
export function normalizeGlossaryList(values: string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
