import { describe, expect, it } from 'vitest';
import { parseCardAction } from './CardActions.js';

describe('parseCardAction', () => {
  it('解析 cardPrivateData 中的按钮动作', () => {
    const action = parseCardAction({
      type: 'actionCallback',
      data: {
        outTrackId: 'track-1',
        conversationId: 'cid-1',
        conversationType: '2',
        userId: 'staff-1',
        userName: '张三',
        cardPrivateData: { actionIds: ['retry'] },
      },
    });
    expect(action).toMatchObject({
      actionId: 'retry',
      command: '/retry',
      conversationId: 'cid-1',
      conversationType: '2',
      userId: 'staff-1',
      nick: '张三',
    });
  });

  it('支持 params.command 自定义指令与全角斜杠', () => {
    const action = parseCardAction({
      data: {
        conversationId: 'cid-2',
        userId: 'staff-2',
        cardPrivateData: {
          actionIds: ['custom'],
          params: { command: '／status' },
        },
      },
    });
    expect(action?.command).toBe('/status');
  });

  it('单聊缺少 conversationId 时回退 userId', () => {
    const action = parseCardAction({
      data: { userId: 'staff-3', cardPrivateData: { actionIds: ['stop'] } },
    });
    expect(action?.conversationId).toBe('staff-3');
    expect(action?.conversationType).toBe('1');
  });

  it('未知动作或非对象输入返回 null', () => {
    expect(
      parseCardAction({
        data: { conversationId: 'c', cardPrivateData: { actionIds: ['nope'] } },
      }),
    ).toBeNull();
    expect(parseCardAction('oops')).toBeNull();
    expect(parseCardAction({})).toBeNull();
  });

  it('解析写操作审批确认与取消按钮（携带 pendingActionId）', () => {
    const confirmAction = parseCardAction({
      data: {
        outTrackId: 'track-approve',
        conversationId: 'cid-1',
        conversationType: '2',
        userId: 'staff-1',
        cardPrivateData: {
          actionIds: ['confirm:act-42'],
        },
      },
    });
    expect(confirmAction).toMatchObject({
      actionKind: 'confirm',
      command: '/confirm act-42',
      pendingActionId: 'act-42',
    });

    const cancelAction = parseCardAction({
      data: {
        conversationId: 'cid-1',
        userId: 'staff-1',
        cardPrivateData: {
          actionIds: ['cancel_action'],
          params: { pendingActionId: 'act-42' },
        },
      },
    });
    expect(cancelAction).toMatchObject({
      actionKind: 'cancel_pending',
      command: '/cancel act-42',
      pendingActionId: 'act-42',
    });
  });

  it('解析卡片点赞/踩反馈、转后台任务及 DWS 授权按钮', () => {
    const up = parseCardAction({
      data: {
        outTrackId: 'track-fb',
        conversationId: 'cid-1',
        userId: 'staff-1',
        cardPrivateData: {
          actionIds: ['feedback_up'],
          params: { traceId: 'trace-9' },
        },
      },
    });
    expect(up).toMatchObject({
      actionKind: 'feedback',
      rating: 'up',
      traceId: 'trace-9',
    });

    const toJob = parseCardAction({
      data: {
        conversationId: 'cid-1',
        userId: 'staff-1',
        cardPrivateData: {
          actionIds: ['convert_to_job'],
          params: { messageId: 'msg-77' },
        },
      },
    });
    expect(toJob).toMatchObject({
      actionKind: 'convert_to_job',
      command: '/job',
      targetMessageId: 'msg-77',
    });

    const consent = parseCardAction({
      data: {
        conversationId: 'cid-1',
        userId: 'staff-1',
        cardPrivateData: { actionIds: ['dws_write'] },
      },
    });
    expect(consent).toMatchObject({
      actionKind: 'dws_consent',
      consentMode: 'write',
      command: '/dws-consent write',
    });
  });
});
