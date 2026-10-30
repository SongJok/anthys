import { describe, expect, it } from 'vitest';
import {
  HierarchicalMemoryManager,
  LlmSemanticFactExtractor,
  type EpisodeSummarizer,
  type EpisodeSummarizerInput,
  type SemanticFactExtractor,
} from './HierarchicalMemoryManager.js';
import type {
  EpisodicSummaryStore,
  SemanticMemoryStore,
} from '../db/memorySchema.js';
import type {
  EpisodicSummaryRecord,
  SemanticMemoryRecord,
  SemanticRecallQuery,
} from '../types/bystander-and-memory.js';
import type {
  ChatStreamChunk,
  StoredMessage,
} from '../types/core.js';

class InMemorySummaryStore implements EpisodicSummaryStore {
  public records: EpisodicSummaryRecord[] = [];

  public async appendSummary(input: {
    conversationId: string;
    summary: string;
    coveredMessageIds: string[];
    tokenCount: number;
  }): Promise<EpisodicSummaryRecord> {
    const record: EpisodicSummaryRecord = {
      id: `summary-${this.records.length + 1}`,
      createdAt: this.records.length + 1,
      ...input,
    };
    this.records.push(record);
    return record;
  }

  public async listSummaries(
    conversationId: string,
    limit: number,
  ): Promise<EpisodicSummaryRecord[]> {
    return this.records
      .filter((record) => record.conversationId === conversationId)
      .slice(-Math.max(1, limit));
  }
}

class InMemorySemanticStore implements SemanticMemoryStore {
  public records: SemanticMemoryRecord[] = [];
  public queries: SemanticRecallQuery[] = [];

  public async upsert(input: {
    scope: SemanticMemoryRecord['scope'];
    subjectKey: string;
    kind: SemanticMemoryRecord['kind'];
    content: string;
    keywords: string[];
    embedding?: number[] | null;
  }): Promise<SemanticMemoryRecord> {
    const existing = this.records.find(
      (record) =>
        record.scope === input.scope &&
        record.subjectKey === input.subjectKey &&
        record.kind === input.kind &&
        record.content === input.content,
    );
    if (existing) {
      existing.keywords = input.keywords;
      existing.embedding = input.embedding ?? null;
      existing.updatedAt += 1;
      return { ...existing };
    }
    const record: SemanticMemoryRecord = {
      id: `semantic-${this.records.length + 1}`,
      scope: input.scope,
      subjectKey: input.subjectKey,
      kind: input.kind,
      content: input.content,
      keywords: input.keywords,
      embedding: input.embedding ?? null,
      updatedAt: this.records.length + 1,
    };
    this.records.push(record);
    return { ...record };
  }

  public async search(
    query: SemanticRecallQuery,
  ): Promise<SemanticMemoryRecord[]> {
    this.queries.push({ ...query });
    const terms = query.query
      .split(/[\s,，。;；、/]+/u)
      .map((term) => term.trim())
      .filter(Boolean);
    return this.records
      .filter((record) => {
        if (!query.scope) return true;
        const inScope =
          record.scope === query.scope &&
          (!query.subjectKey || record.subjectKey === query.subjectKey);
        return inScope || record.scope === 'global';
      })
      .filter((record) => {
        if (terms.length === 0) return true;
        return terms.some(
          (term) =>
            record.content.includes(term) ||
            record.keywords.some(
              (keyword) =>
                keyword.includes(term) || term.includes(keyword),
            ),
        );
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, query.limit ?? 6)
      .map((record) => ({ ...record }));
  }
}

function historyMessage(
  index: number,
  content: string,
): StoredMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    reasoning: null,
    createdAt: index,
  };
}

function longHistory(count: number, size = 1_000): StoredMessage[] {
  return Array.from({ length: count }, (_, index) =>
    historyMessage(index, `${index}:${'细'.repeat(size)}`),
  );
}

function setup(options: {
  summarizer?: EpisodeSummarizer;
  extractor?: SemanticFactExtractor;
  threshold?: number;
  ratio?: number;
  embedding?: {
    dimensions: number;
    embed(texts: string[]): Promise<number[][]>;
  };
} = {}) {
  const summaryStore = new InMemorySummaryStore();
  const semanticStore = new InMemorySemanticStore();
  const summarizeCalls: EpisodeSummarizerInput[] = [];
  const summarizer =
    options.summarizer ?? {
      async summarize(input: EpisodeSummarizerInput) {
        summarizeCalls.push(input);
        return `【关键指标】P99 2.4s；【排查结论】网关连接池打满；【未决事项】扩容方案待评审（归档 ${input.messages.length} 条）`;
      },
    };
  const manager = new HierarchicalMemoryManager({
    summaryStore,
    semanticStore,
    summarizer,
    extractor: options.extractor,
    compressionThresholdTokens: options.threshold ?? 12_000,
    compressionRatio: options.ratio ?? 0.6,
    ...(options.embedding ? { embedding: options.embedding } : {}),
  });
  return { manager, summaryStore, semanticStore, summarizeCalls };
}

