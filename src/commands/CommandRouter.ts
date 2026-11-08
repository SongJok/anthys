import type { InboundMessage } from '../types/core.js';
import { WORKER_NAMES, isWorkerName } from '../types/workers.js';

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
  /** 提交后台任务并返回受理结果 */
  submitJob(message: InboundMessage, prompt: string): Promise<string>;
  /** 提交指定 Worker（research/ops/report）的后台任务 */
  submitWorker(
    message: InboundMessage,
    worker: string,
    prompt: string,
  ): Promise<string>;
  /** 任务线程：创建/查看/关联/订阅/关闭 */
  tasks(message: InboundMessage, args: string[]): Promise<string>;
  /** 群工作区：群定位、职责、群目标与群任务（仅群聊） */
  group(message: InboundMessage, args: string[]): Promise<string>;
  /** 个人表达偏好（仅单聊） */
  pref(message: InboundMessage, args: string[]): Promise<string>;
  /** 跨群记忆授权（仅单聊） */
  privacy(message: InboundMessage, args: string[]): Promise<string>;
  /** 个人记忆查看、检索、添加与删除（仅单聊） */
  memory(message: InboundMessage, args: string[]): Promise<string>;
  /** 查看本会话最近的后台任务 */
  listJobs(message: InboundMessage): Promise<string>;
  /** 查看指定后台任务详情（支持 ID 前缀） */
  jobStatus(message: InboundMessage, id: string): Promise<string>;
  /** 取消指定后台任务（支持 ID 前缀） */
  cancelJob(message: InboundMessage, id: string): Promise<string>;
  /** 恢复已暂停的后台任务，可追加补充要求（支持 ID 前缀） */
  resumeJob(
    message: InboundMessage,
    id: string,
    note?: string,
  ): Promise<string>;
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
  '- 发送「授权状态」查看本人钉钉授权状态',
  '- 发送「授权范围」查看授权说明，发送「同意授权」「允许写操作」「改回只读」「撤销授权」调整授权（单聊）',
  '- 发送「授权」或「重新授权」发起本人钉钉设备授权（单聊）',
  '- 发送「退出授权」清除本人本机登录态（单聊）',
  '- 发送「系统授权状态」查看系统级 DWS 授权状态（管理员）',
  '- 发送「系统重新授权」重新发起系统级 DWS 授权（管理员）',
  '- `/mute` / `/unmute` 暂停或恢复本群旁听（管理员）',
  '- `/feedback <内容>` 提交对本次回答的反馈',
  '- 回复「确认」执行等待确认的写操作',
  '- 回复「取消」放弃等待确认的写操作',
  '- `/remind 25分钟后 开会` 创建个人提醒（单聊）',
  '- `/report daily 09:00` 定时推送日/周/月报（单聊）',
  '- `/job <需求>` 提交后台长任务，完成后主动通知',
  '- `/worker <research|ops|report> <需求>` 提交指定 Worker 的后台任务',
  '- `/task new <需求>` 创建任务线程；`/task list`、`/task show <ID>` 查看',
  '- `/task link <ID> <类型> <引用>` 关联外部实体；`/task subscribe|unsubscribe <ID>` 订阅更新',
  '- `/group` 查看或维护本群定位、职责、群目标与群任务（群聊）',
  '- `/pref` 查看或设置个人回答偏好（单聊）',
  '- `/privacy` 设置个人记忆在群聊中的使用范围（单聊）',
  '- `/memory` 查看、检索、添加或删除个人记忆（单聊）',
  '- `/jobs` 查看本会话最近的后台任务',
  '- `/job-status <id>` 查看任务详情',
  '- `/job-cancel <id>` 取消排队或执行中的任务',
  '- `/job-resume <id> [补充要求]` 恢复已暂停的任务',
].join('\n');

const CHINESE_COMMAND_ALIASES: Record<
  string,
  { name: string; args: string[] }
