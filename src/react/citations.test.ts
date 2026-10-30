import { describe, expect, it } from 'vitest';
import { extractCitations } from './citations.js';

describe('extractCitations', () => {
  it('从工具输出中提取去重后的来源链接', () => {
    const citations = extractCitations(
      '部署手册见 https://wiki.example.com/docs/deploy-guide，' +
        '变更单：https://ops.example.com/tickets/42。' +
        '重复链接 https://wiki.example.com/docs/deploy-guide',
      'mcp__wiki__search',
    );
    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      index: 1,
      title: 'deploy-guide',
      url: 'https://wiki.example.com/docs/deploy-guide',
      source: 'mcp__wiki__search',
    });
    expect(citations[1]).toMatchObject({
      index: 2,
      title: '42',
      url: 'https://ops.example.com/tickets/42',
    });
  });

  it('剔除尾部标点并限制条数', () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => `链接 https://example.com/a${i})`,
    ).join(' ');
    const citations = extractCitations(text, 'tool', 3);
    expect(citations).toHaveLength(3);
    expect(citations[0]?.url).toBe('https://example.com/a0');
  });

  it('没有链接时返回空数组', () => {
    expect(extractCitations('没有链接的结果', 'tool')).toEqual([]);
    expect(extractCitations('', 'tool')).toEqual([]);
  });
});
