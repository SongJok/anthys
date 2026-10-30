import { describe, expect, it } from 'vitest';
import {
  formatDwsPermissionInstruction,
  formatDwsPermissionNotice,
  isDwsPermissionError,
  type DwsPermissionNotice,
} from './DwsPermissionNotice.js';

const NOTICE: DwsPermissionNotice = {
  conversationId: 'cid-1',
  conversationType: '2',
  senderStaffId: 'staff-1',
  senderNick: '张三',
  toolName: 'dws_calendar_manage',
  domain: 'calendar',
  action: '日历写权限（event create）',
  command: 'dws calendar event create --title 周会',
  error: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
  occurredAt: Date.UTC(2026, 9, 30, 11, 28),
};

describe('DWS 权限缺失识别', () => {
  it('识别应用级权限点缺失', () => {
    expect(
      isDwsPermissionError(
        'approval',
        'Forbidden.AccessDenied.AccessTokenPermissionDenied',
      ),
    ).toBe(true);
    expect(
      isDwsPermissionError('todo', '{"message":"没有调用该接口的权限"}'),
    ).toBe(true);
  });

  it('文档资源级拒绝不当作应用权限问题', () => {
    expect(isDwsPermissionError('doc', 'permission denied')).toBe(false);
    expect(isDwsPermissionError('wiki', '无权限访问该文档')).toBe(false);
  });

  it('组织类资源缺少权限时识别为应用权限问题', () => {
    expect(isDwsPermissionError('calendar', 'permission denied')).toBe(true);
    expect(isDwsPermissionError('contact', '无权限')).toBe(true);
  });
});

describe('权限通知文案', () => {
  it('列出权限点、开通命令与重新授权步骤', () => {
    const text = formatDwsPermissionNotice(NOTICE);
    expect(text).toContain('【机器人权限不足】');
    expect(text).toContain('2026-10-30 19:28');
    expect(text).toContain('群聊 cid-1');
    expect(text).toContain('张三（staff-1）');
    expect(text).toContain('Calendar.Event.Write');
    expect(text).toContain('dws dev app permission add');
    expect(text).toContain('/dws-login');
    expect(text).toContain('DWS_CLI_ENABLED=false');
  });

  it('工具指令要求模型停止重试并告知用户', () => {
    const instruction = formatDwsPermissionInstruction(NOTICE, true);
    expect(instruction).toContain('已主动通知管理员');
    expect(instruction).toContain('不要重复调用');
    expect(instruction).toContain('Calendar.Event.Write');
  });
});
