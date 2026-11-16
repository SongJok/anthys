import type { MetricsRegistry } from '../admin-api/metrics.js';
import type { BeginRunResult } from '../harness/RunControlRegistry.js';
import type { AgentStreamEvent, InboundMessage } from '../types/core.js';
import type { AgentJobStore } from '../types/jobs.js';

export interface BackpressureNotice {
  handle(event: AgentStreamEvent): void;
  finish(): Promise<void>;
}

export interface ConcurrencyBackpressureDeps {
  jobStore: Pick<AgentJobStore, 'enqueue'>;
  concurrencyLimit: () => number;
  activeRuns: () => number;
  metrics: Pick<MetricsRegistry, 'inc'>;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * 全局槽位已满时是否把这条问题转入后台队列。
 * 带附件的消息必须留在前台：后台任务只携带 prompt 文本，
 * 转后台会丢掉图片与文档的解析结果。
 */
export function shouldDivertForBackpressure(
  run: Pick<BeginRunResult, 'waitForSlot'>,
  message: Pick<InboundMessage, 'attachments'>,
  enabled: boolean,
): boolean {
  return enabled && run.waitForSlot && !message.attachments?.length;
}

/**
 * 背压出口：落入持久化后台队列，完成后由 JobRunner 单聊通知发起人。
 * 入队失败时向上抛出，调用方回退到前台排队；入队成功后的通知失败只记日志，
 * 不能回退重跑，否则同一问题会被执行两次。
 */
export async function divertTurnToBackground(
  message: InboundMessage,
  streamer: BackpressureNotice,
  deps: ConcurrencyBackpressureDeps,
): Promise<void> {
  const job = await deps.jobStore.enqueue({
    conversationId: message.conversationId,
    conversationType: message.conversationType,
    messageId: `backpressure_${message.messageId}_${Date.now()}`,
    senderStaffId: message.senderStaffId,
    senderNick: message.senderNick,
    kind: 'task',
    prompt: message.text,
    metadata: {
      source: 'backpressure',
      originalMessageId: message.messageId,
      requestedAt: Date.now(),
    },
  });
  deps.metrics.inc('agent_backpressure_total');
  deps.logger.info(
    {
      messageId: message.messageId,
      conversationId: message.conversationId,
      jobId: job.id,
      activeRuns: deps.activeRuns(),
      limit: deps.concurrencyLimit(),
    },
    'turn diverted to background by concurrency backpressure',
  );
  const shortId = job.id.slice(0, 8);
  try {
    streamer.handle({
      type: 'answer_delta',
      content: [
        '',
        `⏳ 当前并发已满（同时最多 ${deps.concurrencyLimit()} 个回答），这条问题已转入后台持久化队列执行（任务 ID：\`${shortId}\`），完成后将通过单聊通知你。`,
        `使用 \`/job-status ${shortId}\` 可随时查询进度。`,
      ].join('\n'),
    });
    await streamer.finish();
  } catch (error) {
    deps.logger.warn(
      {
        messageId: message.messageId,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'backpressure notice failed; job remains queued',
    );
  }
}