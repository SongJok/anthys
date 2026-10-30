import { readFile } from 'node:fs/promises';
import type { StoredAttachment } from './AttachmentStore.js';

export interface VisionConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VisionLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface VisionDescriber {
  describe(attachment: StoredAttachment): Promise<string | null>;
}

export interface OpenAiVisionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  logger?: VisionLogger;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

const DEFAULT_PROMPT =
  '请用中文客观描述这张图片：先说明图片类型（截图/照片/图表/文档扫描等），' +
  '再逐条列出关键文字、数字、报错信息与界面元素。只输出描述，不要寒暄。';

/**
 * 通过 OpenAI 兼容的多模态接口把图片转成文字描述，
 * 让只支持文本的主模型也能理解用户发来的截图。
 */
export class OpenAiVisionDescriber implements VisionDescriber {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: OpenAiVisionOptions) {
    const base = options.baseUrl.replace(/\/+$/u, '');
    this.endpoint = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  public async describe(attachment: StoredAttachment): Promise<string | null> {
    if (attachment.type !== 'image') return null;
    try {
      const bytes = await readFile(attachment.localPath);
      if (bytes.byteLength > this.maxBytes) {
        throw new Error(`图片超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`);
      }
      const mime = attachment.mimeType ?? 'image/png';
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0.2,
          max_tokens: 800,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: DEFAULT_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`视觉接口返回 HTTP ${response.status}`);
      }
      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) return null;
      return content.trim();
    } catch (error) {
      this.options.logger?.warn(
        {
          file: attachment.fileName,
          error: error instanceof Error ? error.message : String(error),
        },
        'vision describe failed, image passed as local path only',
      );
      return null;
    }
  }
}
