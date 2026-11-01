import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EnvConfigProvider } from '../config/EnvConfigProvider.js';
import { createDatabase } from '../db/client.js';
import { DrizzleReActTraceStore } from '../db/configSchema.js';
import type { ReActTraceRecord } from '../types/admin-and-console.js';
import {
  evaluateMessageFlow,
  formatMessageFlowReport,
  parseFlowCases,
} from './MessageFlowEval.js';
import type { FlowEvalCase } from './MessageFlowEval.js';

interface RunnerOptions {
  days: number;
  limit: number;
  casesPath: string;
  jsonPath: string;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    days: 7,
    limit: 500,
    casesPath: '',
    jsonPath: '',
  };
  for (const arg of argv) {
    const [key, value = ''] = arg.replace(/^--/u, '').split('=', 2);
    const parsed = Number(value);
    if (key === 'days' && Number.isFinite(parsed) && parsed > 0) {
      options.days = Math.min(90, Math.trunc(parsed));
    }
    if (key === 'limit' && Number.isFinite(parsed) && parsed > 0) {
      options.limit = Math.min(5_000, Math.trunc(parsed));
    }
    if (key === 'cases' && value) options.casesPath = resolve(value);
    if (key === 'json' && value) options.jsonPath = resolve(value);
  }
  return options;
}

async function loadCases(
  path: string,
): Promise<FlowEvalCase[] | undefined> {
  if (!path) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `读取 flow cases 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseFlowCases(raw).cases;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = await loadCases(options.casesPath);
  const config = new EnvConfigProvider(process.env);
  const sinceMs = Date.now() - options.days * 24 * 60 * 60 * 1_000;
  console.log(
    `消息流评测：最近 ${options.days} 天，最多 ${options.limit} 条轨迹；` +
      `数据库=${config.getDatabaseUrl().replace(/\/\/[^@]*@/u, '//***@')}` +
      `${cases ? `；期望用例 ${cases.length} 条` : ''}`,
  );

  const dbHandle = createDatabase(config.getDatabaseUrl());
  try {
    const traces = new DrizzleReActTraceStore(dbHandle.db);
    const items: ReActTraceRecord[] = [];
    for (let page = 1; items.length < options.limit; page += 1) {
      const size = Math.min(100, options.limit - items.length);
      const result = await traces.query({ page, pageSize: size, sinceMs });
      items.push(...result.items);
      if (result.items.length < size || items.length >= result.total) break;
    }
    const report = evaluateMessageFlow(items, { sinceMs, ...(cases ? { cases } : {}) });
    console.log(`\n${formatMessageFlowReport(report)}`);
    if (options.jsonPath) {
      await writeFile(
        options.jsonPath,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
      console.log(`报告已写入 ${options.jsonPath}`);
    }
    if (cases && report.casePassRate < 1) process.exitCode = 1;
  } finally {
    await dbHandle.close();
  }
}

main().catch((error) => {
  console.error(
    `消息流评测失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
