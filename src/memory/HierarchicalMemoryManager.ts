import type { ChatMessage, ChatModel, StoredMessage } from '../types/core.js';
import {
  groupMemberSubjectKey,
  type AssembledMemoryContext,
  type EpisodicSummaryRecord,
  type SemanticMemoryKind,
  type SemanticMemoryRecord,
  type SemanticMemoryScope,
  type SemanticRecallQuery,
  type SemanticRecallResult,
} from '../types/bystander-and-memory.js';
import type {
  EpisodicSummaryStore,
  SemanticMemoryStore,
} from '../db/memorySchema.js';
import type { EmbeddingClient } from './EmbeddingClient.js';
import {
  formatShanghaiDateTime,
  formatShanghaiMessageStamp,
} from '../time/shanghaiTime.js';
import {
  collectContentStream,
  reportBackgroundUsage,
  type BackgroundUsageRecorder,
} from '../billing/backgroundUsage.js';

export interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface EpisodeSummarizerInput {
  conversationId: string;
  messages: StoredMessage[];
  previousSummary?: string;
}

export interface EpisodeSummarizer {
  summarize(input: EpisodeSummarizerInput): Promise<string>;
}

const SUMMARY_SYSTEM_PROMPT = [
  '你是企业对话记忆压缩器。把给定历史对话压缩成结构化摘要，只输出摘要正文，不要客套话。',
  '必须保留：1) 关键线上指标与数值；2) 已确认的排查结论；3) 未决事项与待办；',
  '4) 重要业务术语、项目代号和人名职责。控制在 800 字以内。',
  '时间一律写成绝对日期（Asia/Shanghai，YYYY-MM-DD HH:mm），不要保留“今天/明天/昨天”等相对说法。',
].join('\n');

function renderMessages(messages: StoredMessage[]): string {
  return messages
    .map((message) => {
      const speaker = message.role === 'user' ? '用户' : '助手';
      const stamp =
        message.createdAt > 0
          ? `[${formatShanghaiMessageStamp(message.createdAt)}] `
          : '';
      return `${stamp}${speaker}: ${message.content}`;
    })
    .join('\n');
}

function emptyFacts(text: string): string {
  return text.trim() ? text.trim() : '无';
}

/**
 * 用同一 ChatModel 做结构化摘要；失败时由调用方决定是否降级。
 */
export class LlmEpisodeSummarizer implements EpisodeSummarizer {
  constructor(
    private readonly options: {
      model: ChatModel;
      temperature?: number;
      maxOutputChars?: number;
      onUsage?: BackgroundUsageRecorder;
      now?: () => number;
    },
  ) {}

  public async summarize(
    input: EpisodeSummarizerInput,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          input.previousSummary
            ? `已有摘要（需延续其结论）：\n${input.previousSummary}`
            : '',
          '待压缩对话：',
          renderMessages(input.messages),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ];

    const { content: summary, usage, durationMs } = await collectContentStream(
      this.options.model.streamChat({
        messages,
        tools: [],
        toolChoice: 'none',
        temperature: this.options.temperature ?? 0.2,
        enableNativeReasoning: false,
      }),
      this.options.now,
    );

    await reportBackgroundUsage(this.options.onUsage, {
      worker: 'memory_compress',
      model: this.options.model.modelName,
      conversationId: input.conversationId,
      conversationType: '1',
      senderStaffId: '',
      senderNick: '',
      totalTokens: usage?.totalTokens ?? 0,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
      durationMs,
    });

    const trimmed = summary.trim();
    if (!trimmed) throw new Error('summarizer returned empty summary');
    const limit = this.options.maxOutputChars ?? 2_000;
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
  }
}

const NUMERIC_PATTERN =
  /(\d+(?:\.\d+)?\s*(?:ms|s|%|万|亿|qps|次|条|台|个)?)/iu;
