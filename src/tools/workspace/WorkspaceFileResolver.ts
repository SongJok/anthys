import { open, realpath, stat } from 'node:fs/promises';
import { decodeTextBuffer } from '../../documents/DocumentExtractor.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ResolvedWorkspaceFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * 把模型给出的路径（相对工作区或工作区内绝对路径）解析为真实文件。
 * 通过 realpath 复核，防止符号链接跳出工作区。
 */
export async function resolveWorkspaceFile(
  input: string,
  hostDir: string,
): Promise<ResolvedWorkspaceFile> {
  const text = input.trim();
  if (!text) throw new WorkspaceFileError('文件路径不能为空');
  if (text.includes('\u0000')) throw new WorkspaceFileError('文件路径不合法');
  const rootResolved = await realpath(hostDir).catch(() => resolve(hostDir));
  const rootLexical = resolve(hostDir);
  const candidate = isAbsolute(text) ? resolve(text) : resolve(rootResolved, text);
  if (!isInside(rootResolved, candidate) && !isInside(rootLexical, candidate)) {
    throw new WorkspaceFileError('只能读取工作区内的文件');
  }
  const actual = await realpath(candidate).catch(() => {
    throw new WorkspaceFileError(`文件不存在: ${text}`);
  });
  if (!isInside(rootResolved, actual)) {
    throw new WorkspaceFileError('只能读取工作区内的文件');
  }
  const info = await stat(actual).catch(() => undefined);
  if (!info || !info.isFile()) {
    throw new WorkspaceFileError(`文件不存在或不是普通文件: ${text}`);
  }
  return {
    absolutePath: actual,
    relativePath: relative(rootResolved, actual).split(sep).join('/'),
    size: info.size,
  };
}

export function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 8_192);
  if (head.includes(0)) return true;
  let control = 0;
  for (const byte of head) {
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return head.length > 0 && control / head.length > 0.1;
}

export interface WorkspaceTextFile extends ResolvedWorkspaceFile {
  content: string;
  truncated: boolean;
  bytesRead: number;
}

/** 读取文本文件；超过上限时按字节截断并标记 truncated */
export async function readWorkspaceText(
  file: ResolvedWorkspaceFile,
  maxBytes: number,
): Promise<WorkspaceTextFile> {
  const limit = Math.min(file.size, Math.max(1, maxBytes));
  const handle = await open(file.absolutePath, 'r');
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (looksBinary(buffer)) {
    throw new WorkspaceFileError('该文件是二进制内容，无法按文本读取');
  }
  return {
    ...file,
    content: decodeTextBuffer(buffer).text,
    truncated: file.size > buffer.length,
    bytesRead: buffer.length,
  };
}
