import { describe, expect, it } from 'vitest';
import { sendTextFallback, splitMarkdown } from './TextFallback.js';

describe('splitMarkdown', () => {
  it('短文本保持单段', () => {
    expect(splitMarkdown('你好')).toEqual(['你好']);
    expect(splitMarkdown('   ')).toEqual([]);
  });

  it('按段落切分且每段不超过上限', () => {
    const text = ['第一段内容', '第二段内容', '第三段内容'].join('\n\n');
    const chunks = splitMarkdown(text, 8);
    expect(chunks).toEqual(['第一段内容', '第二段内容', '第三段内容']);
  });

  it('超长段落硬切分并保持内容完整', () => {
    const text = '甲'.repeat(25);
    const chunks = splitMarkdown(text, 10);
    expect(chunks).toEqual(['甲'.repeat(10), '甲'.repeat(10), '甲'.repeat(5)]);
    expect(chunks.join('')).toBe(text);
  });

  it('混合段落时不丢内容', () => {
    const text = `${'甲'.repeat(12)}\n\n短段落`;
    const chunks = splitMarkdown(text, 10);
    expect(chunks.join('').replace(/\s/gu, '')).toBe('甲'.repeat(12) + '短段落');
  });
});

describe('sendTextFallback', () => {
  it('多分片发送并标注序号', async () => {
    const bodies: Array<{ markdown: { text: string } }> = [];
    const result = await sendTextFallback({
      webhook: 'https://example.com/hook',
      text: `${'甲'.repeat(10)}\n\n${'乙'.repeat(10)}`,
      maxChars: 10,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    expect(result).toEqual({ ok: true, chunks: 2 });
    expect(bodies[0]?.markdown.text).toContain('（1/2）');
    expect(bodies[1]?.markdown.text).toContain('（2/2）');
  });

  it('单片失败按退避重试后成功', async () => {
    let calls = 0;
    const result = await sendTextFallback({
      webhook: 'https://example.com/hook',
      text: '内容',
      retryDelayMs: 0,
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}', { status: calls === 1 ? 500 : 200 });
      }) as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('最终失败仍继续发送后续分片并返回错误摘要', async () => {
    let calls = 0;
    const result = await sendTextFallback({
      webhook: 'https://example.com/hook',
      text: `${'甲'.repeat(10)}\n\n${'乙'.repeat(10)}`,
      maxChars: 10,
      maxRetries: 0,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}', { status: calls === 1 ? 500 : 200 });
      }) as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1/2');
  });
});
