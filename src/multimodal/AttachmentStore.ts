import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { InboundAttachment, InboundMessage } from '../types/core.js';

export interface StoredAttachment {
  type: InboundAttachment['type'];
  fileName: string;
  localPath: string;
  size: number;
  mimeType?: string;
}

export interface AttachmentFailure {
  type: InboundAttachment['type'];
  fileName?: string;
  error: string;
}

export interface AttachmentStoreResult {
  stored: StoredAttachment[];
  failed: AttachmentFailure[];
}

export interface AttachmentStoreLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AttachmentStoreOptions {
  /** 附件落盘根目录，通常为 <workspace>/attachments */
  rootDir: string;
  robotCode: string | (() => string);
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** 单个附件上限，默认 20MB */
  maxBytes?: number;
  timeoutMs?: number;
  logger?: AttachmentStoreLogger;
  downloadEndpoint?: string;
}

const DOWNLOAD_ENDPOINT =
  'https://api.dingtalk.com/v1.0/robot/messageFiles/download';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.zip': 'application/zip',
};

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/u, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function fallbackName(type: InboundAttachment['type']): string {
  switch (type) {
    case 'image':
      return 'image.png';
    case 'audio':
      return 'audio.amr';
    case 'video':
      return 'video.mp4';
    default:
      return 'file.bin';
  }
}

function mimeFor(fileName: string, header: string | null): string | undefined {
  const ext = extname(fileName).toLowerCase();
  const byExt = MIME_BY_EXT[ext];
  if (byExt) return byExt;
  const normalized = header?.split(';')[0]?.trim();
  return normalized && normalized !== 'application/octet-stream'
    ? normalized
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 机器人媒体消息只提供 downloadCode：先用 OpenAPI 换取 downloadUrl，
 * 再把字节落盘到本地目录，供视觉模型与沙盒工具读取。
 */
export class AttachmentStore {
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(private readonly options: AttachmentStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.endpoint = options.downloadEndpoint ?? DOWNLOAD_ENDPOINT;
  }

  public async store(message: InboundMessage): Promise<AttachmentStoreResult> {
    const stored: StoredAttachment[] = [];
    const failed: AttachmentFailure[] = [];
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) return { stored, failed };

    const dir = join(
      this.options.rootDir,
      sanitizeSegment(message.messageId, 'message'),
    );
    await mkdir(dir, { recursive: true });

    for (const [index, attachment] of attachments.entries()) {
      try {
        const file = await this.download(attachment);
        if (file.size > this.maxBytes) {
          throw new Error(
            `附件超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`,
          );
        }
        const fileName = sanitizeSegment(
          file.fileName || attachment.fileName || fallbackName(attachment.type),
          fallbackName(attachment.type),
        );
        const localPath = join(dir, `${index}-${fileName}`);
        await writeFile(localPath, file.bytes);
        const mimeType = mimeFor(fileName, file.contentType);
        stored.push({
          type: attachment.type,
          fileName,
          localPath,
          size: file.size,
          ...(mimeType ? { mimeType } : {}),
        });
      } catch (error) {
        failed.push({
          type: attachment.type,
          ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
          error: errorMessage(error),
        });
        this.options.logger?.warn(
          {
            messageId: message.messageId,
            type: attachment.type,
            error: errorMessage(error),
          },
          'attachment download failed',
        );
      }
    }

    if (stored.length > 0) {
      this.options.logger?.info?.(
        { messageId: message.messageId, files: stored.map((item) => item.fileName) },
        'attachments stored',
      );
    }
    return { stored, failed };
  }

  private async download(attachment: InboundAttachment): Promise<{
    bytes: Uint8Array;
    size: number;
    fileName?: string;
    contentType: string | null;
  }> {
    const token = await this.options.getAccessToken();
    const robotCode =
      typeof this.options.robotCode === 'function'
        ? this.options.robotCode()
        : this.options.robotCode;
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        downloadCode: attachment.downloadCode,
        robotCode,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`下载码换取失败: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      downloadUrl?: unknown;
      fileName?: unknown;
    };
    const downloadUrl =
      typeof payload.downloadUrl === 'string' ? payload.downloadUrl : '';
    if (!downloadUrl) throw new Error('下载码换取失败: 响应缺少 downloadUrl');

    const fileResponse = await this.fetchImpl(downloadUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!fileResponse.ok) {
      throw new Error(`附件下载失败: HTTP ${fileResponse.status}`);
    }
    const declared = Number(fileResponse.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new Error(
        `附件超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`,
      );
    }
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    return {
      bytes,
      size: bytes.byteLength,
      ...(typeof payload.fileName === 'string' && payload.fileName
        ? { fileName: payload.fileName }
        : {}),
      contentType: fileResponse.headers.get('content-type'),
    };
  }
}
