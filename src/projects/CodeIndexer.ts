import { createHash } from 'node:crypto';
import type {
  ProjectDocumentKind,
  ProjectMapResult,
} from '../types/skills-plugins-projects.js';

export interface IndexedSymbol {
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
  parent: string;
  exported: boolean;
}

export interface IndexedChunk {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  kind: ProjectDocumentKind;
  content: string;
  contentHash: string;
  tokenCount: number;
}

export interface IndexFileInput {
  path: string;
  language: string;
  kind: ProjectDocumentKind;
  text: string;
  lineCount: number;
}

export interface MapFileInput {
  path: string;
  language: string;
  lineCount: number;
}

const MAX_CHUNK_CHARS = 8 * 1024;
const WINDOW_LINES = 60;
const WINDOW_OVERLAP = 10;

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function clampLine(value: number, max: number): number {
  return Math.min(Math.max(1, value), Math.max(1, max));
}

/** 从起始行开始做花括号配对，跳过字符串与注释（best-effort） */
function findBraceEnd(lines: string[], startIndex: number): number | undefined {
  let depth = 0;
  let seen = false;
  let inBlockComment = false;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    let quote: '"' | "'" | '`' | null = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index] ?? '';
      const next = line[index + 1] ?? '';
      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (char === '\\') {
          index += 1;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '/' && next === '/') break;
      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '{') {
        depth += 1;
        seen = true;
      } else if (char === '}') {
        depth -= 1;
        if (seen && depth <= 0) return lineIndex + 1;
      }
    }
  }
  return undefined;
}

/** 找签名末尾的 `{` 所在行，避免把参数里的对象字面量当成函数体 */
function findBodyStart(lines: string[], startIndex: number): number | undefined {
  for (
    let index = startIndex;
    index < Math.min(lines.length, startIndex + 12);
    index += 1
  ) {
    const line = lines[index] ?? '';
    const trimmed = line.trimEnd();
    if (trimmed.endsWith('{')) return index;
  }
  const first = lines[startIndex] ?? '';
  return first.includes('{') ? startIndex : undefined;
}

function lineEndOfBody(
  lines: string[],
  startIndex: number,
): number | undefined {
  const bodyStart = findBodyStart(lines, startIndex);
  if (bodyStart === undefined) return undefined;
  const end = findBraceEnd(lines, bodyStart);
  return end;
}

interface RawSymbol {
  name: string;
  kind: string;
  startIndex: number;
  endIndex?: number;
  signature: string;
  parent?: string;
  exported: boolean;
}

const TS_RESERVED = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'constructor',
  'get',
  'set',
  'new',
  'typeof',
]);

function extractTypescript(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const classes: RawSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue;
    }
    const exported = /^\s*export\b/u.test(line);
    let match = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u.exec(
      line,
    );
    if (match?.[1]) {
      const symbol: RawSymbol = {
        name: match[1],
        kind: 'class',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported,
      };
      symbols.push(symbol);
      classes.push(symbol);
      continue;
    }
    match = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'interface',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported,
      });
      continue;
    }
    match = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'type',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported,
      });
      continue;
    }
    match = /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'enum',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported,
      });
      continue;
    }
    match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u.exec(
      line,
    );
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'function',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported,
      });
      continue;
    }
    match = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/u.exec(
      line,
    );
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'function',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported,
      });
      continue;
    }
    match = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/u.exec(
      line,
    );
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'test',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported: false,
      });
    }
  }
  for (const parent of classes) {
    if (parent.endIndex === undefined) continue;
    for (let index = parent.startIndex + 1; index < parent.endIndex; index += 1) {
      const line = lines[index] ?? '';
      const match = /^\s+(?:(?:public|private|protected|static|override|async|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\s*\{/u.exec(
        line,
      );
      const name = match?.[1];
      if (!name || TS_RESERVED.has(name)) continue;
      symbols.push({
        name,
        kind: 'method',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: line.trim().slice(0, 200),
        parent: parent.name,
        exported: false,
      });
    }
  }
  return symbols;
}

function extractPython(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  let pendingDecorator: { index: number; indent: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*@/u.test(line)) {
      pendingDecorator = { index, indent };
      continue;
    }
    const match = /^(\s*)(def|class)\s+([A-Za-z_]\w*)/u.exec(line);
    if (!match) {
      if (!line.trimStart().startsWith(')') && !line.trimStart().startsWith(']')) {
        pendingDecorator = null;
      }
      continue;
    }
    const startIndex =
      pendingDecorator && pendingDecorator.indent === indent
        ? pendingDecorator.index
        : index;
    pendingDecorator = null;
    let endIndex = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? '';
      if (!candidate.trim() || candidate.trimStart().startsWith('#')) continue;
      const nextIndent = candidate.length - candidate.trimStart().length;
      if (nextIndent <= indent) {
        endIndex = next;
        break;
      }
    }
    symbols.push({
      name: match[3] ?? '',
      kind: match[2] === 'class' ? 'class' : indent > 0 ? 'method' : 'function',
      startIndex,
      endIndex,
      signature: line.trim().slice(0, 200),
      exported: !(match[3] ?? '').startsWith('_'),
    });
  }
  return symbols;
}

