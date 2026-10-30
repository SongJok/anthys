import type { ChatMessage, ChatModel, StoredMessage } from '../types/core.js';
import type {
  AssembledMemoryContext,
  EpisodicSummaryRecord,
  SemanticMemoryKind,
  SemanticMemoryRecord,
  SemanticMemoryScope,
  SemanticRecallQuery,
  SemanticRecallResult,
} from '../types/bystander-and-memory.js';
import type {
  EpisodicSummaryStore,
  SemanticMemoryStore,
} from '../db/memorySchema.js';
import type { EmbeddingClient } from './EmbeddingClient.js';

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
].join('\n');

function renderMessages(messages: StoredMessage[]): string {
  return messages
    .map((message) => {
      const speaker = message.role === 'user' ? '用户' : '助手';
      return `${speaker}: ${message.content}`;
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

    let summary = '';
    for await (const chunk of this.options.model.streamChat({
      messages,
      tools: [],
      toolChoice: 'none',
      temperature: this.options.temperature ?? 0.2,
      enableNativeReasoning: false,
    })) {
      summary += chunk.contentDelta ?? '';
    }

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
}

export interface SemanticFactExtractor {
  extract(input: SemanticExtractionInput): Promise<ExtractedSemanticFact[]>;
}

const EXTRACTION_SYSTEM_PROMPT = [
  '你是企业记忆抽取器，只输出 JSON：{"facts":[{"scope":"user|group|global","kind":"profile|terminology","content":"...","keywords":["..."]}]}',
  '只提取对话中明确陈述、长期有效的事实：员工职责/负责系统、团队常用术语、项目代号/缩写。',
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
    },
  ) {}

  public async extract(
    input: SemanticExtractionInput,
  ): Promise<ExtractedSemanticFact[]> {
    let content = '';
    for await (const chunk of this.options.model.streamChat({
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
    })) {
      content += chunk.contentDelta ?? '';
    }

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
      const scope =
        record.scope === 'group' || record.scope === 'global'
          ? record.scope
          : 'user';
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
  /** 钉钉群 conversationId，用于召回群级术语；缺省与 conversationId 一致 */
  groupConversationId?: string;
  groupRecentTranscript?: string;
  activeTurnMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  semanticQuery?: string;
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
      .map((summary) => summary.summary)
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
    }>,
  ): Promise<SemanticMemoryRecord[]> {
    const vectors = await this.embedTexts(facts.map((fact) => fact.content));
    const saved: SemanticMemoryRecord[] = [];
    for (const [index, fact] of facts.entries()) {
      saved.push(
        await this.semanticStore.upsert({
          scope: fact.scope,
          subjectKey: fact.subjectKey,
          kind: fact.kind,
          content: fact.content,
          keywords: fact.keywords ?? [],
          embedding: fact.embedding ?? vectors?.[index] ?? null,
        }),
      );
    }
    return saved;
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
    const [userRecall, groupRecall, episodicSummary] = await Promise.all([
      this.recall(
        {
          query: queryText,
          scope: 'user',
          subjectKey: input.userId,
        },
        queryVector,
      ),
      input.conversationId
        ? this.recall(
            {
              query: queryText,
              scope: 'group',
              subjectKey: input.groupConversationId ?? input.conversationId,
            },
            queryVector,
          )
        : this.recall({ query: queryText, scope: 'global' }, queryVector),
      input.conversationId
        ? this.latestEpisodicSummary(input.conversationId)
        : Promise.resolve(''),
    ]);

    const profileLines = [
      `发言人：${input.speakerNick}`,
      ...userRecall.profileLines,
    ];
    if (userRecall.glossaryLines.length + groupRecall.glossaryLines.length > 0) {
      profileLines.push(
        '团队术语：',
        ...[...userRecall.glossaryLines, ...groupRecall.glossaryLines].filter(
          (line, index, all) => all.indexOf(line) === index,
        ),
      );
    }
    if (groupRecall.profileLines.length > 0) {
      profileLines.push('团队画像：', ...groupRecall.profileLines);
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
    const facts = await this.extractor.extract(input);
    if (facts.length === 0) return [];

    return this.remember(
      facts.map((fact) => ({
        scope: fact.scope,
        subjectKey:
          fact.scope === 'user'
            ? input.userId
            : fact.scope === 'group'
              ? input.conversationId
              : 'global',
        kind: fact.kind,
        content: fact.content,
        keywords: fact.keywords,
      })),
    );
  }
}
