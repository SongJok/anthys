import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { PLUGIN_MANIFEST_FILE } from './PluginManifest.js';

export const MAX_PLUGIN_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 500;
export const MAX_PLUGIN_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const BLOCKED_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
]);
const BLOCKED_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.tgz',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.war',
  '.whl',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.wasm',
  '.bin',
  '.msi',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.bash',
  '.zsh',
]);

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

interface CentralEntry {
  name: string;
  directory: boolean;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  mode: number;
  hostSystem: number;
}

export interface PluginDirectoryStats {
  files: number;
  totalBytes: number;
}

function fail(message: string): never {
  throw new PluginPackageError(message);
}

function normalizeArchivePath(raw: string): string {
  if (raw.includes('\0')) fail('压缩包包含空字符路径');
  let name = raw.replace(/\\/gu, '/');
  while (name.startsWith('./')) name = name.slice(2);
  const directory = name.endsWith('/');
  if (directory) name = name.slice(0, -1);
  if (!name) fail('压缩包包含空路径');
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) {
    fail(`压缩包包含绝对路径：${raw}`);
  }
  const segments = name.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      fail(`压缩包包含非法路径：${raw}`);
    }
  }
  return `${segments.join('/')}${directory ? '/' : ''}`;
}

function assertAllowedPath(name: string): void {
  const segments = name.replace(/\/$/u, '').split('/');
  for (const segment of segments) {
    if (segment === '.git' || segment === 'node_modules') {
      fail(`插件包禁止包含 ${segment}`);
    }
  }
  const base = path.posix.basename(name.replace(/\/$/u, '')).toLowerCase();
  if (BLOCKED_BASENAMES.has(base)) {
    fail(`插件包禁止包含 ${base}，插件必须是纯声明式内容`);
  }
  const extension = path.posix.extname(base);
  if (BLOCKED_EXTENSIONS.has(extension)) {
    fail(`插件包禁止包含可执行文件或嵌套压缩包：${name}`);
  }
}

function parseCentralDirectory(buffer: Buffer): CentralEntry[] {
  if (buffer.length < 22) fail('不是有效的 zip 文件');
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('找不到 zip 中央目录');
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0) fail('不支持分卷 zip');
  if (
    entryCount === 0xffff ||
    centralSize === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL
  ) {
    fail('不支持 zip64');
  }
  if (entryCount > MAX_PLUGIN_FILES) {
    fail(`插件包文件数超过 ${MAX_PLUGIN_FILES} 上限`);
  }
  if (centralOffset + centralSize > eocd) fail('zip 中央目录越界');

  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  const end = centralOffset + centralSize;
  const seen = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      fail('zip 中央目录结构损坏');
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next =
      offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) fail('zip 中央目录条目越界');
    const rawName = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    const name = normalizeArchivePath(rawName);
    const directory = name.endsWith('/');
    if (flags & 0x0001 || flags & 0x0040) fail('不支持加密 zip');
    if (method !== 0 && method !== 8) {
      fail(`不支持的压缩算法 ${method}（仅支持 store / deflate）`);
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      fail('不支持 zip64');
    }
    if (directory) {
      if (compressedSize !== 0 || uncompressedSize !== 0) {
        fail(`目录条目不应包含数据：${name}`);
      }
    } else {
      assertAllowedPath(name);
      if (uncompressedSize > MAX_PLUGIN_FILE_BYTES) {
        fail(`文件 ${name} 超过 ${MAX_PLUGIN_FILE_BYTES} 字节上限`);
      }
      totalBytes += uncompressedSize;
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        fail(`解压后总大小超过 ${MAX_PLUGIN_TOTAL_BYTES} 字节上限`);
      }
    }
    const hostSystem = versionMadeBy >> 8;
    const mode = hostSystem === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if (hostSystem === 3) {
      const fileType = mode & 0o170000;
      if (fileType === 0o120000) fail(`插件包禁止包含符号链接：${name}`);
      if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
        fail(`插件包包含不支持的文件类型：${name}`);
      }
      if (!directory && (mode & 0o111) !== 0) {
        fail(`插件包禁止包含可执行文件：${name}`);
      }
    }
    const key = name.toLowerCase();
    if (seen.has(key)) fail(`插件包包含重复路径：${name}`);
    seen.add(key);
    if (!directory) {
      if (localOffset + 30 > buffer.length) fail(`zip 本地头越界：${name}`);
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        fail(`zip 本地头损坏：${name}`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > buffer.length) {
        fail(`zip 文件数据越界：${name}`);
      }
      if (
        buffer
          .subarray(localOffset + 30, localOffset + 30 + localNameLength)
          .toString('utf8') !== rawName
      ) {
        fail(`zip 本地头文件名不一致：${name}`);
      }
    }
    entries.push({
      name,
      directory,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset,
      mode,
      hostSystem,
    });
    offset = next;
  }
  return entries;
}

function entryData(buffer: Buffer, entry: CentralEntry): Buffer {
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) {
      fail(`zip 文件大小不一致：${entry.name}`);
    }
    return compressed;
  }
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(compressed, {
      maxOutputLength: MAX_PLUGIN_FILE_BYTES,
    });
  } catch {
    fail(`zip 解压失败：${entry.name}`);
  }
  if (inflated.length !== entry.uncompressedSize) {
    fail(`zip 文件解压后大小不一致：${entry.name}`);
  }
  return inflated;
}

