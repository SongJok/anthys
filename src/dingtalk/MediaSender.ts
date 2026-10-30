import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export interface MediaSenderLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ArtifactSendInput {
  conversationId: string;
  conversationType: '1' | '2';
  senderStaffId: string;
  filePath: string;
  /** 展示给用户的文件名，默认取本地文件名 */
  fileName?: string;
}

export interface ArtifactSendResult {
  ok: boolean;
  fileName: string;
  fileSize: number;
  mediaId?: string;
  error?: string;
}

export interface DingTalkMediaSenderOptions {
  /** 支持读取最新配置，管理员热更新 RobotCode 后无需重启 */
  robotCode: string | (() => string);
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  logger?: MediaSenderLogger;
  uploadEndpoint?: string;
  apiBase?: string;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_API_BASE = 'https://api.dingtalk.com';
const OAPI_MEDIA_UPLOAD = 'https://oapi.dingtalk.com/media/upload';

const FILE_TYPE_BY_EXT: Record<string, string> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.zip': 'zip',
  '.rar': 'rar',
  '.txt': 'txt',
  '.csv': 'csv',
  '.md': 'md',
  '.json': 'json',
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.bmp': 'bmp',
  '.mp3': 'mp3',
  '.mp4': 'mp4',
  '.amr': 'amr',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileTypeFor(fileName: string): string {
  return FILE_TYPE_BY_EXT[extname(fileName).toLowerCase()] ?? 'file';
}

/**
 * 把智能体产出的本地文件投递给钉钉会话：
 * 先走 oapi 媒体上传拿到 mediaId，再按单聊/群聊调用机器人文件消息接口。
 */
export class DingTalkMediaSender {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly uploadEndpoint: string;
  private readonly apiBase: string;

  constructor(private readonly options: DingTalkMediaSenderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.uploadEndpoint = options.uploadEndpoint ?? OAPI_MEDIA_UPLOAD;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, '');
  }

  public async send(input: ArtifactSendInput): Promise<ArtifactSendResult> {
    const fileName = input.fileName?.trim() || basename(input.filePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(input.filePath);
    } catch (error) {
      return {
        ok: false,
        fileName,
        fileSize: 0,
        error: `读取文件失败：${errorMessage(error)}`,
      };
    }
    if (bytes.byteLength > this.maxBytes) {
      return {
        ok: false,
        fileName,
        fileSize: bytes.byteLength,
        error: `文件超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`,
      };
    }

    try {
      const mediaId = await this.upload(bytes, fileName);
      await this.deliver(input, fileName, bytes.byteLength, mediaId);
      this.options.logger?.info?.(
        {
          conversationId: input.conversationId,
          fileName,
          fileSize: bytes.byteLength,
        },
        'artifact delivered',
      );
      return {
        ok: true,
        fileName,
        fileSize: bytes.byteLength,
        mediaId,
      };
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId: input.conversationId,
          fileName,
          error: errorMessage(error),
        },
        'artifact delivery failed',
      );
      return {
        ok: false,
        fileName,
        fileSize: bytes.byteLength,
        error: errorMessage(error),
      };
    }
  }

  private async upload(bytes: Buffer, fileName: string): Promise<string> {
    const token = await this.options.getAccessToken();
    const form = new FormData();
    form.append(
      'media',
      new Blob([new Uint8Array(bytes)]),
      fileName,
    );
    const response = await this.fetchImpl(
      `${this.uploadEndpoint}?access_token=${encodeURIComponent(token)}&type=file`,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`媒体上传失败: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
    };
    if (payload.errcode !== undefined && payload.errcode !== 0) {
      throw new Error(`媒体上传失败: ${payload.errmsg ?? payload.errcode}`);
    }
    if (!payload.media_id) throw new Error('媒体上传失败: 缺少 media_id');
    return payload.media_id;
  }

  private async deliver(
    input: ArtifactSendInput,
    fileName: string,
    fileSize: number,
    mediaId: string,
  ): Promise<void> {
    const token = await this.options.getAccessToken();
    const msgParam = JSON.stringify({
      mediaId,
      fileName,
      fileSize,
      fileType: fileTypeFor(fileName),
    });
    const isGroup = input.conversationType === '2';
    const robotCode =
      typeof this.options.robotCode === 'function'
        ? this.options.robotCode()
        : this.options.robotCode;
    const endpoint = isGroup
      ? `${this.apiBase}/v1.0/robot/groupMessages/send`
      : `${this.apiBase}/v1.0/robot/oToMessages/batchSend`;
    const body = isGroup
      ? {
          robotCode,
          openConversationId: input.conversationId,
          msgKey: 'sampleFile',
          msgParam,
        }
      : {
          robotCode,
          userIds: [input.senderStaffId],
          msgKey: 'sampleFile',
          msgParam,
        };
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `文件消息发送失败: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
      );
    }
  }
}