const OPEN_ITEM_PATTERN = /(待办|待确认|未决|下一步|需要|还要|跟进|TODO)/iu;
const TERM_PATTERN = /([A-Z]{2,}[A-Za-z0-9_-]*|[\u4e00-\u9fa5]{2,8}(?:系统|网关|平台|服务|项目))/gu;

/**
 * 无模型环境下的确定性兜底摘要，保证压缩链路不会因模型不可用而阻塞。
 */
export class ExtractiveEpisodeSummarizer implements EpisodeSummarizer {
  public async summarize(
    input: EpisodeSummarizerInput,
  ): Promise<string> {
    const text = renderMessages(input.messages);
    const numbers = text.match(NUMERIC_PATTERN)?.[0];
    const openItems = input.messages
      .map((message) => message.content)
      .filter((content) => OPEN_ITEM_PATTERN.test(content))
      .slice(-3);
    const terms = [...new Set(text.match(TERM_PATTERN) ?? [])].slice(0, 8);

    return [
      input.previousSummary
        ? `【历史摘要】${input.previousSummary}`
        : '【历史摘要】无',
      `【对话范围】共 ${input.messages.length} 条早期消息`,
      `【关键指标】${emptyFacts(numbers ?? '')}`,
      `【排查结论】${emptyFacts(
        input.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content)
          .slice(-2)
          .join(' / '),
      )}`,
      `【未决事项】${emptyFacts(openItems.join(' / '))}`,
      `【术语/代号】${emptyFacts(terms.join('、'))}`,
    ].join('\n');
  }
}

export interface ExtractedSemanticFact {
  scope: SemanticMemoryScope;
  kind: SemanticMemoryKind;
  content: string;
  keywords: string[];
}

export interface SemanticExtractionInput {
  userId: string;
  speakerNick: string;
  conversationId: string;
  conversationType: '1' | '2';
  userText: string;
  assistantText: string;
  sourceMessageId?: string;
}

export interface SemanticFactExtractor {
  extract(input: SemanticExtractionInput): Promise<ExtractedSemanticFact[]>;
}

const EXTRACTION_SYSTEM_PROMPT = [
  '你是企业记忆抽取器，只输出 JSON：{"facts":[{"scope":"user|group|group_member","kind":"profile|terminology","content":"...","keywords":["..."]}]}',
  '只提取对话中明确陈述、长期有效的事实：员工跨群通用职责/负责系统（user）、群内成员仅在本群的角色/分工/偏好（群聊用 group_member）、本群团队常用术语/项目代号/约定（group）。',
  '不要提取临时故障状态、一次性问题、猜测内容。没有可提取内容时返回 {"facts":[]}。',
].join('\n');

/**
 * LLM 事实抽取：把跨会话有价值的画像与术语沉淀到 Semantic Memory。
 */
export class LlmSemanticFactExtractor implements SemanticFactExtractor {
  constructor(
    private readonly options: {
      model: ChatModel;
      temperature?: number;
      onUsage?: BackgroundUsageRecorder;
      now?: () => number;
    },
  ) {}

