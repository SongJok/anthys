import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type { PendingToolAction } from './ToolApprovalGate.js';
import { buildConfirmedActionContext } from './approvalContext.js';

function fallback(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-admin',
    conversationId: 'cid-1',
    conversationType: '2',
    senderStaffId: 'staff-admin',
    senderNick: '管理员',
    isAtBot: true,
    text: '/confirm',
    rawPayload: { senderStaffId: 'staff-admin' },
    timestamp: 1,
    ...overrides,
  };
}

function action(
  requestedBy: PendingToolAction['requestedBy'],
): PendingToolAction {
  return {
    id: 'action-1',
    conversationId: 'cid-1',
    toolName: 'dws_calendar_manage',
    args: { action: 'create' },
    risk: 'write',
    requestedBy,
    createdAt: 1,
    expiresAt: 2,
  };
}

describe('buildConfirmedActionContext', () => {
  it('管理员确认时按原发起人身份构造执行上下文', () => {
    const { context, requesterMessage } = buildConfirmedActionContext({
      action: action({
        staffId: 'staff-requester',
        nick: '发起人',
        messageId: 'msg-requester',
        conversationType: '2',
        personKey: 'staff:staff-requester',
      }),
      fallback: fallback(),
      now: () => 1_000,
      timeoutMs: 30_000,
    });

    expect(requesterMessage).toMatchObject({
      messageId: 'msg-requester',
      conversationId: 'cid-1',
      conversationType: '2',
      senderStaffId: 'staff-requester',
      senderNick: '发起人',
      rawPayload: { senderStaffId: 'staff-requester' },
    });
    expect(context).toMatchObject({
      conversationId: 'cid-1',
      messageId: 'msg-requester',
      senderStaffId: 'staff-requester',
      senderNick: '发起人',
      conversationType: '2',
      personKey: 'staff:staff-requester',
      deadlineAt: 31_000,
    });
    expect(context.notify).toBeUndefined();
  });

  it('旧记录缺少发起人快照时只回退消息字段，不回退身份', () => {
    const { context, requesterMessage } = buildConfirmedActionContext({
      action: action({ staffId: 'staff-requester' }),
      fallback: fallback(),
      now: () => 1_000,
    });

    expect(requesterMessage).toMatchObject({
      messageId: 'msg-admin',
      senderStaffId: 'staff-requester',
      senderNick: 'staff-requester',
      conversationType: '2',
      rawPayload: { senderStaffId: 'staff-requester' },
    });
    expect(context.senderStaffId).toBe('staff-requester');
    expect(context.personKey).toBeUndefined();
  });
});
