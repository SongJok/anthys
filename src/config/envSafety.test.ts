import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanSecrets } from '../eval/GoldenSet.js';

const REPO_ROOT = process.cwd();

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isGitRepo(): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

function isEnvSecretFile(filePath: string): boolean {
  const name = filePath.split('/').pop() ?? '';
  return (
    /^\.env(?:$|\.)/u.test(name) &&
    !/^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample|template)$/u.test(name)
  );
}

describe('.env 安全约束', () => {
  it('.gitignore 忽略 .env 系列但保留示例模板', () => {
    const lines = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('.env');
    expect(lines.some((line) => /^\.env\.\*$/u.test(line))).toBe(true);
    expect(lines).toContain('!.env.example');
    expect(lines.some((line) => /^!\.env\.\*\.example$/u.test(line))).toBe(true);
  });

  it('示例配置不含真实密钥', () => {
    for (const file of ['.env.example', 'deploy/.env.production.example']) {
      const content = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(scanSecrets(content), file).toEqual([]);
    }
  });

  it.skipIf(!isGitRepo())('git 不跟踪任何 .env 密钥文件，示例模板可跟踪', () => {
    expect(git(['ls-files', '--cached', '.env']).trim()).toBe('');
    const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
    expect(tracked.filter(isEnvSecretFile)).toEqual([]);
    for (const filePath of ['.env', '.env.local', 'deploy/.env.production']) {
      expect(
        () => git(['check-ignore', '-q', '--', filePath]),
        `${filePath} 应被忽略`,
      ).not.toThrow();
    }
    for (const filePath of ['.env.example', 'deploy/.env.production.example']) {
      expect(
        () => git(['check-ignore', '-q', '--', filePath]),
        `${filePath} 不应被忽略`,
      ).toThrow();
    }
  });
});
