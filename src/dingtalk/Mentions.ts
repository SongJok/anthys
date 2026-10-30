import type { InboundMessage } from '../types/core.js';
import { isStaffUserId } from './userIds.js';

/**
 * 群聊被 @ 提问时，回复正文先点名提问人；单聊与主动/定时回复不带。
 * 名字来自消息发送者，需压平空白避免打乱 Markdown 结构。
 */
export function replyMention(
  message: InboundMessage,
  proactive = false,
): string {
  if (proactive || message.conversationType !== '2') return '';
  const name =
    message.senderNick.replace(/\s+/gu, ' ').trim() || message.senderStaffId;
  return `@${name}\n`;
}

export interface WebhookMention {
  text: string;
  atUserIds: string[];
}

/**
 * 文本兜底走 markdown 消息：正文必须含 `@userId` 且携带 at.atUserIds，
 * 钉钉才会把它渲染成真实提及并触发提醒；只写昵称只是普通文字。
 * 外部群成员没有 staffId（senderStaffId 是加密值），退回纯昵称文本，
 * 避免把 `@$:LWCP_v1:$…` 原样发到群里。
 */
export function webhookMention(
  message: InboundMessage,
  proactive = false,
): WebhookMention {
  if (proactive || message.conversationType !== '2') {
    return { text: '', atUserIds: [] };
  }
  const userId = message.senderStaffId?.trim();
  if (!userId) return { text: '', atUserIds: [] };
  if (!isStaffUserId(userId)) {
    const name = message.senderNick.replace(/\s+/gu, ' ').trim();
    return { text: name ? `@${name}\n` : '', atUserIds: [] };
  }
  return { text: `@${userId}\n`, atUserIds: [userId] };
}
