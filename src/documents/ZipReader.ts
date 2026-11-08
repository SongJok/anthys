import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  /** 最多允许的条目数，防止恶意压缩包 */
  maxEntries: number;
  /** 单个条目解压后的字节上限（防 zip bomb） */
  maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 64 * 1024 * 1024,
};

/**
 * 纯 Node 的最小 ZIP 读取器（仅支持 stored / deflate），
 * 足以读取 OOXML（pptx / docx / xlsx）容器，无需任何第三方依赖。
 */
export class ZipReader {
  private readonly entries = new Map<string, ZipEntry>();

  constructor(
    private readonly buffer: Buffer,
    private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  ) {
    this.parseCentralDirectory();
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  readText(name: string): string | undefined {
    const data = this.read(name);
    return data ? data.toString('utf8').replace(/^\uFEFF/, '') : undefined;
  }

  read(name: string): Buffer | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const buf = this.buffer;
    const off = entry.localOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) {
      throw new ZipError(`损坏的本地文件头: ${name}`);
    }
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (entry.uncompressedSize > this.limits.maxEntryBytes) {
      throw new ZipError(`条目过大: ${name}`);
    }
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) {
      try {
        return inflateRawSync(raw, {
          maxOutputLength: this.limits.maxEntryBytes,
        });
      } catch (error) {
        throw new ZipError(`解压失败 ${name}: ${(error as Error).message}`);
      }
    }
    throw new ZipError(`不支持的压缩方式 ${entry.method}: ${name}`);
  }

  private parseCentralDirectory(): void {
    const buf = this.buffer;
    if (buf.length < 22) throw new ZipError('不是有效的 ZIP/OOXML 文件');
    let eocd = -1;
    const lowest = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= lowest; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('不是有效的 ZIP/OOXML 文件（找不到目录）');
    const total = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    if (total > this.limits.maxEntries) throw new ZipError('压缩包条目过多');
    for (let i = 0; i < total; i += 1) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
        throw new ZipError('损坏的 ZIP 中央目录');
      }
      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const uncompressedSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localOffset = buf.readUInt32LE(pos + 42);
      const name = buf
        .subarray(pos + 46, pos + 46 + nameLen)
        .toString(flags & 0x800 ? 'utf8' : 'utf8');
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new ZipError('暂不支持 ZIP64 大文件');
      }
      if (flags & 0x1) throw new ZipError('文件已加密，无法解析（请先去除密码保护）');
      this.entries.set(name, {
        name,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
  }
}