  public async extract(
    input: SemanticExtractionInput,
  ): Promise<ExtractedSemanticFact[]> {
    const { content, usage, durationMs } = await collectContentStream(
      this.options.model.streamChat({
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `发言人：${input.speakerNick}（${input.userId}）`,
              `会话类型：${input.conversationType === '1' ? '单聊' : '群聊'}`,
              `用户：${input.userText}`,
              `助手：${input.assistantText}`,
            ].join('\n'),
          },
        ],
        tools: [],
        toolChoice: 'none',
        temperature: this.options.temperature ?? 0,
        enableNativeReasoning: false,
      }),
      this.options.now,
    );

    await reportBackgroundUsage(this.options.onUsage, {
      worker: 'memory_extract',
      model: this.options.model.modelName,
      conversationId: input.conversationId,
      conversationType: input.conversationType,
      senderStaffId: input.userId,
      senderNick: input.speakerNick,
      totalTokens: usage?.totalTokens ?? 0,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
      durationMs,
    });

    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      return [];
    }
    if (parsed === null || typeof parsed !== 'object') return [];
    const facts = (parsed as { facts?: unknown }).facts;
    if (!Array.isArray(facts)) return [];

    return facts.flatMap((fact): ExtractedSemanticFact[] => {
      if (fact === null || typeof fact !== 'object') return [];
      const record = fact as Record<string, unknown>;
      // fail-closed：只接受明确声明的 user/group/group_member；
      // 未知作用域不猜测归档，global 禁止由 LLM 写入（避免跨会话污染所有人上下文）
      const rawScope = record.scope;
      if (
        rawScope !== 'user' &&
        rawScope !== 'group' &&
        rawScope !== 'group_member'
      ) {
        return [];
      }
      const scope: SemanticMemoryScope = rawScope;
      const kind = record.kind === 'terminology' ? 'terminology' : 'profile';
      const factContent =
        typeof record.content === 'string' ? record.content.trim() : '';
      if (!factContent) return [];
      const keywords = Array.isArray(record.keywords)
        ? record.keywords
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      return [
        {
          scope,
          kind,
          content: factContent.slice(0, 500),
          keywords,
        },
      ];
    });
  }
}

export interface AssembleMemoryInput {
  personaSystemPrompt: string;
  userId: string;
  speakerNick: string;
  /** 数据库会话 ID，用于召回情景摘要；单聊/群聊均可 */
  conversationId?: string;
  /** 钉钉群 conversationId，用于召回群级术语；仅群聊传入 */
  groupConversationId?: string;
  /** 当前上下文受众；群聊会过滤未标记共享的用户级记忆 */
  audience?: 'single' | 'group';
  groupRecentTranscript?: string;
  activeTurnMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  semanticQuery?: string;
  /**
   * 群聊中该员工个人记忆的共享档位：
   * off 不召回；shareable 只召回标记可共享的；all 召回全部非敏感记忆。
   * 单聊忽略此字段。
   */
  userGroupSharing?: 'off' | 'shareable' | 'all';
}

export interface TerminologyPromotionCandidate {
  standardName: string;
  aliases: string[];
  definition: string;
  evidence: string;
  sourceConversationId: string;
  reinforcementCount: number;
}

export interface HierarchicalMemoryManagerOptions {
  summaryStore: EpisodicSummaryStore;
  semanticStore: SemanticMemoryStore;
  summarizer?: EpisodeSummarizer;
  extractor?: SemanticFactExtractor;
  /** 触发压缩的上下文 Token 阈值，默认 12000 */
  compressionThresholdTokens?: number;
  /** 归档最早对话的比例，默认 0.6 */
  compressionRatio?: number;
  /** 组装上下文时纳入的最近摘要条数 */
  maxAssembledSummaries?: number;
  /** 语义召回条数 */
  semanticLimit?: number;
  estimateTokens?: (text: string) => number;
  /** 配置后语义召回与写入都带向量，失败时自动回退关键词 */
  embedding?: EmbeddingClient;
  /** 语义记忆冲突消解余弦相似度阈值，默认 0.86 */
  conflictSimilarityThreshold?: number;
  /** 高频术语记忆自动晋升候选的最小强化次数，默认 3 */
  terminologyPromotionThreshold?: number;
  /** 高频术语达标时提交到术语候选审核池（不直接入库正式术语） */
  onTerminologyCandidate?: (
    candidate: TerminologyPromotionCandidate,
  ) => Promise<void> | void;
  logger?: MemoryLogger;
}

export interface CompressionResult {
  compressed: boolean;
  summary?: EpisodicSummaryRecord;
}

/**
 * 三层记忆管理器：
 * Working Memory 由调用方持有（当前对话 + GroupTranscriptBuffer）；
 * Episodic Memory 自动压缩归档；Semantic Memory 负责画像与术语召回。
 */
