import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { GroupBystanderPolicy } from '../../types/bystander-and-memory.js';
import {
  DEFAULT_QA_MODE_TTL_SECONDS,
  isQaModeActive,
} from '../../types/bystander-and-memory.js';
import { formatShanghaiDateTime } from '../../time/shanghaiTime.js';

export interface GroupQaModePolicyPort {
  getGroupPolicy(conversationId: string): Promise<GroupBystanderPolicy>;
  updateGroupPolicy(
    conversationId: string,
    input: { qaModeEnabled?: boolean; qaModeExpiresAt?: number },
    actorStaffId?: string,
  ): Promise<GroupBystanderPolicy>;
}

const DEFAULT_TTL_MINUTES = DEFAULT_QA_MODE_TTL_SECONDS / 60;
const MAX_TTL_MINUTES = 24 * 60;

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function describeExpiry(expiresAt: number): string {
  return expiresAt > 0
    ? `有效期至 ${formatShanghaiDateTime(expiresAt)}`
    : '长期有效（直到被关闭或静音）';
}

/**
 * 群内答疑模式：成员授权后，机器人在限时窗口内对非 @ 提问自主判断并回答。
 * 只作用于当前群；旁听被管理员暂停时拒绝开启，/mute 与紧急静音始终优先。
 */
export class GroupQaModeToolProvider implements IToolProvider {
  public readonly providerName = 'group-qa-mode';
  private readonly policies: GroupQaModePolicyPort;
  private readonly now: () => number;

  constructor(options: {
    policies: GroupQaModePolicyPort;
    now?: () => number;
  }) {
    this.policies = options.policies;
    this.now = options.now ?? Date.now;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (ctx.conversationType !== '2') return [];
    const conversationId = ctx.conversationId;
    return [
      {
        name: 'group_qa_mode',
        description:
          '开启或关闭当前群的限时答疑模式。当群成员要求“后面有人提问你先看看能不能解答/大家提问不用@你也回答/自主答疑”时，必须调用本工具开启（enabled=true），而不是只在正文里口头答应；要求“不用自动回答了/关闭答疑”时调用 enabled=false。开启后机器人会在限时窗口内对群成员的非 @ 提问自主判断是否回答并直接作答。durationMinutes 为答疑时长（分钟），默认 120（2 小时），最长 1440。调用成功后必须在回复正文里向群成员宣布：答疑模式已开启、持续时长与到期时间、期间提问无需 @；该回复会以卡片形式发到群里。工具返回失败时严禁声称已开启。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            enabled: {
              type: 'boolean',
              description: 'true 开启答疑模式，false 关闭',
            },
            durationMinutes: {
              type: 'number',
              description:
                '答疑时长（分钟），默认 120（2 小时），范围 1–1440；传 0 表示不限时',
            },
          },
          required: ['enabled'],
          additionalProperties: false,
        },
        risk: 'write',
        source: 'group-qa-mode',
        execute: async (args) => {
          const enabled = optionalBoolean(args, 'enabled');
          if (enabled === undefined) return '缺少 enabled 参数。';
          const policy = await this.policies.getGroupPolicy(conversationId);

          if (!enabled) {
            await this.policies.updateGroupPolicy(
              conversationId,
              { qaModeEnabled: false, qaModeExpiresAt: 0 },
              ctx.senderStaffId,
            );
            return '已关闭本群答疑模式，后续非 @ 消息恢复普通旁听判定。请在回复里告知群成员答疑模式已关闭。';
          }

          if (!policy.bystanderEnabled || !policy.proactiveReplyEnabled) {
            return '本群旁听或主动回复已被管理员暂停，无法开启答疑模式。请先由管理员发送 /unmute 恢复，或在管理台开启后再试。';
          }

          const rawMinutes = optionalNumber(args, 'durationMinutes');
          const minutes =
            rawMinutes === undefined
              ? DEFAULT_TTL_MINUTES
              : rawMinutes === 0
                ? 0
                : Math.min(MAX_TTL_MINUTES, Math.max(1, Math.round(rawMinutes)));
          const expiresAt =
            minutes === 0 ? 0 : this.now() + minutes * 60_000;
          const updated = await this.policies.updateGroupPolicy(
            conversationId,
            { qaModeEnabled: true, qaModeExpiresAt: expiresAt },
            ctx.senderStaffId,
          );
          const durationText =
            minutes === 0 ? '长期有效' : `${minutes} 分钟`;
          return [
            `已开启本群答疑模式：${durationText}，${describeExpiry(updated.qaModeExpiresAt ?? expiresAt)}。`,
            '期间群成员提问无需 @，机器人会自主判断是否回答并直接作答；闲聊与已有人回答的问题保持沉默。',
            '请在回复正文里向群成员宣布答疑模式已开启、持续时长与到期时间（回复将以卡片形式发到群里）。',
          ].join('\n');
        },
      },
      {
        name: 'group_qa_mode_status',
        description:
          '查询当前群答疑模式状态：是否生效、到期时间。回答“答疑模式还在吗/什么时候到期”时使用，只读。',
        parametersJsonSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        risk: 'read',
        source: 'group-qa-mode',
        execute: async () => {
          const policy = await this.policies.getGroupPolicy(conversationId);
          if (!policy.bystanderEnabled || !policy.proactiveReplyEnabled) {
            return '本群旁听或主动回复已被管理员暂停，答疑模式不生效。';
          }
          if (policy.qaModeEnabled !== true) {
            return '本群当前未开启答疑模式。';
          }
          const expiresAt = policy.qaModeExpiresAt ?? 0;
          if (isQaModeActive(policy, this.now())) {
            return `答疑模式生效中，${describeExpiry(expiresAt)}。`;
          }
          return `答疑模式已到期（${formatShanghaiDateTime(expiresAt)}），如需继续请重新开启。`;
        },
      },
    ];
  }
}