function extractGo(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    let match = /^func\s+(?:\([^)]*?(\w+)\)\s*)?([A-Za-z_]\w*)/u.exec(trimmed);
    if (match?.[2]) {
      const name = match[2];
      symbols.push({
        name,
        kind: match[1] ? 'method' : 'function',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        ...(match[1] ? { parent: match[1] } : {}),
        exported: /^[A-Z]/u.test(name),
      });
      continue;
    }
    match = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/u.exec(trimmed);
    if (match?.[1] && match[2]) {
      symbols.push({
        name: match[1],
        kind: match[2],
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported: /^[A-Z]/u.test(match[1]),
      });
    }
  }
  return symbols;
}

function extractJava(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const classes: RawSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    let match = /^(?:(?:public|private|protected|final|abstract|static|sealed|non-sealed)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/u.exec(
      trimmed,
    );
    if (match?.[1] && match[2]) {
      const symbol: RawSymbol = {
        name: match[2],
        kind: match[1],
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported: /public\b/u.test(trimmed),
      };
      symbols.push(symbol);
      classes.push(symbol);
      continue;
    }
  }

  for (const parent of classes) {
    if (parent.endIndex === undefined) continue;
    for (let index = parent.startIndex + 1; index < parent.endIndex; index += 1) {
      const line = lines[index] ?? '';
      const match = /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+(?:[\w<>\[\],.?]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws [\w, .]+)?\{/u.exec(
        line,
      );
      if (!match?.[1] || match[1] === parent.name) continue;
      symbols.push({
        name: match[1],
        kind: 'method',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: line.trim().slice(0, 200),
        parent: parent.name,
        exported: /public\b/u.test(line),
      });
    }
  }
  return symbols;
}

function extractRust(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const impls: RawSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    let match =
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/u.exec(
        trimmed,
      );
    if (match?.[1]) {
      symbols.push({
        name: match[1],
        kind: 'function',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported: /^pub\b/u.test(trimmed),
      });
      continue;
    }
    match =
      /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod)\s+([A-Za-z_]\w*)/u.exec(
        trimmed,
      );
    if (match?.[1] && match[2]) {
      symbols.push({
        name: match[2],
        kind: match[1],
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported: /^pub\b/u.test(trimmed),
      });
      continue;
    }
    match = /^impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/u.exec(trimmed);
    if (match?.[1]) {
      const symbol: RawSymbol = {
        name: match[1],
        kind: 'impl',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: trimmed.slice(0, 200),
        exported: false,
      };
      symbols.push(symbol);
      impls.push(symbol);
    }
  }
  for (const parent of impls) {
    if (parent.endIndex === undefined) continue;
    for (let index = parent.startIndex + 1; index < parent.endIndex; index += 1) {
      const line = lines[index] ?? '';
      const match =
        /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/u.exec(
          line,
        );
      if (!match?.[1]) continue;
      symbols.push({
        name: match[1],
        kind: 'method',
        startIndex: index,
        endIndex: lineEndOfBody(lines, index),
        signature: line.trim().slice(0, 200),
        parent: parent.name,
        exported: /pub\b/u.test(line),
      });
    }
  }
  return symbols;
}

