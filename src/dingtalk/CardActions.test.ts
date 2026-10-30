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
});
