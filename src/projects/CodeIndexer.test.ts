import { describe, expect, it } from 'vitest';
import {
  buildChunks,
  buildRepoMap,
  extractSymbols,
  renderRepoMap,
} from './CodeIndexer.js';

describe('CodeIndexer 符号提取', () => {
  it('提取 TypeScript 类、方法、函数、箭头函数和测试', () => {
    const text = [
      'import { x } from "./x.js";',
      '',
      'export class ToolRegistry {',
      '  constructor(private readonly items: string[]) {}',
      '',
      '  public register(name: string): void {',
      '    this.items.push(name);',
      '  }',
      '}',
      '',
      'export function createRegistry(): ToolRegistry {',
      '  return new ToolRegistry([]);',
      '}',
      '',
      'export const runAll = async (items: string[]) => {',
      '  return items.length;',
      '};',
      '',
      'interface Options {',
      '  enabled: boolean;',
      '}',
      '',
      'type Registry = ToolRegistry;',
      '',
      "describe('registry', () => {",
      "  it('registers', () => {});",
      '});',
    ].join('\n');
    const symbols = extractSymbols('src/registry.ts', 'typescript', text);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get('ToolRegistry')).toMatchObject({
      kind: 'class',
      startLine: 3,
      exported: true,
    });
    expect(byName.get('register')).toMatchObject({
      kind: 'method',
      parent: 'ToolRegistry',
      startLine: 6,
    });
    expect(byName.get('createRegistry')).toMatchObject({
      kind: 'function',
      exported: true,
    });
    expect(byName.get('runAll')).toMatchObject({ kind: 'function' });
    expect(byName.get('Options')).toMatchObject({ kind: 'interface' });
    expect(byName.get('Registry')).toMatchObject({ kind: 'type' });
    expect(byName.get('registry')).toMatchObject({ kind: 'test' });
  });

  it('提取 Python、Go 和 Markdown 符号', () => {
    const python = extractSymbols(
      'app.py',
      'python',
      [
        'class Service:',
        '    def run(self):',
        '        return 1',
        '',
        'def helper():',
        '    return 2',
      ].join('\n'),
    );
    expect(python.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ['Service', 'class'],
      ['run', 'method'],
      ['helper', 'function'],
    ]);

    const go = extractSymbols(
      'server.go',
      'go',
      [
        'type Server struct {',
        '  Name string',
        '}',
        '',
        'func (s *Server) Start() error {',
        '  return nil',
        '}',
      ].join('\n'),
    );
    expect(go.find((symbol) => symbol.name === 'Server')?.kind).toBe('struct');
    expect(go.find((symbol) => symbol.name === 'Start')).toMatchObject({
      kind: 'method',
      parent: 'Server',
    });

    const markdown = extractSymbols(
      'docs/guide.md',
      'markdown',
      ['# 标题', '', '正文', '', '## 小节', '内容', '', '## 下一节'].join('\n'),
    );
    expect(markdown.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ['标题', 'heading'],
      ['小节', 'heading'],
      ['下一节', 'heading'],
    ]);
    expect(markdown[1]?.endLine).toBe(7);
  });

  it('忽略 Markdown 代码块中的 # 注释', () => {
    const symbols = extractSymbols(
      'README.md',
      'markdown',
      ['# 真标题', '', '```bash', '# 这是注释', '```', '', '## 子标题'].join('\n'),
    );
    expect(symbols.map((symbol) => symbol.name)).toEqual(['真标题', '子标题']);
  });
});

describe('CodeIndexer 分块', () => {
  it('无符号时按 60 行窗口、10 行重叠切分', () => {
    const text = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join('\n');
    const chunks = buildChunks(
      {
        path: 'src/big.ts',
        language: 'typescript',
        kind: 'code',
        text,
        lineCount: 150,
      },
      [],
    );
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 60, symbol: '' });
    expect(chunks[1]).toMatchObject({ startLine: 51, endLine: 110 });
    expect(chunks[2]).toMatchObject({ startLine: 101, endLine: 150 });
    expect(chunks.every((chunk) => chunk.content.length <= 8 * 1024)).toBe(true);
  });

  it('有符号时按符号边界切分并保留符号名', () => {
    const lines = [
      'const header = 1;',
      '',
      'export class Demo {',
      '  value = 1;',
      '}',
      '',
      'export function helper() {',
      '  return 2;',
      '}',
    ];
    const symbols = extractSymbols('src/demo.ts', 'typescript', lines.join('\n'));
    const chunks = buildChunks(
      {
        path: 'src/demo.ts',
        language: 'typescript',
        kind: 'code',
        text: lines.join('\n'),
        lineCount: lines.length,
      },
      symbols,
    );
    expect(chunks.some((chunk) => chunk.symbol === 'Demo' && chunk.startLine === 3)).toBe(true);
    expect(chunks.some((chunk) => chunk.symbol === 'helper' && chunk.startLine === 7)).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length > 0)).toBe(true);
  });
});

describe('CodeIndexer 仓库地图', () => {
  it('按目录组织并带 path:line，受 maxTokens 限制', () => {
    const symbols = extractSymbols(
      'src/harness/ToolRegistry.ts',
      'typescript',
      ['export class ToolRegistry {', '  register() {}', '}'].join('\n'),
    );
    const result = buildRepoMap({
      projectId: 'anthys',
      commit: 'abcdef1234567890',
      files: [
        { path: 'src/harness/ToolRegistry.ts', language: 'typescript', lineCount: 3 },
        { path: 'README.md', language: 'markdown', lineCount: 1 },
      ],
      symbols,
      maxTokens: 500,
    });
    expect(result.text).toContain('anthys @ abcdef123456');
    expect(result.text).toContain('src/harness/');
    expect(result.text).toContain('ToolRegistry:1');
    expect(result.totalFiles).toBe(2);
    expect(renderRepoMap(result)).toBe(result.text);
    expect(result.text.length).toBeLessThanOrEqual(500 * 4 + 20);
  });
});
