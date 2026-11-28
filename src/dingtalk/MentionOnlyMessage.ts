import type { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';
import { stripLeadingMentions } from './MessageParser.js';

/**
 * 只 @ 不说话时向上找同一发言人上一条消息的窗口。
 * 钉钉客户端两次发送的间隔通常只有几秒，15s 足够覆盖手滑与网络抖动。
 */
export const MENTION_ONLY_MERGE_WINDOW_MS = 15_000;

/** 最近群聊都为空、无从推断时的静态兜底，避免用户以为机器人没收到 @ */
export const MENTION_ONLY_FALLBACK_REPLY = '我在，你想问什么？';

/** 只 @ 不说话但带了引用：让模型围绕引用内容作答 */
export const MENTION_ONLY_QUOTE_PROMPT =
  '（用户只 @ 了你，没有输入文字，但引用了上面的消息。请直接围绕被引用的内容回答或继续处理；如果引用内容不可见，先简短说明，再询问对方想要什么帮助。）';

/** 没有引用、也没有紧邻上文：把最近群聊或单聊历史作为作答依据 */
export const MENTION_ONLY_CONTEXT_PROMPT =
  '（用户只 @ 了你，没有输入文字。请结合最近的对话上下文判断对方想让你做什么，并直接给出有用的回应；只有上下文确实无法判断意图时，才用一句话询问对方需要什么帮助。）';

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

export type MentionOnlySource = NonNullable<InboundMessage['mentionOnlySource']>;

export interface MentionOnlyResolution {
  message: InboundMessage;
  source: MentionOnlySource;
  mergedFromMessageId?: string;
}

/** 引用可能只带 messageId（正文稍后回查），两种情况都值得交给模型 */
function hasUsableQuotedMessage(message: InboundMessage): boolean {
  const quoted = message.quotedMessage;
  return Boolean(quoted && (quoted.messageId || quoted.text?.trim()));
}

/** 群聊旁听记录由 AgentHarness 注入记忆上下文，这里只判断是否有可用的背景 */
function hasRecentGroupTranscript(
  message: InboundMessage,
  buffer: GroupTranscriptBuffer,
): boolean {
  return buffer
    .recent(message.conversationId)
    .some(
      (entry) =>
        entry.messageId !== message.messageId && entry.text.trim() !== '',
    );
}

/**
 * 把「只 @、没有正文」的消息转换成可作答的回合：
 * 引用消息 > 同一发言人紧邻上文 > 最近群聊/单聊历史兜底。
 * 群聊连旁听记录都没有时返回 null，由调用方回复静态兜底。
 */
export function resolveMentionOnlyMessage(
  message: InboundMessage,
  buffer: GroupTranscriptBuffer,
): MentionOnlyResolution | null {
  if (hasUsableQuotedMessage(message)) {
    return {
      source: 'quoted',
      message: {
        ...message,
        text: MENTION_ONLY_QUOTE_PROMPT,
        mentionOnly: false,
        mentionOnlySource: 'quoted',
      },
    };
  }

  const context = findMentionOnlyContext(message, buffer);
  if (context) {
    return {
      source: 'merged',
      mergedFromMessageId: context.messageId,
      message: {
        ...message,
        text: context.text,
        mentionOnly: false,
        mentionOnlySource: 'merged',
        rawPayload: {
          ...message.rawPayload,
          mergedFromMessageId: context.messageId,
        },
      },
    };
  }

  if (
    message.conversationType === '2' &&
    !hasRecentGroupTranscript(message, buffer)
  ) {
    return null;
  }
  const source: MentionOnlySource =
    message.conversationType === '2' ? 'transcript' : 'history';
  return {
    source,
    message: {
      ...message,
      text: MENTION_ONLY_CONTEXT_PROMPT,
      mentionOnly: false,
      mentionOnlySource: source,
    },
  };
}
