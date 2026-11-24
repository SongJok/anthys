import type {
  InboundAttachment,
  InboundDocumentReference,
  InboundMessage,
  QuotedMessageContext,
} from '../types/core.js';

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
  repliedMsg?: unknown;
  originalMsgId?: unknown;
}

const ATTACHMENT_TYPES = ['picture', 'file', 'audio', 'video'] as const;
const DOCUMENT_HOSTS = new Set(['alidocs.dingtalk.com', 'docs.dingtalk.com']);
const DOCUMENT_MAX_DEPTH = 10;
const DOCUMENT_MAX_NODES = 400;
const DOCUMENT_MAX_REFERENCES = 5;

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

function hasLeadingMention(text: string): boolean {
  return /^(?:\s*@[^\s@]+\s*)+/.test(text);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractTextFromRichText(richText: unknown): string | null {
  if (!Array.isArray(richText)) return null;
  const parts: string[] = [];
  for (const item of richText) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === undefined || block.type === 'text') {
      const part = asNonEmptyString(block.text);
      if (part) parts.push(part);
    }
  }
  const joined = parts.join('').trim();
  return joined || null;
}

function documentUrl(value: string): string | null {
  if (value.length > 2_048) return null;
  const candidate = value.replace(/[),.;!?，。；！？）】》]+$/g, '');
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      !DOCUMENT_HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      url.pathname === '/'
    ) {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function documentTitle(value: unknown): string | undefined {
  const direct = asNonEmptyString(value);
  if (direct) return direct.replace(/\s+/g, ' ').slice(0, 200);
  const record = asRecord(value);
  if (!record) return undefined;
  return (
    asNonEmptyString(record.text) ??
    asNonEmptyString(record.content) ??
    asNonEmptyString(record.value)
  )?.replace(/\s+/g, ' ').slice(0, 200);
}

/** 卡片结构未公开且可能随客户端变化，只提取白名单域名并限制遍历规模。 */
export function extractDocumentReferences(
  value: unknown,
): InboundDocumentReference[] {
  const references = new Map<string, InboundDocumentReference>();
  const visited = new WeakSet<object>();
  let nodes = 0;

  const add = (raw: string, title?: string): void => {
    if (references.size >= DOCUMENT_MAX_REFERENCES) return;
    const url = documentUrl(raw);
    if (!url || references.has(url)) return;
    references.set(url, { url, ...(title ? { title } : {}) });
  };

  const visitString = (raw: string, depth: number, siblingTitle?: string): void => {
    if (depth > DOCUMENT_MAX_DEPTH || raw.length > 64_000) return;
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        visit(JSON.parse(trimmed), siblingTitle, depth + 1);
        return;
      } catch {
        return;
      }
    }
    for (const match of raw.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) {
      add(match[2]!, siblingTitle ?? match[1]!.trim());
    }
    for (const match of raw.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
      add(match[0], siblingTitle);
    }
  };

  const visit = (current: unknown, siblingTitle?: string, depth = 0): void => {
    if (depth > DOCUMENT_MAX_DEPTH || nodes >= DOCUMENT_MAX_NODES) return;
    nodes += 1;
    if (typeof current === 'string') {
      visitString(current, depth, siblingTitle);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, siblingTitle, depth + 1);
      return;
    }
    const record = current as Record<string, unknown>;
    const title = ['title', 'name', 'documentTitle']
      .map((key) => documentTitle(record[key]))
      .find((item): item is string => Boolean(item));
    for (const [key, item] of Object.entries(record)) {
      visit(item, title ?? siblingTitle, depth + 1);
    }
  };

  visit(value);
  return [...references.values()];
}

function extractCardTitle(
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: DOCUMENT_MAX_NODES },
): string | undefined {
  if (depth > DOCUMENT_MAX_DEPTH || value === null || budget.remaining-- <= 0) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 64_000) return undefined;
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return extractCardTitle(JSON.parse(trimmed), depth + 1, budget);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const title = extractCardTitle(item, depth + 1, budget);
      if (title) return title;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ownTitle = ['title', 'name', 'documentTitle']
    .map((key) => documentTitle(record[key]))
    .find((item): item is string => Boolean(item));
  if (ownTitle) return ownTitle;
  for (const item of Object.values(record)) {
    const title = extractCardTitle(item, depth + 1, budget);
    if (title) return title;
  }
  return undefined;
}

