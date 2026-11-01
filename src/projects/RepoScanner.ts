import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectDocumentKind } from '../types/skills-plugins-projects.js';

export interface ScannedFile {
  /** 仓库相对路径，统一使用 / */
  path: string;
  language: string;
  kind: ProjectDocumentKind;
  text: string;
  sizeBytes: number;
  lineCount: number;
}

export interface RepoScanOptions {
  /** 管理员自定义忽略 glob，匹配仓库相对路径或文件名 */
  ignoreGlobs?: string[];
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export interface RepoScanResult {
  files: ScannedFile[];
  skipped: number;
  skippedReasons: Record<string, number>;
  totalBytes: number;
  truncated: boolean;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const IGNORE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.state',
  '.workspace',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.xml': 'xml',
  '.ini': 'ini',
  '.conf': 'config',
  '.cfg': 'config',
  '.txt': 'text',
  '.csv': 'csv',
};

const CODE_LANGUAGES = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'java',
  'rust',
  'sql',
  'shell',
  'html',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'ruby',
  'php',
  'c',
  'cpp',
  'csharp',
  'kotlin',
  'swift',
  'protobuf',
  'graphql',
]);

const SPECIAL_FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  readme: 'markdown',
  license: 'text',
  changelog: 'markdown',
  contributing: 'markdown',
};

function normalizePath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += escapeRegExp(char);
  }
  return new RegExp(`^${pattern}$`, 'u');
}

export function matchesGlob(relativePath: string, glob: string): boolean {
  const regex = globToRegExp(glob);
  if (regex.test(relativePath)) return true;
  if (!glob.includes('/')) {
    return regex.test(relativePath.split('/').pop() ?? '');
  }
  return false;
}

export function isSensitiveFile(fileName: string): boolean {
  const name = fileName.toLowerCase();
  const envTemplate = /^\.env\.(?:example|sample|template)$/u.test(name);
  return (
    (!envTemplate && /^\.env(?:$|\.)/u.test(name)) ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/u.test(name) ||
    /^id_(?:rsa|ed25519)(?:$|\.)/u.test(name) ||
    /^credentials(?:$|\.)/u.test(name) ||
    name === '.npmrc' ||
    name === '.pypirc'
  );
}

export function detectLanguage(
  filePath: string,
  sample?: Buffer | string,
): string {
  const base = path.basename(filePath).toLowerCase();
  const extension = path.extname(base);
  if (extension && LANGUAGE_BY_EXT[extension]) {
    return LANGUAGE_BY_EXT[extension];
  }
  if (SPECIAL_FILENAMES[base]) return SPECIAL_FILENAMES[base];
  if (base.startsWith('readme')) return 'markdown';
  if (base.startsWith('license')) return 'text';
  const head = typeof sample === 'string' ? sample : sample?.subarray(0, 160).toString('utf8');
  const shebang = head?.split('\n')[0]?.toLowerCase() ?? '';
  if (shebang.startsWith('#!')) {
    if (shebang.includes('node')) return 'javascript';
    if (shebang.includes('python')) return 'python';
    if (shebang.includes('bash') || shebang.includes('/sh')) return 'shell';
    if (shebang.includes('ruby')) return 'ruby';
  }
  return 'other';
}

function detectKind(relativePath: string, language: string): ProjectDocumentKind {
  const lower = relativePath.toLowerCase();
  const segments = lower.split('/');
  const base = segments[segments.length - 1] ?? '';
  const isTest =
    segments.some((segment) =>
      ['test', 'tests', '__tests__', 'spec', 'specs'].includes(segment),
    ) ||
    /\.(?:test|spec)\.[a-z0-9]+$/u.test(base) ||
    /_test\.(?:go|py|rb)$/u.test(base) ||
    /(?:^test_.*\.py$|Test\.(?:java|kt)$)/u.test(base);
  if (isTest) return 'test';
  if (
    language === 'markdown' ||
    language === 'text' ||
    /^(?:readme|license|changelog|contributing|agents|claude)/u.test(base) ||
    segments.includes('docs') ||
    segments.includes('doc')
  ) {
    return 'doc';
  }
  if (
    ['json', 'yaml', 'toml', 'ini', 'config', 'dockerfile', 'makefile'].includes(
      language,
    ) ||
    /(?:^package\.json$|^tsconfig.*\.json$|\.config\.[a-z]+$|^docker-compose\.ya?ml$)/u.test(
      base,
    ) ||
    segments.includes('deploy') ||
    segments.includes('.github') ||
    segments.includes('.gitlab') ||
    base === '.gitlab-ci.yml'
  ) {
    return 'config';
  }
  return CODE_LANGUAGES.has(language) ? 'code' : 'other';
}

function lineCountOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function addSkip(
  reasons: Record<string, number>,
  reason: string,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

export async function scanRepository(
  root: string,
  options: RepoScanOptions = {},
): Promise<RepoScanResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const ignoreGlobs = options.ignoreGlobs ?? [];
  const files: ScannedFile[] = [];
  const skippedReasons: Record<string, number> = {};
  let skipped = 0;
  let totalBytes = 0;
  let truncated = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const walk = async (absoluteDir: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      skipped += 1;
      addSkip(skippedReasons, 'unreadable');
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      const absolute = path.join(absoluteDir, entry.name);
      const relative = normalizePath(root, absolute);
      if (entry.isSymbolicLink()) {
        skipped += 1;
        addSkip(skippedReasons, 'symlink');
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          skipped += 1;
          addSkip(skippedReasons, 'ignored-dir');
          continue;
        }
        if (ignoreGlobs.some((glob) => matchesGlob(relative, glob))) {
          skipped += 1;
          addSkip(skippedReasons, 'ignored');
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        addSkip(skippedReasons, 'not-file');
        continue;
      }
      if (isSensitiveFile(entry.name)) {
        skipped += 1;
        addSkip(skippedReasons, 'sensitive');
        continue;
      }
      if (ignoreGlobs.some((glob) => matchesGlob(relative, glob))) {
        skipped += 1;
        addSkip(skippedReasons, 'ignored');
        continue;
      }
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
        truncated = true;
        addSkip(skippedReasons, 'limit');
        return;
      }
      let sizeBytes = 0;
      try {
        const info = await stat(absolute);
        sizeBytes = info.size;
      } catch {
        skipped += 1;
        addSkip(skippedReasons, 'unreadable');
        continue;
      }
      if (sizeBytes > maxFileBytes) {
        skipped += 1;
        addSkip(skippedReasons, 'too-large');
        continue;
      }
      if (totalBytes + sizeBytes > maxTotalBytes) {
        truncated = true;
        addSkip(skippedReasons, 'limit');
        return;
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(absolute);
      } catch {
        skipped += 1;
        addSkip(skippedReasons, 'unreadable');
        continue;
      }
      if (buffer.subarray(0, 8192).includes(0)) {
        skipped += 1;
        addSkip(skippedReasons, 'binary');
        continue;
      }
      let text: string;
      try {
        text = decoder.decode(buffer);
      } catch {
        skipped += 1;
        addSkip(skippedReasons, 'non-utf8');
        continue;
      }
      const language = detectLanguage(relative, buffer);
      const kind = detectKind(relative, language);
      files.push({
        path: relative,
        language,
        kind,
        text,
        sizeBytes,
        lineCount: lineCountOf(text),
      });
      totalBytes += sizeBytes;
    }
  };

  await walk(root);
  return { files, skipped, skippedReasons, totalBytes, truncated };
}
