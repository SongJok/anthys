import { describe, expect, it } from 'vitest';
import { runJavascriptInWorker } from './WorkerJsSandbox.js';

describe('WorkerJsSandbox', () => {
  it('在隔离 Worker 中执行脚本并传入 datasets', async () => {
    const result = await runJavascriptInWorker({
      wrappedCode:
        'const d = JSON.parse(__DATASETS_JSON__); JSON.stringify({ sum: d.nums.reduce((a, b) => a + b, 0) })',
      datasetsJson: JSON.stringify({ nums: [1, 2, 3, 4] }),
      timeoutMs: 1000,
      memoryLimitMb: 32,
    });
    expect(result).toEqual({ ok: true, raw: '{"sum":10}' });
  });

  it('禁用 eval / Function / 原型链逃逸与宿主全局变量', async () => {
    const result = await runJavascriptInWorker({
      wrappedCode: `(() => {
        let evalBlocked = false;
        let fnBlocked = false;
        try { eval('1+1'); } catch { evalBlocked = true; }
        try { ({}).constructor.constructor('return process')(); } catch { fnBlocked = true; }
        return JSON.stringify({
          evalBlocked,
          fnBlocked,
          hasProcess: typeof process !== 'undefined',
          hasRequire: typeof require !== 'undefined',
          hasFetch: typeof fetch !== 'undefined',
        });
      })()`,
      datasetsJson: '{}',
      timeoutMs: 1000,
      memoryLimitMb: 32,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.raw)).toEqual({
        evalBlocked: true,
        fnBlocked: true,
        hasProcess: false,
        hasRequire: false,
        hasFetch: false,
      });
    }
  });

  it('死循环超时中止且不阻塞主线程', async () => {
    const startedAt = Date.now();
    const result = await runJavascriptInWorker({
      wrappedCode: 'while (true) {}',
      datasetsJson: '{}',
      timeoutMs: 100,
      memoryLimitMb: 16,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.stderr.toLowerCase()).toContain('timed out');
    }
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('超出内存上限时触发 Worker OOM', async () => {
    const result = await runJavascriptInWorker({
      wrappedCode:
        'const arr = []; while (true) { arr.push(new Array(2048).fill("x".repeat(64))); }',
      datasetsJson: '{}',
      timeoutMs: 5000,
      memoryLimitMb: 8,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr.toLowerCase()).toContain('memory');
    }
  });
});
