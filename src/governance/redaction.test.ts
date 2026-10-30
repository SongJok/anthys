import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  redactDeep,
  redactText,
  redactTraceRecord,
} from './redaction.js';
import { createRedactingLogger } from './logger.js';
import type { ReActTraceRecord } from '../types/admin-and-console.js';

describe('redactText', () => {
  it('掩码手机号、邮箱与身份证号', () => {
    expect(redactText('联系 13812345678')).toBe('联系 138****5678');
    expect(redactText('邮箱 zhangsan@example.com')).toBe('邮箱 z***@example.com');
    expect(redactText('身份证 110105199003071234')).toContain('1101****1234');
  });

  it('掩码常见密钥格式与 Bearer Token', () => {
    expect(redactText('key sk-abcdefghijklmnop')).toBe('key sk-a****mnop');
    expect(redactText('Authorization: Bearer abcdefghijk')).toBe(
      'Authorization: Bearer ****',
    );
    expect(redactText('password=Sup3rSecretValue')).toBe(
      'password=Sup3****alue',
    );
    expect(redactText('https://api.test/x?access_token=abcdefgh12345')).toBe(
      'https://api.test/x?access_token=abcd****2345',
    );
    expect(redactText('AKIAABCDEFGHIJKLMNOP')).toBe('AKIA****MNOP');
  });

  it('可关闭指定类别', () => {
    expect(redactText('13812345678', { phone: false })).toBe('13812345678');
    expect(redactText('13812345678', { phone: true })).toBe('138****5678');
  });

  it('空字符串保持原样', () => {
    expect(redactText('')).toBe('');
  });
});

describe('redactDeep', () => {
  it('递归处理对象、数组与嵌套字段', () => {
    const result = redactDeep({
      text: '手机 13812345678',
      args: { token: 'sk-abcdefghijklmnop', list: ['a@b.com'] },
      count: 3,
      flag: true,
      nothing: null,
    }) as Record<string, unknown>;
    expect(result.text).toBe('手机 138****5678');
    expect((result.args as Record<string, unknown>).token).toBe(
      'sk-a****mnop',
    );
    expect((result.args as Record<string, unknown>).list).toEqual(['a***@b.com']);
    expect(result.count).toBe(3);
    expect(result.flag).toBe(true);
    expect(result.nothing).toBeNull();
  });
});

describe('redactTraceRecord', () => {
  it('脱敏问题、推理、回答与工具入参输出', () => {
    const record: ReActTraceRecord = {
      id: 'trace-1',
      conversationId: 'cid-1',
      messageId: 'msg-1',
      senderStaffId: 'staff-1',
      senderNick: '张三',
      conversationType: '2',
      proactive: false,
      question: '帮我查 13812345678 的订单',
      reasoning: '需要调用工具 token=abcdefgh12345',
      steps: [
        {
          index: 1,
          type: 'tool',
          toolName: 'query',
          arguments: { apiKey: 'sk-abcdefghijklmnop' },
          output: '联系邮箱 zhangsan@example.com',
        },
      ],
      answer: '已发送到 13812345678',
      totalTokens: 10,
      stepCount: 1,
      durationMs: 20,
      createdAt: new Date().toISOString(),
    };
    const redacted = redactTraceRecord(record);
    expect(redacted.question).toBe('帮我查 138****5678 的订单');
    expect(redacted.reasoning).toContain('token=abcd****2345');
    expect(redacted.steps[0]?.arguments).toEqual({ apiKey: 'sk-a****mnop' });
    expect(redacted.steps[0]?.output).toBe('联系邮箱 z***@example.com');
    expect(redacted.answer).toBe('已发送到 138****5678');
    expect(record.question).toContain('13812345678');
  });
});

describe('createRedactingLogger', () => {
  function capture(): { stream: Writable; output: () => string } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    return { stream, output: () => chunks.join('') };
  }

  it('日志消息与对象字段在输出前脱敏', async () => {
    const sink = capture();
    const logger = createRedactingLogger({
      level: 'info',
      stream: sink.stream as never,
    });
    logger.info({ phone: '13812345678', nested: { email: 'a@b.com' } }, '联系 13812345678');
    await new Promise((resolve) => setImmediate(resolve));
    const output = sink.output();
    expect(output).not.toContain('13812345678');
    expect(output).not.toContain('a@b.com');
    expect(output).toContain('138****5678');
  });

  it('关闭脱敏后原样输出', async () => {
    const sink = capture();
    const logger = createRedactingLogger({
      level: 'info',
      redact: false,
      stream: sink.stream as never,
    });
    logger.info('手机 13812345678');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.output()).toContain('13812345678');
  });
});
