import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EnvConfigProvider } from '../config/EnvConfigProvider.js';
import { createDatabase } from '../db/client.js';
import { OpenAIEmbeddingClient } from '../memory/EmbeddingClient.js';
import { seedProjectsFromRoot } from '../projects/ProjectSeed.js';
import { ProjectService } from '../projects/ProjectService.js';
import { DrizzleProjectStore } from '../projects/ProjectStore.js';
import { RepoSource } from '../projects/RepoSource.js';
import {
  DEFAULT_GOLDEN_TARGETS,
  evaluateTargets,
  formatGoldenReport,
  isSensitivePath,
  loadGoldenSet,
  normalizeRepoPath,
  scoreGoldenRun,
} from './GoldenSet.js';
import type {
  GoldenEvidence,
  GoldenQuestionRun,
  GoldenSecurityProbe,
} from './GoldenSet.js';

interface RunnerOptions {
  projectId: string;
  goldenPath: string;
  sync: boolean;
  limit: number;
  jsonPath: string;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    projectId: 'anthys',
    goldenPath: resolve(process.cwd(), 'eval/golden/anthys.json'),
    sync: true,
    limit: 8,
    jsonPath: '',
  };
  for (const arg of argv) {
    if (arg === '--no-sync') {
      options.sync = false;
      continue;
    }
    const [key, value = ''] = arg.replace(/^--/u, '').split('=', 2);
    if (key === 'project' && value) options.projectId = value;
    if (key === 'golden' && value) options.goldenPath = resolve(value);
    if (key === 'limit' && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = Math.trunc(parsed);
    }
    if (key === 'json' && value) options.jsonPath = resolve(value);
  }
  return options;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const logger = {
  info(obj: Record<string, unknown>, message: string): void {
    console.log(`[info] ${message}`, obj);
  },
  warn(obj: Record<string, unknown>, message: string): void {
    console.warn(`[warn] ${message}`, obj);
  },
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const golden = await loadGoldenSet(options.goldenPath);
  const config = new EnvConfigProvider(process.env);
  const embeddingConfig = config.getEmbeddingConfig();
  if (
    embeddingConfig.enabled &&
    embeddingConfig.apiKey &&
    embeddingConfig.dimensions !== 1536
  ) {
    console.warn(
      `EMBEDDING_DIMENSIONS=${embeddingConfig.dimensions} 与数据库 vector(1536) 不一致，本次评测禁用向量检索`,
    );
  }
  const embedder =
    embeddingConfig.enabled &&
    embeddingConfig.apiKey &&
    embeddingConfig.dimensions === 1536
      ? new OpenAIEmbeddingClient({
          baseUrl: embeddingConfig.baseUrl,
          apiKey: embeddingConfig.apiKey,
          model: embeddingConfig.model,
          dimensions: embeddingConfig.dimensions,
          timeoutMs: 20_000,
        })
      : undefined;
  console.log(
    `golden set 就绪：${golden.questions.length} 题；embedding=${embedder ? 'enabled' : 'disabled'}；数据库=${config.getDatabaseUrl().replace(/\/\/[^@]*@/u, '//***@')}`,
  );

  const dbHandle = createDatabase(config.getDatabaseUrl());
  try {
    const store = new DrizzleProjectStore(dbHandle.db, logger);
    const projectRoot = resolve(
      process.cwd(),
      process.env.PROJECT_SEED_DIR?.trim() || 'projects',
    );
    const service = new ProjectService({
      store,
      repoSource: new RepoSource({
        allowedRoots: [process.cwd()],
        stateDir: resolve(process.cwd(), '.state/eval-projects'),
        logger,
      }),
      ...(embedder ? { embedder } : {}),
      logger,
    });
    await seedProjectsFromRoot({ service, root: projectRoot, logger });
    const project = await service.getProject(options.projectId);
    if (!project) {
      throw new Error(
        `未找到项目 ${options.projectId}；请检查 ${projectRoot}/<项目>/project.json`,
      );
    }
    if (options.sync) {
      console.log(`同步项目 ${project.id}…`);
      const synced = await service.sync(project.id);
      console.log(
        `同步完成：commit ${synced.snapshot.commitSha.slice(0, 8)}，` +
          `${synced.snapshot.fileCount} 文件，${synced.snapshot.chunkCount} 分块，` +
          `向量 ${synced.stats.embeddedChunks ?? 0}/${synced.stats.chunks}${synced.stats.embeddingError ? `（降级：${synced.stats.embeddingError}）` : ''}`,
      );
    }

    const status = await service.getProjectStatus(project.id);
    const snapshot = status.snapshot;
    if (!snapshot) throw new Error('项目没有可用快照，请先同步');
    const metas = await store.listDocumentMetas(snapshot.id);
    const documentLines = new Map(
      metas.map((meta) => [normalizeRepoPath(meta.path), meta.lineCount]),
    );

    const member = {
      senderStaffId: 'golden-eval',
      isAdmin: true,
      conversationType: '1' as const,
    };
    const runs: GoldenQuestionRun[] = [];
    for (const question of golden.questions) {
      const startedAt = performance.now();
      try {
        const result = await service.searchProject({
          projectRef: project.id,
          query: question.query,
          member,
          limit: options.limit,
        });
        const latencyMs = performance.now() - startedAt;
        const evidence: GoldenEvidence[] = [];
        for (const hit of result.hits.slice(0, options.limit)) {
          const relativePath = normalizeRepoPath(hit.path);
          const document = await store.getDocument(snapshot.id, relativePath);
          const cited = document
            ? document.text
                .split('\n')
                .slice(hit.startLine - 1, hit.endLine)
                .join('\n')
            : hit.content;
          evidence.push({
            path: relativePath,
            startLine: hit.startLine,
            endLine: hit.endLine,
            symbol: hit.symbol,
            match: hit.match,
            content: cited.slice(0, 4_000),
          });
        }
        runs.push({ question, evidence, latencyMs });
        console.log(`  ${question.id} 完成（${latencyMs.toFixed(0)}ms，${evidence.length} 条引用）`);
      } catch (error) {
        runs.push({
          question,
          evidence: [],
          latencyMs: performance.now() - startedAt,
          error: messageOf(error),
        });
        console.warn(`  ${question.id} 失败：${messageOf(error)}`);
      }
    }

    const probes: GoldenSecurityProbe[] = [];
    for (const path of ['.env', '.env.production', 'id_rsa']) {
      try {
        await service.readProject({
          projectRef: project.id,
          path,
          member,
        });
        probes.push({ name: `read:${path}`, ok: false, detail: '敏感文件被读取' });
      } catch {
        probes.push({ name: `read:${path}`, ok: true });
      }
    }
    const sensitiveInSnapshot = metas
      .map((meta) => normalizeRepoPath(meta.path))
      .filter(isSensitivePath);
    probes.push({
      name: 'snapshot:no-sensitive-files',
      ok: sensitiveInSnapshot.length === 0,
      ...(sensitiveInSnapshot.length > 0
        ? { detail: sensitiveInSnapshot.slice(0, 5).join(', ') }
        : {}),
    });

    const report = scoreGoldenRun(golden, runs, documentLines, probes);
    console.log(`\n${formatGoldenReport(report)}`);
    const failures = evaluateTargets(report);
    console.log(
      `\n目标：引用命中 ≥${(DEFAULT_GOLDEN_TARGETS.citationHitRate * 100).toFixed(0)}%，事实代理覆盖 ≥${(DEFAULT_GOLDEN_TARGETS.keywordCoverage * 100).toFixed(0)}%，p95 <${DEFAULT_GOLDEN_TARGETS.p95LatencyMs}ms，安全 100%`,
    );
    if (failures.length > 0) {
      console.log(`未达标：${failures.join('；')}`);
    } else {
      console.log('达标：全部阈值通过');
    }
    console.log(
      '说明：本评测是确定性检索评测，不生成回答文本；事实覆盖率是检索证据中关键词命中的代理指标，不等于人工事实判分；p95 在本地仓库规模下测得，不代表 1 万文件生产规模；安全项不覆盖模型是否服从仓库内提示注入。',
    );
    if (options.jsonPath) {
      await writeFile(
        options.jsonPath,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
      console.log(`报告已写入 ${options.jsonPath}`);
    }
    process.exitCode = failures.length > 0 ? 1 : 0;
  } finally {
    await dbHandle.close();
  }
}

main().catch((error) => {
  console.error(`golden set 执行失败：${messageOf(error)}`);
  process.exitCode = 1;
});
