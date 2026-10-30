import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import {
  IsolatedSandbox,
  type DockerRunOptions,
} from './IsolatedSandbox.js';
import { SandboxToolProvider } from './SandboxToolProvider.js';

const ctx: ExecutionContext = {
  conversationId: 'conv',
  messageId: 'msg-sandbox',
  senderStaffId: 'staff-001',
  senderNick: '测试员工',
  conversationType: '1',
  deadlineAt: Date.now() + 30_000,
  now: () => Date.now(),
};

function parseStdout(stdout: string): {
  result: unknown;
  logs: string[];
} {
  return JSON.parse(stdout) as { result: unknown; logs: string[] };
}

async function findTool(name: string, provider: SandboxToolProvider) {
  const tool = (await provider.getTools(ctx)).find(
    (item): item is ToolDefinition => item.name === name,
  );
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('IsolatedSandbox javascript 模式', () => {
  it('挂载数据集并返回聚合结果', async () => {
    const sandbox = new IsolatedSandbox();
    const result = await sandbox.execute({
      language: 'javascript',
      code: `
        const orders = datasets.orders;
        result = {
          failedCount: orders.filter((o) => o.status === 'failed').length,
          failedAmount: orders
            .filter((o) => o.status === 'failed')
            .reduce((sum, o) => sum + o.amount, 0),
          total: orders.length,
          viaLoader: loadDataset('orders').length,
        };
      `,
      inputDatasets: {
        orders: [
          { id: 1, status: 'failed', amount: 10 },
          { id: 2, status: 'failed', amount: 5.5 },
          { id: 3, status: 'paid', amount: 3 },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseStdout(result.stdout).result).toEqual({
      failedCount: 2,
      failedAmount: 15.5,
      total: 3,
      viaLoader: 3,
    });
  });

  it('收集 console 日志且不暴露宿主能力', async () => {
    const sandbox = new IsolatedSandbox();
    const result = await sandbox.execute({
      language: 'javascript',
      code: `
        console.log('hello', { a: 1 });
        result = {
          require: typeof require,
          process: typeof process,
          fetch: typeof fetch,
          module: typeof module,
          Buffer: typeof Buffer,
        };
      `,
    });
    expect(result.exitCode).toBe(0);
    const output = parseStdout(result.stdout);
    expect(output.logs).toEqual(['hello {"a":1}']);
    expect(output.result).toEqual({
      require: 'undefined',
      process: 'undefined',
      fetch: 'undefined',
      module: 'undefined',
      Buffer: 'undefined',
    });
  });

  it('死循环触发 CPU 超时熔断', async () => {
    const sandbox = new IsolatedSandbox({ jsTimeoutMs: 5_000 });
    const startedAt = Date.now();
    const result = await sandbox.execute({
      language: 'javascript',
      code: 'while (true) {}',
      timeoutMs: 150,
    });
    const elapsed = Date.now() - startedAt;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('timed out');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('超过内存上限时终止 isolate 且宿主不受影响', async () => {
    const sandbox = new IsolatedSandbox({ jsMemoryLimitMb: 8 });
    const result = await sandbox.execute({
      language: 'javascript',
      code: `
        const chunks = [];
        while (true) chunks.push('x'.repeat(1024 * 1024));
      `,
      timeoutMs: 3_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('memory');

    const healthy = await sandbox.execute({
      language: 'javascript',
      code: 'result = 6 * 7;',
    });
    expect(healthy.exitCode).toBe(0);
    expect(parseStdout(healthy.stdout).result).toBe(42);
  });

  it('脚本报错时保留错误与已产生的日志', async () => {
    const sandbox = new IsolatedSandbox();
    const result = await sandbox.execute({
      language: 'javascript',
      code: `
        console.log('before');
        throw new Error('boom');
      `,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
    expect(parseStdout(result.stdout).logs).toEqual(['before']);
  });

  it('超长输出会截断并标记', async () => {
    const sandbox = new IsolatedSandbox({ maxOutputChars: 500 });
    const result = await sandbox.execute({
      language: 'javascript',
      code: "result = 'y'.repeat(2000);",
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(800);
    expect(result.stdout).toContain('输出已截断');
  });

  it('拒绝空脚本与非法超时', async () => {
    const sandbox = new IsolatedSandbox();
    await expect(
      sandbox.execute({ language: 'javascript', code: '  ' }),
    ).rejects.toThrow('脚本不能为空');
    await expect(
      sandbox.execute({
        language: 'javascript',
        code: 'result = 1;',
        timeoutMs: -1,
      }),
    ).rejects.toThrow('timeoutMs 必须是正数');
  });
});

describe('IsolatedSandbox docker 模式', () => {
  function capturingSandbox() {
    const calls: DockerRunOptions[] = [];
    const sandbox = new IsolatedSandbox({
      mode: 'docker',
      dockerExecutor: async (options) => {
        calls.push(options);
        return {
          stdout: 'aggregated: 3\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      },
    });
    return { sandbox, calls };
  }

  it('使用无网络、只读、限内存的受限容器', async () => {
    const { sandbox, calls } = capturingSandbox();
    const result = await sandbox.execute({
      language: 'python',
      code: 'print("aggregated:", len(datasets["orders"]))',
      inputDatasets: { orders: [1, 2, 3] },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('aggregated: 3\n');
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--memory') + 1]).toBe('256m');
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.join(' ')).toContain(':/workspace:ro');
    expect(args.slice(-2)).toEqual(['python', '/workspace/main.py']);
    expect(args).toContain('python:3.12-alpine');
  });

  it('容器超时映射为退出码 124 并给出提示', async () => {
    const sandbox = new IsolatedSandbox({
      mode: 'docker',
      dockerExecutor: async () => ({
        stdout: '',
        stderr: '',
        exitCode: 124,
        timedOut: true,
      }),
    });
    const result = await sandbox.execute({
      language: 'bash',
      code: 'while true; do :; done',
      timeoutMs: 200,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('沙盒执行超时');
  });
});

describe('SandboxToolProvider', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sandbox-workspace-'));
    await writeFile(
      join(workDir, 'data_conv_1.json'),
      JSON.stringify([
        { error: 'timeout', service: 'order' },
        { error: 'timeout', service: 'order' },
        { error: 'null', service: 'pay' },
      ]),
      'utf8',
    );
    await writeFile(
      join(workDir, 'data_conv_2.json'),
      'raw log line 1\nraw log line 2\n',
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('注册 sandbox_analyze_and_aggregate 工具', async () => {
    const provider = new SandboxToolProvider({
      workspace: { hostDir: workDir, sandboxDir: '/workspace' },
    });
    expect(provider.providerName).toBe('sandbox');
    const tools = await provider.getTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual([
      'sandbox_analyze_and_aggregate',
    ]);
  });

  it('按 datasetKey 加载卸载数据并聚类汇总', async () => {
    const provider = new SandboxToolProvider({
      workspace: { hostDir: workDir, sandboxDir: '/workspace' },
    });
    const tool = await findTool('sandbox_analyze_and_aggregate', provider);
    const output = JSON.parse(
      await tool.execute(
        {
          language: 'javascript',
          datasetKeys: ['data_conv_1.json', 'data_conv_2.json'],
          code: `
            const byError = {};
            for (const item of datasets['data_conv_1.json']) {
              byError[item.error] = (byError[item.error] || 0) + 1;
            }
            result = {
              byError,
              rawLines: datasets['data_conv_2.json'].trim().split('\\n').length,
            };
          `,
        },
        ctx,
      ),
    ) as {
      exitCode: number;
      stdout: string;
      truncated: boolean;
    };
    expect(output.exitCode).toBe(0);
    expect(parseStdout(output.stdout).result).toEqual({
      byError: { timeout: 2, null: 1 },
      rawLines: 2,
    });
  });

  it('支持内联数据集与执行失败提示', async () => {
    const provider = new SandboxToolProvider();
    const tool = await findTool('sandbox_analyze_and_aggregate', provider);
    const ok = JSON.parse(
      await tool.execute(
        {
          language: 'javascript',
          inputDatasets: { values: [1, 2, 3, 4] },
          code: 'result = datasets.values.reduce((a, b) => a + b, 0);',
        },
        ctx,
      ),
    ) as { exitCode: number; stdout: string };
    expect(ok.exitCode).toBe(0);
    expect(parseStdout(ok.stdout).result).toBe(10);

    const failed = JSON.parse(
      await tool.execute(
        {
          language: 'javascript',
          code: 'throw new Error("bad script");',
        },
        ctx,
      ),
    ) as { exitCode: number; stderr: string; hint?: string };
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('bad script');
    expect(failed.hint).toContain('不要臆测');
  });

  it('拒绝路径穿越与缺失的数据集', async () => {
    const provider = new SandboxToolProvider({
      workspace: { hostDir: workDir, sandboxDir: '/workspace' },
    });
    const tool = await findTool('sandbox_analyze_and_aggregate', provider);
    await expect(
      tool.execute(
        { language: 'javascript', datasetKeys: ['../secret.json'], code: '1' },
        ctx,
      ),
    ).rejects.toThrow('非法的数据集 key');
    await expect(
      tool.execute(
        { language: 'javascript', datasetKeys: ['nope.json'], code: '1' },
        ctx,
      ),
    ).rejects.toThrow('数据集不存在');
    const withoutWorkspace = new SandboxToolProvider();
    const orphanTool = await findTool(
      'sandbox_analyze_and_aggregate',
      withoutWorkspace,
    );
    await expect(
      orphanTool.execute(
        {
          language: 'javascript',
          datasetKeys: ['data_conv_1.json'],
          code: 'result = 1;',
        },
        ctx,
      ),
    ).rejects.toThrow('沙盒未配置工作区');
  });
});
