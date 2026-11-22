/** 钉钉互动卡片回调解析：把按钮 / 快捷操作映射为结构化动作与文本指令 */

export type CardActionKind =
  | 'command'
  | 'confirm'
  | 'cancel_pending'
  | 'feedback'
  | 'convert_to_job'
  | 'dws_consent';

export interface CardActionEvent {
  outTrackId: string;
  actionId: string;
  actionKind: CardActionKind;
  /** 已归一化的指令，例如 /stop、/confirm <id>、/feedback 👍 */
  command: string;
  conversationId: string;
  conversationType: '1' | '2';
  userId: string;
  nick?: string;
  /** confirm / cancel_pending 动作携带的待确认动作 ID */
  pendingActionId?: string;
  /** feedback 动作携带的正负向评价 */
  rating?: 'up' | 'down';
  /** feedback / convert_to_job 关联的轨迹或原消息 ID */
  traceId?: string;
  targetMessageId?: string;
  /** dws_consent 动作携带的授权模式 */
  consentMode?: 'agree' | 'write' | 'read' | 'revoke';
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

const DWS_CONSENT_ACTIONS: Readonly<Record<string, 'agree' | 'write' | 'read' | 'revoke'>> = {
  dws_agree: 'agree',
  dws_consent_agree: 'agree',
  dws_write: 'write',
  dws_consent_write: 'write',
  dws_read: 'read',
  dws_consent_read: 'read',
  dws_revoke: 'revoke',
  dws_consent_revoke: 'revoke',
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

function resolveStructuredAction(
  actionId: string,
  params: Record<string, unknown>,
): {
  actionKind: CardActionKind;
  command: string;
  pendingActionId?: string;
  rating?: 'up' | 'down';
  traceId?: string;
  targetMessageId?: string;
  consentMode?: 'agree' | 'write' | 'read' | 'revoke';
} | null {
  const lower = actionId.toLowerCase();
  const explicitCommand =
    normalizeCommand(params.command) ?? normalizeCommand(actionId);
  const paramPendingId =
    asString(params.pendingActionId) ?? asString(params.actionId);
  const traceId = asString(params.traceId);
  const targetMessageId =
    asString(params.messageId) ?? asString(params.targetMessageId);

  if (
    lower === 'confirm' ||
    lower === 'confirm_action' ||
    lower === 'approve' ||
    lower.startsWith('confirm:')
  ) {
    const pendingActionId =
      (lower.startsWith('confirm:') ? asString(actionId.slice('confirm:'.length)) : undefined) ??
      paramPendingId;
    return {
      actionKind: 'confirm',
      command: pendingActionId ? `/confirm ${pendingActionId}` : '/confirm',
      ...(pendingActionId ? { pendingActionId } : {}),
    };
  }

  if (
    lower === 'cancel_action' ||
    lower === 'cancel_pending' ||
    lower === 'reject' ||
    lower.startsWith('cancel:')
  ) {
    const pendingActionId =
      (lower.startsWith('cancel:') ? asString(actionId.slice('cancel:'.length)) : undefined) ??
      paramPendingId;
    return {
      actionKind: 'cancel_pending',
      command: pendingActionId ? `/cancel ${pendingActionId}` : '/cancel',
      ...(pendingActionId ? { pendingActionId } : {}),
    };
  }

  if (lower === 'feedback_up' || lower === 'thumbs_up' || lower === 'like') {
    const note = asString(params.feedback) ?? '👍 有用';
    return {
      actionKind: 'feedback',
      rating: 'up',
      command: `/feedback ${note}`,
      ...(traceId ? { traceId } : {}),
      ...(targetMessageId ? { targetMessageId } : {}),
    };
  }

  if (lower === 'feedback_down' || lower === 'thumbs_down' || lower === 'dislike') {
    const note = asString(params.feedback) ?? '👎 回答有误或需改进';
    return {
      actionKind: 'feedback',
      rating: 'down',
      command: `/feedback ${note}`,
      ...(traceId ? { traceId } : {}),
      ...(targetMessageId ? { targetMessageId } : {}),
    };
  }

  if (lower === 'convert_to_job' || lower === 'to_job' || lower === 'deep_job') {
    const prompt = asString(params.prompt);
    return {
      actionKind: 'convert_to_job',
      command: prompt ? `/job ${prompt}` : '/job',
      ...(targetMessageId ? { targetMessageId } : {}),
    };
  }

  const consentMode = DWS_CONSENT_ACTIONS[lower];
  if (consentMode) {
    return {
      actionKind: 'dws_consent',
      consentMode,
      command: `/dws-consent ${consentMode}`,
    };
  }

  const mapped = explicitCommand ?? ACTION_COMMANDS[lower];
  if (!mapped) return null;
  return { actionKind: 'command', command: mapped };
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

  const resolved = resolveStructuredAction(actionId, params);
  if (!resolved) return null;

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
    actionKind: resolved.actionKind,
    command: resolved.command,
    conversationId,
    conversationType: normalizeConversationType(
      data.conversationType ?? root.conversationType,
    ),
    userId,
    nick: asString(data.userName) ?? asString(data.nick),
    ...(resolved.pendingActionId
      ? { pendingActionId: resolved.pendingActionId }
      : {}),
    ...(resolved.rating ? { rating: resolved.rating } : {}),
    ...(resolved.traceId ? { traceId: resolved.traceId } : {}),
    ...(resolved.targetMessageId
      ? { targetMessageId: resolved.targetMessageId }
      : {}),
    ...(resolved.consentMode ? { consentMode: resolved.consentMode } : {}),
    raw: root,
  };
}
