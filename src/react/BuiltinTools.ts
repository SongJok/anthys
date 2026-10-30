import os from 'node:os';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'operator'; value: '+' | '-' | '*' | '/' | '%' | '^' }
  | { kind: 'paren'; value: '(' | ')' };

const ALLOWED_TIME_ZONES = ['Asia/Shanghai', 'UTC'] as const;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(
        expression.slice(index),
      );
      if (!match) {
        throw new Error(`无效的数字: ${expression.slice(index, index + 10)}`);
      }
      tokens.push({ kind: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '%' || char === '^') {
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char });
      index += 1;
      continue;
    }
    throw new Error(`不支持的字符: "${char}"`);
  }
  return tokens;
}

/** 递归下降求值，避免 eval / Function 带来的注入风险 */
export function evaluateArithmetic(expression: string): number {
  if (!expression.trim()) {
    throw new Error('表达式不能为空');
  }
  if (expression.length > 500) {
    throw new Error('表达式过长（上限 500 字符）');
  }
  const tokens = tokenize(expression);
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const consume = (): Token => {
    const token = tokens[position];
    if (!token) throw new Error('表达式不完整');
    position += 1;
    return token;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      const token = peek();
      if (token?.kind === 'operator' && (token.value === '+' || token.value === '-')) {
        consume();
        const right = parseTerm();
        value = token.value === '+' ? value + right : value - right;
        continue;
      }
      return value;
    }
  };

  const parseTerm = (): number => {
    let value = parseUnary();
    for (;;) {
      const token = peek();
      if (
        token?.kind === 'operator' &&
        (token.value === '*' || token.value === '/' || token.value === '%')
      ) {
        consume();
        const right = parseUnary();
        if ((token.value === '/' || token.value === '%') && right === 0) {
          throw new Error('除数不能为 0');
        }
        if (token.value === '*') value *= right;
        else if (token.value === '/') value /= right;
        else value %= right;
        continue;
      }
      return value;
    }
  };

  const parseUnary = (): number => {
    const token = peek();
    if (token?.kind === 'operator' && (token.value === '+' || token.value === '-')) {
      consume();
      const value = parseUnary();
      return token.value === '-' ? -value : value;
    }
    return parsePower();
  };

  const parsePower = (): number => {
    const base = parsePrimary();
    const token = peek();
    if (token?.kind === 'operator' && token.value === '^') {
      consume();
      const exponent = parseUnary();
      const result = Math.pow(base, exponent);
      if (!Number.isFinite(result)) {
        throw new Error('计算结果超出可表示范围');
      }
      return result;
    }
    return base;
  };

  const parsePrimary = (): number => {
    const token = consume();
    if (token.kind === 'number') return token.value;
    if (token.kind === 'paren' && token.value === '(') {
      const value = parseExpression();
      const close = consume();
      if (close.kind !== 'paren' || close.value !== ')') {
        throw new Error('缺少右括号');
      }
      return value;
    }
    throw new Error(`表达式在 "${'value' in token ? token.value : '?'}" 附近无效`);
  };

  const result = parseExpression();
  if (position !== tokens.length) {
    throw new Error('表达式存在多余内容');
  }
  if (!Number.isFinite(result)) {
    throw new Error('计算结果无效');
  }
  return result;
}

export interface BuiltinToolsOptions {
  now?: () => number;
  startedAt?: number;
}

export class BuiltinToolProvider implements IToolProvider {
  public readonly providerName = 'builtin';
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: BuiltinToolsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [this.currentTimeTool(), this.calculatorTool(), this.systemStatusTool()];
  }

  private currentTimeTool(): ToolDefinition {
    return {
      name: 'current_time',
      description:
        '获取当前日期与时间，可指定时区（Asia/Shanghai 或 UTC）。用于回答“现在几点”“今天几号”等与实时时间相关的问题。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            enum: [...ALLOWED_TIME_ZONES],
            description: '目标时区，默认 Asia/Shanghai',
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const requested = args.timeZone;
        const timeZone =
          typeof requested === 'string' &&
          (ALLOWED_TIME_ZONES as readonly string[]).includes(requested)
            ? requested
            : 'Asia/Shanghai';
        const timestamp = this.now();
        return JSON.stringify({
          iso: new Date(timestamp).toISOString(),
          unixMs: timestamp,
          timeZone,
          localTime: new Date(timestamp).toLocaleString('zh-CN', {
            timeZone,
            hour12: false,
          }),
          weekday: new Date(timestamp).toLocaleDateString('zh-CN', {
            timeZone,
            weekday: 'long',
          }),
        });
      },
    };
  }

  private calculatorTool(): ToolDefinition {
    return {
      name: 'calculator',
      description:
        '计算基础数学表达式，支持 + - * / % ^ 与括号，例如 "(12+8)*3/2" 或 "2^10"。用于需要精确数值计算的场景。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '仅包含数字、运算符和括号的数学表达式',
          },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const expression = args.expression;
        if (typeof expression !== 'string') {
          throw new Error('参数 expression 必须是字符串');
        }
        const result = evaluateArithmetic(expression);
        return JSON.stringify({ expression, result });
      },
    };
  }

  private systemStatusTool(): ToolDefinition {
    return {
      name: 'system_status',
      description:
        '查看智能体运行环境状态：Node 版本、进程内存、运行时长、主机与负载。用于回答运行状态或排查问题。',
      parametersJsonSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const memory = process.memoryUsage();
        return JSON.stringify({
          pid: process.pid,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          hostname: os.hostname(),
          uptimeSeconds: Math.round(process.uptime()),
          agentUptimeSeconds: Math.round((this.now() - this.startedAt) / 1000),
          loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
          memory: {
            rssMB: Number((memory.rss / 1024 / 1024).toFixed(1)),
            heapUsedMB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
            heapTotalMB: Number((memory.heapTotal / 1024 / 1024).toFixed(1)),
          },
        });
      },
    };
  }
}
