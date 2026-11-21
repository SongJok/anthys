import { readFile } from 'node:fs/promises';
import type { StoredAttachment } from './AttachmentStore.js';

export type VisionReasoningEffort = 'low' | 'medium' | 'high';

export interface VisionLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
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
  /** 单次输出上限；推理模型的推理 token 也计入该上限 */
  maxTokens?: number;
  /** 仅显式配置时下发，避免非兼容供应商拒绝该字段 */
  reasoningEffort?: VisionReasoningEffort;
  prompt?: string;
  logger?: VisionLogger;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
}

interface VisionResponse {
  content: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}

const DEFAULT_MAX_TOKENS = 4096;
const MAX_RETRY_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 90_000;

const DEFAULT_PROMPT = [
  '请把图片转换成可检索的纯文本，供后续问答直接使用。',
  '1) 若图片含文档、试卷、表格、代码或大段文字：逐字转录全部可见内容，保留标题、题号、分值与表格结构；数学公式用 LaTeX；不总结、不省略、不解题；看不清的内容标 [不清晰]。',
  '2) 若是界面截图或普通照片：按顺序列出关键文字、数字、报错信息与界面元素，再补充场景描述。',
  '只输出转换结果，不要寒暄。',
].join('\n');

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 通过 OpenAI 兼容的多模态接口把图片转成文字，供纯文本主模型使用。
 * 文档/试卷走逐字转录而不是泛化描述；输出被截断时自动扩容重试一次。
 */
export class OpenAiVisionDescriber implements VisionDescriber {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxTokens: number;
  private readonly reasoningEffort?: VisionReasoningEffort;
  private readonly prompt: string;

  constructor(private readonly options: OpenAiVisionOptions) {
    const base = options.baseUrl.replace(/\/+$/u, '');
    this.endpoint = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxTokens = Math.max(256, options.maxTokens ?? DEFAULT_MAX_TOKENS);
    this.reasoningEffort = options.reasoningEffort;
    this.prompt = options.prompt ?? DEFAULT_PROMPT;
  }

  public async describe(
    attachment: StoredAttachment,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    if (attachment.type !== 'image') return null;
    if (options.signal?.aborted) return null;
    try {
      const bytes = await readFile(attachment.localPath);
      if (options.signal?.aborted) return null;
      if (bytes.byteLength > this.maxBytes) {
        throw new Error(`图片超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`);
      }
      const dataUrl = `data:${attachment.mimeType ?? 'image/png'};base64,${bytes.toString('base64')}`;

      let budget = this.maxTokens;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const started = Date.now();
        const result = await this.request(dataUrl, budget, options.signal);
        const truncated = result.finishReason === 'length';
        const nextBudget = Math.min(budget * 2, MAX_RETRY_MAX_TOKENS);
        if (truncated && nextBudget > budget && !options.signal?.aborted) {
          this.options.logger?.warn(
            {
              file: attachment.fileName,
              attempt,
              maxTokens: budget,
              nextMaxTokens: nextBudget,
              chars: result.content.length,
            },
            'vision response truncated, retrying with larger budget',
          );
          budget = nextBudget;
          continue;
        }
        if (truncated) {
          this.options.logger?.warn(
            {
              file: attachment.fileName,
              attempt,
              maxTokens: budget,
              chars: result.content.length,
            },
            'vision response still truncated, keep partial transcription',
          );
        }
        this.options.logger?.info?.(
          {
            file: attachment.fileName,
            model: this.options.model,
            attempt,
            maxTokens: budget,
            durationMs: Date.now() - started,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            reasoningTokens: result.reasoningTokens,
            finishReason: result.finishReason,
            chars: result.content.length,
            truncated,
          },
          'vision describe completed',
        );
        const content = result.content.trim();
        if (!content) return null;
        return truncated
          ? `${content}\n\n（图片内容较多，以上识别可能不完整；可把图片分块发送或补充文字后重试。）`
          : content;
      }
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

  private async request(
    dataUrl: string,
    maxTokens: number,
    callerSignal?: AbortSignal,
  ): Promise<VisionResponse> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([timeoutSignal, callerSignal])
      : timeoutSignal;
    const body: Record<string, unknown> = {
      model: this.options.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: this.prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    };
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`视觉接口返回 HTTP ${response.status}`);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    return {
      content: typeof content === 'string' ? content : '',
      finishReason:
        typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      promptTokens: asNumber(payload.usage?.prompt_tokens),
      completionTokens: asNumber(payload.usage?.completion_tokens),
      reasoningTokens: asNumber(
        payload.usage?.completion_tokens_details?.reasoning_tokens,
      ),
    };
  }
}