import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectLanguage,
  globToRegExp,
  isSensitiveFile,
  scanRepository,
} from './RepoScanner.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'anthys-scan-'));
  roots.push(root);
  return root;
}

async function write(root: string, relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RepoScanner', () => {
  it('扫描源码与文档，跳过敏感文件、二进制和忽略目录', async () => {
    const root = await makeRoot();
    await write(
      root,
      'package.json',
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }),
    );
    await write(root, 'README.md', '# Demo\n\n项目说明。\n');
    await write(
      root,
      'src/app.ts',
      'export class App {\n  run(): void {}\n}\n',
    );
    await write(root, 'src/app.test.ts', "describe('app', () => {});\n");
    await write(root, 'docs/guide.md', '# 指南\n');
    await write(root, 'Dockerfile', 'FROM node:24\n');
    await write(root, '.env', 'SECRET=1\n');
    await write(root, 'cert.pem', 'PRIVATE KEY\n');
    await write(root, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    await write(root, 'dist/out.js', 'console.log(1);\n');
    await write(
      root,
      'src/generated/types.ts',
      'export type Generated = string;\n',
    );
    await write(root, 'tool', '#!/usr/bin/env python3\nprint(1)\n');

    const result = await scanRepository(root, {
      ignoreGlobs: ['src/generated/**'],
    });
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toEqual([
      'Dockerfile',
      'README.md',
      'docs/guide.md',
      'package.json',
      'src/app.test.ts',
      'src/app.ts',
      'tool',
    ]);
    const app = result.files.find((file) => file.path === 'src/app.ts');
    expect(app?.language).toBe('typescript');
    expect(app?.kind).toBe('code');
    const test = result.files.find((file) => file.path === 'src/app.test.ts');
    expect(test?.kind).toBe('test');
    const docs = result.files.find((file) => file.path === 'docs/guide.md');
    expect(docs?.kind).toBe('doc');
    const pkg = result.files.find((file) => file.path === 'package.json');
    expect(pkg?.kind).toBe('config');
    const script = result.files.find((file) => file.path === 'tool');
    expect(script?.language).toBe('python');
    expect(result.skippedReasons.sensitive).toBe(2);
    expect(result.skippedReasons.binary).toBe(1);
    expect(result.skippedReasons['ignored-dir']).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(false);
  });

  it('超过文件数量上限时标记 truncated', async () => {
    const root = await makeRoot();
    for (let index = 0; index < 5; index += 1) {
      await write(root, `src/file-${index}.ts`, `export const value${index} = ${index};\n`);
    }
    const result = await scanRepository(root, { maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.skippedReasons.limit).toBeGreaterThan(0);
  });

  it('跳过符号链接，避免逃逸仓库根目录', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await write(outside, 'secret.ts', 'export const leaked = true;\n');
    await write(root, 'src/main.ts', 'export const ok = true;\n');
    await symlink(
      path.join(outside, 'secret.ts'),
      path.join(root, 'src', 'linked.ts'),
    );
    const result = await scanRepository(root);
    expect(result.files.map((file) => file.path)).toEqual(['src/main.ts']);
    expect(result.skippedReasons.symlink).toBe(1);
  });
});

describe('scanner helpers', () => {
  it('识别敏感文件名', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.production')).toBe(true);
    expect(isSensitiveFile('.env.example')).toBe(false);
    expect(isSensitiveFile('.env.template')).toBe(false);
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('credentials.json')).toBe(true);
    expect(isSensitiveFile('.npmrc')).toBe(true);
    expect(isSensitiveFile('package.json')).toBe(false);
  });

  it('glob 支持 ** 与 *', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.md')).toBe(false);
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
  });

  it('无扩展名时按 shebang 识别语言', () => {
    expect(detectLanguage('bin/tool', '#!/usr/bin/env node\n')).toBe('javascript');
    expect(detectLanguage('bin/tool', '#!/bin/bash\n')).toBe('shell');
    expect(detectLanguage('unknown', 'plain text')).toBe('other');
  });
});