function extractMarkdown(lines: string[]): RawSymbol[] {
  const headings: Array<{
    name: string;
    level: number;
    startIndex: number;
  }> = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match?.[1] && match[2]) {
      headings.push({
        name: match[2].trim(),
        level: match[1].length,
        startIndex: index,
      });
    }
  }
  return headings.map((heading, position) => {
    let endIndex = lines.length;
    for (let next = position + 1; next < headings.length; next += 1) {
      if ((headings[next]?.level ?? 0) <= heading.level) {
        endIndex = headings[next]?.startIndex ?? lines.length;
        break;
      }
    }
    return {
      name: heading.name,
      kind: 'heading',
      startIndex: heading.startIndex,
      endIndex,
      signature: (lines[heading.startIndex] ?? '').trim().slice(0, 200),
      exported: false,
    };
  });
}

function normalizeSymbols(
  path: string,
  raw: RawSymbol[],
  lineCount: number,
): IndexedSymbol[] {
  const sorted = raw
    .filter((symbol) => symbol.name.trim().length > 0)
    .sort(
      (left, right) =>
        left.startIndex - right.startIndex ||
        (right.endIndex ?? right.startIndex) -
          (left.endIndex ?? left.startIndex) ||
        left.name.localeCompare(right.name),
    );
  const seen = new Set<string>();
  const symbols: IndexedSymbol[] = [];
  for (const symbol of sorted) {
    const startLine = clampLine(symbol.startIndex + 1, lineCount);
    let endLine = clampLine(
      (symbol.endIndex ?? symbol.startIndex + 1),
      lineCount,
    );
    if (endLine < startLine) endLine = startLine;
    const key = `${symbol.name}:${startLine}:${symbol.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push({
      path,
      name: symbol.name,
      kind: symbol.kind,
      startLine,
      endLine,
      signature: symbol.signature,
      parent: symbol.parent ?? '',
      exported: symbol.exported,
    });
  }
  return symbols;
}

export function extractSymbols(
  path: string,
  language: string,
  text: string,
): IndexedSymbol[] {
  const lines = text.split('\n');
  let raw: RawSymbol[] = [];
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      raw = extractTypescript(lines);
      break;
    case 'python':
      raw = extractPython(lines);
      break;
    case 'go':
      raw = extractGo(lines);
      break;
    case 'java':
    case 'kotlin':
      raw = extractJava(lines);
      break;
    case 'rust':
      raw = extractRust(lines);
      break;
    case 'markdown':
      raw = extractMarkdown(lines);
      break;
    default:
      return [];
  }
  return normalizeSymbols(path, raw, lines.length);
}

function sliceChunk(
  lines: string[],
  startLine: number,
  endLine: number,
): { content: string; endLine: number } {
  const boundedStart = clampLine(startLine, lines.length);
  let boundedEnd = clampLine(endLine, lines.length);
  let content = lines.slice(boundedStart - 1, boundedEnd).join('\n');
  while (content.length > MAX_CHUNK_CHARS && boundedEnd > boundedStart) {
    boundedEnd -= 1;
    content = lines.slice(boundedStart - 1, boundedEnd).join('\n');
  }
  if (content.length > MAX_CHUNK_CHARS) {
    content = content.slice(0, MAX_CHUNK_CHARS);
  }
  return { content, endLine: boundedEnd };
}

function pushChunk(
  chunks: IndexedChunk[],
  input: IndexFileInput,
  lines: string[],
  startLine: number,
  endLine: number,
  symbol: string,
): void {
  const { content, endLine: actualEnd } = sliceChunk(lines, startLine, endLine);
  if (!content.trim()) return;
  chunks.push({
    path: input.path,
    startLine: clampLine(startLine, lines.length),
    endLine: actualEnd,
    symbol,
    kind: input.kind,
    content,
    contentHash: hashText(content),
    tokenCount: Math.ceil(content.length / 4),
  });
}

function pushWindowChunks(
  chunks: IndexedChunk[],
  input: IndexFileInput,
  lines: string[],
  fromLine: number,
  toLine: number,
  symbol: string,
): void {
  let start = fromLine;
  while (start <= toLine) {
    const end = Math.min(toLine, start + WINDOW_LINES - 1);
    pushChunk(chunks, input, lines, start, end, symbol);
    if (end >= toLine) break;
    start = Math.max(start + 1, end - WINDOW_OVERLAP + 1);
  }
}

export function buildChunks(
  input: IndexFileInput,
  symbols: IndexedSymbol[],
): IndexedChunk[] {
  const lines = input.text.split('\n');
  if (input.text.trim().length === 0) return [];
  const lineCount = Math.max(1, lines.length);
  const candidates = symbols
    .filter((symbol) => !symbol.parent)
    .sort(
      (left, right) =>
        left.startLine - right.startLine ||
        right.endLine - left.endLine,
    );
  const chunks: IndexedChunk[] = [];
  let cursor = 1;
  for (const symbol of candidates) {
    const start = Math.max(1, symbol.startLine);
    const end = Math.min(lineCount, symbol.endLine);
    if (end < cursor) continue;
    if (start > cursor) {
      pushWindowChunks(chunks, input, lines, cursor, start - 1, '');
    }
    const span = end - start + 1;
    if (span > WINDOW_LINES) {
      pushWindowChunks(chunks, input, lines, start, end, symbol.name);
    } else {
      pushChunk(chunks, input, lines, start, end, symbol.name);
    }
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= lineCount) {
    pushWindowChunks(chunks, input, lines, cursor, lineCount, '');
  }
  return chunks;
}

const KIND_WEIGHT: Record<string, number> = {
  class: 6,
  interface: 5,
  function: 5,
  struct: 4,
  trait: 4,
  enum: 4,
  type: 3,
  impl: 3,
  method: 2,
  test: 1,
  heading: 2,
};

function pickSymbols(
  symbols: IndexedSymbol[],
  limit = 4,
): IndexedSymbol[] {
  return symbols
    .slice()
    .sort(
      (left, right) =>
        Number(right.exported) - Number(left.exported) ||
        (KIND_WEIGHT[right.kind] ?? 0) - (KIND_WEIGHT[left.kind] ?? 0) ||
        left.startLine - right.startLine,
    )
    .slice(0, limit);
}

export interface RepoMapInput {
  projectId: string;
  commit: string;
  files: MapFileInput[];
  symbols: IndexedSymbol[];
  maxTokens: number;
  pathPrefix?: string;
}

export function buildRepoMap(input: RepoMapInput): ProjectMapResult {
  const maxChars = Math.max(500, input.maxTokens) * 4;
  const prefix = input.pathPrefix?.replace(/^\/+|\/+$/gu, '');
  const files = input.files
    .filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`))
    .sort((left, right) => left.path.localeCompare(right.path));
  const symbolsByPath = new Map<string, IndexedSymbol[]>();
  for (const symbol of input.symbols) {
    const list = symbolsByPath.get(symbol.path) ?? [];
    list.push(symbol);
    symbolsByPath.set(symbol.path, list);
  }
  const groups = new Map<string, MapFileInput[]>();
  for (const file of files) {
    const dir = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '.';
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }
  const modules: ProjectMapResult['modules'] = [];
  const lines: string[] = [`${input.projectId} @ ${input.commit.slice(0, 12)}`];
  let truncated = false;
  const charCount = (): number => lines.reduce((sum, line) => sum + line.length + 1, 0);
  const emit = (line: string): boolean => {
    if (charCount() + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };
  for (const dir of Array.from(groups.keys()).sort()) {
    if (truncated) break;
    const groupFiles = groups.get(dir) ?? [];
    if (!emit(`${dir}/ (${groupFiles.length} files)`)) break;
    for (const file of groupFiles) {
      const chosen = pickSymbols(symbolsByPath.get(file.path) ?? []);
      const symbols = chosen.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        exported: symbol.exported,
      }));
      const renderedSymbols = symbols
        .map((symbol) => `${symbol.name}:${symbol.startLine} (${symbol.kind})`)
        .join(', ');
      const line = renderedSymbols
        ? `  ${file.path.split('/').pop()}: ${renderedSymbols}`
        : `  ${file.path.split('/').pop()}`;
      if (!emit(line)) break;
    }
    modules.push({
      path: dir,
      language:
        groupFiles.find((file) => file.language !== 'other')?.language ?? 'other',
      symbols: groupFiles.flatMap((file) =>
        pickSymbols(symbolsByPath.get(file.path) ?? []).map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          exported: symbol.exported,
        })),
      ),
    });
  }
  return {
    projectId: input.projectId,
    commit: input.commit,
    modules,
    totalFiles: files.length,
    truncated,
    text: `${lines.join('\n')}${truncated ? '\n…（仓库地图已截断）' : ''}`,
  };
}

export function renderRepoMap(result: ProjectMapResult): string {
  return result.text;
}
