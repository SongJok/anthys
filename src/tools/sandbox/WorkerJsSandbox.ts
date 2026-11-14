import { Worker } from 'node:worker_threads';

export interface WorkerJsRequest {
  wrappedCode: string;
  datasetsJson: string;
  timeoutMs: number;
  memoryLimitMb: number;
}

export type WorkerJsResult =
  | { ok: true; raw: string }
  | { ok: false; stderr: string; timedOut: boolean };

interface WorkerPayload {
  ok: boolean;
  raw?: string;
  code?: string;
  error?: string;
}

const WORKER_BOOTSTRAP = `
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

try {
  const sandbox = {
    __DATASETS_JSON__: workerData.datasetsJson,
  };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  const raw = vm.runInContext(workerData.wrappedCode, context, {
    timeout: workerData.timeoutMs,
  });
  parentPort?.postMessage({
    ok: true,
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null),
  });
} catch (error) {
  const err = error && typeof error === 'object' ? error : null;
  parentPort?.postMessage({
    ok: false,
    code: typeof err?.code === 'string' ? err.code : undefined,
    error: typeof err?.message === 'string' ? err.message : String(error),
  });
}
`;

function workerExecArgv(): string[] {
  return ['--permission'];
}

function classifyWorkerFailure(error: unknown): WorkerJsResult {
  const err = error as NodeJS.ErrnoException | null | undefined;
  const code = err?.code ?? '';
  const message = err?.message ?? String(error);
  if (
    code === 'ERR_WORKER_OUT_OF_MEMORY' ||
    /out of memory|heap limit/i.test(message)
  ) {
    return {
      ok: false,
      stderr: `Worker heap memory limit exceeded: ${message}`,
      timedOut: false,
    };
  }
  const timedOut =
    code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(message);
  return {
    ok: false,
    stderr: message,
    timedOut,
  };
}

/**
 * 在 isolated-vm 不可用（例如 Node 主版本 ABI 不匹配）时使用的 Worker + vm.createContext 降级沙盒：
 * - 运行于独立 Worker 线程，绝不阻塞主事件循环；
 * - 通过 vm.createContext(codeGeneration: { strings: false, wasm: false }) 禁用 eval/new Function/Wasm；
 * - 不注入 process/require/fetch/Buffer/fs 等任何宿主能力；
 * - 通过 resourceLimits 限制堆内存，并通过 vm timeout + 看门狗 terminate 防止死循环。
 */
export async function runJavascriptInWorker(
  request: WorkerJsRequest,
): Promise<WorkerJsResult> {
  // vm.createContext 不是硬隔离边界；没有 --permission 时 worker 仍可触达 fs/process，
  // 宁可拒绝执行也不降级为无约束运行（engines 要求 Node >= 24，均支持该标志）
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) {
    return {
      ok: false,
      stderr:
        'Worker sandbox requires Node.js --permission support; refusing to run unconfined',
      timedOut: false,
    };
  }
  const maxYoungMb = Math.min(32, Math.max(4, Math.floor(request.memoryLimitMb / 4)));
  return new Promise<WorkerJsResult>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      execArgv: workerExecArgv(),
      workerData: {
        wrappedCode: request.wrappedCode,
        datasetsJson: request.datasetsJson,
        timeoutMs: request.timeoutMs,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: request.memoryLimitMb,
        maxYoungGenerationSizeMb: maxYoungMb,
      },
    });

    const settle = (result: WorkerJsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(memoryWatchdog);
      void worker.terminate().catch(() => {});
      resolve(result);
    };

    const watchdog = setTimeout(() => {
      settle({
        ok: false,
        stderr: `Script execution timed out after ${request.timeoutMs}ms`,
        timedOut: true,
      });
    }, request.timeoutMs + 150);

    // resourceLimits 只约束 V8 堆，ArrayBuffer/Buffer 等外部内存不受限；
    // worker 与主进程共享 RSS，在父线程采样可覆盖同步执行期间的内存暴涨
    const rssCapBytes =
      process.memoryUsage().rss + (request.memoryLimitMb + 128) * 1024 * 1024;
    const memoryWatchdog = setInterval(() => {
      if (process.memoryUsage().rss > rssCapBytes) {
        settle({
          ok: false,
          stderr: 'Worker memory limit exceeded (process RSS cap)',
          timedOut: false,
        });
      }
    }, 50);

    worker.once('message', (payload: WorkerPayload) => {
      if (payload.ok) {
        settle({ ok: true, raw: payload.raw ?? 'null' });
        return;
      }
      const message = payload.error ?? 'Worker script execution failed';
      const timedOut =
        payload.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
        /timed out/i.test(message);
      settle({
        ok: false,
        stderr: timedOut && !/timed out/i.test(message)
          ? `Script execution timed out: ${message}`
          : message,
        timedOut,
      });
    });

    worker.once('error', (error) => {
      settle(classifyWorkerFailure(error));
    });

    worker.once('exit', (exitCode) => {
      if (settled) return;
      settle({
        ok: false,
        stderr:
          exitCode === 0
            ? 'Worker exited without producing output'
            : `Worker exited unexpectedly with code ${exitCode}`,
        timedOut: false,
      });
    });
  });
}