export class HierarchicalMemoryManager {
  private readonly summaryStore: EpisodicSummaryStore;
  private readonly semanticStore: SemanticMemoryStore;
  private readonly summarizer: EpisodeSummarizer;
  private readonly extractor?: SemanticFactExtractor;
  private readonly thresholdTokens: number;
  private readonly compressionRatio: number;
  private readonly maxAssembledSummaries: number;
  private readonly semanticLimit: number;
  private readonly estimate: (text: string) => number;
  private readonly embedding?: EmbeddingClient;
  private readonly conflictSimilarityThreshold: number;
  private readonly terminologyPromotionThreshold: number;
  private readonly onTerminologyCandidate?: HierarchicalMemoryManagerOptions['onTerminologyCandidate'];
  private readonly promotedTerms = new Set<string>();
  private readonly logger?: MemoryLogger;
  private readonly compressing = new Set<string>();

  constructor(options: HierarchicalMemoryManagerOptions) {
    this.summaryStore = options.summaryStore;
    this.semanticStore = options.semanticStore;
    this.summarizer =
      options.summarizer ?? new ExtractiveEpisodeSummarizer();
    this.extractor = options.extractor;
    this.thresholdTokens = Math.max(
      1,
      options.compressionThresholdTokens ?? 12_000,
    );
    this.compressionRatio = Math.min(
      0.9,
      Math.max(0.1, options.compressionRatio ?? 0.6),
    );
    this.maxAssembledSummaries = Math.max(
      1,
      options.maxAssembledSummaries ?? 3,
    );
    this.semanticLimit = Math.max(1, options.semanticLimit ?? 6);
    this.estimate =
      options.estimateTokens ?? ((text) => Math.ceil(text.length / 2));
    this.embedding = options.embedding;
    this.conflictSimilarityThreshold = Math.min(
      0.99,
      Math.max(0.6, options.conflictSimilarityThreshold ?? 0.86),
    );
    this.terminologyPromotionThreshold = Math.max(
      1,
      Math.floor(options.terminologyPromotionThreshold ?? 3),
    );
    this.onTerminologyCandidate = options.onTerminologyCandidate;
    this.logger = options.logger;
  }

  public estimateMessagesTokens(messages: StoredMessage[]): number {
    return messages.reduce(
      (sum, message) => sum + this.estimate(message.content),
      0,
    );
  }

  public async maybeCompress(
    conversationId: string,
    history: StoredMessage[],
  ): Promise<CompressionResult> {
    if (this.compressing.has(conversationId)) {
      return { compressed: false };
    }

    const summaries = await this.summaryStore.listSummaries(
      conversationId,
      50,
    );
    const covered = new Set(
      summaries.flatMap((summary) => summary.coveredMessageIds),
    );
    const pending = history.filter((message) => !covered.has(message.id));
    if (pending.length < 3) return { compressed: false };

    const totalTokens = this.estimateMessagesTokens(pending);
    if (totalTokens < this.thresholdTokens) return { compressed: false };

    const targetTokens = totalTokens * this.compressionRatio;
    let accumulated = 0;
    let splitIndex = 0;
    while (
      splitIndex < pending.length - 1 &&
      accumulated < targetTokens
    ) {
      accumulated += this.estimate(pending[splitIndex]?.content ?? '');
      splitIndex += 1;
    }
    splitIndex = Math.max(1, Math.min(splitIndex, pending.length - 1));

    const toCompress = pending.slice(0, splitIndex);
    this.compressing.add(conversationId);
    try {
      const previousSummary = summaries.at(-1)?.summary;
      const summaryText = await this.summarizer.summarize({
        conversationId,
        messages: toCompress,
        previousSummary,
      });
      const summary = await this.summaryStore.appendSummary({
        conversationId,
        summary: summaryText,
        coveredMessageIds: toCompress.map((message) => message.id),
        tokenCount: this.estimateMessagesTokens(toCompress),
      });
      this.logger?.info(
        {
          conversationId,
          archivedMessages: toCompress.length,
          remainingMessages: pending.length - toCompress.length,
          archivedTokens: summary.tokenCount,
        },
        'episodic memory compressed',
      );
      return { compressed: true, summary };
    } finally {
      this.compressing.delete(conversationId);
    }
  }

