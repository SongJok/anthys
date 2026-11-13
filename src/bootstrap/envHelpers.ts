import { readFileSync } from 'node:fs';
import type { CardLogger } from '../dingtalk/CardStreamer.js';
import { webhookMention } from '../dingtalk/Mentions.js';
import { sendTextFallback } from '../dingtalk/TextFallback.js';
import type {
  InboundMessage,
  RunResult,
  ToolApprovalRequest,
} from '../types/core.js';

export const FALLBACK_ERROR_TEXT = '抱歉，处理这条消息时出现异常，请稍后重试。';
export const EMPTY_RESULT: RunResult = {
  answer: '',
  reasoning: '',
  usage: { totalTokens: 0, steps: 0, durationMs: 0 },
};

export function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * DWS 普通写操作在本人已授权后直接执行；
 * 取消日程、覆盖文档这类不可逆操作仍要求 /confirm。
 */
export function requiresExplicitDwsConfirmation(
  request: Pick<ToolApprovalRequest, 'toolName' | 'args' | 'risk'>,
): boolean {
  if (request.risk === 'destructive') return true;
  if (request.toolName === 'dws_calendar_cancel') return true;
  return (
    request.toolName === 'dws_doc_manage' && request.args.action === 'overwrite'
  );
}

export function readAgentVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 钉钉单聊文本单条有长度上限，按行切块后分条发送 */
export function splitForDelivery(text: string, limit = 1_200): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    const candidate = current === '' ? piece : `${current}\n${piece}`;
    if (candidate.length > limit) {
      if (current !== '') chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

/** DINGTALK_ADMIN 与 ADMIN_STAFF_IDS 等价，合并去重后作为初始管理员 */
export function parseAdminIds(...raw: (string | undefined)[]): string[] {
  const ids: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    for (const item of value.split(',')) {
      const id = item.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function envEnabled(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function envMegabytes(
  raw: string | undefined,
  fallbackMb: number,
): number {
  const mb = Number(raw);
  return (Number.isFinite(mb) && mb > 0 ? mb : fallbackMb) * 1024 * 1024;
}

export function envSeconds(
  raw: string | undefined,
  fallbackSeconds: number,
): number {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
}

export function envCount(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export async function runWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} 超时（>${Math.round(timeoutMs / 1000)}s）`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 卡片不可用时的文本兜底：按长度分片发送并逐片重试，
 * 避免长答案被钉钉 markdown 长度上限截断或整体丢失。
 */
export async function sendSessionWebhook(
  message: InboundMessage,
  text: string,
  logger: CardLogger,
  options: { mention?: boolean; isAtAll?: boolean } = {},
): Promise<void> {
  const webhook = message.rawPayload.sessionWebhook;
  if (typeof webhook !== 'string' || !webhook) {
    logger.warn(
      { messageId: message.messageId },
      'no sessionWebhook available for text fallback',
    );
    return;
  }
  const at = options.mention
    ? webhookMention(message)
    : { text: '', atUserIds: [] };
  const result = await sendTextFallback({
    webhook,
    text: `${at.text}${text}`,
    ...(at.atUserIds.length > 0 ? { atUserIds: at.atUserIds } : {}),
    ...(options.isAtAll ? { isAtAll: true } : {}),
    logger,
  });
  if (result.ok) {
    logger.info?.(
      { messageId: message.messageId, chunks: result.chunks },
      'text fallback delivered',
    );
    return;
  }
  logger.warn(
    {
      messageId: message.messageId,
      chunks: result.chunks,
      error: result.error,
    },
    'text fallback partially failed',
  );
}
