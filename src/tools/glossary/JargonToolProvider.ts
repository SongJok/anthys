import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type {
  GroupArchiveSummary,
  GroupTranscriptArchive,
} from '../../bystander/GroupTranscriptArchive.js';
import type { TranscriptEntry } from '../../types/bystander-and-memory.js';
import {
  isGlossarySensitivity,
  isGlossaryTimeliness,
} from '../../types/glossary.js';
import type {
  GlossaryCandidate,
  GlossaryCandidateInput,
} from '../../types/glossary-candidates.js';

export interface JargonToolLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** 候选提交最小端口（GlossaryCandidateService 满足） */
export interface JargonCandidatePort {
  submit(input: GlossaryCandidateInput): Promise<GlossaryCandidate>;
}

export interface JargonToolProviderOptions {
  archive: GroupTranscriptArchive;
  candidates: JargonCandidatePort;
  isAdmin?: (staffId: string) => boolean;
  enabled?: () => boolean;
  logger?: JargonToolLogger;
}

const SHANGHAI_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatClock(timestamp: number): string {
  if (!timestamp) return '--/-- --:--';
  return SHANGHAI_TIME.format(new Date(timestamp));
}

function normalizeText(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' / ').trim();
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/**
 * 公司黑话工具：读取群发言持久化归档、把归纳出的黑话提交为待审批候选。
 * 候选绝不直接写入术语知识库——只有管理员在后台「通过」后才入库。
 */
export class JargonToolProvider implements IToolProvider {
  public readonly providerName = 'jargon';
  private readonly archive: GroupTranscriptArchive;
  private readonly candidates: JargonCandidatePort;
  private readonly isAdmin: (staffId: string) => boolean;
  private readonly enabled: () => boolean;
  private readonly logger?: JargonToolLogger;

  constructor(options: JargonToolProviderOptions) {
    this.archive = options.archive;
    this.candidates = options.candidates;
    this.isAdmin = options.isAdmin ?? (() => false);
    this.enabled = options.enabled ?? (() => true);
    this.logger = options.logger;
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    if (!this.enabled()) return [];
    return [this.transcriptReadTool(ctx), this.candidateSubmitTool()];
  }

