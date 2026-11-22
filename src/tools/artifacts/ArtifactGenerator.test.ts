import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDocument } from '../../documents/DocumentExtractor.js';
import {
  buildDocxBuffer,
  buildXlsxBuffer,
  generateWorkspaceArtifact,
} from './ArtifactGenerator.js';

describe('ArtifactGenerator', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-gen-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('生成多工作表 xlsx 并可被 DocumentExtractor 完整解析回读', async () => {
    const generated = await generateWorkspaceArtifact(root, {
      format: 'xlsx',
      fileName: '销售汇总',
      sheets: [
        {
          name: '区域统计',
          headers: ['区域', '订单数', '达标'],
          rows: [
            ['华东', 120, true],
            ['华北', 85, false],
          ],
        },
        {
          name: '明细',
          headers: ['ID', '备注'],
          rows: [['ORD-1', '特殊字符 <&>"']],
        },
      ],
    });

    expect(generated.fileName).toBe('销售汇总.xlsx');
    expect(generated.workspaceRelativePath).toMatch(/^generated\/\d{8}\/doc_/);
    const buffer = await readFile(generated.absolutePath);
    const extracted = extractDocument(buffer, generated.fileName);
    expect(extracted.format).toBe('xlsx');
    expect(extracted.unitCount).toBe(2);
    expect(extracted.text).toContain('华东');
    expect(extracted.text).toContain('120');
    expect(extracted.text).toContain('特殊字符 <&>"');
  });

  it('生成 docx 文档并可被 DocumentExtractor 完整解析回读', async () => {
    const generated = await generateWorkspaceArtifact(root, {
      format: 'docx',
      fileName: '排障复盘.docx',
      title: '支付网关超时复盘报告',
      content: [
        '# 故障概要',
        '10:05 出现连接池打满。',
        '## 后续行动项',
        '- 调大连接池上限',
        '- 补齐慢 SQL 告警',
      ].join('\n'),
    });

    const buffer = await readFile(generated.absolutePath);
    const extracted = extractDocument(buffer, generated.fileName);
    expect(extracted.format).toBe('docx');
    expect(extracted.text).toContain('支付网关超时复盘报告');
    expect(extracted.text).toContain('故障概要');
    expect(extracted.text).toContain('调大连接池上限');
  });

  it('生成带 UTF-8 BOM 的 CSV 以及格式化 JSON / HTML', async () => {
    const csv = await generateWorkspaceArtifact(root, {
      format: 'csv',
      fileName: 'data',
      sheets: [
        {
          headers: ['姓名', '说明'],
          rows: [['张三', '含逗号,与"引号"']],
        },
      ],
    });
    const csvRaw = await readFile(csv.absolutePath, 'utf8');
    expect(csvRaw.startsWith('\uFEFF')).toBe(true);
    expect(csvRaw).toContain('"含逗号,与""引号"""');

    const html = await generateWorkspaceArtifact(root, {
      format: 'html',
      fileName: 'summary.html',
      title: '测试报告',
      content: '<h1>结论</h1><p>一切正常</p>',
    });
    const htmlRaw = await readFile(html.absolutePath, 'utf8');
    expect(htmlRaw).toContain('<title>测试报告</title>');
    expect(htmlRaw).toContain('<h1>结论</h1>');
  });

  it('超过大小上限时拒绝生成', async () => {
    await expect(
      generateWorkspaceArtifact(
        root,
        { format: 'txt', fileName: 'big.txt', content: 'x'.repeat(200) },
        { maxBytes: 50 },
      ),
    ).rejects.toThrow('上限');
  });

  it('非法格式或缺失必填数据时抛出明确错误', () => {
    expect(() => buildXlsxBuffer([])).toThrow('工作表');
    expect(buildDocxBuffer('纯文本').length).toBeGreaterThan(100);
  });
});
