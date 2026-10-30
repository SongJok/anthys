import type { InboundMessage } from '../types/core.js';

interface RawRobotPayload {
  msgId?: unknown;
  conversationId?: unknown;
  conversationType?: unknown;
  senderStaffId?: unknown;
  senderId?: unknown;
  senderNick?: unknown;
  msgtype?: unknown;
  createAt?: unknown;
  chatbotUserId?: unknown;
  isInAtList?: unknown;
  atUsers?: unknown;
  text?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asAtUsers(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object',
  );
}

/** 去掉消息开头的一个或多个 "@某个机器人" 前缀 */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*@[^\s@]+\s*)+/, '').trim();
}

function detectAtBot(
  payload: RawRobotPayload,
  conversationType: '1' | '2',
): boolean {
  if (conversationType === '1') return true;
  if (payload.isInAtList === true) return true;
  const botId = asNonEmptyString(payload.chatbotUserId);
  if (!botId) return false;
  return asAtUsers(payload.atUsers).some(
    (user) => user.dingtalkId === botId || user.staffId === botId,
  );
}

/**
 * 把钉钉 Stream TOPIC_ROBOT 的 data 解析为统一入站消息。
 * 非文本消息返回 null，由调用方直接忽略。
 */
export function parseStreamMessage(
  raw: unknown,
  now: () => number = Date.now,
): InboundMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const payload = raw as RawRobotPayload;

  const conversationType =
    payload.conversationType === '1' || payload.conversationType === '2'
      ? payload.conversationType
      : null;
  if (!conversationType) return null;

  const messageId = asNonEmptyString(payload.msgId);
  const conversationId = asNonEmptyString(payload.conversationId);
  const senderStaffId =
    asNonEmptyString(payload.senderStaffId) ?? asNonEmptyString(payload.senderId);
  if (!messageId || !conversationId || !senderStaffId) return null;
  if (payload.msgtype !== 'text') return null;

  const textBlock = payload.text;
  if (textBlock === null || typeof textBlock !== 'object') return null;
  const content = asNonEmptyString((textBlock as { content?: unknown }).content);
  if (!content) return null;

  const text = stripLeadingMentions(content);
  if (!text) return null;

  const createdAt = Number(payload.createAt);

  return {
    messageId,
    conversationId,
    conversationType,
    senderStaffId,
    senderNick: asNonEmptyString(payload.senderNick) ?? senderStaffId,
    isAtBot: detectAtBot(payload, conversationType),
    text,
    rawPayload: raw as Record<string, unknown>,
    timestamp: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now(),
  };
}
