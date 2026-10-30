import type { InboundAttachment, InboundMessage } from '../types/core.js';

interface RawRobotPayload {
  msgId?: unknown;
  conversationId?: unknown;
  conversationType?: unknown;
  conversationTitle?: unknown;
  senderStaffId?: unknown;
  senderId?: unknown;
  senderNick?: unknown;
  msgtype?: unknown;
  createAt?: unknown;
  chatbotUserId?: unknown;
  isInAtList?: unknown;
  atUsers?: unknown;
  text?: unknown;
  content?: unknown;
}

const ATTACHMENT_TYPES = ['picture', 'file', 'audio', 'video'] as const;

type AttachmentMsgType = (typeof ATTACHMENT_TYPES)[number];

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

function asPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAttachment(
  msgtype: AttachmentMsgType,
  content: Record<string, unknown>,
): InboundAttachment | null {
  const downloadCode =
    asNonEmptyString(content.downloadCode) ??
    // 图片消息历史上存在 pictureDownloadCode 字段
    asNonEmptyString(content.pictureDownloadCode);
  if (!downloadCode) return null;
  const attachment: InboundAttachment = {
    type: msgtype === 'picture' ? 'image' : msgtype,
    downloadCode,
  };
  const fileName = asNonEmptyString(content.fileName);
  if (fileName) attachment.fileName = fileName;
  const fileSize = asPositiveNumber(content.fileSize);
  if (fileSize !== undefined) attachment.fileSize = fileSize;
  const durationMs = asPositiveNumber(content.duration);
  if (durationMs !== undefined) attachment.durationMs = durationMs;
  return attachment;
}

function attachmentPlaceholder(attachment: InboundAttachment): string {
  switch (attachment.type) {
    case 'image':
      return '[图片]';
    case 'audio':
      return '[语音]';
    case 'video':
      return '[视频]';
    default:
      return '[文件]';
  }
}

/**
 * 把钉钉 Stream TOPIC_ROBOT 的 data 解析为统一入站消息。
 * 支持文本与 picture/file/audio/video 附件消息；其余类型返回 null。
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

  let text = '';
  const attachments: InboundAttachment[] = [];
  if (payload.msgtype === 'text') {
    const textBlock = payload.text;
    if (textBlock === null || typeof textBlock !== 'object') return null;
    const content = asNonEmptyString(
      (textBlock as { content?: unknown }).content,
    );
    if (!content) return null;
    text = stripLeadingMentions(content);
    if (!text) return null;
  } else if (
    typeof payload.msgtype === 'string' &&
    (ATTACHMENT_TYPES as readonly string[]).includes(payload.msgtype)
  ) {
    const content = payload.content;
    if (content === null || typeof content !== 'object') return null;
    const attachment = parseAttachment(
      payload.msgtype as AttachmentMsgType,
      content as Record<string, unknown>,
    );
    if (!attachment) return null;
    attachments.push(attachment);
  } else {
    return null;
  }

  const createdAt = Number(payload.createAt);

  if (!text && attachments.length > 0) {
    text = attachmentPlaceholder(attachments[0]!);
  }

  return {
    messageId,
    conversationId,
    conversationType,
    senderStaffId,
    senderNick: asNonEmptyString(payload.senderNick) ?? senderStaffId,
    isAtBot: detectAtBot(payload, conversationType),
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(asNonEmptyString(payload.conversationTitle)
      ? { conversationTitle: asNonEmptyString(payload.conversationTitle)! }
      : {}),
    rawPayload: raw as Record<string, unknown>,
    timestamp: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now(),
  };
}
