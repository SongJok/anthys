import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSkillMarkdown } from '../skills/SkillRegistry.js';
import type {
  PluginManifest,
  PluginMcpServerDecl,
  PluginPermissions,
  PluginSecretDecl,
  PluginValidationIssue,
  SkillFrontmatter,
} from '../types/skills-plugins-projects.js';

export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/u;
export const PLUGIN_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
export const PLUGIN_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
export const PLUGIN_SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
export const DEFAULT_PLUGIN_ALLOWED_COMMANDS = [
  'npx',
  'uvx',
  'node',
  'python3',
  'docker',
] as const;

const MAX_SKILLS = 50;
const MAX_MCP_SERVERS = 20;
const MAX_SECRETS = 20;
const MAX_NETWORK_HOSTS = 50;
const MAX_PLUGIN_DIRS = 1_000;
const SHELL_META_PATTERN = /[\n\r;|&`$<>]/u;
const PLACEHOLDER_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/gu;
const DOMAINS = new Set([
  'code',
  'data',
  'log',
  'apidoc',
  'business',
  'general',
]);
const TRANSPORTS = new Set(['stdio', 'sse', 'streamable-http']);

export type PluginManifestStage =
  | 'manifest'
  | 'skills'
  | 'mcp'
  | 'secrets'
  | 'conflict';

export class PluginManifestError extends Error {
  public readonly issues: PluginValidationIssue[];

  constructor(
    public readonly stage: PluginManifestStage,
    issues: PluginValidationIssue[],
  ) {
    super(
      issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('；') || '插件清单校验失败',
    );
    this.name = 'PluginManifestError';
    this.issues = issues;
  }
}

export interface PluginManifestContext {
  agentVersion: string;
  /** 裸命令白名单；未配置时 stdio MCP 一律拒绝 */
  allowedCommands?: readonly string[];
  env?: Record<string, string | undefined>;
  allowMissingSecrets?: boolean;
  /** 内置 / 本地技能名，用于冲突检测 */
  reservedSkillNames?: Iterable<string>;
}

export interface PluginSkillDescriptor {
  /** plugin:<pluginId>:<skillName> */
  id: string;
  name: string;
  relativeDir: string;
  dir: string;
  bodyHash: string;
  frontmatter: SkillFrontmatter;
}

export interface ParsedPluginManifest {
  manifest: PluginManifest;
  skills: PluginSkillDescriptor[];
  warnings: PluginValidationIssue[];
  missingSecrets: string[];
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

interface PartialSemVer {
  major: number;
  minor?: number;
  patch?: number;
}

function parseSemver(value: string): SemVer | null {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      value,
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function parsePartialSemver(value: string): PartialSemVer | null {
  const match = /^(\d+)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?$/u.exec(value);
  if (!match) return null;
  const minor =
    match[2] && match[2] !== '*' && match[2] !== 'x' && match[2] !== 'X'
      ? Number(match[2])
      : undefined;
  const patch =
    match[3] && match[3] !== '*' && match[3] !== 'x' && match[3] !== 'X'
      ? Number(match[3])
      : undefined;
  if (patch !== undefined && minor === undefined) return null;
  return { major: Number(match[1]), minor, patch };
}

function compareSemver(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

export function comparePluginVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left.localeCompare(right);
  return compareSemver(a, b);
}

function makeVersion(
  major: number,
  minor = 0,
  patch = 0,
): SemVer {
  return { major, minor, patch, prerelease: [] };
}

function matchesComparator(version: SemVer, comparator: string): boolean {
  if (comparator === '*' || comparator === 'x' || comparator === 'X') {
    return true;
  }
  const match = /^(\^|~|>=|>|<=|<|=)?(.*)$/u.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const partial = parsePartialSemver(match[2]);
  if (!partial) return false;
  const base = makeVersion(partial.major, partial.minor ?? 0, partial.patch ?? 0);
  const comparison = compareSemver(version, base);

  if (operator === '=') {
    if (partial.patch !== undefined) return comparison === 0;
    if (partial.minor !== undefined) {
      return version.major === base.major && version.minor === base.minor;
    }
    return version.major === base.major;
  }
  if (operator === '>=') return comparison >= 0;
  if (operator === '>') return comparison > 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '~') {
    const upper = makeVersion(base.major, (partial.minor ?? 0) + 1, 0);
    return comparison >= 0 && compareSemver(version, upper) < 0;
  }
  // ^：处理 0.x 的兼容范围
  if (base.major > 0) {
    const upper = makeVersion(base.major + 1, 0, 0);
    return comparison >= 0 && compareSemver(version, upper) < 0;
  }
  if (base.minor > 0) {
    const upper = makeVersion(0, base.minor + 1, 0);
    return comparison >= 0 && compareSemver(version, upper) < 0;
  }
  const upper = makeVersion(0, 0, (partial.patch ?? 0) + 1);
  return comparison >= 0 && compareSemver(version, upper) < 0;
}

/** 支持 >=1.2.3、^1.2.3、~1.2.3、1.2.x、空格 AND 与 || OR */
export function satisfiesSemverRange(
  versionText: string,
  rangeText: string,
): boolean {
  const version = parseSemver(versionText);
  if (!version) return false;
  const alternatives = rangeText
    .trim()
    .split('||')
    .map((item) => item.trim())
    .filter(Boolean);
  if (alternatives.length === 0) return false;
  return alternatives.some((alternative) => {
    const comparators = alternative
      .replace(/,/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean);
    return comparators.every((comparator) =>
      matchesComparator(version, comparator),
    );
  });
}

export function isValidSemverRange(rangeText: string): boolean {
  if (!rangeText.trim()) return false;
  return rangeText.split('||').every((alternative) => {
    const parts = alternative
      .trim()
      .replace(/,/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean);
    return parts.length > 0 && parts.every(isValidComparator);
  });
}

function isValidComparator(comparator: string): boolean {
  if (comparator === '*' || comparator === 'x' || comparator === 'X') {
    return true;
  }
  const match = /^(\^|~|>=|>|<=|<|=)?(.*)$/u.exec(comparator);
  if (!match) return false;
  return parsePartialSemver(match[2]) !== null;
}

function issue(
  issues: PluginValidationIssue[],
  pathName: string,
  message: string,
): void {
  issues.push({ severity: 'error', path: pathName, message });
}

function warn(
  warnings: PluginValidationIssue[],
  pathName: string,
  message: string,
): void {
  warnings.push({ severity: 'warning', path: pathName, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(
  value: unknown,
  pathName: string,
  issues: PluginValidationIssue[],
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issue(issues, pathName, '必须是字符串数组');
    return undefined;
  }
  if (value.length > maxItems) {
    issue(issues, pathName, `最多允许 ${maxItems} 项`);
    return undefined;
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim()) {
      issue(issues, `${pathName}[${index}]`, '必须是非空字符串');
      continue;
    }
    if (item.length > maxLength) {
      issue(issues, `${pathName}[${index}]`, `长度不能超过 ${maxLength}`);
      continue;
    }
    result.push(item);
  }
  return result;
}

function normalizeRelativePath(
  value: string,
  pathName: string,
  issues: PluginValidationIssue[],
): string | null {
  if (value.includes('\0')) {
    issue(issues, pathName, '路径不能包含空字符');
    return null;
  }
  const normalized = value.replace(/\\/gu, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    issue(issues, pathName, '必须是相对插件根目录的路径');
    return null;
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    issue(issues, pathName, '路径不能包含空段、. 或 ..');
    return null;
  }
  return segments.join('/');
}

function extractPlaceholders(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    found.push(match[1]);
  }
  return found;
}

function validatePermissionNetwork(
  value: unknown,
  pathName: string,
  issues: PluginValidationIssue[],
): string[] {
  if (value === undefined) return [];
  const hosts = asStringArray(value, pathName, issues, MAX_NETWORK_HOSTS, 253);
  if (!hosts) return [];
  const result: string[] = [];
  for (const [index, host] of hosts.entries()) {
    const normalized = host.toLowerCase();
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
        normalized,
      )
    ) {
      issue(issues, `${pathName}[${index}]`, '不是合法的主机名');
      continue;
    }
    result.push(normalized);
  }
  return result;
}

function validateSecrets(
  value: unknown,
  issues: PluginValidationIssue[],
): PluginSecretDecl[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, 'secrets', '必须是数组');
    return [];
  }
  if (value.length > MAX_SECRETS) {
    issue(issues, 'secrets', `最多允许 ${MAX_SECRETS} 项`);
    return [];
  }
  const result: PluginSecretDecl[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const pathName = `secrets[${index}]`;
    if (!isRecord(item)) {
      issue(issues, pathName, '必须是对象');
      continue;
    }
    const key = item.key;
    if (typeof key !== 'string' || !PLUGIN_SECRET_KEY_PATTERN.test(key)) {
      issue(
        issues,
        `${pathName}.key`,
        '必须是环境变量名（大写字母开头，仅含 A-Z / 0-9 / _）',
      );
      continue;
    }
    if (seen.has(key)) {
      issue(issues, `${pathName}.key`, `密钥 ${key} 重复声明`);
      continue;
    }
    seen.add(key);
    if (
      item.description !== undefined &&
      (typeof item.description !== 'string' || item.description.length > 200)
    ) {
      issue(issues, `${pathName}.description`, '必须是不超过 200 字符的字符串');
    }
    if (item.required !== undefined && typeof item.required !== 'boolean') {
      issue(issues, `${pathName}.required`, '必须是布尔值');
    }
    result.push({
      key,
      ...(typeof item.description === 'string'
        ? { description: item.description }
        : {}),
      ...(typeof item.required === 'boolean'
        ? { required: item.required }
        : {}),
    });
  }
  return result;
}

function validatePermissions(
  value: unknown,
  issues: PluginValidationIssue[],
): PluginPermissions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issue(issues, 'permissions', '必须是对象');
    return undefined;
  }
  const permissions: PluginPermissions = {};
  if (value.network !== undefined) {
    permissions.network = validatePermissionNetwork(
      value.network,
      'permissions.network',
      issues,
    );
  }
  if (value.filesystem !== undefined && value.filesystem !== 'none') {
    issue(issues, 'permissions.filesystem', '第一期只接受 none');
  } else if (value.filesystem === 'none') {
    permissions.filesystem = 'none';
  }
  return permissions;
}

function validateMcpServer(
  value: unknown,
  index: number,
  context: PluginManifestContext,
  secretKeys: Set<string>,
  declaredNetwork: string[],
  issues: PluginValidationIssue[],
  warnings: PluginValidationIssue[],
): PluginMcpServerDecl | null {
  const pathName = `mcpServers[${index}]`;
  if (!isRecord(value)) {
    issue(issues, pathName, '必须是对象');
    return null;
  }
  const id = value.id;
  if (typeof id !== 'string' || !PLUGIN_SERVER_ID_PATTERN.test(id)) {
    issue(
      issues,
      `${pathName}.id`,
      '必须是 1-32 位小写字母开头的 kebab-case 标识',
    );
  }
  const name = value.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 80) {
    issue(issues, `${pathName}.name`, '必须是不超过 80 字符的非空字符串');
  }
  const domain = value.domain;
  if (typeof domain !== 'string' || !DOMAINS.has(domain)) {
    issue(issues, `${pathName}.domain`, `必须是 ${[...DOMAINS].join(' / ')}`);
  }
  const transport = value.transport;
  if (typeof transport !== 'string' || !TRANSPORTS.has(transport)) {
    issue(
      issues,
      `${pathName}.transport`,
      '必须是 stdio / sse / streamable-http',
    );
  }
  const endpoint = value.endpointOrCommand;
  if (
    typeof endpoint !== 'string' ||
    !endpoint.trim() ||
    endpoint.length > 2048
  ) {
    issue(
      issues,
      `${pathName}.endpointOrCommand`,
      '必须是不超过 2048 字符的非空字符串',
    );
  }

  const args =
    asStringArray(value.args, `${pathName}.args`, issues, 50, 512) ?? [];

  const envOrHeaders: Record<string, string> = {};
  if (value.envOrHeaders !== undefined) {
    if (!isRecord(value.envOrHeaders)) {
      issue(issues, `${pathName}.envOrHeaders`, '必须是字符串键值对象');
    } else {
      for (const [key, raw] of Object.entries(value.envOrHeaders)) {
        const headerPath = `${pathName}.envOrHeaders.${key}`;
        if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key)) {
          issue(issues, headerPath, '键名不合法');
          continue;
        }
        if (typeof raw !== 'string' || raw.length > 4096) {
          issue(issues, headerPath, '必须是不超过 4096 字符的字符串');
          continue;
        }
        const withoutPlaceholders = raw.replace(PLACEHOLDER_PATTERN, '');
        if (SHELL_META_PATTERN.test(withoutPlaceholders)) {
          issue(issues, headerPath, '不能包含 shell 元字符（仅支持 ${VAR} 占位符）');
          continue;
        }
        for (const variable of extractPlaceholders(raw)) {
          if (!secretKeys.has(variable)) {
            issue(
              issues,
              headerPath,
              `引用了未在 secrets 中声明的变量 \${${variable}}`,
            );
          }
        }
        envOrHeaders[key] = raw;
      }
    }
  }

  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== 'number' ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 1_000 ||
      value.timeoutMs > 600_000
    ) {
      issue(issues, `${pathName}.timeoutMs`, '必须是 1000-600000 的整数');
    } else {
      timeoutMs = value.timeoutMs;
    }
  }

  let maxResultChars: number | undefined;
  if (value.maxResultChars !== undefined) {
    if (
      typeof value.maxResultChars !== 'number' ||
      !Number.isInteger(value.maxResultChars) ||
      value.maxResultChars < 1_000 ||
      value.maxResultChars > 200_000
    ) {
      issue(
        issues,
        `${pathName}.maxResultChars`,
        '必须是 1000-200000 的整数',
      );
    } else {
      maxResultChars = value.maxResultChars;
    }
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    issue(issues, `${pathName}.enabled`, '必须是布尔值');
  }

  if (typeof endpoint === 'string' && endpoint.trim()) {
    if (transport === 'stdio') {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(endpoint) ||
        path.isAbsolute(endpoint)
      ) {
        issue(
          issues,
          `${pathName}.endpointOrCommand`,
          'stdio 命令必须是裸命令名，不接受路径',
        );
      } else if (!(context.allowedCommands ?? []).includes(endpoint)) {
        issue(
          issues,
          `${pathName}.endpointOrCommand`,
          `命令 ${endpoint} 不在白名单（PLUGIN_ALLOWED_COMMANDS）`,
        );
      }
      for (const [argIndex, arg] of args.entries()) {
        if (SHELL_META_PATTERN.test(arg)) {
          issue(
            issues,
            `${pathName}.args[${argIndex}]`,
            '参数不能包含 shell 元字符',
          );
        }
      }
      if (args.some((arg) => arg === 'latest' || arg.endsWith('@latest'))) {
        warn(
          warnings,
          `${pathName}.args`,
          '生产环境不建议使用 latest，请固定版本',
        );
      }
    } else {
      let url: URL | null = null;
      try {
        url = new URL(endpoint);
      } catch {
        issue(issues, `${pathName}.endpointOrCommand`, '必须是合法 URL');
      }
      if (url) {
        const localhost =
          url.hostname === 'localhost' ||
          url.hostname === '127.0.0.1' ||
          url.hostname === '[::1]' ||
          url.hostname === '::1';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
          issue(
            issues,
            `${pathName}.endpointOrCommand`,
            '远程 MCP 必须使用 https（本机地址可用 http）',
          );
        }
        if (url.username || url.password) {
          issue(
            issues,
            `${pathName}.endpointOrCommand`,
            'URL 中不能包含账号密码，请使用 secrets',
          );
        }
        if (declaredNetwork.length === 0) {
          warn(
            warnings,
            `${pathName}.endpointOrCommand`,
            '未在 permissions.network 声明域名白名单',
          );
        } else if (
          !declaredNetwork.some(
            (host) =>
              url.hostname === host || url.hostname.endsWith(`.${host}`),
          )
        ) {
          issue(
            issues,
            `${pathName}.endpointOrCommand`,
            `主机 ${url.hostname} 不在 permissions.network 白名单`,
          );
        }
      }
    }
  }

  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return {
    id,
    name,
    domain: (typeof domain === 'string' ? domain : 'general') as PluginMcpServerDecl['domain'],
    transport: (typeof transport === 'string'
      ? transport
      : 'stdio') as PluginMcpServerDecl['transport'],
    endpointOrCommand: typeof endpoint === 'string' ? endpoint : '',
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(envOrHeaders).length > 0 ? { envOrHeaders } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxResultChars !== undefined ? { maxResultChars } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

async function listSkillFiles(
  root: string,
  issues: PluginValidationIssue[],
): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;
    if (visited > MAX_PLUGIN_DIRS) {
      issue(issues, 'skills', `插件目录数量超过 ${MAX_PLUGIN_DIRS} 上限`);
      break;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  return found;
}

async function loadSkillDescriptors(
  pluginRoot: string,
  skills: string[],
  pluginId: string,
  reservedSkillNames: Set<string>,
  issues: PluginValidationIssue[],
): Promise<PluginSkillDescriptor[]> {
  const descriptors: PluginSkillDescriptor[] = [];
  const seenNames = new Map<string, string>();
  const declaredFiles = new Set<string>();

  let rootReal: string;
  try {
    rootReal = await realpath(pluginRoot);
  } catch {
    issue(issues, 'plugin.json', '插件目录不存在');
    return descriptors;
  }

  for (const relativeDir of skills) {
    const normalized = normalizeRelativePath(
      relativeDir,
      `skills.${relativeDir}`,
      issues,
    );
    if (!normalized) continue;
    const skillDir = path.resolve(rootReal, normalized);
    const relativeToRoot = path.relative(rootReal, skillDir);
    if (
      relativeToRoot.startsWith('..') ||
      path.isAbsolute(relativeToRoot)
    ) {
      issue(issues, `skills.${relativeDir}`, '技能目录位于插件目录之外');
      continue;
    }
    let realSkillDir: string;
    try {
      realSkillDir = await realpath(skillDir);
    } catch {
      issue(issues, `skills.${relativeDir}`, '技能目录不存在');
      continue;
    }
    const realRelative = path.relative(rootReal, realSkillDir);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      issue(issues, `skills.${relativeDir}`, '技能目录通过符号链接逃逸');
      continue;
    }
    const skillFile = path.join(realSkillDir, 'SKILL.md');
    let fileInfo;
    let raw: string;
    try {
      fileInfo = await stat(skillFile);
      if (!fileInfo.isFile()) throw new Error('not a file');
      if (fileInfo.size > 64 * 1024) {
        throw new Error('SKILL.md 超过 64KB 上限');
      }
      raw = await readFile(skillFile, 'utf8');
    } catch (error) {
      issue(
        issues,
        `skills.${relativeDir}`,
        error instanceof Error ? error.message : 'SKILL.md 不可读',
      );
      continue;
    }
    const fileRelative = path
      .relative(rootReal, skillFile)
      .split(path.sep)
      .join('/');
    declaredFiles.add(fileRelative);
    try {
      const parsed = parseSkillMarkdown(
        raw,
        path.basename(realSkillDir),
      );
      const name = parsed.frontmatter.name;
      if (seenNames.has(name)) {
        issue(
          issues,
          `skills.${relativeDir}`,
          `技能名 ${name} 与 ${seenNames.get(name)} 重复`,
        );
        continue;
      }
      if (reservedSkillNames.has(name)) {
        issue(
          issues,
          `skills.${relativeDir}`,
          `技能名 ${name} 与内置或本地技能冲突，请改名`,
        );
        continue;
      }
      seenNames.set(name, relativeDir);
      descriptors.push({
        id: `plugin:${pluginId}:${name}`,
        name,
        relativeDir: normalized,
        dir: realSkillDir,
        bodyHash: parsed.bodyHash,
        frontmatter: parsed.frontmatter,
      });
    } catch (error) {
      issue(
        issues,
        `skills.${relativeDir}`,
        error instanceof Error ? error.message : '技能 front matter 校验失败',
      );
    }
  }

  const allSkillFiles = await listSkillFiles(rootReal, issues);
  for (const file of allSkillFiles) {
    if (!declaredFiles.has(file)) {
      issue(issues, file, '技能未在 plugin.json 的 skills 中声明');
    }
  }
  return descriptors;
}

export function parsePluginManifest(
  raw: unknown,
  context: PluginManifestContext,
): {
  manifest: PluginManifest;
  warnings: PluginValidationIssue[];
  missingSecrets: string[];
} {
  const issues: PluginValidationIssue[] = [];
  const warnings: PluginValidationIssue[] = [];
  if (!isRecord(raw)) {
    throw new PluginManifestError('manifest', [
      { severity: 'error', path: 'plugin.json', message: '根节点必须是 JSON 对象' },
    ]);
  }

  if (raw.schemaVersion !== 1) {
    issue(issues, 'schemaVersion', '第一期只接受 1');
  }

  const id = raw.id;
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    issue(
      issues,
      'id',
      '必须匹配 ^[a-z0-9][a-z0-9.-]{1,63}$（小写字母、数字、点、连字符）',
    );
  } else if (id.includes('..')) {
    issue(issues, 'id', '不能包含连续的 ..');
  }

  const name = raw.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 80) {
    issue(issues, 'name', '必须是不超过 80 字符的非空字符串');
  }

  const version = raw.version;
  if (typeof version !== 'string' || !PLUGIN_VERSION_PATTERN.test(version)) {
    issue(issues, 'version', '必须是语义化版本，例如 1.2.0');
  }

  const description = raw.description;
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > 500
  ) {
    issue(issues, 'description', '必须是不超过 500 字符的非空字符串');
  }

  if (raw.publisher !== undefined) {
    if (typeof raw.publisher !== 'string' || raw.publisher.length > 80) {
      issue(issues, 'publisher', '必须是不超过 80 字符的字符串');
    }
  }
  if (raw.homepage !== undefined) {
    if (typeof raw.homepage !== 'string' || raw.homepage.length > 300) {
      issue(issues, 'homepage', '必须是不超过 300 字符的字符串');
    } else {
      try {
        const protocol = new URL(raw.homepage).protocol;
        if (protocol !== 'https:' && protocol !== 'http:') {
          issue(issues, 'homepage', '只支持 http/https URL');
        }
      } catch {
        issue(issues, 'homepage', '必须是合法 URL');
      }
    }
  }
  if (raw.license !== undefined) {
    if (typeof raw.license !== 'string' || raw.license.length > 40) {
      issue(issues, 'license', '必须是不超过 40 字符的字符串');
    }
  }

  const engines = raw.engines;
  if (!isRecord(engines) || typeof engines.agent !== 'string') {
    issue(issues, 'engines.agent', '必须声明 agent 版本范围');
  } else if (!isValidSemverRange(engines.agent)) {
    issue(issues, 'engines.agent', '不是合法的 semver 范围');
  } else if (!satisfiesSemverRange(context.agentVersion, engines.agent)) {
    issue(
      issues,
      'engines.agent',
      `要求 agent ${engines.agent}，当前版本 ${context.agentVersion}`,
    );
  }

  if (raw.trust !== 'declarative') {
    issue(issues, 'trust', '第一期只接受 declarative');
  }

  const skills =
    asStringArray(raw.skills, 'skills', issues, MAX_SKILLS, 256) ?? [];
  const secrets = validateSecrets(raw.secrets, issues);
  const secretKeys = new Set(secrets.map((item) => item.key));
  const permissions = validatePermissions(raw.permissions, issues);
  const declaredNetwork = permissions?.network ?? [];

  let mcpServers: PluginMcpServerDecl[] = [];
  if (raw.mcpServers !== undefined) {
    if (!Array.isArray(raw.mcpServers)) {
      issue(issues, 'mcpServers', '必须是数组');
    } else if (raw.mcpServers.length > MAX_MCP_SERVERS) {
      issue(issues, 'mcpServers', `最多允许 ${MAX_MCP_SERVERS} 项`);
    } else {
      const seen = new Set<string>();
      for (const [index, item] of raw.mcpServers.entries()) {
        const server = validateMcpServer(
          item,
          index,
          context,
          secretKeys,
          declaredNetwork,
          issues,
          warnings,
        );
        if (!server) continue;
        if (seen.has(server.id)) {
          issue(issues, `mcpServers[${index}].id`, `服务 ID ${server.id} 重复`);
          continue;
        }
        seen.add(server.id);
        mcpServers.push(server);
      }
    }
  }

  if (raw.config !== undefined && !isRecord(raw.config)) {
    issue(issues, 'config', '必须是 JSON 对象');
  }

  if (issues.length > 0) {
    const stage = issues.some(
      (item) =>
        item.path.startsWith('mcpServers') || item.path.startsWith('permissions'),
    )
      ? 'mcp'
      : issues.some((item) => item.path.startsWith('secrets'))
        ? 'secrets'
        : 'manifest';
    throw new PluginManifestError(stage, issues);
  }

  const env = context.env ?? {};
  const missingSecrets = secrets
    .filter((secret) => secret.required && !env[secret.key])
    .map((secret) => secret.key);
  if (missingSecrets.length > 0) {
    if (!context.allowMissingSecrets) {
      throw new PluginManifestError(
        'secrets',
        missingSecrets.map((key) => ({
          severity: 'error',
          path: `secrets.${key}`,
          message: `缺少必需的环境变量 ${key}；可先设置 .env 或使用 allowMissingSecrets 安装后配置`,
        })),
      );
    }
    warn(
      warnings,
      'secrets',
      `缺少必需的环境变量 ${missingSecrets.join(', ')}，插件将保持禁用`,
    );
  }

  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: id as string,
    name: name as string,
    version: version as string,
    description: description as string,
    ...(typeof raw.publisher === 'string' ? { publisher: raw.publisher } : {}),
    ...(typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {}),
    ...(typeof raw.license === 'string' ? { license: raw.license } : {}),
    engines: { agent: (engines as Record<string, string>).agent },
    trust: 'declarative',
    ...(skills.length > 0 ? { skills } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(permissions ? { permissions } : {}),
    ...(isRecord(raw.config) ? { config: raw.config } : {}),
  };
  return { manifest, warnings, missingSecrets };
}

function jsonErrorWithLine(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let position = -1;
  const positionMatch = /position (\d+)/u.exec(message);
  if (positionMatch) position = Number(positionMatch[1]);
  const lineMatch = /line (\d+) column (\d+)/u.exec(message);
  if (lineMatch) {
    return `JSON 解析失败（第 ${lineMatch[1]} 行第 ${lineMatch[2]} 列）：${message}`;
  }
  if (position >= 0) {
    const before = text.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    return `JSON 解析失败（第 ${line} 行第 ${column} 列）：${message}`;
  }
  return `JSON 解析失败：${message}`;
}

export async function loadPluginManifest(
  pluginDir: string,
  context: PluginManifestContext,
): Promise<ParsedPluginManifest> {
  const file = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('不是普通文件');
    if (info.size > 256 * 1024) throw new Error('plugin.json 超过 256KB 上限');
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new PluginManifestError('manifest', [
      {
        severity: 'error',
        path: PLUGIN_MANIFEST_FILE,
        message:
          error instanceof Error ? error.message : `${PLUGIN_MANIFEST_FILE} 不可读`,
      },
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PluginManifestError('manifest', [
      {
        severity: 'error',
        path: PLUGIN_MANIFEST_FILE,
        message: jsonErrorWithLine(text, error),
      },
    ]);
  }

  const parsed = parsePluginManifest(raw, context);
  const reserved = new Set(
    [...(context.reservedSkillNames ?? [])].map((name) => name.toLowerCase()),
  );
  const skillIssues: PluginValidationIssue[] = [];
  const skills = await loadSkillDescriptors(
    pluginDir,
    parsed.manifest.skills ?? [],
    parsed.manifest.id,
    reserved,
    skillIssues,
  );
  if (skillIssues.length > 0) {
    throw new PluginManifestError('skills', skillIssues);
  }
  return {
    manifest: parsed.manifest,
    skills,
    warnings: parsed.warnings,
    missingSecrets: parsed.missingSecrets,
  };
}
