import type { InboundMessage } from '../types/core.js';

export interface CommandRuntime {
  isAdmin(staffId: string): boolean;
  stopRun(conversationId: string): number;
  retryLast(conversationId: string): Promise<'started' | 'none'>;
  resetConversation(message: InboundMessage): Promise<void>;
  status(): Promise<string> | string;
  lastTrace(conversationId: string): Promise<string>;
  /** 本人 DWS 身份授权状态 */
  dwsStatus(message: InboundMessage): Promise<string> | string;
  /** 发起本人 DWS 设备码授权（仅单聊） */
  dwsLogin(message: InboundMessage): Promise<string>;
  /** 查看/同意/调整本人 DWS 授权范围（仅单聊） */
  dwsConsent(message: InboundMessage, args: string[]): Promise<string>;
  /** 清除本人本机 DWS 登录态（仅单聊） */
  dwsLogout(message: InboundMessage): Promise<string>;
  /** 系统级 DWS 授权状态（管理员，仅用于旁听等基础设施） */
  dwsSystemStatus(): Promise<string> | string;
  /** 重新发起系统级 DWS 授权（管理员） */
  dwsSystemLogin(message: InboundMessage): Promise<string>;
  setMuted(conversationId: string, muted: boolean): Promise<void>;
  recordFeedback(input: {
    conversationId: string;
    staffId: string;
    nick: string;
    messageId: string;
    text: string;
  }): Promise<void>;
  /** 执行等待确认的写操作，返回给用户的执行结果 */
  confirmAction(message: InboundMessage): Promise<string>;
  /** 取消等待确认的写操作 */
  cancelAction(conversationId: string): Promise<string>;
  /** 创建/查看/取消个人提醒（仅单聊） */
  remind(message: InboundMessage, args: string[]): Promise<string>;
  /** 创建/预览/取消个人日周月报（仅单聊） */
  reports(message: InboundMessage, args: string[]): Promise<string>;
  reply(message: InboundMessage, text: string): Promise<void>;
}

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

const HELP_TEXT = [
  '可用指令：',
  '- `/help` 查看帮助',
  '- `/status` 查看机器人与模型状态',
  '- `/stop` 停止当前回答并清空排队中的问题',
  '- `/retry` 重试上一条问题',
  '- `/reset` 清空本会话上下文',
  '- `/trace` 查看最近一次执行轨迹摘要',
  '- `/dws-status` 查看本人 DWS 授权状态',
  '- `/dws-consent` 查看并同意本人 DWS 授权范围（单聊）',
  '- `/dws-login` 发起本人 DWS 设备授权（单聊）',
  '- `/dws-logout` 清除本人本机 DWS 登录态（单聊）',
  '- `/dws-system` 查看系统级 DWS 授权状态（管理员）',
  '- `/dws-system-login` 重新发起系统级 DWS 授权（管理员）',
  '- `/mute` / `/unmute` 暂停或恢复本群旁听（管理员）',
  '- `/feedback <内容>` 提交对本次回答的反馈',
  '- `/confirm` 执行等待确认的写操作',
  '- `/cancel` 取消等待确认的写操作',
  '- `/remind 25分钟后 开会` 创建个人提醒（单聊）',
  '- `/report daily 09:00` 定时推送日/周/月报（单聊）',
].join('\n');

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  const normalized = trimmed.startsWith('／')
    ? `/${trimmed.slice(1)}`
    : trimmed;
  if (!normalized.startsWith('/')) return null;
  const tokens = normalized.slice(1).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const [name, ...args] = tokens;
  return {
    name: name.toLowerCase(),
    args,
    raw: normalized,
  };
}

/**
 * 文本指令路由：在进入 ReAct 之前拦截 /help、/stop 等控制指令。
 * 指令不消耗模型 token，也不写入对话历史。
 */
export class CommandRouter {
  constructor(private readonly runtime: CommandRuntime) {}

