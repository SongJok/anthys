import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type {
  McpToolDescriptor,
  WorkspacePaths,
} from '../../types/mcp-and-sandbox.js';
import type { McpClientPool, McpPoolLogger } from './McpClientPool.js';
import type { McpToolAccessPolicy } from '../../types/admin-and-console.js';

export interface McpToolAccessFilter {
  policies: () => McpToolAccessPolicy[];
  isAdmin: (staffId: string) => boolean;
}

export interface McpToolProviderOptions {
  pool: McpClientPool;
  workspace: WorkspacePaths;
  sampleSize?: number;
  logger?: McpPoolLogger;
  now?: () => number;
  toolAccess?: McpToolAccessFilter;
}

const DEFAULT_SAMPLE_SIZE = 20;
const SAMPLE_PREVIEW_BUDGET = 3_200;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function describeSchema(value: unknown, depth = 0): unknown {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: value.length > 0 ? describeSchema(value[0], depth + 1) : undefined,
    };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string', length: value.length };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      if (depth >= 3) return { type: 'object' };
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      const fields: Record<string, unknown> = {};
      for (const key of keys.slice(0, 50)) {
        fields[key] = describeSchema(record[key], depth + 1);
      }
      return { type: 'object', keys: keys.length, fields };
    }
    default:
      return { type: typeof value };
  }
}

function parseMaybeJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function compactForPreview(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactForPreview(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= 3) return '[object]';
    const record = value as Record<string, unknown>;
    const compact: Record<string, unknown> = {};
    for (const key of Object.keys(record).slice(0, 20)) {
      compact[key] = compactForPreview(record[key], depth + 1);
    }
    return compact;
  }
  return value;
}

function buildPreview(text: string, sampleSize: number): {
  sample: unknown;
  previewCount: number;
  schema: string;
} {
  const parsed = parseMaybeJson(text);
  if (parsed.ok) {
    const value = parsed.value;
    if (Array.isArray(value)) {
      return {
        sample: compactForPreview(value.slice(0, sampleSize)),
        previewCount: Math.min(sampleSize, value.length),
        schema: JSON.stringify(describeSchema(value)),
      };
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).slice(0, sampleSize);
      const sample: Record<string, unknown> = {};
      for (const key of keys) sample[key] = record[key];
      return {
        sample: compactForPreview(sample),
        previewCount: keys.length,
        schema: JSON.stringify(describeSchema(value)),
      };
    }
    return {
      sample: value,
      previewCount: 1,
      schema: JSON.stringify(describeSchema(value)),
    };
  }
  const lines = text.split('\n');
  return {
    sample: lines.slice(0, sampleSize).join('\n'),
    previewCount: Math.min(sampleSize, lines.length),
    schema: JSON.stringify({ type: 'text', lines: lines.length, chars: text.length }),
  };
}

function stepSlug(messageId: string): string {
  const cleaned = messageId.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(0, 24) || 'message';
}

/**
 * 把 MCP 工具包装成 ReAct 工具。
 * 超过 maxResultChars 的观察结果会写入沙盒工作区，只向模型返回前 20 条样本、
 * 数据结构 Schema 与文件路径，引导模型调用沙盒完成聚合分析。
 */
export class McpToolProvider implements IToolProvider {
  public readonly providerName = 'mcp';
  private readonly sampleSize: number;
  private readonly now: () => number;
  private readonly counters = new Map<string, number>();

