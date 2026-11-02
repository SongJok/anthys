import type { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';
import { stripLeadingMentions } from './MessageParser.js';

/**
 * 只 @ 不说话时向上找同一发言人上一条消息的窗口。
 * 钉钉客户端两次发送的间隔通常只有几秒，15s 足够覆盖手滑与网络抖动。
 */
export const MENTION_ONLY_MERGE_WINDOW_MS = 15_000;

/** 找不到可合并的上文时直接回应，避免用户以为机器人没收到 @ */
export const MENTION_ONLY_FALLBACK_REPLY = '我在，你想问什么？';

/** DWS 个人事件与机器人回调的 createAt 来自不同链路，允许少量时钟偏差 */
const CLOCK_SKEW_MS = 5_000;

export interface MentionOnlyContext {
  messageId: string;
  text: string;
  senderNick: string;
}

function normalizeNick(nick: string): string {
  return nick.trim().toLowerCase();
}

/** DWS 只有 openDingTalkId，机器人回调是 staffId，ID 对不上时回退昵称 */
function isSameSender(message: InboundMessage, entry: TranscriptEntry): boolean {
  if (
    entry.senderStaffId &&
    message.senderStaffId &&
    entry.senderStaffId === message.senderStaffId
  ) {
    return true;
  }
  const entryNick = normalizeNick(entry.senderNick);
  return entryNick !== '' && entryNick === normalizeNick(message.senderNick);
}

/**
 * 为「只有 @、没有正文」的消息寻找同一发言人的上一条非 @ 消息。
 * 只接受窗口内、有实际正文、且不是另一次 @ 的条目。
 */
export function findMentionOnlyContext(
  message: InboundMessage,
  buffer: GroupTranscriptBuffer,
  windowMs = MENTION_ONLY_MERGE_WINDOW_MS,
): MentionOnlyContext | null {
  const entries = buffer.recent(message.conversationId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.messageId === message.messageId) continue;
    if (entry.isAtBot) continue;
    if (!isSameSender(message, entry)) continue;
    if (entry.timestamp < message.timestamp - windowMs) continue;
    if (entry.timestamp > message.timestamp + CLOCK_SKEW_MS) continue;

    const text = stripLeadingMentions(entry.text).trim();
    if (!text) continue;
    return {
      messageId: entry.messageId,
      text,
      senderNick: entry.senderNick,
    };
  }
  return null;
}
