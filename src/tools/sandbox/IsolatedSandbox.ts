import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type ivmType from 'isolated-vm';
import { runJavascriptInWorker } from './WorkerJsSandbox.js';

type IvmModule = typeof ivmType;
let cachedIvmModule: IvmModule | null | undefined;

async function loadIvmModule(): Promise<IvmModule | null> {
  if (cachedIvmModule !== undefined) return cachedIvmModule;
  try {
    const mod = await import('isolated-vm');
    cachedIvmModule = (mod.default ?? mod) as IvmModule;
  } catch {
    cachedIvmModule = null;
  }
  return cachedIvmModule;
}
import type {
  SandboxArtifactOutputOptions,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxGeneratedArtifact,
} from '../../types/mcp-and-sandbox.js';

export type SandboxLanguage = SandboxExecRequest['language'];

export interface DockerRunOptions {
  args: string[];
  timeoutMs: number;
}

export interface DockerRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type DockerExecutor = (
  options: DockerRunOptions,
) => Promise<DockerRunOutcome>;

export interface IsolatedSandboxOptions {
  /** auto：JS 走 isolated-vm，python/bash 走 Docker；docker：全部走 Docker */
  mode?: 'auto' | 'docker';
  jsMemoryLimitMb?: number;
  jsTimeoutMs?: number;
  dockerMemoryMb?: number;
  dockerTimeoutMs?: number;
  maxOutputChars?: number;
  dockerImages?: Partial<Record<SandboxLanguage, string>>;
  dockerExecutor?: DockerExecutor;
  dockerBinary?: string;
}

const DEFAULT_JS_MEMORY_MB = 128;
const DEFAULT_JS_TIMEOUT_MS = 5_000;
const DEFAULT_DOCKER_MEMORY_MB = 256;
const DEFAULT_DOCKER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
const MAX_CODE_CHARS = 200_000;
const MAX_DATASET_JSON_CHARS = 32 * 1024 * 1024;
const DOCKER_STARTUP_GRACE_MS = 5_000;

const DEFAULT_MAX_ARTIFACT_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_TOTAL_BYTES = 30 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_FILES = 10;

const ALLOWED_ARTIFACT_EXTENSIONS: Readonly<Record<string, string>> = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

const DEFAULT_IMAGES: Record<SandboxLanguage, string> = {
  javascript: process.env.SANDBOX_NODE_IMAGE?.trim() || 'node:24-alpine',
  python: process.env.SANDBOX_PYTHON_IMAGE?.trim() || 'python:3.12-alpine',
  bash: process.env.SANDBOX_BASH_IMAGE?.trim() || 'alpine:3.20',
};

const CODE_FILES: Record<SandboxLanguage, string> = {
  javascript: 'main.js',
  python: 'main.py',
  bash: 'script.sh',
};

const RUN_COMMANDS: Record<SandboxLanguage, string[]> = {
  javascript: ['node', '/workspace/main.js'],
  python: ['python', '/workspace/main.py'],
  bash: ['sh', '/workspace/script.sh'],
};

interface RawJsArtifact {
  fileName?: unknown;
  content?: unknown;
  encoding?: unknown;
}

export function sanitizeArtifactFileName(raw: string): string | null {
  const base = basename(raw.trim());
  if (!base || base === '.' || base === '..' || base.startsWith('.')) {
    return null;
  }
  const ext = extname(base).toLowerCase();
  if (!(ext in ALLOWED_ARTIFACT_EXTENSIONS)) return null;
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._-]+/u, '')
    .slice(0, 80);
  if (!stem) return null;
  return `${stem}${ext}`;
}

