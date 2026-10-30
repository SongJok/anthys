import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type {
  ArtifactSendInput,
  ArtifactSendResult,
} from '../../dingtalk/MediaSender.js';

export interface ArtifactSender {
  send(input: ArtifactSendInput): Promise<ArtifactSendResult>;
}

export interface ArtifactToolProviderOptions {
  sender: ArtifactSender;
  /** 允许投递的根目录白名单，相对路径按第一个根目录解析 */
  allowedRoots: string[];
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

function withinRoots(target: string, roots: string[]): boolean {
  return roots.some(
    (root) => target === root || target.startsWith(`${root}${sep}`),
  );
}

/**
 * 产物投递工具：模型把沙盒/工具生成的本地文件回传给当前会话。
 * 只允许读取白名单目录，避免把服务器任意文件外发。
 */
export class ArtifactToolProvider implements IToolProvider {
  public readonly providerName = 'artifacts';
  private readonly maxBytes: number;

  constructor(private readonly options: ArtifactToolProviderOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const roots = await Promise.all(
      this.options.allowedRoots.map((root) =>
        realpath(root).catch(() => resolve(root)),
      ),
    );
    return [this.deliverTool(roots)];
  }

  private deliverTool(roots: string[]): ToolDefinition {
    return {
      name: 'deliver_artifact',
      description:
        '把本地文件作为附件发送到当前钉钉会话，用于交付报表、导出数据、图片或生成的文档。' +
        `只允许发送工作区内的文件，单个文件不超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB。` +
        '调用前请先确认文件已经生成；发送成功后不要再用文本重复整份内容。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径：可为工作区相对路径或白名单目录内的绝对路径',
          },
          fileName: {
            type: 'string',
            description: '展示给用户的文件名，缺省使用本地文件名',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      source: 'artifacts',
      execute: async (args, ctx) => {
        const rawPath = args.path;
        if (typeof rawPath !== 'string' || rawPath.trim() === '') {
          throw new Error('参数 path 必须是非空字符串');
        }
        const requested = rawPath.trim();
        const candidate = isAbsolute(requested)
          ? requested
          : resolve(roots[0] ?? process.cwd(), requested);
        const target = await realpath(candidate).catch(() => null);
        if (!target) throw new Error(`文件不存在: ${requested}`);
        if (!withinRoots(target, roots)) {
          throw new Error('只允许发送工作区目录内的文件');
        }
        const info = await stat(target);
        if (!info.isFile()) throw new Error('目标不是普通文件');
        if (info.size > this.maxBytes) {
          throw new Error(
            `文件超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`,
          );
        }
        const fileName =
          typeof args.fileName === 'string' && args.fileName.trim()
            ? args.fileName.trim()
            : basename(target);
        const result = await this.options.sender.send({
          conversationId: ctx.conversationId,
          conversationType: ctx.conversationType,
          senderStaffId: ctx.senderStaffId,
          filePath: target,
          fileName,
        });
        if (!result.ok) {
          throw new Error(result.error ?? '文件发送失败');
        }
        return JSON.stringify({
          ok: true,
          fileName: result.fileName,
          fileSize: result.fileSize,
          message: `已发送文件「${result.fileName}」`,
        });
      },
    };
  }
}