async function ensureEmptyDestination(destDir: string): Promise<void> {
  try {
    const info = await stat(destDir);
    if (!info.isDirectory()) fail('解压目标不是目录');
    const entries = await readdir(destDir);
    if (entries.length > 0) fail('解压目标目录必须为空');
  } catch (error) {
    if (
      error instanceof PluginPackageError ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    await mkdir(destDir, { recursive: true });
  }
}

/** 安全解压：拒绝路径逃逸、符号链接、加密、zip64、可执行文件和嵌套压缩包 */
export async function extractPluginZip(
  zipPath: string,
  destDir: string,
): Promise<PluginDirectoryStats> {
  const archiveInfo = await stat(zipPath);
  if (!archiveInfo.isFile()) fail('插件包不是文件');
  if (archiveInfo.size > MAX_PLUGIN_ARCHIVE_BYTES) {
    fail(`插件包超过 ${MAX_PLUGIN_ARCHIVE_BYTES} 字节上限`);
  }
  const buffer = await readFile(zipPath);
  const entries = parseCentralDirectory(buffer);
  await ensureEmptyDestination(destDir);
  const createdRoot = path.resolve(destDir);
  let files = 0;
  let totalBytes = 0;
  try {
    for (const entry of entries) {
      const target = path.resolve(
        createdRoot,
        entry.name.replace(/\/$/u, ''),
      );
      const relative = path.relative(createdRoot, target);
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        relative.length === 0
      ) {
        fail(`插件包路径逃逸：${entry.name}`);
      }
      if (entry.directory) {
        await mkdir(target, { recursive: true, mode: 0o755 });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      const data = entryData(buffer, entry);
      await writeFile(target, data, { mode: 0o644, flag: 'wx' });
      files += 1;
      totalBytes += data.length;
    }
  } catch (error) {
    await rm(createdRoot, { recursive: true, force: true });
    throw error;
  }
  return { files, totalBytes };
}

/** 校验目录形式的插件包（直接上传目录或解压后的目录） */
export async function inspectPluginDir(
  dir: string,
): Promise<PluginDirectoryStats & { root: string }> {
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    fail('插件目录不存在');
  }
  const info = await stat(root);
  if (!info.isDirectory()) fail('插件路径不是目录');

  const stack = [root];
  let files = 0;
  let totalBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const full = path.join(current, entry.name);
      const entryInfo = await lstat(full);
      if (entryInfo.isSymbolicLink()) {
        fail(`插件目录禁止包含符号链接：${path.relative(root, full)}`);
      }
      if (entryInfo.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
          fail(`插件目录禁止包含 ${entry.name}`);
        }
        stack.push(full);
        continue;
      }
      if (!entryInfo.isFile()) {
        fail(`插件目录包含不支持的文件类型：${path.relative(root, full)}`);
      }
      const relative = path.relative(root, full).split(path.sep).join('/');
      assertAllowedPath(relative);
      if (entryInfo.size > MAX_PLUGIN_FILE_BYTES) {
        fail(`文件 ${relative} 超过 ${MAX_PLUGIN_FILE_BYTES} 字节上限`);
      }
      if ((entryInfo.mode & 0o111) !== 0) {
        fail(`插件目录禁止包含可执行文件：${relative}`);
      }
      files += 1;
      totalBytes += entryInfo.size;
      if (files > MAX_PLUGIN_FILES) {
        fail(`插件文件数超过 ${MAX_PLUGIN_FILES} 上限`);
      }
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        fail(`插件总大小超过 ${MAX_PLUGIN_TOTAL_BYTES} 字节上限`);
      }
    }
  }
  if (files === 0) fail('插件目录为空');
  try {
    const manifestInfo = await stat(path.join(root, PLUGIN_MANIFEST_FILE));
    if (!manifestInfo.isFile()) fail(`${PLUGIN_MANIFEST_FILE} 不是文件`);
  } catch (error) {
    if (error instanceof PluginPackageError) throw error;
    fail(`插件根目录缺少 ${PLUGIN_MANIFEST_FILE}`);
  }
  return { root, files, totalBytes };
}

/** zip 内可能只有一层包装目录，允许自动下钻一次 */
export async function locatePluginRoot(dir: string): Promise<string> {
  const root = await realpath(dir);
  try {
    const info = await stat(path.join(root, PLUGIN_MANIFEST_FILE));
    if (info.isFile()) return root;
  } catch {
    // 继续尝试单层包装目录
  }
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.name !== '.DS_Store' && !entry.name.startsWith('__MACOSX'),
  );
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(root, entries[0].name);
    try {
      const info = await stat(path.join(nested, PLUGIN_MANIFEST_FILE));
      if (info.isFile()) return nested;
    } catch {
      // fallthrough
    }
  }
  fail(`插件根目录缺少 ${PLUGIN_MANIFEST_FILE}`);
}

async function listPluginFiles(dir: string): Promise<string[]> {
  const root = await realpath(dir);
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const full = path.join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (info.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  return files.sort();
}

/** 目录内容校验和，用于展示与审计；路径和内容同时参与哈希 */
export async function checksumPluginDir(dir: string): Promise<string> {
  const root = await realpath(dir);
  const hash = createHash('sha256');
  for (const relative of await listPluginFiles(root)) {
    const content = await readFile(path.join(root, relative));
    hash.update(relative);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
