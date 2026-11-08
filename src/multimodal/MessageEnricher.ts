import type { InboundMessage } from '../types/core.js';
import type {
  AttachmentFailure,
  AttachmentStoreResult,
  StoredAttachment,
} from './AttachmentStore.js';
import type { VisionDescriber } from './VisionDescriber.js';
import { digestAttachment, type AttachmentDigest } from './AttachmentDigest.js';

export interface MessageEnricherLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MessageEnricherDeps {
  store: { store(message: InboundMessage): Promise<AttachmentStoreResult> };
  vision?: VisionDescriber;
  logger?: MessageEnricherLogger;
  /** 是否对 pptx/docx/xlsx/csv 做文本提取，默认开启 */
  documents?: boolean;
  /** 文档解析结果回调（用于指标） */
  onDocument?(info: { format?: string; ok: boolean; reason?: string; fileName: string }): void;
}

export interface EnrichmentResult {
  message: InboundMessage;
  attachments: StoredAttachment[];
  failed: AttachmentFailure[];
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function typeLabel(type: StoredAttachment['type']): string {
  switch (type) {
    case 'image':
      return '图片';
    case 'audio':
      return '语音';
    case 'video':
      return '视频';
    default:
      return '文件';
  }
}

/** 把落盘附件与图片识别结果渲染为提示词片段 */
export function renderAttachmentSection(
  stored: StoredAttachment[],
  descriptions: ReadonlyMap<string, string | null>,
  failed: AttachmentFailure[],
  digests: ReadonlyMap<string, AttachmentDigest | null> = new Map(),
): string {
  if (stored.length === 0 && failed.length === 0) return '';
  const lines: string[] = ['【用户附件】'];
  for (const item of stored) {
    lines.push(
      `- ${typeLabel(item.type)}「${item.fileName}」本地路径：${item.localPath}（${formatSize(item.size)}）`,
    );
    const description = descriptions.get(item.localPath);
    if (description) {
      lines.push(`  识别内容：${description}`);
    } else if (item.type === 'image') {
      lines.push('  识别内容：（视觉模型未启用或识别失败，仅保留本地路径）');
    }
    const digest = digests.get(item.localPath);
    if (digest?.ok) {
      lines.push(`  文档解析成功（${digest.format}，${digest.summary}），以下为提取的正文：`);
      lines.push(digest.preview ?? '');
      if (digest.textPath) lines.push(`  完整提取文本：${digest.textPath}`);
      for (const csv of digest.csvPaths) {
        lines.push(`  表格数据「${csv.name}」${csv.rowCount} 行 CSV：${csv.path}`);
      }
      for (const warning of digest.warnings) lines.push(`  注意：${warning}`);
    } else if (digest && !digest.ok) {
      lines.push(
        `  文档解析失败：${digest.error}。请如实告知用户该原因和处理办法，不要让用户联系管理员，也不要编造文件内容。`,
      );
    }
  }
  for (const item of failed) {
    lines.push(
      `- ${typeLabel(item.type)}${item.fileName ? `「${item.fileName}」` : ''}下载失败：${item.error}`,
    );
  }
  lines.push(
    '说明：文本/CSV/JSON/Markdown 及已解析的 Office 附件可用 workspace_read_file 读取（pptx/docx/xlsx 会自动转为文本），整表分析可把路径传给 sandbox_analyze_and_aggregate 的 datasetKeys；回答时直接说明附件结论，无需复述路径。',
  );
  return lines.join('\n');
}

/**
 * 入站增强：下载附件、识别图片并拼进用户文本，
 * 让纯文本主模型也能拿到「图片讲了什么」。
 */
export async function enrichInboundMessage(
  message: InboundMessage,
  deps: MessageEnricherDeps,
): Promise<EnrichmentResult> {
  if (!message.attachments || message.attachments.length === 0) {
    return { message, attachments: [], failed: [] };
  }
  const { stored, failed } = await deps.store.store(message);
  const descriptions = new Map<string, string | null>();
  if (deps.vision) {
    for (const attachment of stored) {
      if (attachment.type !== 'image') continue;
      descriptions.set(
        attachment.localPath,
        await deps.vision.describe(attachment),
      );
    }
  }
  const digests = new Map<string, AttachmentDigest | null>();
  if (deps.documents !== false) {
    for (const attachment of stored) {
      try {
        const digest = await digestAttachment(attachment, {
          ...(deps.vision ? { vision: deps.vision } : {}),
        });
        digests.set(attachment.localPath, digest);
        if (digest) {
          deps.onDocument?.({
            fileName: attachment.fileName,
            ok: digest.ok,
            ...(digest.format ? { format: digest.format } : {}),
            ...(digest.errorReason ? { reason: digest.errorReason } : {}),
          });
        }
        if (digest && !digest.ok) {
          deps.logger?.warn(
            { file: attachment.fileName, reason: digest.errorReason },
            digest.error ?? '文档解析失败',
          );
        }
      } catch (error) {
        deps.logger?.warn({ err: String(error) }, '文档解析异常');
      }
    }
  }
  const section = renderAttachmentSection(stored, descriptions, failed, digests);
  if (!section) return { message, attachments: stored, failed };
  return {
    message: {
      ...message,
      text: message.text.trim() ? `${message.text}\n\n${section}` : section,
    },
    attachments: stored,
    failed,
  };
}