describe('HierarchicalMemoryManager', () => {
  it('启用向量后写入与召回都携带 embedding', async () => {
    const embedded: string[][] = [];
    const ctx = setup({
      embedding: {
        dimensions: 3,
        async embed(texts: string[]) {
          embedded.push(texts);
          return texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    await ctx.manager.remember([
      {
        scope: 'user',
        subjectKey: 'staff-1',
        kind: 'profile',
        content: '张三负责支付网关',
        keywords: ['支付网关'],
      },
    ]);
    expect(embedded).toEqual([['张三负责支付网关']]);
    expect(ctx.semanticStore.records[0]?.embedding).toEqual([0.1, 0.2, 0.3]);

    await ctx.manager.recall(
      { query: '支付网关', scope: 'user', subjectKey: 'staff-1' },
      [0.3, 0.2, 0.1],
    );
    expect(ctx.semanticStore.queries[0]?.embedding).toEqual([0.3, 0.2, 0.1]);

    const assembled = await ctx.manager.assemble({
      personaSystemPrompt: 'system',
      userId: 'staff-1',
      speakerNick: '张三',
      semanticQuery: '支付网关怎么排查',
    });
    expect(assembled.userSemanticProfile).toContain('张三负责支付网关');
    expect(ctx.semanticStore.queries.at(-1)?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('向量服务失败时回退关键词召回', async () => {
    const warnings: string[] = [];
    const manager = new HierarchicalMemoryManager({
      summaryStore: new InMemorySummaryStore(),
      semanticStore: new InMemorySemanticStore(),
      embedding: {
        dimensions: 3,
        async embed() {
          throw new Error('embedding down');
        },
      },
      logger: {
        info() {},
        warn(_obj, msg) {
          warnings.push(msg);
        },
      },
    });

    const result = await manager.assemble({
      personaSystemPrompt: 'system',
      userId: 'staff-1',
      speakerNick: '张三',
      semanticQuery: '支付网关',
    });
    expect(result.userSemanticProfile).toContain('发言人：张三');
    expect(warnings).toContain('embedding failed, falling back to keyword recall');
  });

  it('长对话超过阈值时把最早 60% 归档为情景摘要，且不重复压缩', async () => {
    const ctx = setup();
    const history = longHistory(30);

    const first = await ctx.manager.maybeCompress('conv-1', history);
    expect(first.compressed).toBe(true);
    expect(first.summary?.coveredMessageIds).toHaveLength(19);
    expect(first.summary?.coveredMessageIds[0]).toBe('m0');
    expect(first.summary?.coveredMessageIds.at(-1)).toBe('m18');
    expect(first.summary?.summary).toContain('网关连接池打满');
    expect(ctx.summarizeCalls).toHaveLength(1);
    expect(ctx.summarizeCalls[0]?.messages).toHaveLength(19);

    const second = await ctx.manager.maybeCompress('conv-1', history);
    expect(second.compressed).toBe(false);
    expect(ctx.summaryStore.records).toHaveLength(1);

    const extended = longHistory(60);
    const third = await ctx.manager.maybeCompress('conv-1', extended);
    expect(third.compressed).toBe(true);
    expect(ctx.summaryStore.records).toHaveLength(2);
    expect(third.summary?.coveredMessageIds[0]).toBe('m19');
    expect(ctx.summarizeCalls[1]?.previousSummary).toContain('网关连接池打满');
  });

  it('未超过阈值时不触发压缩', async () => {
    const ctx = setup();
    const result = await ctx.manager.maybeCompress(
      'conv-1',
      longHistory(6, 100),
    );
    expect(result.compressed).toBe(false);
    expect(ctx.summaryStore.records).toHaveLength(0);
  });

  it('组装上下文时召回员工画像、团队术语与情景摘要', async () => {
    const ctx = setup();
    await ctx.summaryStore.appendSummary({
      conversationId: 'conv-1',
      summary: '【排查结论】支付网关超时已定位为连接池打满',
      coveredMessageIds: ['old-1'],
      tokenCount: 120,
    });
    await ctx.manager.remember([
      {
        scope: 'user',
        subjectKey: 'staff-1',
        kind: 'profile',
        content: '张三负责支付网关研发',
        keywords: ['张三', '支付网关'],
      },
      {
        scope: 'group',
        subjectKey: 'cid-1',
        kind: 'terminology',
        content: 'GMV 指商品交易总额',
        keywords: ['GMV'],
      },
    ]);

    const memory = await ctx.manager.assemble({
      personaSystemPrompt: '你是小钉',
      userId: 'staff-1',
      speakerNick: '张三',
      conversationId: 'conv-1',
      groupConversationId: 'cid-1',
      groupRecentTranscript: '[14:05:12] 王五: 订单接口一直报 504',
      activeTurnMessages: [
        { role: 'user', content: '支付网关的 GMV 怎么对不上？' },
      ],
    });

    expect(memory.personaSystemPrompt).toBe('你是小钉');
    expect(memory.userSemanticProfile).toContain('发言人：张三');
    expect(memory.userSemanticProfile).toContain('张三负责支付网关研发');
    expect(memory.userSemanticProfile).toContain('GMV 指商品交易总额');
    expect(memory.groupRecentTranscript).toContain('订单接口一直报 504');
    expect(memory.episodicSummary).toContain('连接池打满');
    expect(memory.activeTurnMessages).toHaveLength(1);
  });

  it('不同会话的同一员工画像可跨实例召回', async () => {
    const ctx = setup();
    await ctx.manager.remember([
      {
        scope: 'user',
        subjectKey: 'staff-1',
        kind: 'profile',
        content: '张三负责支付网关研发',
        keywords: ['支付网关'],
      },
    ]);

    const nextSession = new HierarchicalMemoryManager({
      summaryStore: ctx.summaryStore,
      semanticStore: ctx.semanticStore,
    });
    const recall = await nextSession.recall({
      query: '支付网关又超时了',
      scope: 'user',
      subjectKey: 'staff-1',
    });

    expect(recall.profileLines).toEqual(['- 张三负责支付网关研发']);
    expect(recall.glossaryLines).toEqual([]);
  });

  it('抽取器返回的长期事实按会话归属落库', async () => {
    const extractor: SemanticFactExtractor = {
      async extract() {
        return [
          {
            scope: 'user',
            kind: 'profile',
            content: '张三负责支付网关研发',
            keywords: ['支付网关'],
          },
          {
            scope: 'group',
            kind: 'terminology',
            content: 'GMV 指商品交易总额',
            keywords: ['GMV'],
          },
        ];
      },
    };
    const ctx = setup({ extractor });
    const saved = await ctx.manager.captureSemantic({
      userId: 'staff-1',
      speakerNick: '张三',
      conversationId: 'cid-1',
      conversationType: '2',
      userText: '我是张三，负责支付网关研发',
      assistantText: '了解，已记录。',
    });

    expect(saved).toHaveLength(2);
    expect(ctx.semanticStore.records[0]).toMatchObject({
      scope: 'user',
      subjectKey: 'staff-1',
      kind: 'profile',
    });
    expect(ctx.semanticStore.records[1]).toMatchObject({
      scope: 'group',
      subjectKey: 'cid-1',
      kind: 'terminology',
    });
    expect(ctx.manager.shouldExtractSemantic('我是张三，负责支付网关')).toBe(
      true,
    );
    expect(ctx.manager.shouldExtractSemantic('今天下午茶吃什么？')).toBe(false);
  });

  it('LLM 抽取器解析 JSON 并忽略非法条目', async () => {
    const extractor = new LlmSemanticFactExtractor({
      model: {
        modelName: 'scripted',
        async *streamChat(): AsyncIterable<ChatStreamChunk> {
          yield {
            contentDelta: JSON.stringify({
              facts: [
                {
                  scope: 'user',
                  kind: 'profile',
                  content: '张三负责支付网关研发',
                  keywords: ['支付网关'],
                },
                { scope: 'user', kind: 'profile', content: '' },
                { nope: true },
              ],
            }),
          };
        },
      },
    });

    const facts = await extractor.extract({
      userId: 'staff-1',
      speakerNick: '张三',
      conversationId: 'cid-1',
      conversationType: '1',
      userText: '我是张三，负责支付网关研发',
      assistantText: '收到',
    });

    expect(facts).toEqual([
      {
        scope: 'user',
        kind: 'profile',
        content: '张三负责支付网关研发',
        keywords: ['支付网关'],
      },
    ]);
  });
});
