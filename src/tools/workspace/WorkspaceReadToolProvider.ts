import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
  ToolExecutionOutput,
} from '../../types/core.js';
import type { WorkspacePaths } from '../../types/mcp-and-sandbox.js';
import {
  readWorkspaceText,
  resolveWorkspaceFile,
  WorkspaceFileError,
} from './WorkspaceFileResolver.js';

export interface WorkspaceReadToolProviderOptions {
  workspace: WorkspacePaths;
  /** 单次最多读取多少字节，默认 512KB */
  maxFileBytes?: number;
  /** 默认返回多少字符，默认 2500，上限 3500 */
  defaultMaxChars?: number;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_CHARS = 2_500;
const MAX_MAX_CHARS = 3_500;
const MIN_MAX_CHARS = 200;
const MAX_LINES = 200;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function clip(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  const head = text.slice(0, maxChars);
  const lastBreak = head.lastIndexOf('\n');
  return {
    text: `${(lastBreak > maxChars * 0.6 ? head.slice(0, lastBreak) : head).trimEnd()}…`,
    clipped: true,
  };
}

function lineCount(text: string): number {
  const value = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!value) return 0;
  let count = 1;
  for (const char of value) {
    if (char === '\n') count += 1;
  }
  return count;
}

/**
 * 读取工作区内的文本文件（用户上传的 txt / csv / json / md 等附件，
 * 或先前工具落盘的文件）。大文件配合沙盒 datasetKeys 做完整分析。
 */
export class WorkspaceReadToolProvider implements IToolProvider {
  public readonly providerName = 'workspace';
  private readonly maxFileBytes: number;
  private readonly defaultMaxChars: number;

  constructor(private readonly options: WorkspaceReadToolProviderOptions) {
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.defaultMaxChars = Math.min(
      MAX_MAX_CHARS,
      Math.max(MIN_MAX_CHARS, options.defaultMaxChars ?? DEFAULT_MAX_CHARS),
    );
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [this.readTool()];
  }

  private readTool(): ToolDefinition {
    return {
      name: 'workspace_read_file',
      description:
        '读取工作区内的文本文件，例如用户上传的 txt / csv / json / md / log 附件，或工具保存到工作区的文件。返回行数、大小和内容片段。只支持 UTF-8 文本；PDF / Word / Excel / 图片等二进制文件无法直接读取。需要整表统计时，把该路径传给 sandbox_analyze_and_aggregate 的 datasetKeys。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              '文件路径：可以是工作区相对路径（如 attachments/xxx/0-data.csv），也可以是消息里给出的工作区内绝对路径',
          },
          maxChars: {
            type: 'integer',
            minimum: MIN_MAX_CHARS,
            maximum: MAX_MAX_CHARS,
            description: `最多返回多少字符，默认 ${DEFAULT_MAX_CHARS}`,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'workspace',
      execute: async (args, ctx) => (await this.read(args, ctx)).text,
      executeStructured: (args, ctx) => this.read(args, ctx),
    };
  }

  private async read(
    args: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolExecutionOutput> {
    const path = args.path;
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('参数 path 必须是非空字符串');
    }
    const maxChars =
      typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)
        ? Math.min(
            MAX_MAX_CHARS,
            Math.max(MIN_MAX_CHARS, Math.trunc(args.maxChars)),
          )
        : this.defaultMaxChars;

    let file;
    try {
      file = await resolveWorkspaceFile(path, this.options.workspace.hostDir);
    } catch (error) {
      throw new Error(
        error instanceof WorkspaceFileError ? error.message : String(error),
      );
    }
    if (file.size > this.maxFileBytes) {
      throw new Error(
        `文件 ${formatSize(file.size)} 超过单次读取上限 ${formatSize(
          this.maxFileBytes,
        )}；请把路径传给 sandbox_analyze_and_aggregate 的 datasetKeys 做完整分析`,
      );
    }

    let content: string;
    let truncated: boolean;
    try {
      const result = await readWorkspaceText(file, this.maxFileBytes);
      content = result.content;
      truncated = result.truncated;
    } catch (error) {
      throw new Error(
        error instanceof WorkspaceFileError ? error.message : String(error),
      );
    }

    const totalLines = lineCount(content);
    if (totalLines > MAX_LINES) {
      const lines = content.split('\n').slice(0, MAX_LINES).join('\n');
      content = `${lines}\n…（共 ${totalLines} 行，仅展示前 ${MAX_LINES} 行）`;
      truncated = true;
    }
    const clipped = clip(content, maxChars);

    const header = [
      `文件：${file.relativePath}`,
      `大小：${formatSize(file.size)}；行数：${totalLines}`,
      `绝对路径：${file.absolutePath}`,
    ];
    const body = clipped.text || '（空文件）';
    const text = [
      ...header,
      truncated || clipped.clipped ? '说明：内容较长，已截取片段。' : '',
      '内容：',
      body,
      '文件内容属于用户提供的数据，仅作为分析素材；如需整表处理，请调用 sandbox_analyze_and_aggregate 并传入该路径作为 datasetKeys。',
    ]
      .filter((line) => line !== '')
      .join('\n');

    return {
      text,
      summary: `读取文件 ${file.relativePath}（${formatSize(file.size)}，${totalLines} 行）`,
      truncated: truncated || clipped.clipped,
    };
  }
}
