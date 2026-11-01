import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import {
  formatTaskResultMemory,
  type TaskResultSearchInput,
} from '../../memory/TaskResultMemory.js';
import type { TaskResultRecord } from '../../types/task-memory.js';

export interface TaskResultMemoryPort {
  search(input: TaskResultSearchInput): Promise<TaskResultRecord[]>;
}

export interface TaskMemoryToolProviderOptions {
  memory: TaskResultMemoryPort;
  enabled?: () => boolean;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * 让模型检索当前会话已完成的后台任务结果，
 * 解决“上周让你查的结论是什么”这类跨轮次追问。
 */
export class TaskMemoryToolProvider implements IToolProvider {
  public readonly providerName = 'task-memory';
  private readonly memory: TaskResultMemoryPort;
  private readonly enabled: () => boolean;

  constructor(options: TaskMemoryToolProviderOptions) {
    this.memory = options.memory;
    this.enabled = options.enabled ?? (() => true);
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (!this.enabled()) return [];
    return [
      {
        name: 'task_result_search',
        description:
          '检索当前会话中已完成的后台任务、Worker 任务或静默调查结果（仅本会话，按完成时间倒序）。用户追问“上次/昨天/之前让你查的结论”“那个任务的进展”或需要复用历史调查结果时使用。query 留空可列出最近结果。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                '检索关键词，例如“订单服务 报错”“发布检查”；留空表示按时间列出最近任务',
            },
            days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              description: '回看天数，默认 90',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: '最多返回条数，默认 5',
            },
          },
          additionalProperties: false,
        },
        risk: 'read',
        source: 'task-memory',
        execute: async (args, execCtx) => {
          const query = optionalString(args, 'query');
          const days = optionalNumber(args, 'days');
          const limit = optionalNumber(args, 'limit');
          const records = await this.memory.search({
            conversationId: execCtx.conversationId,
            ...(query ? { query } : {}),
            ...(days !== undefined ? { days } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          return formatTaskResultMemory(records);
        },
      },
    ];
  }
}
