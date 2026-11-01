import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  SkillDefinition,
  SkillFrontmatter,
  SkillResourceInfo,
  SkillRisk,
  SkillSource,
  SkillVisibility,
} from '../types/skills-plugins-projects.js';

const SKILL_FILE = 'SKILL.md';
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const MAX_RESOURCES = 200;
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SKIPPED_DIRS = new Set([
  '.git',
  '.svn',
  'node_modules',
  'scripts',
  '__pycache__',
]);

export interface SkillScanRoot {
  source: SkillSource;
  dir: string;
  pluginId?: string;
  /** 插件版本仅用于展示与审计 */
  pluginVersion?: string;
}

export interface SkillRegistryOptions {
  roots: SkillScanRoot[];
  maxFileBytes?: number;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
  now?: () => number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  definition: SkillDefinition;
}

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

/** 去除 UTF-8 BOM，避免 front matter 起始符匹配失败 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function splitFrontmatter(
  raw: string,
): { yaml: string; body: string } | null {
  const text = stripBom(raw).replace(/\r\n/gu, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const after = end + 4;
  const yaml = text.slice(4, end);
  const body = text.slice(after).replace(/^\n/u, '');
  return { yaml, body };
}

function stripComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && index > 0 && /\s/u.test(value[index - 1] ?? '')) {
      return value.slice(0, index);
    }
  }
  return value;
}

function parseScalar(raw: string): unknown {
  const value = stripComment(raw).trim();
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const result: Record<string, unknown> = {};
    if (!inner) return result;
    for (const pair of inner.split(',')) {
      const colon = pair.indexOf(':');
      if (colon < 0) continue;
      const key = pair.slice(0, colon).trim();
      if (!key) continue;
      result[key] = parseScalar(pair.slice(colon + 1));
    }
    return result;
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/u.test(value)) return Number(value);
  return value;
}

/**
 * 只解析 SKILL.md 需要的 YAML 子集：标量、行内数组、缩进数组、`|` 块。
 * 不引入完整 YAML 解析器，避免为一个受控文件格式增加依赖面。
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const result: Record<string, unknown> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > 0) continue;
    const match = /^([A-Za-z0-9_-]+):(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1] ?? '';
    const rest = (match[2] ?? '').trim();
    if (!key) continue;

    if (rest === '|' || rest === '>') {
      const folded = rest === '>';
      const collected: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? '';
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() && nextIndent === 0) break;
        collected.push(next);
        index += 1;
      }
      const nonEmpty = collected.filter((item) => item.trim());
      const minIndent = Math.min(
        ...nonEmpty.map((item) => item.length - item.trimStart().length),
      );
      const normalized = collected.map((item) =>
        item.length >= minIndent ? item.slice(minIndent) : item,
      );
      result[key] = folded
        ? normalized.join('\n').trim().replace(/\n+/gu, ' ')
        : normalized.join('\n').trim();
      continue;
    }

    if (rest === '') {
      const items: unknown[] = [];
      let seenListItem = false;
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (!next.trim() || next.trimStart().startsWith('#')) {
          index += 1;
          continue;
        }
        const nextIndent = next.length - next.trimStart().length;
        const listMatch = /^\s*-\s+(.*)$/u.exec(next);
        if (nextIndent > 0 && listMatch) {
          items.push(parseScalar(listMatch[1] ?? ''));
          seenListItem = true;
          index += 1;
          continue;
        }
        if (nextIndent > 0 && !seenListItem) {
          // 嵌套对象暂不支持；跳过缩进行，避免污染后续顶层键
          index += 1;
          continue;
        }
        break;
      }
      result[key] = seenListItem ? items : '';
      continue;
    }

    result[key] = parseScalar(rest);
  }

  return result;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function validateFrontmatter(
  raw: Record<string, unknown>,
  fallbackName: string,
): SkillFrontmatter {
  const name = asString(raw.name) || fallbackName;
  if (!NAME_PATTERN.test(name)) {
    throw new SkillValidationError(
      `技能 name 必须匹配 ${NAME_PATTERN.source}，当前为 "${name}"`,
    );
  }
  const description = asString(raw.description);
  if (!description) throw new SkillValidationError('技能 description 不能为空');
  if (description.length > 160) {
    throw new SkillValidationError('技能 description 不能超过 160 字符');
  }
  const version = asString(raw.version);
  if (!VERSION_PATTERN.test(version)) {
    throw new SkillValidationError('技能 version 必须是语义化版本');
  }
  const whenToUse = asString(raw.when_to_use);
  if (!whenToUse) throw new SkillValidationError('技能 when_to_use 不能为空');
  if (whenToUse.length > 200) {
    throw new SkillValidationError('技能 when_to_use 不能超过 200 字符');
  }
  const riskRaw = asString(raw.risk) as SkillRisk;
  const risk: SkillRisk =
    riskRaw === 'read' || riskRaw === 'write' || riskRaw === 'destructive'
      ? riskRaw
      : 'read';
  const visibilityRaw = asString(raw.visibility) as SkillVisibility;
  const visibility: SkillVisibility =
    visibilityRaw === 'admin' ? 'admin' : 'public';
  const maxInstructionChars = clamp(
    Number(raw.max_instruction_chars ?? 4_000),
    1_000,
    8_000,
  );
  return {
    name,
    description,
    version,
    when_to_use: whenToUse,
    tags: asStringList(raw.tags),
    allowed_tools: asStringList(raw.allowed_tools),
    risk,
    visibility,
    max_instruction_chars: maxInstructionChars,
  };
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  bodyHash: string;
}

export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): ParsedSkill {
  const parts = splitFrontmatter(raw);
  if (!parts) {
    throw new SkillValidationError('缺少 YAML front matter（文件需以 --- 开头）');
  }
  if (!parts.body.trim()) throw new SkillValidationError('技能正文不能为空');
  const yaml = parseSimpleYaml(parts.yaml);
  const frontmatter = validateFrontmatter(yaml, fallbackName);
  return {
    frontmatter,
    body: parts.body.trim(),
    bodyHash: createHash('sha256').update(parts.body).digest('hex'),
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

async function resolveInside(
  root: string,
  candidate: string,
): Promise<string | null> {
  try {
    const resolved = await realpath(candidate);
    return isPathInside(root, resolved) || resolved === root ? resolved : null;
  } catch {
    return null;
  }
}

async function listResources(skillDir: string): Promise<SkillResourceInfo[]> {
  const resources: SkillResourceInfo[] = [];
  const stack = [skillDir];
  while (stack.length > 0 && resources.length < MAX_RESOURCES) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCES) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (path.basename(fullPath) === SKILL_FILE && current === skillDir) {
        continue;
      }
      try {
        const info = await stat(fullPath);
        resources.push({
          path: path.relative(skillDir, fullPath).split(path.sep).join('/'),
          sizeBytes: info.size,
        });
      } catch {
        // 文件在遍历过程中消失时忽略
      }
    }
  }
  return resources.sort((a, b) => a.path.localeCompare(b.path));
}

function fallbackNameFromDir(dir: string): string {
  const base = path.basename(dir);
  return NAME_PATTERN.test(base) ? base : 'invalid-skill';
}

export class SkillRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxFileBytes: number;

  constructor(private readonly options: SkillRegistryOptions) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** 扫描所有根目录；单个技能损坏只记录 loadError，不影响其他技能 */
  public async scan(): Promise<SkillDefinition[]> {
    const definitions: SkillDefinition[] = [];
    for (const root of this.options.roots) {
      if (!root.dir) continue;
      let rootReal: string;
      try {
        rootReal = await realpath(root.dir);
        const info = await stat(rootReal);
        if (!info.isDirectory()) continue;
      } catch {
        continue;
      }

      const skillDirs: string[] = [];
      try {
        const direct = await resolveInside(rootReal, path.join(rootReal, SKILL_FILE));
        if (direct) skillDirs.push(rootReal);
      } catch {
        // ignore
      }
      let entries: Dirent[] = [];
      try {
        entries = await readdir(rootReal, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        skillDirs.push(path.join(rootReal, entry.name));
      }

      for (const skillDir of skillDirs) {
        const definition = await this.loadSkillDir(skillDir, rootReal, root);
        if (definition) definitions.push(definition);
      }
    }
    this.markNameConflicts(definitions);
    const sourceOrder: Record<SkillSource, number> = {
      builtin: 0,
      local: 1,
      plugin: 2,
    };
    return definitions.sort(
      (a, b) =>
        sourceOrder[a.source] - sourceOrder[b.source] ||
        a.name.localeCompare(b.name),
    );
  }

  private markNameConflicts(definitions: SkillDefinition[]): void {
    const byName = new Map<string, SkillDefinition[]>();
    for (const definition of definitions) {
      if (definition.loadError) continue;
      const group = byName.get(definition.name) ?? [];
      group.push(definition);
      byName.set(definition.name, group);
    }
    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      const sources = group.map((item) => item.id).join(', ');
      for (const definition of group) {
        definition.loadError = `技能名称冲突：${name} 同时存在于 ${sources}`;
      }
    }
  }

  private async loadSkillDir(
    skillDir: string,
    rootReal: string,
    root: SkillScanRoot,
  ): Promise<SkillDefinition | null> {
    const realDir = await resolveInside(rootReal, skillDir);
    if (!realDir) {
      this.options.logger?.warn(
        { dir: skillDir, root: rootReal },
        'skip skill outside root (symlink escape)',
      );
      return null;
    }
    const file = path.join(realDir, SKILL_FILE);
    let fileInfo;
    try {
      fileInfo = await stat(file);
    } catch {
      return null;
    }
    if (!fileInfo.isFile()) return null;

    const cacheKey = `${file}|${root.source}|${root.pluginId ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      cached.mtimeMs === fileInfo.mtimeMs &&
      cached.size === fileInfo.size
    ) {
      return cloneDefinition(cached.definition);
    }

    const fallbackName = fallbackNameFromDir(realDir);
    let raw: string;
    try {
      if (fileInfo.size > this.maxFileBytes) {
        throw new SkillValidationError(
          `SKILL.md 超过 ${this.maxFileBytes} 字节上限`,
        );
      }
      raw = await readFile(file, 'utf8');
    } catch (error) {
      return this.cacheAndReturn(cacheKey, fileInfo.mtimeMs, fileInfo.size, {
        ...emptyDefinition(root, realDir, fallbackName),
        loadError:
          error instanceof Error ? error.message : 'SKILL.md 读取失败',
      });
    }

    let definition: SkillDefinition;
    try {
      const parsed = parseSkillMarkdown(raw, fallbackName);
      const id =
        root.source === 'plugin'
          ? `plugin:${root.pluginId ?? 'unknown'}:${parsed.frontmatter.name}`
          : `${root.source}:${parsed.frontmatter.name}`;
      definition = {
        id,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        version: parsed.frontmatter.version ?? '0.0.0',
        whenToUse: parsed.frontmatter.when_to_use ?? '',
        tags: parsed.frontmatter.tags ?? [],
        allowedTools: parsed.frontmatter.allowed_tools ?? [],
        risk: parsed.frontmatter.risk ?? 'read',
        visibility: parsed.frontmatter.visibility ?? 'public',
        source: root.source,
        ...(root.pluginId ? { pluginId: root.pluginId } : {}),
        dir: realDir,
        body: parsed.body,
        bodyHash: parsed.bodyHash,
        maxInstructionChars: parsed.frontmatter.max_instruction_chars ?? 4_000,
        enabled: true,
        resources: await listResources(realDir),
      };
    } catch (error) {
      definition = {
        ...emptyDefinition(root, realDir, fallbackName),
        loadError:
          error instanceof Error ? error.message : '技能解析失败',
      };
    }
    return this.cacheAndReturn(
      cacheKey,
      fileInfo.mtimeMs,
      fileInfo.size,
      definition,
    );
  }

  private cacheAndReturn(
    key: string,
    mtimeMs: number,
    size: number,
    definition: SkillDefinition,
  ): SkillDefinition {
    this.cache.set(key, { mtimeMs, size, definition });
    return cloneDefinition(definition);
  }
}

function emptyDefinition(
  root: SkillScanRoot,
  dir: string,
  name: string,
): SkillDefinition {
  const id =
    root.source === 'plugin'
      ? `plugin:${root.pluginId ?? 'unknown'}:${name}`
      : `${root.source}:${name}`;
  return {
    id,
    name,
    description: '',
    version: '0.0.0',
    whenToUse: '',
    tags: [],
    allowedTools: [],
    risk: 'read',
    visibility: 'public',
    source: root.source,
    ...(root.pluginId ? { pluginId: root.pluginId } : {}),
    dir,
    body: '',
    bodyHash: '',
    maxInstructionChars: 4_000,
    enabled: true,
    resources: [],
  };
}

function cloneDefinition(definition: SkillDefinition): SkillDefinition {
  return {
    ...definition,
    tags: [...definition.tags],
    allowedTools: [...definition.allowedTools],
    resources: definition.resources.map((item) => ({ ...item })),
  };
}