  public async latestEpisodicSummary(
    conversationId: string,
  ): Promise<string> {
    const summaries = await this.summaryStore.listSummaries(
      conversationId,
      this.maxAssembledSummaries,
    );
    if (summaries.length === 0) return '';
    return summaries
      .map((summary) => {
        const stamp =
          summary.createdAt > 0
            ? formatShanghaiDateTime(summary.createdAt)
            : '未知时间';
        return [
          `【摘要生成于 ${stamp}；其中“今天/明天”等相对时间仅指生成当时】`,
          summary.summary,
        ].join('\n');
      })
      .join('\n---\n')
      .slice(-6_000);
  }

  private async embedTexts(
    texts: string[],
  ): Promise<number[][] | null> {
    if (!this.embedding || texts.length === 0) return null;
    try {
      const vectors = await this.embedding.embed(texts);
      if (vectors.some((vector) => vector.length !== this.embedding!.dimensions)) {
        throw new Error('embedding dimension mismatch');
      }
      return vectors;
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'embedding failed, falling back to keyword recall',
      );
      return null;
    }
  }

  public async remember(
    facts: Array<{
      scope: SemanticMemoryScope;
      subjectKey: string;
      kind: SemanticMemoryKind;
      content: string;
      keywords?: string[];
      embedding?: number[] | null;
      shareableInGroup?: boolean;
      sensitivity?: SemanticMemoryRecord['sensitivity'];
      confidence?: number;
      expiresAt?: number | null;
      sourceConversationId?: string | null;
      sourceConversationType?: '1' | '2' | null;
      sourceMessageId?: string | null;
    }>,
  ): Promise<SemanticMemoryRecord[]> {
    const vectors = await this.embedTexts(facts.map((fact) => fact.content));
    const saved: SemanticMemoryRecord[] = [];
    for (const [index, fact] of facts.entries()) {
      const record = await this.semanticStore.upsert({
        scope: fact.scope,
        subjectKey: fact.subjectKey,
        kind: fact.kind,
        content: fact.content,
        keywords: fact.keywords ?? [],
        embedding: fact.embedding ?? vectors?.[index] ?? null,
        ...(fact.shareableInGroup !== undefined
          ? { shareableInGroup: fact.shareableInGroup }
          : {}),
        ...(fact.sensitivity ? { sensitivity: fact.sensitivity } : {}),
        ...(fact.confidence !== undefined
          ? { confidence: fact.confidence }
          : {}),
        ...(fact.expiresAt !== undefined
          ? { expiresAt: fact.expiresAt }
          : {}),
        ...(fact.sourceConversationId !== undefined
          ? { sourceConversationId: fact.sourceConversationId }
          : {}),
        ...(fact.sourceConversationType !== undefined
          ? { sourceConversationType: fact.sourceConversationType }
          : {}),
        ...(fact.sourceMessageId !== undefined
          ? { sourceMessageId: fact.sourceMessageId }
          : {}),
      });
      saved.push(record);
      await this.resolveMemoryConflicts(record);
      await this.maybePromoteTerminology(record);
    }
    return saved;
  }

  /** 检测并替代同作用域下与新事实冲突/过时的旧语义记忆 */
  private async resolveMemoryConflicts(
    incoming: SemanticMemoryRecord,
  ): Promise<void> {
    if (!this.semanticStore.supersede || incoming.status !== 'active') return;
    try {
      const candidates = this.semanticStore.listActiveBySubject
        ? await this.semanticStore.listActiveBySubject({
            scope: incoming.scope,
            subjectKey: incoming.subjectKey,
            kind: incoming.kind,
            limit: 50,
          })
        : await this.semanticStore.search({
            query: incoming.content,
            scope: incoming.scope,
            subjectKey: incoming.subjectKey,
            ...(incoming.embedding ? { embedding: incoming.embedding } : {}),
            limit: 20,
          });
      const conflictingIds = candidates
        .filter((existing) =>
          isConflictingMemory(
            existing,
            incoming,
            this.conflictSimilarityThreshold,
          ),
        )
        .map((existing) => existing.id);
      if (conflictingIds.length === 0) return;
      const supersededCount = await this.semanticStore.supersede(
        conflictingIds,
        incoming.id,
      );
      if (supersededCount > 0) {
        this.logger?.info(
          {
            newId: incoming.id,
            scope: incoming.scope,
            subjectKey: incoming.subjectKey,
            supersededCount,
          },
          'semantic memory conflict resolved via superseding',
        );
      }
    } catch (error) {
      this.logger?.warn(
        {
          memoryId: incoming.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'semantic memory conflict resolution failed',
      );
    }
  }

  /** 高频强化的 terminology 记忆自动提审到企业术语候选池 */
  private async maybePromoteTerminology(
    record: SemanticMemoryRecord,
  ): Promise<void> {
    if (
      !this.onTerminologyCandidate ||
      record.kind !== 'terminology' ||
      record.status !== 'active'
    ) {
      return;
    }
    const count = record.reinforcementCount ?? 1;
    if (count < this.terminologyPromotionThreshold) return;
    const draft = parseTerminologyDraft(record);
    if (!draft) return;
    const dedupeKey = draft.standardName.toLowerCase();
    if (this.promotedTerms.has(dedupeKey)) return;
    this.promotedTerms.add(dedupeKey);
    try {
      await this.onTerminologyCandidate({
        ...draft,
        evidence: `语义记忆重复出现 ${count} 次：${record.content}`,
        sourceConversationId: record.sourceConversationId ?? '',
        reinforcementCount: count,
      });
      this.logger?.info(
        {
          term: draft.standardName,
          reinforcementCount: count,
          memoryId: record.id,
        },
        'promoted frequent semantic terminology to glossary candidate',
      );
    } catch (error) {
      this.promotedTerms.delete(dedupeKey);
      this.logger?.warn(
        {
          term: draft.standardName,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to promote semantic terminology to glossary candidate',
      );
    }
  }

  public async recall(
    query: SemanticRecallQuery,
    embedding?: number[],
  ): Promise<SemanticRecallResult> {
    const records = await this.semanticStore.search({
      ...query,
      ...(embedding && embedding.length > 0 ? { embedding } : {}),
      limit: query.limit ?? this.semanticLimit,
    });
    const profileLines: string[] = [];
    const glossaryLines: string[] = [];
    for (const record of records) {
      const line = `- ${record.content}`;
      if (record.kind === 'profile') {
        if (!profileLines.includes(line)) profileLines.push(line);
      } else if (!glossaryLines.includes(line)) {
        glossaryLines.push(line);
      }
    }
    return { profileLines, glossaryLines };
  }

  public async assemble(
    input: AssembleMemoryInput,
  ): Promise<AssembledMemoryContext> {
    const queryText =
      input.semanticQuery ??
      (input.activeTurnMessages ?? [])
        .map((message) => message.content)
        .join(' ')
        .slice(-500);

    const queryVector = (await this.embedTexts([queryText]))?.[0];
    const audience =
      input.audience ?? (input.groupConversationId ? 'group' : 'single');
    const inGroup = audience === 'group';
    const userGroupSharing = input.userGroupSharing ?? 'shareable';
    const userRecall =
      inGroup && userGroupSharing === 'off'
        ? Promise.resolve({ profileLines: [], glossaryLines: [] })
        : this.recall(
            {
              query: queryText,
              scope: 'user',
              subjectKey: input.userId,
              ...(inGroup && userGroupSharing === 'shareable'
                ? { shareableOnly: true }
                : {}),
              // 敏感级记忆在任何授权档位下都不进入群聊上下文
              ...(inGroup ? { excludeSensitive: true } : {}),
            },
            queryVector,
          );
    const [userRecallResult, groupMemberRecall, groupRecall, episodicSummary] =
      await Promise.all([
        userRecall,
        inGroup && input.groupConversationId
          ? this.recall(
              {
                query: queryText,
                scope: 'group_member',
                subjectKey: groupMemberSubjectKey(
                  input.groupConversationId,
                  input.userId,
                ),
                excludeSensitive: true,
              },
              queryVector,
            )
          : Promise.resolve({ profileLines: [], glossaryLines: [] }),
        inGroup && input.groupConversationId
          ? this.recall(
              {
                query: queryText,
                scope: 'group',
                subjectKey: input.groupConversationId,
                excludeSensitive: true,
              },
              queryVector,
            )
          : this.recall({ query: queryText, scope: 'global' }, queryVector),
        input.conversationId
          ? this.latestEpisodicSummary(input.conversationId)
          : Promise.resolve(''),
      ]);

    const profileLines = [`发言人：${input.speakerNick}`];
    for (const line of userRecallResult.profileLines) {
      if (!profileLines.includes(line)) profileLines.push(line);
    }
    const groupMemberProfileLines = groupMemberRecall.profileLines.filter(
      (line) =>
        !profileLines.includes(line) &&
        !groupRecall.profileLines.includes(line),
    );
    if (groupMemberProfileLines.length > 0) {
      profileLines.push(
        `本群成员记忆（${input.speakerNick}）：`,
        ...groupMemberProfileLines,
      );
    }
    if (
      userRecallResult.glossaryLines.length +
        groupMemberRecall.glossaryLines.length +
        groupRecall.glossaryLines.length >
      0
    ) {
      profileLines.push(
        '团队术语：',
        ...[
          ...userRecallResult.glossaryLines,
          ...groupMemberRecall.glossaryLines,
          ...groupRecall.glossaryLines,
        ].filter(
          (line, index, all) => all.indexOf(line) === index,
        ),
      );
    }
    const groupProfileLines = groupRecall.profileLines.filter(
      (line) => !profileLines.includes(line),
    );
    if (groupProfileLines.length > 0) {
      profileLines.push('团队画像：', ...groupProfileLines);
    }

    return {
      personaSystemPrompt: input.personaSystemPrompt,
      userSemanticProfile: profileLines.join('\n'),
      groupRecentTranscript: input.groupRecentTranscript ?? '',
      episodicSummary,
      activeTurnMessages: input.activeTurnMessages ?? [],
    };
  }

  /** 仅当消息包含长期画像/术语信号时才调用模型抽取，避免每轮消耗 */
  public shouldExtractSemantic(userText: string): boolean {
    if (!this.extractor) return false;
    return /(我是|我在|我负责|我们组|我们团队|负责|项目代号|简称|黑话|别名|对接|owner|oncall|带我|由我)/iu.test(
      userText,
    );
  }

  public async captureSemantic(
    input: SemanticExtractionInput,
  ): Promise<SemanticMemoryRecord[]> {
    if (!this.extractor) return [];
    // 双重防线：即便抽取器返回 global 也一律丢弃，全局记忆只能由管理员维护
    const facts = (await this.extractor.extract(input)).filter(
      (fact) => fact.scope !== 'global',
    );
    if (facts.length === 0) return [];

    return this.remember(
      facts.map((fact) => {
        // 单聊没有群上下文，抽取器误标为 group / group_member 的事实归回该员工，
        // 否则会落在永远无法召回的伪群作用域里
        const scope: SemanticMemoryScope =
          (fact.scope === 'group' || fact.scope === 'group_member') &&
          input.conversationType === '1'
            ? 'user'
            : fact.scope;
        const subjectKey =
          scope === 'user'
            ? input.userId
            : scope === 'group_member'
              ? groupMemberSubjectKey(input.conversationId, input.userId)
              : scope === 'group'
                ? input.conversationId
                : 'global';
        return {
          scope,
          subjectKey,
          kind: scope === 'group_member' ? 'profile' : fact.kind,
          content: fact.content,
          keywords: fact.keywords,
          // 私聊沉淀的个人事实默认不跨群共享，需管理员显式放开；群内成员记忆仅在本群对该成员生效
          shareableInGroup: scope === 'user' ? false : true,
          sensitivity: scope === 'user' ? 'private' : 'normal',
          confidence: 0.8,
          sourceConversationId: input.conversationId,
          sourceConversationType: input.conversationType,
          sourceMessageId: input.sourceMessageId ?? null,
        };
      }),
    );
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const PREDICATE_RULES: Array<{ pattern: RegExp; group: string }> = [
  {
    pattern:
      /^(.{1,24}?)(?:目前|现在|当前|已经|改为|更新为)?(?:负责|担任|主管|维护|对接|oncall)\s*(.+)$/iu,
    group: 'responsibility',
  },
  {
    pattern: /^(.{1,24}?)(?:负责人|owner|对接人)(?:目前|现在)?(?:是|为|改为|[:：=])\s*(.+)$/iu,
    group: 'owner',
  },
  {
    pattern:
      /^(.{1,24}?)(?:目前|现在)?(?:偏好|习惯|要求|位于|所在部门是|属于)\s*(.+)$/iu,
    group: 'attribute',
  },
  {
    pattern:
      /^[「『"']?([^\s「」『』"'：:=]{1,30})[」』"']?\s*(?:是指|指的是|指代|简称|定义为|意思是|[:：=])\s*(.+)$/iu,
    group: 'definition',
  },
];

export function extractSubjectPredicateKey(content: string): string | null {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  for (const rule of PREDICATE_RULES) {
    const match = rule.pattern.exec(normalized);
    if (match?.[1] && match[2]) {
      const subject = match[1].trim().toLowerCase();
      if (subject.length >= 1) {
        return `${subject}|${rule.group}`;
      }
    }
  }
  return null;
}

export function isConflictingMemory(
  existing: SemanticMemoryRecord,
  incoming: SemanticMemoryRecord,
  similarityThreshold = 0.86,
): boolean {
  if (existing.id === incoming.id) return false;
  if (existing.status !== 'active') return false;
  if (
    existing.scope !== incoming.scope ||
    existing.subjectKey !== incoming.subjectKey ||
    existing.kind !== incoming.kind
  ) {
    return false;
  }
  if (existing.content.trim() === incoming.content.trim()) return false;
  // 低置信度抽取不允许覆盖明显更高置信度的人工/权威记忆
  if (existing.confidence > incoming.confidence + 0.05) return false;

  if (
    existing.embedding &&
    incoming.embedding &&
    existing.embedding.length === incoming.embedding.length &&
    cosineSimilarity(existing.embedding, incoming.embedding) >= similarityThreshold
  ) {
    return true;
  }

  const existingKey = extractSubjectPredicateKey(existing.content);
  const incomingKey = extractSubjectPredicateKey(incoming.content);
  if (existingKey && incomingKey && existingKey === incomingKey) {
    return true;
  }
  return false;
}

export function parseTerminologyDraft(
  record: SemanticMemoryRecord,
): { standardName: string; aliases: string[]; definition: string } | null {
  const content = record.content.trim();
  if (!content) return null;
  const match =
    /^[「『"']?([^\s「」『』"'：:=]{1,30})[」』"']?\s*(?:是指|指的是|指代|简称|定义为|意思是|[:：=])\s*(.+)$/iu.exec(
      content,
    );
  const standardName = (match?.[1] ?? record.keywords[0] ?? '').trim();
  const definition = (match?.[2] ?? content).trim();
  if (!standardName || standardName.length > 40 || !definition) return null;
  const aliases = record.keywords
    .map((kw) => kw.trim())
    .filter((kw) => kw && kw.toLowerCase() !== standardName.toLowerCase())
    .slice(0, 6);
  return { standardName, aliases, definition };
}
