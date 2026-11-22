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
import {
  generateWorkspaceArtifact,
  isArtifactFormat,
  type TableSheetInput,
} from './ArtifactGenerator.js';

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
    return [this.deliverTool(roots), this.generateTool(roots)];
  }

  private generateTool(roots: string[]): ToolDefinition {
    const primaryRoot = roots[0] ?? process.cwd();
    return {
      name: 'artifact_generate',
      risk: 'write',
      description:
        '在工作区受控目录生成结构化文档或报表文件（支持 md / txt / json / html / csv / xlsx / docx），生成后可立即投递或返回路径给 deliver_artifact 发送。' +
        '当用户要求导出 Excel（.xlsx）、Word（.docx）、CSV 表格、Markdown 或 HTML 报告时优先使用本工具；需要复杂统计或 Python 绘图时请先用 sandbox_analyze_and_aggregate 生成文件再用 deliver_artifact 发送。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['md', 'txt', 'json', 'html', 'csv', 'xlsx', 'docx'],
            description: '导出格式：md/txt/json/html/csv/xlsx/docx',
          },
          fileName: {
            type: 'string',
            description: '输出文件名，例如 周报汇总.docx 或 订单明细.xlsx',
          },
          title: {
            type: 'string',
            description: '可选标题（用于 docx 首页标题或 html 标题）',
          },
          content: {
            type: 'string',
            description:
              '文档正文（md/txt/json/html/docx 必填；csv 无 sheets 时也可直接传 CSV 文本）',
          },
          sheets: {
            type: 'array',
            description: '表格工作表数组（xlsx 必填，csv 可选）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '工作表名称' },
                headers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '表头列名',
                },
                rows: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: {
                      type: ['string', 'number', 'boolean', 'null'],
                    },
                  },
                  description: '二维数据行',
                },
              },
              required: ['rows'],
              additionalProperties: false,
            },
          },
          deliver: {
            type: 'boolean',
            description: '生成后是否立即作为附件发送到当前钉钉会话，默认 true',
          },
        },
        required: ['format', 'fileName'],
        additionalProperties: false,
      },
      source: 'artifacts',
      execute: async (args, ctx) => {
        const formatRaw =
          typeof args.format === 'string' ? args.format.trim().toLowerCase() : '';
        if (!isArtifactFormat(formatRaw)) {
          throw new Error(
            `不支持的 format: ${formatRaw}（支持 md/txt/json/html/csv/xlsx/docx）`,
          );
        }
        const fileName =
          typeof args.fileName === 'string' ? args.fileName.trim() : '';
        if (!fileName) throw new Error('参数 fileName 必须是非空字符串');
        const content =
          typeof args.content === 'string' ? args.content : undefined;
        const title =
          typeof args.title === 'string' ? args.title : undefined;
        const sheets = parseSheetsArg(args.sheets);
        const generated = await generateWorkspaceArtifact(
          primaryRoot,
          {
            format: formatRaw,
            fileName,
            ...(content !== undefined ? { content } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(sheets ? { sheets } : {}),
          },
          { maxBytes: this.maxBytes, now: ctx.now },
        );

        const shouldDeliver = args.deliver !== false;
        if (!shouldDeliver) {
          return JSON.stringify({
            ok: true,
            delivered: false,
            path: generated.workspaceRelativePath,
            fileName: generated.fileName,
            fileSize: generated.sizeBytes,
            format: generated.format,
            message: `已生成文件「${generated.fileName}」（路径：${generated.workspaceRelativePath}），可调用 deliver_artifact 发送`,
          });
        }

        const sent = await this.options.sender.send({
          conversationId: ctx.conversationId,
          conversationType: ctx.conversationType,
          senderStaffId: ctx.senderStaffId,
          filePath: generated.absolutePath,
          fileName: generated.fileName,
        });
        if (!sent.ok) {
          return JSON.stringify({
            ok: false,
            delivered: false,
            path: generated.workspaceRelativePath,
            fileName: generated.fileName,
            fileSize: generated.sizeBytes,
            error: sent.error ?? '文件已生成但发送到钉钉失败',
          });
        }
        return JSON.stringify({
          ok: true,
          delivered: true,
          path: generated.workspaceRelativePath,
          fileName: sent.fileName,
          fileSize: sent.fileSize,
          format: generated.format,
          message: `已生成并发送文件「${sent.fileName}」`,
        });
      },
    };
  }

  private deliverTool(roots: string[]): ToolDefinition {
    return {
      name: 'deliver_artifact',
      risk: 'write',
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

function parseSheetsArg(raw: unknown): TableSheetInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('参数 sheets 必须是数组');
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`sheets[${idx}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    if (!Array.isArray(obj.rows)) {
      throw new Error(`sheets[${idx}].rows 必须是二维数组`);
    }
    const rows = obj.rows.map((row, rowIdx) => {
      if (!Array.isArray(row)) {
        throw new Error(`sheets[${idx}].rows[${rowIdx}] 必须是数组`);
      }
      return row.map((cell) => {
        if (
          cell === null ||
          cell === undefined ||
          typeof cell === 'string' ||
          typeof cell === 'number' ||
          typeof cell === 'boolean'
        ) {
          return cell;
        }
        return JSON.stringify(cell);
      });
    });
    const headers = Array.isArray(obj.headers)
      ? obj.headers.map((h) => String(h ?? ''))
      : undefined;
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    return {
      ...(name ? { name } : {}),
      ...(headers ? { headers } : {}),
      rows,
    };
  });
}