  private transcriptReadTool(ctx: ExecutionContext): ToolDefinition {
    return {
      name: 'group_transcript_read',
      description:
        '读取群发言的持久化归档（服务器固定位置单独存放，含群内所有成员的 @ 与非 @ 发言，按时间顺序）。用于归纳公司黑话、回顾群内约定或上下文。默认读取当前群最近 200 条；管理员可指定其他群或列出已归档的群。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description:
              '要读取的群 conversationId；缺省为当前群。非管理员只能读取当前群。',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: '最多返回最近多少条发言，默认 200',
          },
          listGroups: {
            type: 'boolean',
            description:
              '为 true 时列出所有已归档的群及条数（仅管理员），忽略其他参数',
          },
        },
        additionalProperties: false,
      },
      risk: 'read',
      source: 'jargon',
      execute: async (args) => {
        const admin = this.isAdmin(ctx.senderStaffId);
        if (args.listGroups === true) {
          if (!admin) return '列出归档群仅管理员可用。';
          const groups = await this.archive.listGroups();
          if (groups.length === 0) return '暂无群发言归档。';
          return [
            `已归档 ${groups.length} 个群（按最近发言排序）：`,
            ...groups.map(
              (group: GroupArchiveSummary) =>
                `- ${group.conversationId} · ${group.entryCount} 条 · 最近 ${formatClock(group.lastTimestamp)}`,
            ),
          ].join('\n');
        }

        const target =
          readString(args.conversationId) ?? ctx.conversationId;
        if (!admin && (ctx.conversationType !== '2' || target !== ctx.conversationId)) {
          return '仅管理员可跨群读取发言归档；当前只能读取本群。';
        }
        const limitArg = args.limit;
        const limit =
          typeof limitArg === 'number' && Number.isFinite(limitArg)
            ? Math.trunc(limitArg)
            : undefined;
        const entries = await this.archive.read(target, {
          ...(limit !== undefined ? { limit } : {}),
        });
        if (entries.length === 0) {
          return `群 ${target} 暂无发言归档（机器人需在群内且开启归档后才会收集）。`;
        }
        const lines = entries.map(
          (entry: TranscriptEntry) =>
            `[${formatClock(entry.timestamp)}] ${entry.senderNick}: ${normalizeText(entry.text)}`,
        );
        return [`群 ${target} 最近 ${entries.length} 条发言：`, ...lines].join('\n');
      },
    };
  }

  private candidateSubmitTool(): ToolDefinition {
    return {
      name: 'glossary_candidate_submit',
      description:
        '把从群发言归纳出的公司黑话提交为「待审批候选」。注意：本工具不会直接写入术语知识库，候选必须由管理员在后台控制台点击「通过」后才会正式入库。提交前请确保定义准确、有群内原话作为证据，避免把临时梗或一次性用语当作长期黑话。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          standardName: {
            type: 'string',
            description: '黑话的标准名称，例如「拉齐」「PB 系统」',
          },
          definition: {
            type: 'string',
            description: '准确定义这个黑话在团队内的含义',
          },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: '常见别名 / 缩写',
          },
          usageScenarios: {
            type: 'string',
            description: '典型使用场景',
          },
          examples: {
            type: 'array',
            items: { type: 'string' },
            description: '群内真实例句（尽量引用原话）',
          },
          misconceptions: {
            type: 'string',
            description: '容易被误解为什么',
          },
          department: {
            type: 'string',
            description: '所属部门 / 项目',
          },
          timeliness: {
            type: 'string',
            enum: ['long_term', 'project', 'retired'],
            description: '时效性，默认 long_term',
          },
          sensitivity: {
            type: 'string',
            enum: ['public', 'team', 'sensitive'],
            description: '敏感级别，默认 team',
          },
          evidence: {
            type: 'string',
            description: '支撑证据：群内原话摘录与归纳理由',
          },
          sourceConversationId: {
            type: 'string',
            description: '来源群 conversationId；缺省为当前群',
          },
        },
        required: ['standardName', 'definition'],
        additionalProperties: false,
      },
      risk: 'write',
      source: 'jargon',
      execute: async (args, executionContext) => {
        const standardName = readString(args.standardName);
        const definition = readString(args.definition);
        if (!standardName) return '参数 standardName 必须是非空字符串';
        if (!definition) return '参数 definition 必须是非空字符串';

        const timelinessRaw = readString(args.timeliness);
        if (timelinessRaw !== undefined && !isGlossaryTimeliness(timelinessRaw)) {
          return 'timeliness 必须是 long_term / project / retired';
        }
        const sensitivityRaw = readString(args.sensitivity);
        if (
          sensitivityRaw !== undefined &&
          !isGlossarySensitivity(sensitivityRaw)
        ) {
          return 'sensitivity 必须是 public / team / sensitive';
        }

        const input: GlossaryCandidateInput = {
          standardName,
          definition,
          ...(readStringArray(args.aliases)
            ? { aliases: readStringArray(args.aliases) }
            : {}),
          ...(readString(args.usageScenarios)
            ? { usageScenarios: readString(args.usageScenarios) }
            : {}),
          ...(readStringArray(args.examples)
            ? { examples: readStringArray(args.examples) }
            : {}),
          ...(readString(args.misconceptions)
            ? { misconceptions: readString(args.misconceptions) }
            : {}),
          ...(readString(args.department)
            ? { department: readString(args.department) }
            : {}),
          ...(timelinessRaw !== undefined ? { timeliness: timelinessRaw } : {}),
          ...(sensitivityRaw !== undefined
            ? { sensitivity: sensitivityRaw }
            : {}),
          ...(readString(args.evidence)
            ? { evidence: readString(args.evidence) }
            : {}),
          sourceConversationId:
            readString(args.sourceConversationId) ??
            (executionContext.conversationType === '2'
              ? executionContext.conversationId
              : ''),
          submittedBy: executionContext.senderStaffId || 'company-jargon',
        };

        try {
          const candidate = await this.candidates.submit(input);
          return [
            `已提交黑话候选「${candidate.standardName}」（编号 ${candidate.id}），状态：待审批。`,
            '该候选尚未进入术语知识库，需管理员在控制台「术语知识库 → 黑话候选审批」点击通过后才会正式入库。',
          ].join('\n');
        } catch (error) {
          this.logger?.warn(
            {
              standardName,
              error: error instanceof Error ? error.message : String(error),
            },
            'failed to submit glossary candidate',
          );
          return `提交黑话候选失败：${error instanceof Error ? error.message : String(error)}`;
        }
      },
    };
  }
}