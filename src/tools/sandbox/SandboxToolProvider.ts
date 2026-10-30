import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type {
  SandboxExecRequest,
  WorkspacePaths,
} from '../../types/mcp-and-sandbox.js';
import {
  IsolatedSandbox,
  type IsolatedSandboxOptions,
  type SandboxLanguage,
} from './IsolatedSandbox.js';

const LANGUAGES = ['javascript', 'python', 'bash'] as const;
const DATASET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_MAX_DATASET_BYTES = 32 * 1024 * 1024;

export interface SandboxToolProviderOptions {
  sandbox?: IsolatedSandbox;
  sandboxOptions?: IsolatedSandboxOptions;
  workspace?: WorkspacePaths;
  maxDatasetBytes?: number;
}

function parseDatasets(args: Record<string, unknown>): Record<string, unknown> {
  const value = args.inputDatasets;
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('参数 inputDatasets 必须是对象');
  }
  return { ...(value as Record<string, unknown>) };
}

function parseDatasetKeys(args: Record<string, unknown>): string[] {
  const value = args.datasetKeys;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('参数 datasetKeys 必须是字符串数组');
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`datasetKeys[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

export class SandboxToolProvider implements IToolProvider {
  public readonly providerName = 'sandbox';
  private readonly sandbox: IsolatedSandbox;
  private readonly workspace?: WorkspacePaths;
  private readonly maxDatasetBytes: number;

  constructor(options: SandboxToolProviderOptions = {}) {
    this.sandbox =
      options.sandbox ??
      new IsolatedSandbox(options.sandboxOptions ?? {});
    this.workspace = options.workspace;
    this.maxDatasetBytes =
      options.maxDatasetBytes ?? DEFAULT_MAX_DATASET_BYTES;
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [this.aggregateTool()];
  }

  private async loadDatasets(
    keys: string[],
    inline: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const datasets: Record<string, unknown> = { ...inline };
    for (const key of keys) {
      if (!DATASET_KEY_PATTERN.test(key) || key.includes('..')) {
        throw new Error(`非法的数据集 key: "${key}"`);
      }
      if (!this.workspace) {
        throw new Error('沙盒未配置工作区，无法按 datasetKeys 加载数据');
      }
      const path = join(this.workspace.hostDir, key);
      const info = await stat(path).catch(() => undefined);
      if (!info || !info.isFile()) {
        throw new Error(`数据集不存在: ${key}`);
      }
      if (info.size > this.maxDatasetBytes) {
        throw new Error(
          `数据集 ${key} 超过 ${this.maxDatasetBytes} 字节上限`,
        );
      }
      const raw = await readFile(path, 'utf8');
      try {
        datasets[key] = JSON.parse(raw);
      } catch {
        datasets[key] = raw;
      }
    }
    return datasets;
  }

  private aggregateTool(): ToolDefinition {
    return {
      name: 'sandbox_analyze_and_aggregate',
      description:
        '在隔离沙盒中执行分析脚本，用于日志正则提取、异常堆栈聚类、多表 Join、同比/环比与统计汇总。' +
        'javascript 模式（默认）无需任何依赖，脚本可直接使用全局变量 datasets 与 loadDataset(key)，把最终结果赋值给 result，console.log 的内容会一并返回；' +
        'python/bash 会进入无网络、只读文件系统的受限 Docker 容器，脚本可读取 /workspace/datasets.json，python 额外提供 datasets 与 load_dataset(key)。' +
        'MCP 大结果被卸载后，用 datasetKeys 传入返回的 datasetKey 即可加载完整数据。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: [...LANGUAGES],
            description: '脚本语言，默认 javascript',
          },
          code: {
            type: 'string',
            description:
              '要执行的脚本。javascript 请把结果赋值给 result；python/bash 请直接 print 输出。',
          },
          datasetKeys: {
            type: 'array',
            items: { type: 'string' },
            description:
              '需要挂载的数据集 key（来自 MCP 卸载结果中的 datasetKey），从沙盒工作区读取',
          },
          inputDatasets: {
            type: 'object',
            description: '直接内联的小体量数据集，键名即脚本中 datasets 的键',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 50,
            description: '执行超时毫秒数，默认 javascript 5000、docker 30000',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const language = (args.language ?? 'javascript') as SandboxLanguage;
        if (!LANGUAGES.includes(language)) {
          throw new Error(
            `不支持的沙盒语言: ${String(language)}（允许: ${LANGUAGES.join(', ')}）`,
          );
        }
        const code = args.code;
        if (typeof code !== 'string' || code.trim() === '') {
          throw new Error('参数 code 必须是非空字符串');
        }
        const requestedTimeout = args.timeoutMs;
        if (
          requestedTimeout !== undefined &&
          (typeof requestedTimeout !== 'number' ||
            !Number.isFinite(requestedTimeout) ||
            requestedTimeout <= 0)
        ) {
          throw new Error('参数 timeoutMs 必须是正数');
        }

        const datasets = await this.loadDatasets(
          parseDatasetKeys(args),
          parseDatasets(args),
        );
        const remaining = ctx.deadlineAt - ctx.now();
        if (remaining <= 0) {
          throw new Error('执行已超时，无法调用沙盒');
        }
        const timeoutMs = Math.min(
          typeof requestedTimeout === 'number' ? requestedTimeout : remaining,
          remaining,
        );

        const request: SandboxExecRequest = {
          language,
          code,
          ...(Object.keys(datasets).length > 0
            ? { inputDatasets: datasets }
            : {}),
          timeoutMs,
        };
        const result = await this.sandbox.execute(request);
        const hint =
          result.exitCode === 0
            ? undefined
            : '脚本执行失败，请根据 stderr 修正后重试；不要臆测未成功计算的数据。';
        return JSON.stringify({
          language,
          ...result,
          ...(hint ? { hint } : {}),
        });
      },
    };
  }
}
