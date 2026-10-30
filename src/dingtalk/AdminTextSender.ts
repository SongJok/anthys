export interface AdminTextSenderLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DingTalkAdminTextSenderOptions {
  /** 支持热更新 RobotCode */
  robotCode: string | (() => string);
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
  logger?: AdminTextSenderLogger;
}

export interface AdminTextSendResult {
  ok: boolean;
  sentStaffIds: string[];
  failed: Array<{ staffId: string; error: string }>;
}

const DEFAULT_API_BASE = 'https://api.dingtalk.com';
/** 钉钉机器人单次批量发送的 userId 上限 */
const MAX_BATCH_SIZE = 20;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 管理员主动通知：用机器人单聊文本消息推送给指定 StaffId。 */
export class DingTalkAdminTextSender {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiBase: string;

  constructor(private readonly options: DingTalkAdminTextSenderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, '');
  }

  public async send(
    staffIds: string[],
    text: string,
  ): Promise<AdminTextSendResult> {
    const recipients = [
      ...new Set(staffIds.map((id) => id.trim()).filter(Boolean)),
    ];
    const content = text.trim();
    if (!content) {
      return { ok: false, sentStaffIds: [], failed: [] };
    }
    if (recipients.length === 0) {
      return { ok: true, sentStaffIds: [], failed: [] };
    }

    let token: string;
    try {
      token = await this.options.getAccessToken();
    } catch (error) {
      const reason = errorMessage(error);
      this.options.logger?.warn(
        { recipients: recipients.length, error: reason },
        'admin text notification token failed',
      );
      return {
        ok: false,
        sentStaffIds: [],
        failed: recipients.map((staffId) => ({ staffId, error: reason })),
      };
    }

    const sentStaffIds: string[] = [];
    const failed: Array<{ staffId: string; error: string }> = [];
    for (let index = 0; index < recipients.length; index += MAX_BATCH_SIZE) {
      const batch = recipients.slice(index, index + MAX_BATCH_SIZE);
      try {
        await this.deliver(batch, content, token);
        sentStaffIds.push(...batch);
      } catch (error) {
        const reason = errorMessage(error);
        failed.push(...batch.map((staffId) => ({ staffId, error: reason })));
        this.options.logger?.warn(
          { recipients: batch.length, error: reason },
          'admin text notification failed',
        );
      }
    }

    this.options.logger?.info?.(
      { sent: sentStaffIds.length, failed: failed.length },
      'admin text notification finished',
    );
    return { ok: failed.length === 0, sentStaffIds, failed };
  }

  private async deliver(
    userIds: string[],
    content: string,
    token: string,
  ): Promise<void> {
    const robotCode =
      typeof this.options.robotCode === 'function'
        ? this.options.robotCode()
        : this.options.robotCode;
    const response = await this.fetchImpl(
      `${this.apiBase}/v1.0/robot/oToMessages/batchSend`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          robotCode,
          userIds,
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `管理员通知发送失败: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
      );
    }
  }
}
