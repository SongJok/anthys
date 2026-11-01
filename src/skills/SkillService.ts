import { watch, type FSWatcher } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillStore } from './SkillStore.js';
import {
  SkillRegistry,
  type SkillScanRoot,
} from './SkillRegistry.js';
import { SkillRouter, toCatalogEntry } from './SkillRouter.js';
import type {
  SkillAdminView,
  SkillCatalogEntry,
  SkillCatalogResult,
  SkillContextInput,
  SkillDefinition,
  SkillLoadResult,
  SkillPreviewEntry,
  SkillPreviewResult,
  SkillResourceReadRequest,
  SkillResourceReadResult,
  SkillSearchMatch,
  SkillSearchResult,
  SkillUsageAction,
  SkillUsageSummary,
} from '../types/skills-plugins-projects.js';

const DEFAULT_CATALOG_LIMIT = 20;
const OVERFLOW_CATALOG_LIMIT = 12;
const DEFAULT_CATALOG_MAX_CHARS = 1_200;
const DEFAULT_ENTRY_MAX_CHARS = 80;
const DEFAULT_INSTRUCTION_CAP = 4_000;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const RESOURCE_MAX_LINES = 500;
const RESOURCE_MAX_CHARS = 4_000;
const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SkillRootProvider =
  | SkillScanRoot[]
  | (() => SkillScanRoot[] | Promise<SkillScanRoot[]>);

export interface SkillServiceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SkillServiceOptions {
  roots: SkillRootProvider;
  store?: SkillStore;
  router?: SkillRouter;
  catalogLimit?: number;
  catalogMaxChars?: number;
  catalogEntryMaxChars?: number;
  instructionCap?: number;
  logger?: SkillServiceLogger;
  now?: () => number;
}

export class SkillNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillDisabledError';
  }
}

export class SkillForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillForbiddenError';
  }
}

export class SkillResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillResourceError';
  }
}

export interface SkillLoadInput {
  name: string;
  conversationId: string;
  senderStaffId: string;
  isAdmin: boolean;
}

