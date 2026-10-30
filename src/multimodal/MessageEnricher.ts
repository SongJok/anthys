import type { InboundMessage } from '../types/core.js';
import type {
  AttachmentFailure,
  AttachmentStoreResult,
  StoredAttachment,
} from './AttachmentStore.js';
import type { VisionDescriber } from './VisionDescriber.js';

export interface MessageEnricherLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MessageEnricherDeps {
  store: { store(message: InboundMessage): Promise<AttachmentStoreResult> };
  vision?: VisionDescriber;
  logger?: MessageEnricherLogger;
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
  }
  for (const item of failed) {
    lines.push(
      `- ${typeLabel(item.type)}${item.fileName ? `「${item.fileName}」` : ''}下载失败：${item.error}`,
    );
  }
  lines.push(
    '说明：可借助沙盒或 DWS 工具读取上述本地路径；回答时直接说明附件结论，无需复述路径。',
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
  const section = renderAttachmentSection(stored, descriptions, failed);
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
