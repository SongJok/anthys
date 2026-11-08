import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extractAnyDocument } from '../documents/DocumentService.js';
import {
  DocumentExtractionError,
  isExtractableExtension,
  type ExtractedDocument,
} from '../documents/DocumentExtractor.js';
import type { StoredAttachment } from './AttachmentStore.js';
import type { VisionDescriber } from './VisionDescriber.js';

export interface AttachmentDigest {
  ok: boolean;
  format?: string;
  /** 给用户/模型看的一行概要，如“12 页” */
  summary?: string;
  /** 内联到提示词的文本预览 */
  preview?: string;
  /** 完整提取文本的落盘路径（workspace_read_file 可读） */
  textPath?: string;
  /** 每个工作表的 CSV 路径（可传给 sandbox datasetKeys） */
  csvPaths: Array<{ name: string; path: string; rowCount: number }>;
  warnings: string[];
  /** 失败原因（面向用户的中文说明） */
  error?: string;
  errorReason?: DocumentExtractionError['reason'] | 'io';
}

export const DEFAULT_PREVIEW_CHARS = 8_000;

function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 40) || 'sheet';
}

/** 对一个已落盘附件做文本提取，并把完整结果写成旁路文件 */
export async function digestAttachment(
  attachment: StoredAttachment,
  options: { previewChars?: number; vision?: VisionDescriber } = {},
): Promise<AttachmentDigest | null> {
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  if (attachment.type !== 'file' || !isExtractableExtension(attachment.fileName)) {
    return null;
  }
  let doc: ExtractedDocument;
  try {
    const buffer = await readFile(attachment.localPath);
    doc = await extractAnyDocument(buffer, attachment.fileName);
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      return {
        ok: false,
        error: error.message,
        errorReason: error.reason,
        csvPaths: [],
        warnings: [],
      };
    }
    return {
      ok: false,
      error: `读取附件失败：${(error as Error).message}`,
      errorReason: 'io',
      csvPaths: [],
      warnings: [],
    };
  }

  // 内嵌图片 → 视觉识别（需启用视觉模型），结果并入正文预览
  let imageSection = '';
  if (options.vision && doc.images && doc.images.length > 0) {
    const dir = `${attachment.localPath}.media`;
    const lines: string[] = [];
    try {
      await mkdir(dir, { recursive: true });
      for (const [i, image] of doc.images.entries()) {
        const path = `${dir}/${i}-${safeName(image.fileName)}`;
        await writeFile(path, image.data);
        const description = await options.vision.describe({
          type: 'image',
          fileName: image.fileName,
          localPath: path,
          size: image.data.length,
          mimeType: image.mimeType,
        });
        if (description) lines.push(`- ${image.label}的图片（${image.fileName}）：${description.replace(/\n+/g, ' ')}`);
      }
    } catch {
      // 图片识别失败不影响文字
    }
    if (lines.length > 0) imageSection = `\n\n## 内嵌图片识别\n${lines.join('\n')}`;
  }
  if (imageSection) doc = { ...doc, text: doc.text + imageSection };

  const textPath = `${attachment.localPath}.extracted.md`;
  const csvPaths: AttachmentDigest['csvPaths'] = [];
  try {
    await writeFile(textPath, doc.text, 'utf8');
    if (doc.format === 'xlsx' || doc.format === 'csv') {
      for (const [i, sheet] of doc.sheets.entries()) {
        const path = `${attachment.localPath}.${i}-${safeName(sheet.name)}.csv`;
        // 原生 utf-8 csv 无需重复落盘，除非发生了转码
        if (doc.format === 'csv' && doc.warnings.length === 0) continue;
        await writeFile(path, `\uFEFF${sheet.csv}`, 'utf8');
        csvPaths.push({ name: sheet.name, path, rowCount: sheet.rowCount });
      }
    }
  } catch {
    // 旁路文件写入失败不影响内联预览
  }

  const preview =
    doc.text.length > previewChars
      ? `${doc.text.slice(0, previewChars)}\n…（预览已截断，完整文本见 ${textPath}）`
      : doc.text;
  return {
    ok: true,
    format: doc.format,
    summary: `${doc.unitCount} ${doc.unitLabel}`,
    preview,
    textPath,
    csvPaths,
    warnings: doc.warnings,
  };
}
