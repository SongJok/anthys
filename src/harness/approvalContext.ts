import type { ExecutionContext, InboundMessage } from '../types/core.js';
import type { PendingToolAction } from './ToolApprovalGate.js';

/**
 * 待确认动作可能由管理员代确认；执行身份必须还原为原始发起人，
 * 否则 DWS 等按 senderStaffId 选择个人身份的工具会改用确认人的账号。
 */
export function approvalRequesterMessage(
  action: PendingToolAction,
  fallback: InboundMessage,
  now: () => number = Date.now,
): InboundMessage {
  const requester = action.requestedBy;
  return {
    messageId: requester.messageId ?? fallback.messageId,
    conversationId: action.conversationId,
    conversationType: requester.conversationType ?? fallback.conversationType,
    senderStaffId: requester.staffId,
    senderNick: requester.nick ?? requester.staffId,
    isAtBot: true,
    text: '',
    rawPayload: { senderStaffId: requester.staffId },
    timestamp: now(),
  };
}

export function buildConfirmedActionContext(input: {
  action: PendingToolAction;
  fallback: InboundMessage;
  personKey?: string;
  now?: () => number;
  timeoutMs?: number;
}): { context: ExecutionContext; requesterMessage: InboundMessage } {
  const now = input.now ?? Date.now;
  const requesterMessage = approvalRequesterMessage(
    input.action,
    input.fallback,
    now,
  );
  const personKey = input.personKey ?? input.action.requestedBy.personKey;
  return {
    requesterMessage,
    context: {
      conversationId: input.action.conversationId,
      messageId: requesterMessage.messageId,
      senderStaffId: requesterMessage.senderStaffId,
      senderNick: requesterMessage.senderNick,
      conversationType: requesterMessage.conversationType,
      ...(personKey ? { personKey } : {}),
      deadlineAt: now() + (input.timeoutMs ?? 120_000),
      now,
    },
  };
}
