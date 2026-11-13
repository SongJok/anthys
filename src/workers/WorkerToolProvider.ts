import { randomUUID } from 'node:crypto';
import type {
  AgentEngine,
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
  ToolExecutionOutput,
} from '../types/core.js';
import type { AgentJob, AgentJobStore } from '../types/jobs.js';
import { WORKER_NAMES, isWorkerName, type WorkerName } from '../types/workers.js';

export interface InlineWorkerResult {
  answer: string;
  usage: {
    totalTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    steps: number;
    durationMs: number;
  };
}

export interface WorkerToolProviderOptions {
  /** 后台派发 Worker 任务持久化存储 */
  jobStore: Pick<AgentJobStore, 'enqueue'>;
  /** 可选同步内联执行（仅限只读研究/报表 Worker） */
  runInline?: (
    worker: WorkerName,
    task: string,
    context: ExecutionContext,
  ) => Promise<InlineWorkerResult>;
  /** 用于校验 inline 目标是否只读，非只读 ops 默认后台执行或走审批 */
  isReadOnlyWorker?: (worker: WorkerName) => boolean;
  enabled?: () => boolean;
}

const TOOL_NAME = 'dispatch_worker';

/**
 * Router 编排工具：把特定领域子任务委派给专职 Worker（research / ops / report）。
 * 仅在主交互对话中暴露，在子代理与 Worker 内部屏蔽，防止递归派发。
 */
export class WorkerToolProvider implements IToolProvider {
  public readonly providerName = 'worker-router';

  constructor(private readonly options: WorkerToolProviderOptions) {}

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (this.options.enabled && !this.options.enabled()) return [];
    // Worker 内部与群聊主动搭话场景禁止嵌套委派
    if (ctx.worker || ctx.proactive) return [];

    return [
      {
        name: TOOL_NAME,
        description:
          '把复杂子任务委派给专职后台 Worker（research=深度只读查证，ops=受控执行，report=汇总报表）。默认异步入队执行并自动通知结果；对于只读 research/report 也可设置 background=false 直接同步取回摘要。',
        risk: 'read',
        source: 'worker-router',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            worker: {
              type: 'string',
              enum: [...WORKER_NAMES],
              description: '目标 Worker 类型：research、ops 或 report',
            },
            task: {
              type: 'string',
              description: '清晰完整的任务说明，包含上下文、约束与期望产出',
            },
            background: {
              type: 'boolean',
              description: '是否转入后台异步队列执行，默认 true',
            },
          },
          required: ['worker', 'task'],
          additionalProperties: false,
        },
        execute: async (args, context) =>
          (await this.dispatch(args, context)).text,
        executeStructured: async (args, context) =>
          this.dispatch(args, context),
      },
    ];
  }

  private async dispatch(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionOutput> {
    if (context.worker) {
      return {
        text: 'Error: Worker 内部禁止再次调用 dispatch_worker，请直接完成当前任务。',
        summary: '禁止递归派发',
      };
    }

    const rawWorker =
      typeof args.worker === 'string' ? args.worker.trim().toLowerCase() : '';
    if (!isWorkerName(rawWorker)) {
      return {
        text: `Error: 不支持的 worker 类型 "${rawWorker}"，可选值为：${WORKER_NAMES.join(', ')}`,
        summary: '无效 Worker',
      };
    }

    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) {
      return {
        text: 'Error: dispatch_worker 需要非空的 task 描述',
        summary: '缺少任务描述',
      };
    }

    const background = args.background !== false;
    const canInline =
      !background &&
      Boolean(this.options.runInline) &&
      (this.options.isReadOnlyWorker?.(rawWorker) ?? rawWorker !== 'ops');

    if (canInline && this.options.runInline) {
      const inline = await this.options.runInline(rawWorker, task, context);
      return {
        text: `[Worker:${rawWorker} 同步执行结果]\n${inline.answer}`,
        summary: `Worker:${rawWorker} 完成（${inline.usage.steps} 步）`,
        usage: inline.usage,
        traces: [
          {
            kind: 'subagent',
            name: `worker:${rawWorker}`,
            steps: inline.usage.steps,
            tokens: inline.usage.totalTokens,
            durationMs: inline.usage.durationMs,
          },
        ],
      };
    }

    const job: AgentJob = await this.options.jobStore.enqueue({
      conversationId: context.conversationId,
      conversationType: context.conversationType,
      messageId: `worker_${randomUUID()}`,
      senderStaffId: context.senderStaffId,
      senderNick: context.senderNick,
      kind: 'worker',
      prompt: task,
      metadata: {
        source: 'dispatch_worker',
        worker: rawWorker,
        parentMessageId: context.messageId,
        requestedAt: Date.now(),
      },
    });
    const shortId = job.id.slice(0, 8);
    return {
      text: [
        `已派发 Worker「${rawWorker}」后台执行（任务 ID：${shortId}）。`,
        '任务将在独立隔离上下文运行，完成后会自动通知发起人；用户也可通过 `/jobs` 或 `/job-status` 查询进展。',
      ].join('\n'),
      summary: `已派发 Worker:${rawWorker}（${shortId}）`,
    };
  }
}

export type InlineWorkerRunner = (
  engine: AgentEngine,
  worker: WorkerName,
  task: string,
  context: ExecutionContext,
) => Promise<InlineWorkerResult>;