function parseQuotedMessage(payload: RawRobotPayload): QuotedMessageContext | undefined {
  const textBlock = asRecord(payload.text);
  const contentBlock = asRecord(payload.content);
  const repliedRaw =
    asRecord(textBlock?.repliedMsg) ??
    asRecord(contentBlock?.repliedMsg) ??
    asRecord(payload.repliedMsg);

  const originalMsgId =
    asNonEmptyString(repliedRaw?.msgId) ??
    asNonEmptyString(textBlock?.originalMsgId) ??
    asNonEmptyString(contentBlock?.originalMsgId) ??
    asNonEmptyString(payload.originalMsgId);

  const quoteContent =
    asNonEmptyString(contentBlock?.quoteContent) ??
    asNonEmptyString(textBlock?.quoteContent);

  if (!repliedRaw && !originalMsgId && !quoteContent) return undefined;

  let quotedText: string | undefined = quoteContent ?? undefined;
  let quotedMsgType: string | undefined;
  if (repliedRaw) {
    quotedMsgType =
      asNonEmptyString(repliedRaw.msgType) ??
      asNonEmptyString(repliedRaw.msgtype) ??
      undefined;
    const repliedContent = asRecord(repliedRaw.content);
    quotedText =
      quotedText ??
      asNonEmptyString(repliedContent?.text) ??
      asNonEmptyString(asRecord(repliedContent?.text)?.content) ??
      extractTextFromRichText(repliedContent?.richText) ??
      asNonEmptyString(repliedContent?.recognition) ??
      asNonEmptyString(repliedRaw.text) ??
      asNonEmptyString(repliedRaw.content) ??
      undefined;
  }

  const senderStaffId =
    asNonEmptyString(repliedRaw?.senderStaffId) ??
    asNonEmptyString(repliedRaw?.senderId) ??
    undefined;
  const senderNick =
    asNonEmptyString(repliedRaw?.senderNick) ??
    asNonEmptyString(repliedRaw?.senderName) ??
    undefined;

  if (!originalMsgId && !quotedText) return undefined;
  return {
    ...(originalMsgId ? { messageId: originalMsgId } : {}),
    ...(senderStaffId ? { senderStaffId } : {}),
    ...(senderNick ? { senderNick } : {}),
    ...(quotedText ? { text: quotedText } : {}),
    ...(quotedMsgType ? { msgtype: quotedMsgType } : {}),
  };
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
  if (msgtype === 'audio') {
    const recognition = asNonEmptyString(content.recognition);
    if (recognition) attachment.nativeRecognition = recognition;
  }
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
 * 支持文本、富文本与 picture/file/audio/video 附件消息；其余类型返回 null。
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
  let mentionOnly = false;
  let supported = true;
  const attachments: InboundAttachment[] = [];
  const rawRecord = raw as Record<string, unknown>;
  const cardLike =
    /card|forward|mixed/i.test(asNonEmptyString(payload.msgtype) ?? '') ||
    ['interactiveCard', 'actionCard', 'action_card', 'cardData', 'forwardMessages'].some(
      (key) => key in rawRecord,
    );
  const cardTitle = cardLike ? extractCardTitle(rawRecord) : undefined;
  const extractedDocuments = extractDocumentReferences(raw);
  const documentReferences =
    extractedDocuments.length === 1 && cardTitle
      ? [{ ...extractedDocuments[0]!, title: cardTitle }]
      : extractedDocuments;
  if (payload.msgtype === 'text') {
    const textBlock = payload.text;
    if (textBlock === null || typeof textBlock !== 'object') {
      supported = false;
    } else {
      const content = asNonEmptyString(
        (textBlock as { content?: unknown }).content,
      );
      if (!content) {
        supported = false;
      } else {
        text = stripLeadingMentions(content);
        if (!text) {
          if (!hasLeadingMention(content)) {
            supported = false;
          } else {
            mentionOnly = true;
          }
        }
      }
    }
  } else if (payload.msgtype === 'richText') {
    const content = payload.content;
    if (content === null || typeof content !== 'object') {
      supported = false;
    } else {
      const richText = (content as { richText?: unknown }).richText;
      if (!Array.isArray(richText)) {
        supported = false;
      } else {
        const textParts: string[] = [];
        for (const item of richText) {
          if (item === null || typeof item !== 'object') continue;
          const block = item as Record<string, unknown>;
          if (block.type === 'picture') {
            const attachment = parseAttachment('picture', block);
            if (attachment) attachments.push(attachment);
          } else if (block.type === undefined || block.type === 'text') {
            const part = asNonEmptyString(block.text);
            if (part) textParts.push(part);
          }
        }
        const rawText = textParts.join('');
        text = stripLeadingMentions(rawText);
        if (!text && attachments.length === 0) {
          if (!hasLeadingMention(rawText)) {
            supported = false;
          } else {
            mentionOnly = true;
          }
        }
      }
    }
  } else if (
    typeof payload.msgtype === 'string' &&
    (ATTACHMENT_TYPES as readonly string[]).includes(payload.msgtype)
  ) {
    const content = payload.content;
    if (content === null || typeof content !== 'object') {
      supported = false;
    } else {
      const attachment = parseAttachment(
        payload.msgtype as AttachmentMsgType,
        content as Record<string, unknown>,
      );
      if (attachment) {
        attachments.push(attachment);
      } else {
        supported = false;
      }
    }
  } else {
    supported = false;
  }

  if (!supported) {
    if (documentReferences.length === 0 && !cardTitle) return null;
    text = documentReferences.length > 0 ? '[钉钉文档]' : `[卡片] ${cardTitle}`;
    mentionOnly = false;
  }

  const createdAt = Number(payload.createAt);
  const quotedMessage = parseQuotedMessage(payload);

  if (!text && attachments.length > 0) {
    const first = attachments[0]!;
    text =
      first.type === 'audio' && first.nativeRecognition
        ? stripLeadingMentions(first.nativeRecognition) || first.nativeRecognition
        : attachmentPlaceholder(first);
  }

  return {
    messageId,
    conversationId,
    conversationType,
    senderStaffId,
    senderNick: asNonEmptyString(payload.senderNick) ?? senderStaffId,
    isAtBot: detectAtBot(payload, conversationType),
    text,
    ...(mentionOnly ? { mentionOnly: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(quotedMessage ? { quotedMessage } : {}),
    ...(documentReferences.length > 0 ? { documentReferences } : {}),
    ...(asNonEmptyString(payload.conversationTitle)
      ? { conversationTitle: asNonEmptyString(payload.conversationTitle)! }
      : {}),
    rawPayload: raw as Record<string, unknown>,
    timestamp: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now(),
  };
}