  public async tryHandle(message: InboundMessage): Promise<boolean> {
    const command = parseCommand(message.text);
    if (!command) return false;
    const { runtime } = this;

    switch (command.name) {
      case 'help':
        await runtime.reply(message, HELP_TEXT);
        return true;
      case 'status':
        await runtime.reply(message, await runtime.status());
        return true;
      case 'stop': {
        const stopped = runtime.stopRun(message.conversationId);
        const queued = Math.max(0, stopped - 1);
        await runtime.reply(
          message,
          stopped === 0
            ? '当前没有进行中的回答。'
            : queued > 0
              ? `已停止当前回答，并取消 ${queued} 条排队中的问题。`
              : '已停止当前回答。',
        );
        return true;
      }
      case 'retry': {
        const result = await runtime.retryLast(message.conversationId);
        await runtime.reply(
          message,
          result === 'started'
            ? '正在重新执行上一条问题。'
            : '没有可重试的问题。',
        );
        return true;
      }
      case 'reset':
        await runtime.resetConversation(message);
        await runtime.reply(
          message,
          '已清空本会话的上下文，历史摘要与团队记忆仍会保留。',
        );
        return true;
      case 'trace':
        await runtime.reply(message, await runtime.lastTrace(message.conversationId));
        return true;
      case 'dws-status':
        await runtime.reply(message, await runtime.dwsStatus(message));
        return true;
      case 'dws-consent':
      case 'dws-login':
      case 'dws-logout': {
        if (message.conversationType !== '1') {
          await runtime.reply(
            message,
            '个人 DWS 授权只能在与机器人的单聊中操作，避免把授权信息发到群里。',
          );
          return true;
        }
        const text =
          command.name === 'dws-consent'
            ? await runtime.dwsConsent(message, command.args)
            : command.name === 'dws-login'
              ? await runtime.dwsLogin(message)
              : await runtime.dwsLogout(message);
        await runtime.reply(message, text);
        return true;
      }
      case 'dws-system':
      case 'dws-system-login': {
        if (!runtime.isAdmin(message.senderStaffId)) {
          await runtime.reply(message, '只有管理员可以查看或重新发起系统级 DWS 授权。');
          return true;
        }
        const text =
          command.name === 'dws-system-login'
            ? await runtime.dwsSystemLogin(message)
            : await runtime.dwsSystemStatus();
        await runtime.reply(message, text);
        return true;
      }
      case 'mute':
      case 'unmute': {
        if (message.conversationType !== '2') {
          await runtime.reply(message, '该指令仅在群聊中可用。');
          return true;
        }
        if (!runtime.isAdmin(message.senderStaffId)) {
          await runtime.reply(message, '只有管理员可以调整本群旁听策略。');
          return true;
        }
        const muted = command.name === 'mute';
        await runtime.setMuted(message.conversationId, muted);
        await runtime.reply(
          message,
          muted
            ? '已暂停本群旁听与主动回复，发送 /unmute 恢复。'
            : '已恢复本群旁听与主动回复。',
        );
        return true;
      }
      case 'confirm': {
        await runtime.reply(message, await runtime.confirmAction(message));
        return true;
      }
      case 'cancel': {
        await runtime.reply(
          message,
          await runtime.cancelAction(message.conversationId),
        );
        return true;
      }
      case 'remind': {
        await runtime.reply(message, await runtime.remind(message, command.args));
        return true;
      }
      case 'report':
      case 'reports': {
        await runtime.reply(
          message,
          await runtime.reports(message, command.args),
        );
        return true;
      }
      case 'feedback': {
        const text = command.args.join(' ').trim();
        if (!text) {
          await runtime.reply(message, '用法：`/feedback 你的反馈内容`');
          return true;
        }
        await runtime.recordFeedback({
          conversationId: message.conversationId,
          staffId: message.senderStaffId,
          nick: message.senderNick,
          messageId: message.messageId,
          text,
        });
        await runtime.reply(message, '已记录你的反馈，感谢参与改进。');
        return true;
      }
      default:
        await runtime.reply(
          message,
          `未知指令 /${command.name}，发送 /help 查看可用指令。`,
        );
        return true;
    }
  }
}
