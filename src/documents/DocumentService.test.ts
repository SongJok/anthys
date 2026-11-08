import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { digestAttachment } from '../multimodal/AttachmentDigest.js';
import { DocumentExtractionError } from './DocumentExtractor.js';
import { extractAnyDocument } from './DocumentService.js';
import { makeZip } from './DocumentExtractor.test.js';

/** 手写最小单页 PDF（含文字层） */
function makePdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 18 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

describe('extractAnyDocument', () => {
  it('提取 PDF 文字层', async () => {
    const doc = await extractAnyDocument(
      makePdf('Quarterly robot operations report for the whole team'),
      'a.pdf',
    );
    expect(doc.format).toBe('pdf');
    expect(doc.text).toContain('Quarterly robot operations');
  });

  it('无文字层 PDF 给出扫描件提示', async () => {
    await expect(extractAnyDocument(makePdf(' '), 'scan.pdf')).rejects.toBeInstanceOf(
      DocumentExtractionError,
    );
  });

  it('旧版格式在无 LibreOffice 时保持另存为提示', async () => {
    const prev = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = '/nonexistent/soffice';
    try {
      await expect(
        extractAnyDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0]), 'a.ppt'),
      ).rejects.toThrow(/另存为/);
    } finally {
      if (prev === undefined) delete process.env.SOFFICE_PATH;
      else process.env.SOFFICE_PATH = prev;
    }
  }, 60_000);
});

describe('digestAttachment', () => {
  it('落盘旁路文件，并对内嵌大图调用视觉识别', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digest-'));
    const png = Buffer.alloc(20 * 1024, 1);
    const buf = makeZip({
      'word/document.xml':
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>正文一句</w:t></w:r></w:p></w:body></w:document>',
      'word/media/image1.png': png.toString('latin1'),
    });
    const path = join(dir, '0-a.docx');
    await writeFile(path, buf);
    const vision = { describe: vi.fn().mockResolvedValue('架构图：A→B') };
    const digest = await digestAttachment(
      { type: 'file', fileName: 'a.docx', localPath: path, size: buf.length },
      { vision },
    );
    expect(vision.describe).toHaveBeenCalledTimes(1);
    expect(digest?.ok).toBe(true);
    expect(digest?.preview).toContain('内嵌图片识别');
    expect(digest?.preview).toContain('架构图：A→B');
    expect(await readFile(digest!.textPath!, 'utf8')).toContain('正文一句');
  });

  it('失败时返回可读原因', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digest-'));
    const path = join(dir, '0-bad.pptx');
    await writeFile(path, 'garbage-garbage-garbage-garbage');
    const digest = await digestAttachment({
      type: 'file',
      fileName: 'bad.pptx',
      localPath: path,
      size: 10,
    });
    expect(digest?.ok).toBe(false);
    expect(digest?.error).toBeTruthy();
  });
});
