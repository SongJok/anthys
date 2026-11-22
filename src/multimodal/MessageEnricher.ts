import type { InboundMessage, QuotedMessageContext } from '../types/core.js';
import type {
  AttachmentFailure,
  AttachmentStoreResult,
  StoredAttachment,
} from './AttachmentStore.js';
import type { VisionDescriber } from './VisionDescriber.js';
import { digestAttachment, type AttachmentDigest } from './AttachmentDigest.js';
import { isAudioFileName, type AudioTranscriber } from './AudioTranscriber.js';
import { isVideoFileName, type VideoAnalyzer } from './VideoAnalyzer.js';

export interface MessageEnricherLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MessageEnricherDeps {
  store: {
    store(
      message: InboundMessage,
      options?: { signal?: AbortSignal },
    ): Promise<AttachmentStoreResult>;
  };
  vision?: {
    describe(
      attachment: StoredAttachment,
      options?: { signal?: AbortSignal },
    ): Promise<string | null>;
  };
  /** 语音/音频转文字（当钉钉未自带 recognition 或用户上传音频文件时触发） */
  audio?: AudioTranscriber;
  /** 短视频/录屏关键帧与音轨摘要（需要宿主安装 ffmpeg 且配置视觉/语音能力） */
  video?: VideoAnalyzer;
  /** 当引用回复仅携带 messageId 时，从会话历史/旁听缓冲反查原消息上下文 */
  resolveQuotedMessage?: (
    messageId: string,
    conversationId: string,
  ) => Promise<QuotedMessageContext | null>;
  logger?: MessageEnricherLogger;
  /** 是否对 pptx/docx/xlsx/csv 做文本提取，默认开启 */
  documents?: boolean;
  /** 中止信号：排队期间被 /stop 时立即停止下载与视觉理解 */
  signal?: AbortSignal;
  /** 文档解析结果回调（用于指标） */
  onDocument?(info: { format?: string; ok: boolean; reason?: string; fileName: string }): void;
  /** 音频转写结果回调（用于指标） */
  onAudio?(info: { source: 'native' | 'asr'; ok: boolean; fileName: string }): void;
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

/** 把引用消息渲染为结构化提示词片段 */
export function renderQuotedSection(quoted?: QuotedMessageContext): string {
  if (!quoted) return '';
  const text = quoted.text?.trim();
  if (!text) return '';
  const speaker = quoted.senderNick?.trim() || quoted.senderStaffId?.trim() || '群成员';
  const clipped = text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  return `【引用消息（${speaker}）】\n${clipped}`;
}

/** 把落盘附件与图片/语音/视频识别结果渲染为提示词片段 */
export function renderAttachmentSection(
  stored: StoredAttachment[],
  descriptions: ReadonlyMap<string, string | null>,
  failed: AttachmentFailure[],
  digests: ReadonlyMap<string, AttachmentDigest | null> = new Map(),
  transcripts: ReadonlyMap<string, string | null> = new Map(),
  videoSummaries: ReadonlyMap<string, string | null> = new Map(),
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
    const transcript = transcripts.get(item.localPath);
    if (transcript) {
      lines.push(`  语音转写：${transcript}`);
    } else if (item.type === 'audio' || isAudioFileName(item.fileName)) {
      lines.push('  语音转写：（语音识别未启用或转写失败，仅保留本地路径）');
    }
    const videoSummary = videoSummaries.get(item.localPath);
    if (videoSummary) {
      lines.push(`  视频摘要：\n  ${videoSummary.replaceAll('\n', '\n  ')}`);
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
    '说明：文本/CSV/JSON/Markdown 及已解析的 Office 附件可用 workspace_read_file 读取（pptx/docx/xlsx 会自动转为文本），整表分析可把路径传给 sandbox_analyze_and_aggregate 的 datasetKeys；回答时直接说明附件结论，无需复述路径。' +
      (stored.some((item) => item.type === 'image')
        ? '沙盒没有 OCR/图像识别能力，不要尝试用沙盒识别图片；识别内容不完整时请让用户分块上传或补充文字。'
        : ''),
  );
  return lines.join('\n');
}

/**
 * 入站增强：
 * 1) 补齐引用回复（quotedMessage）上下文；
 * 2) 下载附件，执行视觉识图、语音转写（原生/ASR）、视频关键帧提取与文档解析，
 *    让纯文本主模型完整感知多模态上下文。
 */
export async function enrichInboundMessage(
  message: InboundMessage,
  deps: MessageEnricherDeps,
): Promise<EnrichmentResult> {
  if (deps.signal?.aborted) {
    return { message, attachments: [], failed: [] };
  }

  let quoted = message.quotedMessage;
  if (
    quoted &&
    !quoted.text?.trim() &&
    quoted.messageId &&
    deps.resolveQuotedMessage
  ) {
    try {
      const resolved = await deps.resolveQuotedMessage(
        quoted.messageId,
        message.conversationId,
      );
      if (resolved) {
        quoted = {
          ...quoted,
          ...(resolved.senderStaffId && !quoted.senderStaffId
            ? { senderStaffId: resolved.senderStaffId }
            : {}),
          ...(resolved.senderNick && !quoted.senderNick
            ? { senderNick: resolved.senderNick }
            : {}),
          ...(resolved.text ? { text: resolved.text } : {}),
        };
      }
    } catch (error) {
      deps.logger?.warn(
        { messageId: quoted.messageId, err: String(error) },
        'failed to resolve quoted message context',
      );
    }
  }
  const quotedSection = renderQuotedSection(quoted);

  const hasAttachments = Boolean(
    message.attachments && message.attachments.length > 0,
  );
  if (!hasAttachments) {
    if (!quotedSection) return { message, attachments: [], failed: [] };
    return {
      message: {
        ...message,
        ...(quoted ? { quotedMessage: quoted } : {}),
        text: message.text.trim()
          ? `${quotedSection}\n\n${message.text}`
          : quotedSection,
      },
      attachments: [],
      failed: [],
    };
  }

  const { stored, failed } = deps.signal
    ? await deps.store.store(message, { signal: deps.signal })
    : await deps.store.store(message);

  const descriptions = new Map<string, string | null>();
  if (deps.vision) {
    for (const attachment of stored) {
      if (deps.signal?.aborted) break;
      if (attachment.type !== 'image') continue;
      descriptions.set(
        attachment.localPath,
        deps.signal
          ? await deps.vision.describe(attachment, { signal: deps.signal })
          : await deps.vision.describe(attachment),
      );
    }
  }

  const transcripts = new Map<string, string | null>();
  const inboundAudios = (message.attachments ?? []).filter(
    (item) => item.type === 'audio',
  );
  let audioCursor = 0;
  let primaryVoiceTranscript: string | null = null;
  for (const attachment of stored) {
    if (deps.signal?.aborted) break;
    const isAudio =
      attachment.type === 'audio' || isAudioFileName(attachment.fileName);
    if (!isAudio) continue;
    const nativeText =
      attachment.type === 'audio'
        ? inboundAudios[audioCursor++]?.nativeRecognition?.trim() || null
        : null;
    if (nativeText) {
      transcripts.set(attachment.localPath, nativeText);
      deps.onAudio?.({ source: 'native', ok: true, fileName: attachment.fileName });
      if (!primaryVoiceTranscript) primaryVoiceTranscript = nativeText;
      continue;
    }
    if (deps.audio) {
      const transcribed = deps.signal
        ? await deps.audio.transcribe(attachment, { signal: deps.signal })
        : await deps.audio.transcribe(attachment);
      transcripts.set(attachment.localPath, transcribed);
      deps.onAudio?.({
        source: 'asr',
        ok: Boolean(transcribed),
        fileName: attachment.fileName,
      });
      if (transcribed && !primaryVoiceTranscript) {
        primaryVoiceTranscript = transcribed;
      }
    }
  }

  const videoSummaries = new Map<string, string | null>();
  if (deps.video) {
    for (const attachment of stored) {
      if (deps.signal?.aborted) break;
      const isVideo =
        attachment.type === 'video' || isVideoFileName(attachment.fileName);
      if (!isVideo) continue;
      videoSummaries.set(
        attachment.localPath,
        deps.signal
          ? await deps.video.analyze(attachment, { signal: deps.signal })
          : await deps.video.analyze(attachment),
      );
    }
  }

  const digests = new Map<string, AttachmentDigest | null>();
  if (deps.documents !== false) {
    for (const attachment of stored) {
      if (deps.signal?.aborted) break;
      try {
        const digest = await digestAttachment(attachment, {
          ...(deps.vision ? { vision: deps.vision as VisionDescriber } : {}),
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

  const section = renderAttachmentSection(
    stored,
    descriptions,
    failed,
    digests,
    transcripts,
    videoSummaries,
  );

  let baseText = message.text.trim();
  if (baseText === '[语音]' && primaryVoiceTranscript) {
    baseText = primaryVoiceTranscript;
  }

  const parts = [quotedSection, baseText, section].filter(Boolean);
  if (parts.length === 0) return { message, attachments: stored, failed };
  return {
    message: {
      ...message,
      ...(quoted ? { quotedMessage: quoted } : {}),
      text: parts.join('\n\n'),
    },
    attachments: stored,
    failed,
  };
}
