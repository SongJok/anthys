import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { StoredAttachment } from './AttachmentStore.js';

export interface AudioTranscriber {
  transcribe(
    attachment: StoredAttachment,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
}

export interface AudioAsrConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxAudioBytes: number;
  language?: string;
}

export interface OpenAiAudioTranscriberOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
  language?: string;
  fetchImpl?: typeof fetch;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.amr',
  '.ogg',
  '.opus',
  '.flac',
  '.webm',
  '.aac',
]);

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.amr': 'audio/amr',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function isAudioFileName(fileName: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export function resolveAudioAsrConfig(
  env: NodeJS.ProcessEnv = process.env,
): AudioAsrConfig {
  const rawEnabled = env.AUDIO_ASR_ENABLED?.trim().toLowerCase();
  const enabled =
    rawEnabled !== undefined && rawEnabled !== ''
      ? !['0', 'false', 'no', 'off'].includes(rawEnabled)
      : false;
  const baseUrl = (
    env.AUDIO_ASR_BASE_URL?.trim() ||
    env.LLM_BASE_URL?.trim() ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/u, '');
  const apiKey =
    env.AUDIO_ASR_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    env.LLM_API_KEY?.trim() ||
    '';
  const model = env.AUDIO_ASR_MODEL?.trim() || 'whisper-1';
  const parsedTimeout = Number(env.AUDIO_ASR_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 1_000
      ? Math.floor(parsedTimeout)
      : DEFAULT_TIMEOUT_MS;
  const parsedMb = Number(env.AUDIO_ASR_MAX_MB);
  const maxAudioBytes =
    Number.isFinite(parsedMb) && parsedMb > 0
      ? Math.floor(parsedMb * 1024 * 1024)
      : DEFAULT_MAX_AUDIO_BYTES;
  const language = env.AUDIO_ASR_LANGUAGE?.trim() || undefined;
  return {
    enabled,
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    maxAudioBytes,
    ...(language ? { language } : {}),
  };
}

/**
 * OpenAI 兼容语音转文字客户端（POST /audio/transcriptions），
 * 适用于 Whisper、SenseVoice、Paraformer、Qwen-Audio 等兼容网关。
 */
export class OpenAiAudioTranscriber implements AudioTranscriber {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly language?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: OpenAiAudioTranscriberOptions['logger'];

  constructor(options: OpenAiAudioTranscriberOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.language = options.language;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  public async transcribe(
    attachment: StoredAttachment,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    if (options.signal?.aborted) return null;
    if (attachment.size > this.maxAudioBytes) {
      this.logger?.warn(
        {
          file: attachment.fileName,
          size: attachment.size,
          maxBytes: this.maxAudioBytes,
        },
        'audio attachment exceeds ASR max bytes, skipping transcription',
      );
      return null;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('ASR timeout')), this.timeoutMs);
    timer.unref?.();

    try {
      const buffer = await readFile(attachment.localPath);
      const fileName = basename(attachment.fileName || attachment.localPath) || 'audio.wav';
      const ext = extname(fileName).toLowerCase();
      const mimeType = attachment.mimeType || MIME_BY_EXT[ext] || 'application/octet-stream';

      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mimeType }), fileName);
      form.append('model', this.model);
      form.append('response_format', 'json');
      if (this.language) {
        form.append('language', this.language);
      }

      const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger?.warn(
          {
            file: attachment.fileName,
            status: response.status,
            body: body.slice(0, 300),
          },
          'audio transcription API returned non-2xx',
        );
        return null;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const parsed = (await response.json()) as { text?: unknown };
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        return text || null;
      }
      const rawText = (await response.text()).trim();
      return rawText || null;
    } catch (error) {
      if (options.signal?.aborted) return null;
      this.logger?.warn(
        {
          file: attachment.fileName,
          error: error instanceof Error ? error.message : String(error),
        },
        'audio transcription failed',
      );
      return null;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