export function mimeTypeForArtifact(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  return ALLOWED_ARTIFACT_EXTENSIONS[ext] ?? 'application/octet-stream';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function errorMessage(error: unknown): string {
  // 只回传 message，避免堆栈把宿主路径泄漏进工具输出
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 沙盒 JS 脚本包装：从隔离上下文的 __DATASETS_JSON__ 注入 datasets/console/emitArtifact，并收集 result、日志与产物。 */
function wrapJavascript(code: string): string {
  return `(function () {
  'use strict';
  var __logs = [];
  var __artifacts = [];
  function __stringify(value) {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }
  var console = {
    log: function () { __logs.push(Array.prototype.map.call(arguments, __stringify).join(' ')); },
    info: function () { __logs.push(Array.prototype.map.call(arguments, __stringify).join(' ')); },
    warn: function () { __logs.push(Array.prototype.map.call(arguments, __stringify).join(' ')); },
    error: function () { __logs.push(Array.prototype.map.call(arguments, __stringify).join(' ')); }
  };
  var datasets = JSON.parse(typeof __DATASETS_JSON__ === 'string' ? __DATASETS_JSON__ : '{}');
  function loadDataset(key) { return datasets[key]; }
  function emitArtifact(fileName, content, options) {
    if (typeof fileName !== 'string' || !fileName.trim()) {
      throw new Error('emitArtifact 需要非空文件名');
    }
    if (__artifacts.length >= 10) {
      throw new Error('单次执行最多导出 10 个产物文件');
    }
    var encoding = options && options.encoding === 'base64' ? 'base64' : 'utf8';
    var text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    __artifacts.push({ fileName: fileName.trim(), content: text, encoding: encoding });
    return { fileName: fileName.trim(), queued: true };
  }
  var result;
  try {
    ${code}
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: (error && error.stack) || String(error),
      logs: __logs
    });
  }
  try {
    return JSON.stringify({
      ok: true,
      result: result === undefined ? null : result,
      logs: __logs,
      artifacts: __artifacts
    });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: 'result 无法序列化为 JSON: ' + String(error),
      logs: __logs
    });
  }
})()`;
}

function dockerJavascriptPrelude(): string {
  return `const fs = require('node:fs');
const path = require('node:path');
const datasets = JSON.parse(fs.readFileSync('/workspace/datasets.json', 'utf8'));
function loadDataset(key) { return datasets[key]; }
function outputPath(fileName) { return path.join('/workspace/out', path.basename(String(fileName))); }
function emitArtifact(fileName, content, options) {
  const target = outputPath(fileName);
  const encoding = options && options.encoding === 'base64' ? 'base64' : 'utf8';
  const payload = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(target, encoding === 'base64' ? Buffer.from(payload, 'base64') : payload);
  return { fileName: path.basename(String(fileName)), path: target };
}
`;
}

function dockerPythonPrelude(): string {
  return `import json, os
with open('/workspace/datasets.json', 'r', encoding='utf-8') as __f:
    datasets = json.load(__f)
def load_dataset(key):
    return datasets.get(key)
def output_path(file_name):
    return os.path.join('/workspace/out', os.path.basename(str(file_name)))
`;
}

function scriptFor(language: SandboxLanguage, code: string): string {
  if (language === 'javascript') return `${dockerJavascriptPrelude()}\n${code}\n`;
  if (language === 'python') return `${dockerPythonPrelude()}\n${code}\n`;
  return code;
}

/**
 * 双模隔离沙盒：
 * - javascript：isolated-vm 独立 Isolate（128MB 内存上限、5s CPU 上限、不暴露宿主能力）
 * - python/bash（或显式 docker 模式）：受限 Docker（--network none --read-only --memory 256m）
 */
export class IsolatedSandbox {
  private readonly mode: 'auto' | 'docker';
  private readonly jsMemoryLimitMb: number;
  private readonly jsTimeoutMs: number;
  private readonly dockerMemoryMb: number;
  private readonly dockerTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly dockerImages: Record<SandboxLanguage, string>;
  private readonly dockerExecutor: DockerExecutor;
  private readonly dockerBinary: string;

  constructor(options: IsolatedSandboxOptions = {}) {
    this.mode = options.mode ?? 'auto';
    this.jsMemoryLimitMb = Math.max(
      8,
      options.jsMemoryLimitMb ?? DEFAULT_JS_MEMORY_MB,
    );
    this.jsTimeoutMs = clamp(
      options.jsTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
      50,
      60_000,
    );
    this.dockerMemoryMb = Math.max(
      64,
      options.dockerMemoryMb ?? DEFAULT_DOCKER_MEMORY_MB,
    );
    this.dockerTimeoutMs = clamp(
      options.dockerTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS,
      100,
      120_000,
    );
    this.maxOutputChars = Math.max(
      500,
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    );
    this.dockerImages = { ...DEFAULT_IMAGES, ...options.dockerImages };
    this.dockerBinary = options.dockerBinary ?? 'docker';
    this.dockerExecutor =
      options.dockerExecutor ?? ((request) => this.execDocker(request));
  }

  public async execute(
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult> {
    this.validate(request);
    if (this.mode === 'auto' && request.language === 'javascript') {
      return this.executeJavascript(request);
    }
    return this.executeDocker(request);
  }

  private validate(request: SandboxExecRequest): void {
    if (!['javascript', 'python', 'bash'].includes(request.language)) {
      throw new Error(`不支持的沙盒语言: ${String(request.language)}`);
    }
    if (typeof request.code !== 'string' || request.code.trim() === '') {
      throw new Error('沙盒脚本不能为空');
    }
    if (request.code.length > MAX_CODE_CHARS) {
      throw new Error(`沙盒脚本超过 ${MAX_CODE_CHARS} 字符上限`);
    }
    if (request.timeoutMs !== undefined) {
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new Error('timeoutMs 必须是正数');
      }
    }
  }

  private timeoutFor(request: SandboxExecRequest, max: number): number {
    return clamp(request.timeoutMs ?? max, 50, max);
  }

  private serializeDatasets(
    inputDatasets: Record<string, unknown> | undefined,
    startedAt: number,
  ): { datasetsJson: string } | { errorResult: SandboxExecResult } {
    let datasetsJson: string;
    try {
      datasetsJson = JSON.stringify(inputDatasets ?? {});
    } catch (error) {
      return {
        errorResult: {
          exitCode: 1,
          stdout: '',
          stderr: `数据集无法序列化为 JSON: ${errorMessage(error)}`,
          executionTimeMs: Date.now() - startedAt,
          truncated: false,
        },
      };
    }
    if (datasetsJson.length > MAX_DATASET_JSON_CHARS) {
      return {
        errorResult: {
          exitCode: 1,
          stdout: '',
          stderr: `数据集超过 ${MAX_DATASET_JSON_CHARS} 字符上限`,
          executionTimeMs: Date.now() - startedAt,
          truncated: false,
        },
      };
    }
    return { datasetsJson };
  }

  private async runJavascriptInIvm(
    ivm: IvmModule,
    wrappedCode: string,
    datasetsJson: string,
    timeoutMs: number,
  ): Promise<{ ok: true; raw: string } | { ok: false; stderr: string }> {
    const isolate = new ivm.Isolate({ memoryLimit: this.jsMemoryLimitMb });
    try {
      const context = await isolate.createContext();
      await context.global.set('__DATASETS_JSON__', datasetsJson);
      const script = await isolate.compileScript(wrappedCode);
      const raw = await script.run(context, { timeout: timeoutMs, copy: true });
      return {
        ok: true,
        raw: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null),
      };
    } catch (error) {
      return { ok: false, stderr: errorMessage(error) };
    } finally {
      if (!isolate.isDisposed) isolate.dispose();
    }
  }

  private async executeJavascript(
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const timeoutMs = this.timeoutFor(request, this.jsTimeoutMs);
    const serialized = this.serializeDatasets(request.inputDatasets, startedAt);
    if ('errorResult' in serialized) return serialized.errorResult;

    const wrappedCode = wrapJavascript(request.code);
    const ivm = await loadIvmModule();
    const execution = ivm
      ? await this.runJavascriptInIvm(
          ivm,
          wrappedCode,
          serialized.datasetsJson,
          timeoutMs,
        )
      : await runJavascriptInWorker({
          wrappedCode,
          datasetsJson: serialized.datasetsJson,
          timeoutMs,
          memoryLimitMb: this.jsMemoryLimitMb,
        });

    if (!execution.ok) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: execution.stderr,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    }

    const parsed = safeParse(execution.raw);
    const isOk = parsed?.ok !== false;
    const generatedArtifacts =
      isOk && request.artifactOutput && Array.isArray(parsed?.artifacts)
        ? await this.persistJsArtifacts(parsed.artifacts, request.artifactOutput)
        : [];
    const stdout = isOk
      ? JSON.stringify({ result: parsed?.result ?? null, logs: parsed?.logs ?? [] })
      : JSON.stringify({
          error: parsed?.error ?? execution.raw,
          logs: parsed?.logs ?? [],
        });
    return this.finalize(
      {
        exitCode: isOk ? 0 : 1,
        stdout,
        stderr: isOk ? '' : String(parsed?.error ?? '沙盒脚本执行失败'),
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
        ...(generatedArtifacts.length > 0 ? { generatedArtifacts } : {}),
      },
      this.maxOutputChars,
    );
  }

  private async executeDocker(
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const timeoutMs = this.timeoutFor(request, this.dockerTimeoutMs);
    const serialized = this.serializeDatasets(request.inputDatasets, startedAt);
    if ('errorResult' in serialized) return serialized.errorResult;
    const { datasetsJson } = serialized;

    const workDir = await mkdtemp(join(tmpdir(), 'sandbox-'));
    try {
      await chmod(workDir, 0o755);
      const codeFile = join(workDir, CODE_FILES[request.language]);
      await writeFile(
        codeFile,
        scriptFor(request.language, request.code),
        'utf8',
      );
      await writeFile(join(workDir, 'datasets.json'), datasetsJson, 'utf8');
      await chmod(codeFile, 0o644);
      await chmod(join(workDir, 'datasets.json'), 0o644);

      let outDir: string | undefined;
      if (request.artifactOutput) {
        outDir = join(workDir, 'out');
        await mkdir(outDir, { recursive: true });
        await chmod(outDir, 0o777);
      }

      const image = this.dockerImages[request.language];
      const args = [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--memory',
        `${this.dockerMemoryMb}m`,
        '--memory-swap',
        `${this.dockerMemoryMb}m`,
        '--cpus',
        '1',
        '--pids-limit',
        '128',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp:rw,size=64m',
        '-v',
        `${workDir}:/workspace:ro`,
        ...(outDir ? ['-v', `${outDir}:/workspace/out:rw`] : []),
        '-w',
        '/workspace',
        image,
        ...RUN_COMMANDS[request.language],
      ];

      const outcome = await this.dockerExecutor({
        args,
        timeoutMs: timeoutMs + DOCKER_STARTUP_GRACE_MS,
      });
      const generatedArtifacts =
        outcome.exitCode === 0 && outDir && request.artifactOutput
          ? await this.collectDockerArtifacts(outDir, request.artifactOutput)
          : [];
      return this.finalize(
        {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.timedOut
            ? `${outcome.stderr}沙盒执行超时（${timeoutMs}ms），已强制终止`
            : outcome.stderr,
          executionTimeMs: Date.now() - startedAt,
          truncated: false,
          ...(generatedArtifacts.length > 0 ? { generatedArtifacts } : {}),
        },
        this.maxOutputChars,
      );
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: errorMessage(error),
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async resolveOutputTargetDir(
    output: SandboxArtifactOutputOptions,
  ): Promise<{ workspaceRoot: string; targetDir: string }> {
    const workspaceRoot = await realpath(output.workspaceRoot).catch(() =>
      resolve(output.workspaceRoot),
    );
    const targetDir = resolve(workspaceRoot, output.subdir);
    if (
      targetDir !== workspaceRoot &&
      !targetDir.startsWith(`${workspaceRoot}${sep}`)
    ) {
      throw new Error('沙盒产物目录越界');
    }
    await mkdir(targetDir, { recursive: true });
    const resolvedTarget = await realpath(targetDir);
    if (
      resolvedTarget !== workspaceRoot &&
      !resolvedTarget.startsWith(`${workspaceRoot}${sep}`)
    ) {
      throw new Error('沙盒产物目录符号链接越界');
    }
    return { workspaceRoot, targetDir: resolvedTarget };
  }

  private async persistJsArtifacts(
    rawArtifacts: RawJsArtifact[],
    output: SandboxArtifactOutputOptions,
  ): Promise<SandboxGeneratedArtifact[]> {
    if (rawArtifacts.length === 0) return [];
    const maxFileBytes = output.maxFileBytes ?? DEFAULT_MAX_ARTIFACT_FILE_BYTES;
    const maxTotalBytes =
      output.maxTotalBytes ?? DEFAULT_MAX_ARTIFACT_TOTAL_BYTES;
    const maxFiles = Math.max(1, output.maxFiles ?? DEFAULT_MAX_ARTIFACT_FILES);
    const { workspaceRoot, targetDir } = await this.resolveOutputTargetDir(output);
    const saved: SandboxGeneratedArtifact[] = [];
    let totalBytes = 0;

    for (const item of rawArtifacts) {
      if (saved.length >= maxFiles) break;
      if (typeof item.fileName !== 'string' || typeof item.content !== 'string') {
        continue;
      }
      const safeName = sanitizeArtifactFileName(item.fileName);
      if (!safeName) continue;
      const data =
        item.encoding === 'base64'
          ? Buffer.from(item.content, 'base64')
          : Buffer.from(item.content, 'utf8');
      if (data.length > maxFileBytes || totalBytes + data.length > maxTotalBytes) {
        continue;
      }
      const dest = join(targetDir, safeName);
      await writeFile(dest, data);
      await chmod(dest, 0o644);
      totalBytes += data.length;
      saved.push({
        workspaceRelativePath: relative(workspaceRoot, dest).replaceAll('\\', '/'),
        absolutePath: dest,
        fileName: safeName,
        sizeBytes: data.length,
        mimeType: mimeTypeForArtifact(safeName),
      });
    }
    return saved;
  }

  private async collectDockerArtifacts(
    outDir: string,
    output: SandboxArtifactOutputOptions,
  ): Promise<SandboxGeneratedArtifact[]> {
    const entries = await readdir(outDir).catch(() => [] as string[]);
    if (entries.length === 0) return [];
    const maxFileBytes = output.maxFileBytes ?? DEFAULT_MAX_ARTIFACT_FILE_BYTES;
    const maxTotalBytes =
      output.maxTotalBytes ?? DEFAULT_MAX_ARTIFACT_TOTAL_BYTES;
    const maxFiles = Math.max(1, output.maxFiles ?? DEFAULT_MAX_ARTIFACT_FILES);
    let resolvedTarget: { workspaceRoot: string; targetDir: string } | null = null;
    const saved: SandboxGeneratedArtifact[] = [];
    let totalBytes = 0;

    for (const entry of entries) {
      if (saved.length >= maxFiles) break;
      const safeName = sanitizeArtifactFileName(entry);
      if (!safeName) continue;
      const src = join(outDir, entry);
      const info = await lstat(src).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) continue;
      if (info.size > maxFileBytes || totalBytes + info.size > maxTotalBytes) {
        continue;
      }
      if (!resolvedTarget) {
        resolvedTarget = await this.resolveOutputTargetDir(output);
      }
      const dest = join(resolvedTarget.targetDir, safeName);
      await copyFile(src, dest);
      await chmod(dest, 0o644);
      totalBytes += info.size;
      saved.push({
        workspaceRelativePath: relative(resolvedTarget.workspaceRoot, dest).replaceAll(
          '\\',
          '/',
        ),
        absolutePath: dest,
        fileName: safeName,
        sizeBytes: info.size,
        mimeType: mimeTypeForArtifact(safeName),
      });
    }
    return saved;
  }

  private execDocker(
    request: DockerRunOptions,
  ): Promise<DockerRunOutcome> {
    return new Promise((resolve) => {
      execFile(
        this.dockerBinary,
        request.args,
        {
          timeout: request.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, exitCode: 0, timedOut: false });
            return;
          }
          const failure = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
          };
          const timedOut =
            failure.killed === true || failure.signal === 'SIGTERM';
          const exitCode =
            failure.code === 'ENOENT'
              ? 127
              : timedOut
                ? 124
                : typeof failure.code === 'number'
                  ? failure.code
                  : 1;
          resolve({
            stdout,
            stderr:
              failure.code === 'ENOENT'
                ? `Docker 不可用或未安装: ${error.message}`
                : stderr || error.message,
            exitCode,
            timedOut,
          });
        },
      );
    });
  }

  private finalize(
    result: SandboxExecResult,
    maxChars: number,
  ): SandboxExecResult {
    const stdoutTruncated = result.stdout.length > maxChars;
    const stderrTruncated = result.stderr.length > maxChars;
    return {
      ...result,
      stdout: stdoutTruncated
        ? `${result.stdout.slice(0, maxChars)}\n…（输出已截断，原长 ${result.stdout.length} 字符）`
        : result.stdout,
      stderr: stderrTruncated
        ? `${result.stderr.slice(0, maxChars)}\n…（错误输出已截断）`
        : result.stderr,
      truncated: result.truncated || stdoutTruncated || stderrTruncated,
    };
  }
}

function safeParse(value: string): {
  ok?: boolean;
  result?: unknown;
  logs?: unknown;
  error?: unknown;
  artifacts?: RawJsArtifact[];
} | null {
  try {
    return JSON.parse(value) as {
      ok?: boolean;
      result?: unknown;
      logs?: unknown;
      error?: unknown;
      artifacts?: RawJsArtifact[];
    };
  } catch {
    return null;
  }
}