  constructor(private readonly options: McpToolProviderOptions) {
    this.sampleSize = Math.max(1, options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
    this.now = options.now ?? Date.now;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const descriptors = await this.options.pool.listTools();
    const policy = this.selectPolicy(ctx);
    if (!policy) return descriptors.map((descriptor) => this.toTool(descriptor));
    return descriptors
      .filter((descriptor) => this.isAllowed(policy, descriptor))
      .map((descriptor) => this.toTool(descriptor));
  }

  /** 选中最具体的一条策略：群级优先于全局，角色级优先于不限角色 */
  private selectPolicy(ctx: ExecutionContext): McpToolAccessPolicy | null {
    const filter = this.options.toolAccess;
    if (!filter) return null;
    const role = filter.isAdmin(ctx.senderStaffId) ? 'admin' : 'employee';
    const candidates = filter
      .policies()
      .filter(
        (policy) =>
          policy.enabled &&
          (policy.conversationId === undefined ||
            policy.conversationId === ctx.conversationId) &&
          (policy.role === undefined || policy.role === role),
      )
      .map((policy) => ({
        policy,
        score:
          (policy.conversationId ? 2 : 0) + (policy.role ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.policy ?? null;
  }

  private isAllowed(
    policy: McpToolAccessPolicy,
    descriptor: McpToolDescriptor,
  ): boolean {
    if (
      policy.allowedServerIds.length > 0 &&
      !policy.allowedServerIds.includes(descriptor.serverId)
    ) {
      return false;
    }
    if (policy.allowedTools.length === 0) return true;
    return (
      policy.allowedTools.includes(descriptor.originalName) ||
      policy.allowedTools.includes(descriptor.namespacedName)
    );
  }

  private toTool(descriptor: McpToolDescriptor): ToolDefinition {
    return {
      name: descriptor.namespacedName,
      description:
        `[MCP ${descriptor.serverName} · ${descriptor.domain}] ${descriptor.description}\n` +
        `单次结果超过 ${descriptor.maxResultChars} 字符时，系统会自动转存到沙盒工作区并返回样本预览与 Schema；` +
        `此时请调用 sandbox_analyze_and_aggregate，通过 datasets['data_*.json'] 读取完整数据做聚合。`,
      parametersJsonSchema: descriptor.inputSchema,
      execute: async (args, ctx) => {
        const stepId = this.nextStepId(ctx);
        const result = await this.options.pool.callTool(
          descriptor.namespacedName,
          args,
          { stepId, ...(ctx.signal ? { signal: ctx.signal } : {}) },
        );
        if (result.isError) {
          throw new Error(result.text || `MCP 工具 ${descriptor.originalName} 返回错误`);
        }
        if (result.text.length <= descriptor.maxResultChars) {
          return result.text;
        }
        return this.offload(descriptor, result.text, stepId);
      },
    };
  }

  private nextStepId(ctx: ExecutionContext): string {
    const count = (this.counters.get(ctx.messageId) ?? 0) + 1;
    this.counters.set(ctx.messageId, count);
    if (this.counters.size > 500) {
      const oldest = this.counters.keys().next().value;
      if (oldest !== undefined) this.counters.delete(oldest);
    }
    return `${stepSlug(ctx.messageId)}_${count}`;
  }

  private async offload(
    descriptor: McpToolDescriptor,
    text: string,
    stepId: string,
  ): Promise<string> {
    const datasetKey = `data_${stepId}.json`;
    const hostPath = join(this.options.workspace.hostDir, datasetKey);
    await mkdir(this.options.workspace.hostDir, { recursive: true });
    await writeFile(hostPath, text, 'utf8');

    const preview = buildPreview(text, this.sampleSize);
    let sampleJson = JSON.stringify(preview.sample);
    let sampleTruncated = false;
    if (sampleJson.length > SAMPLE_PREVIEW_BUDGET) {
      sampleJson = `${sampleJson.slice(0, SAMPLE_PREVIEW_BUDGET)}…`;
      sampleTruncated = true;
    }
    const datasetPath = `${this.options.workspace.sandboxDir}/${datasetKey}`;
    this.options.logger?.info?.(
      {
        serverId: descriptor.serverId,
        tool: descriptor.originalName,
        datasetPath,
        sizeChars: text.length,
      },
      'mcp observation offloaded to sandbox workspace',
    );

    return JSON.stringify({
      offloaded: true,
      reason: `结果 ${text.length} 字符，超过 ${descriptor.maxResultChars} 字符阈值`,
      datasetPath,
      datasetKey,
      sizeChars: text.length,
      schema: preview.schema,
      sample: sampleTruncated ? sampleJson : preview.sample,
      sampleTruncated,
      previewCount: preview.previewCount,
      hint:
        `完整结果已写入 ${datasetPath}。请调用 sandbox_analyze_and_aggregate（language=javascript），` +
        `脚本中可直接使用全局变量 datasets，例如 datasets['${datasetKey}']；` +
        `也可使用 loadDataset('${datasetKey}')。不要在回答中臆测未看到的数据。`,
    });
  }
}
