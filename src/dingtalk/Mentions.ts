import type { InboundMessage } from '../types/core.js';

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