> = {
  确认: { name: 'confirm', args: [] },
  确认执行: { name: 'confirm', args: [] },
  同意执行: { name: 'confirm', args: [] },
  取消: { name: 'cancel', args: [] },
  取消执行: { name: 'cancel', args: [] },
  取消操作: { name: 'cancel', args: [] },
  放弃: { name: 'cancel', args: [] },
  授权: { name: 'dws-login', args: [] },
  开始授权: { name: 'dws-login', args: [] },
  重新授权: { name: 'dws-login', args: [] },
  钉钉授权: { name: 'dws-login', args: [] },
  登录授权: { name: 'dws-login', args: [] },
  授权状态: { name: 'dws-status', args: [] },
  查看授权: { name: 'dws-status', args: [] },
  授权范围: { name: 'dws-consent', args: [] },
  授权说明: { name: 'dws-consent', args: [] },
  同意授权: { name: 'dws-consent', args: ['agree'] },
  允许写操作: { name: 'dws-consent', args: ['write'] },
  开启写权限: { name: 'dws-consent', args: ['write'] },
  允许写入: { name: 'dws-consent', args: ['write'] },
  改回只读: { name: 'dws-consent', args: ['read'] },
  仅只读: { name: 'dws-consent', args: ['read'] },
  关闭写权限: { name: 'dws-consent', args: ['read'] },
  撤销授权: { name: 'dws-consent', args: ['revoke'] },
  退出授权: { name: 'dws-logout', args: [] },
  清除授权: { name: 'dws-logout', args: [] },
  系统授权状态: { name: 'dws-system', args: [] },
  系统重新授权: { name: 'dws-system-login', args: [] },
};

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  const normalized = trimmed.startsWith('／')
    ? `/${trimmed.slice(1)}`
    : trimmed;
  const plainKey = normalized
    .replace(/^\/+/u, '')
    .replace(/^[「『“"']+|[」』”"'。！!？?]+$/gu, '')
    .trim();
  const chineseAlias = CHINESE_COMMAND_ALIASES[plainKey];
  if (chineseAlias) {
    return {
      name: chineseAlias.name,
      args: [...chineseAlias.args],
      raw: normalized,
    };
  }
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
      case 'job': {
        const prompt = command.args.join(' ').trim();
        if (!prompt) {
          await runtime.reply(message, '用法：`/job 需要后台执行的任务需求`');
          return true;
        }
        await runtime.reply(message, await runtime.submitJob(message, prompt));
        return true;
      }
      case 'task': {
        await runtime.reply(message, await runtime.tasks(message, command.args));
        return true;
      }
      case 'group': {
        await runtime.reply(message, await runtime.group(message, command.args));
        return true;
      }
      case 'pref': {
        await runtime.reply(message, await runtime.pref(message, command.args));
        return true;
      }
      case 'privacy': {
        await runtime.reply(
          message,
          await runtime.privacy(message, command.args),
        );
        return true;
      }
      case 'memory': {
        await runtime.reply(message, await runtime.memory(message, command.args));
        return true;
      }
      case 'jobs': {
        await runtime.reply(message, await runtime.listJobs(message));
        return true;
      }
      case 'worker': {
        const [workerToken, ...rest] = command.args;
        const worker = workerToken?.toLowerCase();
        const prompt = rest.join(' ').trim();
        if (!worker || !isWorkerName(worker) || !prompt) {
          await runtime.reply(
            message,
            `用法：\`/worker <${WORKER_NAMES.join('|')}> <需求>\``,
          );
          return true;
        }
        await runtime.reply(
          message,
          await runtime.submitWorker(message, worker, prompt),
        );
        return true;
      }
      case 'job-status': {
        const id = command.args[0]?.trim();
        if (!id) {
          await runtime.reply(message, '用法：`/job-status <任务 ID>`');
          return true;
        }
        await runtime.reply(message, await runtime.jobStatus(message, id));
        return true;
      }
      case 'job-cancel': {
        const id = command.args[0]?.trim();
        if (!id) {
          await runtime.reply(message, '用法：`/job-cancel <任务 ID>`');
          return true;
        }
        await runtime.reply(message, await runtime.cancelJob(message, id));
        return true;
      }
      case 'job-resume': {
        const [idToken, ...rest] = command.args;
        const id = idToken?.trim();
        if (!id) {
          await runtime.reply(
            message,
            '用法：`/job-resume <任务 ID> [补充要求]`',
          );
          return true;
        }
        await runtime.reply(
          message,
          await runtime.resumeJob(message, id, rest.join(' ').trim() || undefined),
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
