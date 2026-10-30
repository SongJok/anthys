import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ivm from 'isolated-vm';
import type {
  SandboxExecRequest,
  SandboxExecResult,
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

const DEFAULT_IMAGES: Record<SandboxLanguage, string> = {
  javascript: 'node:24-alpine',
  python: 'python:3.12-alpine',
  bash: 'alpine:3.20',
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** isolated-vm 里的脚本包装：注入 datasets/console，并收集 result 与日志。 */
function wrapJavascript(code: string, datasetsJson: string): string {
  return `(function () {
  'use strict';
  var __logs = [];
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
  var datasets = JSON.parse(${JSON.stringify(datasetsJson)});
  function loadDataset(key) { return datasets[key]; }
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
      logs: __logs
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
const datasets = JSON.parse(fs.readFileSync('/workspace/datasets.json', 'utf8'));
function loadDataset(key) { return datasets[key]; }
`;
}

function dockerPythonPrelude(): string {
  return `import json
with open('/workspace/datasets.json', 'r', encoding='utf-8') as __f:
    datasets = json.load(__f)
def load_dataset(key):
    return datasets.get(key)
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

  private executeJavascript(
    request: SandboxExecRequest,
  ): SandboxExecResult {
    const startedAt = Date.now();
    const timeoutMs = this.timeoutFor(request, this.jsTimeoutMs);
    let datasetsJson: string;
    try {
      datasetsJson = JSON.stringify(request.inputDatasets ?? {});
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `数据集无法序列化为 JSON: ${errorMessage(error)}`,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    }
    if (datasetsJson.length > MAX_DATASET_JSON_CHARS) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `数据集超过 ${MAX_DATASET_JSON_CHARS} 字符上限`,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    }

    const isolate = new ivm.Isolate({ memoryLimit: this.jsMemoryLimitMb });
    try {
      const script = isolate.compileScriptSync(
        wrapJavascript(request.code, datasetsJson),
      );
      const context = isolate.createContextSync();
      const raw = script.runSync(context, { timeout: timeoutMs, copy: true });
      const output =
        typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
      const parsed = safeParse(output);
      const isOk = parsed?.ok !== false;
      const stdout = isOk
        ? JSON.stringify({ result: parsed?.result ?? null, logs: parsed?.logs ?? [] })
        : JSON.stringify({ error: parsed?.error ?? output, logs: parsed?.logs ?? [] });
      return this.finalize(
        {
          exitCode: isOk ? 0 : 1,
          stdout,
          stderr: isOk ? '' : String(parsed?.error ?? '沙盒脚本执行失败'),
          executionTimeMs: Date.now() - startedAt,
          truncated: false,
        },
        this.maxOutputChars,
      );
    } catch (error) {
      const message = errorMessage(error);
      return {
        exitCode: 1,
        stdout: '',
        stderr: message,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    } finally {
      if (!isolate.isDisposed) isolate.dispose();
    }
  }

  private async executeDocker(
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const timeoutMs = this.timeoutFor(request, this.dockerTimeoutMs);
    let datasetsJson: string;
    try {
      datasetsJson = JSON.stringify(request.inputDatasets ?? {});
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `数据集无法序列化为 JSON: ${errorMessage(error)}`,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    }
    if (datasetsJson.length > MAX_DATASET_JSON_CHARS) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `数据集超过 ${MAX_DATASET_JSON_CHARS} 字符上限`,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      };
    }

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
        '-w',
        '/workspace',
        image,
        ...RUN_COMMANDS[request.language],
      ];

      const outcome = await this.dockerExecutor({
        args,
        timeoutMs: timeoutMs + DOCKER_STARTUP_GRACE_MS,
      });
      return this.finalize(
        {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.timedOut
            ? `${outcome.stderr}沙盒执行超时（${timeoutMs}ms），已强制终止`
            : outcome.stderr,
          executionTimeMs: Date.now() - startedAt,
          truncated: false,
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
} | null {
  try {
    return JSON.parse(value) as {
      ok?: boolean;
      result?: unknown;
      logs?: unknown;
      error?: unknown;
    };
  } catch {
    return null;
  }
}