export interface SkillSearchInput {
  query: string;
  limit?: number;
  conversationId?: string;
  senderStaffId?: string;
  isAdmin: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function buildOutline(
  definition: SkillDefinition,
  totalLines: number,
): string {
  const headings = definition.body
    .split('\n')
    .filter((line) => /^#{1,3}\s+/u.test(line))
    .slice(0, 20)
    .map((line) => line.trim());
  const lines = [
    `技能 ${definition.name} 正文共 ${totalLines} 行，超过单次注入上限 ${definition.maxInstructionChars} 字符。`,
    '请使用 skill_read 分段读取 SKILL.md 后再执行；不要凭名称猜测步骤。',
  ];
  if (headings.length > 0) {
    lines.push('章节：', ...headings.map((heading) => `- ${heading}`));
  }
  if (definition.resources.length > 0) {
    lines.push(
      '参考资源：',
      ...definition.resources
        .slice(0, 20)
        .map((resource) => `- ${resource.path}（${resource.sizeBytes} 字节）`),
    );
  }
  lines.push(
    `建议先读取第 1-200 行：skill_read(name="${definition.name}", path="SKILL.md", startLine=1, endLine=200)。`,
  );
  return lines.join('\n');
}

export class SkillService {
  private readonly router: SkillRouter;
  private readonly store?: SkillStore;
  private readonly logger?: SkillServiceLogger;
  private readonly now: () => number;
  private readonly catalogLimit: number;
  private readonly catalogMaxChars: number;
  private readonly catalogEntryMaxChars: number;
  private readonly instructionCap: number;

  private definitions: SkillDefinition[] = [];
  private byId = new Map<string, SkillDefinition>();
  private byName = new Map<string, SkillDefinition>();
  private usage = new Map<string, SkillUsageSummary>();
  private initialized = false;

  constructor(options: SkillServiceOptions) {
    this.router = options.router ?? new SkillRouter();
    this.store = options.store;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.catalogLimit = Math.min(
      50,
      Math.max(1, Math.trunc(options.catalogLimit ?? DEFAULT_CATALOG_LIMIT)),
    );
    this.catalogMaxChars = Math.max(
      300,
      Math.trunc(options.catalogMaxChars ?? DEFAULT_CATALOG_MAX_CHARS),
    );
    this.catalogEntryMaxChars = Math.min(
      120,
      Math.max(40, Math.trunc(options.catalogEntryMaxChars ?? DEFAULT_ENTRY_MAX_CHARS)),
    );
    this.instructionCap = Math.min(
      8_000,
      Math.max(1_000, Math.trunc(options.instructionCap ?? DEFAULT_INSTRUCTION_CAP)),
    );
    this.rootProvider = options.roots;
  }

  private readonly rootProvider: SkillRootProvider;

  public async init(): Promise<this> {
    if (this.initialized) return this;
    this.initialized = true;
    await this.reload();
    return this;
  }

  /** 重新扫描磁盘并刷新数据库中的启用状态；单点失败只记录错误 */
  public async reload(): Promise<{ loaded: number; errors: string[] }> {
    const roots = await this.resolveRoots();
    const registry = new SkillRegistry({
      roots,
      ...(this.logger ? { logger: this.logger } : {}),
      now: this.now,
    });
    const scanned = await registry.scan();

    if (this.store) {
      try {
        const states = await this.store.listStates();
        const stateById = new Map(states.map((state) => [state.id, state]));
        for (const definition of scanned) {
          const state = stateById.get(definition.id);
          if (state) definition.enabled = state.enabled;
        }
      } catch (error) {
        this.logger?.warn(
          { error: errorMessage(error) },
          'failed to load skill states, using defaults',
        );
      }
    }

    this.definitions = scanned;
    this.byId = new Map(scanned.map((definition) => [definition.id, definition]));
    this.byName = new Map();
    for (const definition of scanned) {
      const key = definition.name.toLowerCase();
      if (!this.byName.has(key)) this.byName.set(key, definition);
    }

    if (this.store) {
      try {
        await this.store.sync(scanned);
      } catch (error) {
        this.logger?.warn(
          { error: errorMessage(error) },
          'failed to sync skill metadata',
        );
      }
      await this.refreshUsage();
    }

    const errors = scanned
      .filter((definition) => definition.loadError)
      .map((definition) => `${definition.id}: ${definition.loadError}`);
    return { loaded: scanned.length - errors.length, errors };
  }

  public getAll(): SkillDefinition[] {
    return this.definitions.map((definition) => this.clone(definition));
  }

  public getByNameOrId(nameOrId: string): SkillDefinition | null {
    const skill = this.find(nameOrId);
    return skill ? this.clone(skill) : null;
  }

  public async listAdmin(): Promise<SkillAdminView[]> {
    return this.definitions.map((definition) => {
      const usage = this.usage.get(definition.id);
      return {
        ...this.clone(definition),
        lastUsedAt: usage?.lastUsedAt ?? null,
        uses: usage?.uses ?? 0,
      };
    });
  }

  public async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<SkillDefinition> {
    const definition = this.find(id);
    if (!definition) throw new SkillNotFoundError(`技能不存在：${id}`);
    if (this.store) await this.store.setEnabled(definition.id, enabled);
    definition.enabled = enabled;
    return this.clone(definition);
  }

  public buildCatalog(input: SkillContextInput): SkillCatalogResult {
    const usable = this.usableSkills(input);
    const ranked = this.router.rank(usable, {
      query: input.query,
      isAdmin: input.isAdmin,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      usage: this.usage,
      now: this.now(),
    });
    const limit = Math.min(
      this.catalogLimit,
      Math.max(1, Math.trunc(input.limit ?? this.catalogLimit)),
    );
    const target = ranked.length > limit ? Math.min(OVERFLOW_CATALOG_LIMIT, limit) : ranked.length;
    const selected = ranked.slice(0, target);
    const entries: SkillCatalogEntry[] = [];
    const lines = [
      '## 可用技能',
      '当任务匹配时，先调用 use_skill 加载完整步骤；不要凭名称猜测内容。',
    ];
    let budget = this.catalogMaxChars;
    for (const match of selected) {
      const entry = toCatalogEntry(match);
      const line = clip(
        `- ${entry.name}：${entry.description}。适用：${entry.whenToUse}`,
        this.catalogEntryMaxChars,
      );
      if (budget - line.length - 1 < 0) break;
      budget -= line.length + 1;
      lines.push(line);
      entries.push(entry);
    }
    const omitted = ranked.length - entries.length;
    if (omitted > 0) {
      const hint = `- 还有其他 ${omitted} 个技能，可调用 skill_search 查找。`;
      if (budget >= hint.length) lines.push(hint);
    }
    return {
      prompt: entries.length > 0 ? lines.join('\n') : '',
      entries,
      total: ranked.length,
      truncated: omitted > 0,
    };
  }

  public search(input: SkillSearchInput): SkillSearchResult {
    const usable = this.usableSkills({
      conversationType: '1',
      isAdmin: input.isAdmin,
      query: input.query,
    });
    const ranked = this.router.rank(usable, {
      query: input.query,
      isAdmin: input.isAdmin,
      usage: this.usage,
      now: this.now(),
    });
    const limit = Math.min(10, Math.max(1, Math.trunc(input.limit ?? 5)));
    const query = input.query.trim().toLowerCase();
    const matches = ranked
      .filter((match) => (query ? match.score > 0 : true))
      .slice(0, limit);
    if (input.conversationId !== undefined && input.senderStaffId !== undefined) {
      for (const match of matches) {
        void this.recordUsage(match.id, 'search', {
          conversationId: input.conversationId,
          senderStaffId: input.senderStaffId,
        });
      }
    }
    return { matches, total: ranked.length };
  }

  public async load(input: SkillLoadInput): Promise<SkillLoadResult> {
    const definition = this.requireUsable(input.name, input.isAdmin);
    const cap = Math.min(this.instructionCap, definition.maxInstructionChars);
    const totalLines = definition.body.split('\n').length;
    const tooLong = definition.body.length > cap;
    const result: SkillLoadResult = {
      skill: this.clone(definition),
      outline: tooLong ? buildOutline(definition, totalLines) : '',
      truncated: tooLong,
      resources: definition.resources.map((resource) => ({ ...resource })),
      ...(tooLong ? {} : { instructions: definition.body }),
    };
    await this.recordUsage(definition.id, 'load', {
      conversationId: input.conversationId,
      senderStaffId: input.senderStaffId,
    });
    return result;
  }

  public async readResource(
    input: SkillResourceReadRequest,
  ): Promise<SkillResourceReadResult> {
    const definition = this.requireUsable(input.name, input.isAdmin);
    const relative = input.path.trim().replace(/\\/gu, '/');
    if (!relative) throw new SkillResourceError('path 不能为空');
    if (path.isAbsolute(relative) || relative.startsWith('..')) {
      throw new SkillResourceError('只允许读取技能目录内的相对路径');
    }
    const candidate = path.resolve(definition.dir, relative);
    if (!isInside(definition.dir, candidate)) {
      throw new SkillResourceError('路径逃逸技能目录');
    }
    let realFile: string;
    try {
      realFile = await realpath(candidate);
    } catch {
      throw new SkillResourceError(`资源不存在：${relative}`);
    }
    if (!isInside(definition.dir, realFile)) {
      throw new SkillResourceError('资源通过符号链接逃逸技能目录');
    }
    const info = await stat(realFile);
    if (!info.isFile()) throw new SkillResourceError('资源不是普通文件');
    if (info.size > MAX_RESOURCE_BYTES) {
      throw new SkillResourceError('资源文件超过 1MB，无法读取');
    }
    const raw = await readFile(realFile, 'utf8');
    if (raw.includes('\u0000')) {
      throw new SkillResourceError('二进制资源不支持读取');
    }
    const allLines = raw.replace(/\r\n/gu, '\n').split('\n');
    const totalLines = allLines.length;
    const startLine = Math.min(
      totalLines,
      Math.max(1, Math.trunc(input.startLine ?? 1)),
    );
    const requestedEnd = Math.max(
      startLine,
      Math.trunc(input.endLine ?? startLine + RESOURCE_MAX_LINES - 1),
    );
    let endLine = Math.min(
      totalLines,
      startLine + RESOURCE_MAX_LINES - 1,
      requestedEnd,
    );
    let content = allLines.slice(startLine - 1, endLine).join('\n');
    let truncated = false;
    if (content.length > RESOURCE_MAX_CHARS) {
      content = content.slice(0, RESOURCE_MAX_CHARS);
      truncated = true;
      const consumed = content.split('\n').length;
      endLine = Math.min(endLine, startLine + consumed - 1);
    }
    const nextStartLine =
      endLine < totalLines ? endLine + 1 : undefined;
    if (nextStartLine !== undefined) truncated = true;
    await this.recordUsage(definition.id, 'read', {
      conversationId: input.conversationId ?? '',
      senderStaffId: input.senderStaffId ?? '',
    });
    return {
      skillId: definition.id,
      path: relative,
      startLine,
      endLine,
      totalLines,
      ...(nextStartLine !== undefined ? { nextStartLine } : {}),
      content,
      truncated,
    };
  }

  public preview(input: SkillContextInput): SkillPreviewResult {
    const usable = this.usableSkills(input);
    const ranked = this.router.rank(usable, {
      query: input.query,
      isAdmin: input.isAdmin,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      usage: this.usage,
      now: this.now(),
    });
    const catalog = this.buildCatalog(input);
    const entries: SkillPreviewEntry[] = ranked
      .slice(0, Math.max(20, catalog.entries.length))
      .map((match) => ({
        skill: toCatalogEntry(match),
        score: match.score,
        matched: !!(input.query ?? '').trim() && match.score > 0,
      }));
    return {
      prompt: catalog.prompt,
      entries,
      truncated: catalog.truncated,
    };
  }

  /** 管理端使用统计；不传天数时按默认 7 天窗口 */
  public async usageSince(days?: number): Promise<Map<string, SkillUsageSummary>> {
    if (!this.store) return new Map();
    const windowDays = Math.min(
      90,
      Math.max(1, Math.trunc(days ?? USAGE_WINDOW_MS / (24 * 60 * 60 * 1000))),
    );
    const since = this.now() - windowDays * 24 * 60 * 60 * 1000;
    try {
      return await this.store.usageSince(since);
    } catch (error) {
      this.logger?.warn(
        { error: errorMessage(error) },
        'failed to load skill usage window',
      );
      return new Map();
    }
  }

  public async refreshUsage(): Promise<void> {
    if (!this.store) return;
    try {
      this.usage = await this.store.usageSince(this.now() - USAGE_WINDOW_MS);
    } catch (error) {
      this.logger?.warn(
        { error: errorMessage(error) },
        'failed to load skill usage',
      );
    }
  }

  /** 监听技能目录变化，返回停止函数；防抖 500ms */
  public startWatching(onChange: () => void | Promise<void>): () => void {
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const trigger = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void Promise.resolve(onChange()).catch(() => undefined);
      }, 500);
      timer.unref?.();
    };
    const roots = this.rootProvider;
    const attach = async (): Promise<void> => {
      let resolved: SkillScanRoot[];
      try {
        resolved = typeof roots === 'function' ? await roots() : roots;
      } catch {
        return;
      }
      for (const root of resolved) {
        try {
          const watcher = watch(root.dir, { recursive: true }, trigger);
          watcher.on('error', () => undefined);
          watcher.unref?.();
          watchers.push(watcher);
        } catch {
          try {
            const watcher = watch(root.dir, trigger);
            watcher.on('error', () => undefined);
            watcher.unref?.();
            watchers.push(watcher);
          } catch {
            // 目录不存在或无权限时忽略
          }
        }
      }
    };
    void attach();
    return () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  private async resolveRoots(): Promise<SkillScanRoot[]> {
    const roots =
      typeof this.rootProvider === 'function'
        ? await this.rootProvider()
        : this.rootProvider;
    return roots.filter((root) => root.dir);
  }

