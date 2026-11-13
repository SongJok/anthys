import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

interface LintViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'scripts', 'web-console/src'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', '.state']);

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function scanFile(filePath: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const rel = relative(ROOT, filePath).replaceAll('\\', '/');
  const isTestFile = /\.test\.(ts|tsx)$/.test(rel);
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((text, idx) => {
    const line = idx + 1;
    if (/@ts-ignore\b|@ts-nocheck\b/.test(text) && rel !== 'scripts/lint.ts') {
      violations.push({
        file: rel,
        line,
        rule: 'no-ts-suppression',
        message: '禁止使用 @ts-ignore / @ts-nocheck 屏蔽类型错误',
      });
    }
    if (!isTestFile && /^\s*debugger\s*;?\s*$/.test(text)) {
      violations.push({
        file: rel,
        line,
        rule: 'no-debugger',
        message: '生产代码禁止遗留 debugger 语句',
      });
    }
    if (
      isTestFile &&
      /\b(describe|it|test)\.only\s*\(|\bf(it|describe)\s*\(/.test(text)
    ) {
      violations.push({
        file: rel,
        line,
        rule: 'no-focused-test',
        message: '测试文件禁止遗留 .only / fit / fdescribe',
      });
    }
  });

  if (rel === 'src/admin-api/server.ts' && content.includes("query('token')")) {
    violations.push({
      file: rel,
      line: 1,
      rule: 'no-query-token-auth',
      message: '禁止在 REST 或 /metrics 接口重新启用 ?token= 查询参数鉴权',
    });
  }

  return violations;
}

function main(): void {
  const files = SCAN_DIRS.flatMap((dir) => collectFiles(join(ROOT, dir)));
  const violations = files.flatMap(scanFile);

  if (violations.length > 0) {
    console.error(`Lint failed with ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }
  console.log(`Lint passed (${files.length} files checked).`);
}

main();
