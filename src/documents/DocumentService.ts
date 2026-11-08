import {
  DocumentExtractionError,
  extractDocument,
  type ExtractedDocument,
  type ExtractOptions,
} from './DocumentExtractor.js';
import { convertLegacyOffice } from './LegacyConverter.js';
import { extname } from 'node:path';

/** 扫描件判定：平均每页有效字符少于该值视为无文字层 */
const MIN_CHARS_PER_PAGE = 20;

export async function extractPdf(
  buffer: Buffer,
  maxChars: number,
): Promise<ExtractedDocument> {
  let pages: string[];
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text as string[];
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (/password/i.test(message)) {
      throw new DocumentExtractionError('PDF 已加密，无法解析（请先去除密码保护）', 'corrupt');
    }
    throw new DocumentExtractionError(`PDF 解析失败：${message}`, 'corrupt');
  }
  const parts = pages.map((text, i) => `## 第 ${i + 1} 页\n${text.trim()}`);
  const body = pages.join('').replace(/\s+/g, '');
  if (pages.length === 0 || body.length / pages.length < MIN_CHARS_PER_PAGE) {
    throw new DocumentExtractionError(
      `PDF（${pages.length} 页）几乎没有文字层，可能是扫描件或纯图片。请导出为图片发送，或提供可复制文字的版本`,
      'empty',
    );
  }
  const text = parts.join('\n\n');
  const truncated = text.length > maxChars;
  return {
    format: 'pdf',
    text: truncated ? `${text.slice(0, maxChars)}\n…（已截断）` : text,
    unitCount: pages.length,
    unitLabel: '页',
    sheets: [],
    warnings: [],
    truncated,
  };
}

/**
 * 统一入口（异步）：新版 Office 与 CSV 走同步提取；
 * PDF 走 unpdf；旧版 .ppt/.doc/.xls 优先尝试 LibreOffice 转换。
 */
export async function extractAnyDocument(
  buffer: Buffer,
  fileName: string,
  options: ExtractOptions = {},
): Promise<ExtractedDocument> {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.pdf') return extractPdf(buffer, options.maxChars ?? 200_000);
  try {
    return extractDocument(buffer, fileName, options);
  } catch (error) {
    if (error instanceof DocumentExtractionError && error.reason === 'unsupported') {
      const converted = await convertLegacyOffice(buffer, fileName);
      if (converted) {
        const doc = extractDocument(converted.buffer, converted.fileName, options);
        return {
          ...doc,
          warnings: [`原文件为旧版格式，已通过 LibreOffice 转换为 ${doc.format}`, ...doc.warnings],
        };
      }
    }
    throw error;
  }
}
