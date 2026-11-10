import { CooldownLimiter } from '../bystander/CooldownLimiter.js';
import { formatShanghaiDate } from '../time/shanghaiTime.js';

export interface GroupNotifyAllDeliverInput {
  conversationId: string;
  text: string;
  /** 原始提问消息 ID，用于卡片失败时回退到该消息的 sessionWebhook */
  requesterMessageId?: string;
}

export interface GroupNotifyAllDelivery {
  channel: 'card' | 'text';
}

/** 真实投递端口：成功返回投递通道，失败必须抛错，不允许静默吞掉 */
export type GroupNotifyAllDeliver = (
  input: GroupNotifyAllDeliverInput,
) => Promise<GroupNotifyAllDelivery>;

export interface GroupNotifyAllAuditRecord {
  conversationId: string;
  actorStaffId: string;
  actorNick: string;
  text: string;
  result: 'succeeded' | 'failed';
  channel?: 'card' | 'text';
  error?: string;
}

export interface GroupNotifyAllServiceOptions {
  isAdmin: (staffId: string) => boolean;
  /** 总开关，默认关闭（灰度） */
  enabled?: boolean;
  /** 同群两次全员通知的最小间隔秒数，默认 60 */
  cooldownSeconds?: number;
  /** 单群每个上海自然日的全员通知上限，默认 10 */
  dailyQuota?: number;
  /** 通知正文最大字符数，默认 1000 */
  maxTextChars?: number;
  now?: () => number;
  audit?: (record: GroupNotifyAllAuditRecord) => Promise<void> | void;
  logger?: {
    info?(obj: Record<string, unknown>, msg: string): void;
    warn?(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface GroupNotifyAllRequest {
  conversationId: string;
  text: string;
  actorStaffId: string;
  actorNick: string;
  requesterMessageId?: string;
}

/**
 * 群聊原生 @所有人 的受控入口：管理员校验、冷却、日配额、并发防重与审计。
 * 只有投递端口真实返回成功才允许对外声称“已通知所有人”。
 */
export class GroupNotifyAllService {
  /** 由启动 wiring 在卡片/兜底通道就绪后注入 */
  public deliver: GroupNotifyAllDeliver | null = null;

  private readonly isAdmin: (staffId: string) => boolean;
  private readonly enabled: boolean;
  private readonly cooldownSeconds: number;
  private readonly dailyQuota: number;
  private readonly maxTextChars: number;
  private readonly now: () => number;
  private readonly audit?: GroupNotifyAllServiceOptions['audit'];
  private readonly logger?: GroupNotifyAllServiceOptions['logger'];
  private readonly cooldown: CooldownLimiter;
  private readonly dailyCounts = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(options: GroupNotifyAllServiceOptions) {
    this.isAdmin = options.isAdmin;
    this.enabled = options.enabled ?? false;
    this.cooldownSeconds = Math.max(0, options.cooldownSeconds ?? 60);
    this.dailyQuota = Math.max(1, options.dailyQuota ?? 10);
    this.maxTextChars = Math.max(1, options.maxTextChars ?? 1_000);
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
    this.logger = options.logger;
    this.cooldown = new CooldownLimiter({ now: this.now });
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  /** 工具暴露条件：功能开启且发起人是管理员 */
  public canUse(staffId: string): boolean {
    return this.enabled && this.isAdmin(staffId);
  }

  public async notify(input: GroupNotifyAllRequest): Promise<string> {
    if (!this.enabled) return '全员通知功能未开启。';
    if (!this.isAdmin(input.actorStaffId)) {
      return '只有管理员可以发起 @所有人 通知。';
    }
    const text = input.text.trim();
    if (!text) return '全员通知内容不能为空。';
    if (text.length > this.maxTextChars) {
      return `全员通知内容过长（最多 ${this.maxTextChars} 字符），请精简后重试。`;
    }
    const conversationId = input.conversationId;
    if (this.inFlight.has(conversationId)) {
      return '本群正在发送一条全员通知，请勿重复操作。';
    }
    const remaining = this.cooldown.remainingSeconds(
      conversationId,
      this.cooldownSeconds,
    );
    if (remaining > 0) {
      return `本群 ${this.cooldownSeconds} 秒内已发送过全员通知，请 ${remaining} 秒后再试。`;
    }
    const dayKey = `${conversationId}:${formatShanghaiDate(this.now())}`;
    const usedToday = this.dailyCounts.get(dayKey) ?? 0;
    if (usedToday >= this.dailyQuota) {
      return `本群今日全员通知次数已达上限（${this.dailyQuota} 次），请明天再试。`;
    }
    const deliver = this.deliver;
    if (!deliver) return '全员通知投递通道未就绪，请稍后重试。';

    this.inFlight.add(conversationId);
    this.logger?.info?.(
      {
        conversationId,
        actorStaffId: input.actorStaffId,
        textChars: text.length,
      },
      'group notify all attempting delivery',
    );
    try {
      const delivery = await deliver({
        conversationId,
        text,
        ...(input.requesterMessageId
          ? { requesterMessageId: input.requesterMessageId }
          : {}),
      });
      this.cooldown.markReplied(conversationId);
      this.dailyCounts.set(dayKey, usedToday + 1);
      this.pruneDailyCounts(dayKey);
      await this.recordAudit({
        conversationId,
        actorStaffId: input.actorStaffId,
        actorNick: input.actorNick,
        text,
        result: 'succeeded',
        channel: delivery.channel,
      });
      return [
        `已向本群发送 @所有人 通知（${delivery.channel === 'card' ? 'AI 卡片' : '文本消息'}通道）。`,
        '通知内容：',
        text,
      ].join('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.(
        { conversationId, actorStaffId: input.actorStaffId, error: message },
        'group notify all delivery failed',
      );
      await this.recordAudit({
        conversationId,
        actorStaffId: input.actorStaffId,
        actorNick: input.actorNick,
        text,
        result: 'failed',
        error: message,
      });
      return `全员通知发送失败：${message}。请勿声称已通知所有人；如仍需通知，可稍后重试或改用普通群消息。`;
    } finally {
      this.inFlight.delete(conversationId);
    }
  }

  private async recordAudit(record: GroupNotifyAllAuditRecord): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit(record);
    } catch (error) {
      this.logger?.warn?.(
        {
          conversationId: record.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to record group notify all audit',
      );
    }
  }

  private pruneDailyCounts(currentKey: string): void {
    const suffix = currentKey.slice(currentKey.lastIndexOf(':') + 1);
    for (const key of this.dailyCounts.keys()) {
      if (!key.endsWith(`:${suffix}`)) this.dailyCounts.delete(key);
    }
  }
}