import { describe, expect, it } from 'vitest';
import {
  BuiltinToolProvider,
  evaluateArithmetic,
} from './BuiltinTools.js';
import type { ExecutionContext } from '../types/core.js';

const ctx: ExecutionContext = {
  conversationId: 'c',
  messageId: 'm',
  senderStaffId: 's',
  senderNick: 'n',
  conversationType: '1',
  deadlineAt: Date.now() + 10_000,
  now: () => Date.now(),
};

async function findTool(name: string, provider = new BuiltinToolProvider()) {
  const tools = await provider.getTools(ctx);
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('evaluateArithmetic', () => {
  it.each([
    ['1+2', 3],
    ['2+3*4', 14],
    ['(2+3)*4', 20],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['10%3', 1],
    ['8/2/2', 2],
    ['1.5*2', 3],
    ['1e3+1', 1001],
  ])('计算 %s = %s', (expression, expected) => {
    expect(evaluateArithmetic(expression)).toBe(expected);
  });

  it.each([
    ['1/0', '除数不能为 0'],
    ['1%0', '除数不能为 0'],
    ['（1+2）', '不支持的字符'],
    ['(1+2', '表达式不完整'],
    ['1+2)', '表达式存在多余内容'],
    ['', '表达式不能为空'],
    ['2+abc', '不支持的字符'],
  ])('拒绝非法表达式 %s', (expression, message) => {
    expect(() => evaluateArithmetic(expression)).toThrow(message);
  });

  it('拒绝超长表达式', () => {
    expect(() => evaluateArithmetic('1+'.repeat(300) + '1')).toThrow(
      '表达式过长',
    );
  });
});

describe('BuiltinToolProvider', () => {
  it('以 builtin 名称暴露三个工具', async () => {
    const provider = new BuiltinToolProvider();
    expect(provider.providerName).toBe('builtin');
    const tools = await provider.getTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual([
      'current_time',
      'calculator',
      'system_status',
    ]);
  });

  it('当前时间工具使用注入的时钟与时区', async () => {
    const fixed = Date.UTC(2026, 9, 30, 2, 0, 0);
    const tool = await findTool(
      'current_time',
      new BuiltinToolProvider({ now: () => fixed }),
    );
    const output = JSON.parse(
      await tool.execute({ timeZone: 'UTC' }, ctx),
    ) as Record<string, unknown>;
    expect(output.iso).toBe('2026-10-30T02:00:00.000Z');
    expect(output.timeZone).toBe('UTC');
    expect(output.unixMs).toBe(fixed);

    const fallback = JSON.parse(
      await tool.execute({ timeZone: 'Mars/Olympus' }, ctx),
    ) as Record<string, unknown>;
    expect(fallback.timeZone).toBe('Asia/Shanghai');
  });

  it('计算器工具返回表达式与结果', async () => {
    const tool = await findTool('calculator');
    const output = JSON.parse(
      await tool.execute({ expression: '(12+8)*3/2' }, ctx),
    ) as Record<string, unknown>;
    expect(output).toEqual({ expression: '(12+8)*3/2', result: 30 });
  });

  it('计算器工具拒绝非字符串表达式', async () => {
    const tool = await findTool('calculator');
    await expect(tool.execute({ expression: 42 }, ctx)).rejects.toThrow(
      'expression 必须是字符串',
    );
  });

  it('系统状态工具返回进程与内存信息', async () => {
    const tool = await findTool('system_status');
    const output = JSON.parse(await tool.execute({}, ctx)) as {
      pid: number;
      node: string;
      memory: { rssMB: number };
      agentUptimeSeconds: number;
    };
    expect(output.pid).toBe(process.pid);
    expect(output.node).toBe(process.version);
    expect(output.memory.rssMB).toBeGreaterThan(0);
    expect(output.agentUptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
