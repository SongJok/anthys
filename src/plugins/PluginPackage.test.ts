import { deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checksumPluginDir,
  extractPluginZip,
  inspectPluginDir,
  locatePluginRoot,
  PluginPackageError,
} from './PluginPackage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-package-'));
  roots.push(dir);
  return dir;
}

interface ZipEntryInput {
  name: string;
  data?: Buffer | string;
  mode?: number;
  method?: number;
  flags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
}

function buildZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const isDirectory = entry.name.endsWith('/');
    const method = isDirectory ? 0 : (entry.method ?? 8);
    const compressed = method === 0 ? data : deflateRawSync(data);
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const flags = entry.flags ?? 0;
    const mode = entry.mode ?? (isDirectory ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, name, compressed]);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(compressedSize, 20);
    header.writeUInt32LE(uncompressedSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

async function writeZip(entries: ZipEntryInput[]): Promise<string> {
  const dir = await tempDir();
  const file = path.join(dir, 'plugin.zip');
  await writeFile(file, buildZip(entries));
  return file;
}

async function extractError(entries: ZipEntryInput[]): Promise<unknown> {
  const zip = await writeZip(entries);
  const dest = await tempDir();
  return extractPluginZip(zip, dest);
}

describe('extractPluginZip', () => {
  it('解压合法插件包并保留目录', async () => {
    const zip = await writeZip([
      { name: 'plugin.json', data: '{"schemaVersion":1}' },
      { name: 'skills/' },
      { name: 'skills/demo/', method: 0 },
      { name: 'skills/demo/SKILL.md', data: '# demo' },
    ]);
    const dest = await tempDir();
    const stats = await extractPluginZip(zip, dest);
    expect(stats.files).toBe(2);
    expect(await readFile(path.join(dest, 'skills/demo/SKILL.md'), 'utf8')).toBe(
      '# demo',
    );
  });

  it('拒绝路径逃逸和绝对路径', async () => {
    await expect(extractError([{ name: '../evil.txt', data: 'x' }])).rejects.toThrow(
      PluginPackageError,
    );
    await expect(
      extractError([{ name: '/etc/passwd', data: 'x' }]),
    ).rejects.toThrow(PluginPackageError);
    await expect(
      extractError([{ name: 'C:\\evil.txt', data: 'x' }]),
    ).rejects.toThrow(PluginPackageError);
  });

  it('拒绝符号链接、可执行文件和加密包', async () => {
    await expect(
      extractError([{ name: 'link', data: 'x', mode: 0o120777 }]),
    ).rejects.toThrow(/符号链接/);
    await expect(
      extractError([{ name: 'run', data: 'x', mode: 0o100755 }]),
    ).rejects.toThrow(/可执行/);
    await expect(
      extractError([{ name: 'plugin.json', data: '{}', flags: 0x0001 }]),
    ).rejects.toThrow(/加密/);
  });

  it('拒绝重复路径、package.json 和嵌套压缩包', async () => {
    await expect(
      extractError([
        { name: 'plugin.json', data: '{}' },
        { name: 'plugin.json', data: '{}' },
      ]),
    ).rejects.toThrow(/重复路径/);
    await expect(
      extractError([{ name: 'package.json', data: '{}' }]),
    ).rejects.toThrow(/package\.json/);
    await expect(
      extractError([{ name: 'assets/nested.zip', data: 'x' }]),
    ).rejects.toThrow(/嵌套压缩包/);
  });

  it('拒绝 zip64', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'zip64.zip');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 10);
    await writeFile(file, eocd);
    const dest = await tempDir();
    await expect(extractPluginZip(file, dest)).rejects.toThrow(/zip64/);
  });
});

describe('inspectPluginDir', () => {
  async function pluginDir(): Promise<string> {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'plugin.json'), '{}');
    await mkdir(path.join(dir, 'skills', 'demo'), { recursive: true });
    await writeFile(path.join(dir, 'skills', 'demo', 'SKILL.md'), '# demo');
    return dir;
  }

  it('接受合法目录并拒绝符号链接', async () => {
    const dir = await pluginDir();
    const result = await inspectPluginDir(dir);
    expect(result.files).toBe(2);
    const outside = await tempDir();
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(dir, 'skills', 'demo', 'link.md'),
    );
    await expect(inspectPluginDir(dir)).rejects.toThrow(/符号链接/);
  });

  it('拒绝可执行文件', async () => {
    const dir = await pluginDir();
    await writeFile(path.join(dir, 'tools.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(inspectPluginDir(dir)).rejects.toThrow(/可执行/);
  });
});

describe('locatePluginRoot / checksum', () => {
  it('支持单层包装目录', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'wrapper'), { recursive: true });
    await writeFile(path.join(dir, 'wrapper', 'plugin.json'), '{}');
    const root = await locatePluginRoot(dir);
    expect(root).toBe(await realpath(path.join(dir, 'wrapper')));
  });

  it('校验和随内容变化', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'plugin.json'), '{}');
    const first = await checksumPluginDir(dir);
    await writeFile(path.join(dir, 'plugin.json'), '{"a":1}');
    const second = await checksumPluginDir(dir);
    expect(first).not.toBe(second);
  });
});
