/** 钉钉互动卡片回调解析：把按钮 / 快捷操作映射为文本指令 */

export interface CardActionEvent {
  outTrackId: string;
  actionId: string;
  /** 已归一化的指令，例如 /stop */
  command: string;
  conversationId: string;
  conversationType: '1' | '2';
  userId: string;
  nick?: string;
  raw: Record<string, unknown>;
}

const ACTION_COMMANDS: Record<string, string> = {
  stop: '/stop',
  cancel: '/stop',
  retry: '/retry',
  restart: '/retry',
  help: '/help',
  status: '/status',
  trace: '/trace',
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeCommand(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const normalized = text.startsWith('／')
    ? `/${text.slice(1)}`
    : text;
  return normalized.startsWith('/') ? normalized : undefined;
}

function normalizeConversationType(value: unknown): '1' | '2' {
  return String(value) === '2' ? '2' : '1';
}

export function parseCardAction(payload: unknown): CardActionEvent | null {
  const root = asRecord(payload);
  if (!root || Object.keys(root).length === 0) return null;
  const data = asRecord(root.data ?? root);
  const privateData = asRecord(data.cardPrivateData ?? root.cardPrivateData);
  const params = asRecord(privateData.params ?? data.params);
  const actionIds = Array.isArray(privateData.actionIds)
    ? privateData.actionIds
    : Array.isArray(data.actionIds)
      ? data.actionIds
      : [];
  const actionId =
    asString(actionIds[0]) ??
    asString(privateData.actionId) ??
    asString(data.actionId);
  if (!actionId) return null;

  const command =
    normalizeCommand(params.command) ??
    normalizeCommand(actionId) ??
    ACTION_COMMANDS[actionId.toLowerCase()];
  if (!command) return null;

  const userId =
    asString(data.userId) ??
    asString(data.staffId) ??
    asString(root.userId) ??
    '';
  const conversationId =
    asString(data.conversationId) ??
    asString(root.conversationId) ??
    userId;
  if (!conversationId) return null;

  return {
    outTrackId:
      asString(data.outTrackId) ?? asString(root.outTrackId) ?? '',
    actionId,
    command,
    conversationId,
    conversationType: normalizeConversationType(
      data.conversationType ?? root.conversationType,
    ),
    userId,
    nick: asString(data.userName) ?? asString(data.nick),
    raw: root,
  };
}