  private usableSkills(input: SkillContextInput): SkillDefinition[] {
    return this.definitions.filter(
      (definition) =>
        definition.enabled &&
        !definition.loadError &&
        (input.isAdmin || definition.visibility !== 'admin'),
    );
  }

  private find(nameOrId: string): SkillDefinition | null {
    const key = nameOrId.trim();
    if (!key) return null;
    return (
      this.byId.get(key) ??
      this.byName.get(key.toLowerCase()) ??
      this.byId.get(key.toLowerCase()) ??
      null
    );
  }

  private requireUsable(nameOrId: string, isAdmin: boolean): SkillDefinition {
    const definition = this.find(nameOrId);
    if (!definition) {
      throw new SkillNotFoundError(
        `技能不存在：${nameOrId}。可先调用 skill_search 查找可用技能。`,
      );
    }
    if (!definition.enabled) {
      throw new SkillDisabledError(`技能已停用：${definition.name}`);
    }
    if (definition.loadError) {
      throw new SkillDisabledError(
        `技能加载失败：${definition.name}（${definition.loadError}）`,
      );
    }
    if (definition.visibility === 'admin' && !isAdmin) {
      throw new SkillForbiddenError(`技能仅管理员可用：${definition.name}`);
    }
    return definition;
  }

  private async recordUsage(
    skillId: string,
    action: SkillUsageAction,
    context: { conversationId: string; senderStaffId: string },
  ): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.recordUsage({
        skillId,
        conversationId: context.conversationId,
        senderStaffId: context.senderStaffId,
        action,
      });
      const current = this.usage.get(skillId);
      this.usage.set(skillId, {
        skillId,
        uses: (current?.uses ?? 0) + 1,
        lastUsedAt: this.now(),
      });
    } catch (error) {
      this.logger?.warn(
        { error: errorMessage(error), skillId },
        'failed to record skill usage',
      );
    }
  }

  private clone(definition: SkillDefinition): SkillDefinition {
    return {
      ...definition,
      tags: [...definition.tags],
      allowedTools: [...definition.allowedTools],
      resources: definition.resources.map((resource) => ({ ...resource })),
    };
  }
}
