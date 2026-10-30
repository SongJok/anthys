import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type {
  GlossaryLookupProvider,
  GlossaryTerm,
} from '../../types/glossary.js';

export interface GlossaryToolLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GlossaryToolService extends GlossaryLookupProvider {
  formatCard(term: GlossaryTerm): string;
}

export interface GlossaryToolProviderOptions {
  service: GlossaryToolService;
  logger?: GlossaryToolLogger;
}

/**
 * 方式③：把术语库暴露成模型可主动调用的工具。
 * 与系统提示注入、按问检索共用同一份术语卡与敏感级别策略。
 */
export class GlossaryToolProvider implements IToolProvider {
  public readonly providerName = 'glossary';
  private readonly service: GlossaryToolService;
  private readonly logger?: GlossaryToolLogger;

  constructor(options: GlossaryToolProviderOptions) {
    this.service = options.service;
    this.logger = options.logger;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    try {
      if (!(await this.service.hasTerms())) return [];
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'failed to check glossary availability',
      );
      return [];
    }
    return [
      {
        name: 'glossary_lookup',
        description:
          '查询企业术语知识库（内部黑话、缩写、项目代号、历史称呼）。返回标准名称、常见别名、定义、使用场景、示例句子、易误解点、所属部门/项目、时效性、敏感级别与关联文档。遇到含义不确定的术语时必须先查询，不要按字面猜测。',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            term: {
              type: 'string',
              description: '要查询的术语、缩写或别名，例如“CQ”“双十一大促”“PB 系统”',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: '最多返回的相关术语条数，默认 4',
            },
          },
          required: ['term'],
          additionalProperties: false,
        },
        risk: 'read',
        source: 'glossary',
        execute: async (args, executionContext) => {
          const term = args.term;
          if (typeof term !== 'string' || term.trim() === '') {
            throw new Error('参数 term 必须是非空字符串');
          }
          const limitArg = args.limit;
          const limit =
            typeof limitArg === 'number' && Number.isFinite(limitArg)
              ? Math.trunc(limitArg)
              : undefined;
          const result = await this.service.lookup(term.trim(), {
            conversationType: executionContext.conversationType,
            ...(limit !== undefined ? { limit } : {}),
          });
          if (result.exact.length === 0 && result.related.length === 0) {
            return `术语库未收录「${term.trim()}」。请向提问者确认含义或常见称呼，不要凭空猜测。`;
          }
          const blocks: string[] = [];
          if (result.exact.length > 0) {
            blocks.push(
              '## 精确匹配',
              ...result.exact.map((item) => this.service.formatCard(item)),
            );
          }
          if (result.related.length > 0) {
            blocks.push(
              '## 相关术语',
              ...result.related.map((item) => this.service.formatCard(item)),
            );
          }
          if (executionContext.conversationType === '2') {
            blocks.push('当前为群聊，敏感级别术语已自动排除。');
          }
          return blocks.join('\n\n');
        },
      },
    ];
  }
}
