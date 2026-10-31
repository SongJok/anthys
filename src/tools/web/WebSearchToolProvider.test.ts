import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import {
  WebSearchError,
  type WebSearchExecutor,
  type WebSearchRequest,
  type WebSearchResult,
} from './WebSearchClient.js';
import { WebSearchToolProvider } from './WebSearchToolProvider.js';

function context(conversationId = 'conv-web'): ExecutionContext {
  return {
    conversationId,
    messageId: 'msg-web',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '2',
    deadlineAt: Date.now() + 60_000,
    now: () => Date.now(),
  };
}

function providerWith(
  search: (input: WebSearchRequest) => Promise<WebSearchResult[]>,
  enabled = true,
): WebSearchToolProvider {
  const client: WebSearchExecutor = { search };
  return new WebSearchToolProvider({
    client,
    enabled: () => enabled,
  });
}

const SAMPLE: WebSearchResult = {
  title: '示例结果',
  content: '示例摘要',
  link: 'https://example.com/a',
};

function makeProvider(
  search: (input: WebSearchRequest) => Promise<WebSearchResult[]>,
  options: Partial<
    Omit<
      ConstructorParameters<typeof WebSearchToolProvider>[0],
      'client' | 'enabled'
    >
  > = {},
): WebSearchToolProvider {
  return new WebSearchToolProvider({
    client: { search },
    enabled: () => true,
    ...options,
  });
}

async function toolOf(
  provider: WebSearchToolProvider,
): Promise<ToolDefinition> {
  const tools = await provider.getTools(context());
  const tool = tools[0];
  if (!tool) throw new Error('missing web_search tool');
  return tool;
}

describe('WebSearchToolProvider', () => {
  it('关闭时不下发工具，开启时在群聊可见', async () => {
    await expect(providerWith(async () => [], false).getTools(context())).resolves.toEqual(
      [],
    );
    const tool = await toolOf(providerWith(async () => []));
    expect(tool.name).toBe('web_search');
    expect(tool.risk).toBe('read');
    expect(tool.source).toBe('web');
  });

  it('格式化结果并生成引用，过滤非 http 链接', async () => {
    const search = vi.fn(async (input: WebSearchRequest) => {
      expect(input).toMatchObject({
        query: 'GLM-5.3 发布说明',
        recency: 'oneWeek',
        site: 'docs.bigmodel.cn',
        count: 3,
      });
      return [
        {
          title: '发布说明',
          content: '新增  联网搜索能力',
          link: 'https://docs.bigmodel.cn/release',
          publishDate: '2026-10-20',
        },
        {
          title: '非法链接',
          content: '不应出现在引用里',
          link: 'javascript:alert(1)',
        },
      ];
    });
    const tool = await toolOf(providerWith(search));
    const output = await tool.executeStructured!(
      {
        query: 'GLM-5.3 发布说明',
        recency: 'oneWeek',
        site: 'docs.bigmodel.cn',
        count: 3,
      },
      context(),
    );

    expect(output.text).toContain('返回 1 条公开网页结果');
    expect(output.text).toContain('https://docs.bigmodel.cn/release');
    expect(output.text).not.toContain('javascript:alert');
    expect(output.text).toContain('新增 联网搜索能力');
    expect(output.summary).toContain('返回 1 条结果');
    expect(output.citations).toEqual([
      {
        index: 1,
        title: '发布说明',
        url: 'https://docs.bigmodel.cn/release',
        source: 'web',
        snippet: '新增 联网搜索能力',
      },
    ]);
  });

  it('无结果时提示不要编造来源', async () => {
    const tool = await toolOf(providerWith(async () => []));
    const output = await tool.executeStructured!({ query: '冷门问题' }, context());
    expect(output.text).toContain('未检索到公开网页结果');
    expect(output.citations).toEqual([]);
  });

  it('拒绝空查询和超长查询', async () => {
    const tool = await toolOf(providerWith(async () => []));
    await expect(tool.execute({}, context())).rejects.toThrow('非空字符串');
    await expect(
      tool.execute({ query: 'a'.repeat(71) }, context()),
    ).rejects.toThrow('搜索词过长');
  });

  it('client 抛错时向上抛出，由 ReAct 标记工具失败', async () => {
    const tool = await toolOf(
      providerWith(async () => {
        throw new Error('upstream down');
      }),
    );
    await expect(
      tool.executeStructured!({ query: 'test' }, context()),
    ).rejects.toThrow('upstream down');
  });

  it('相同查询命中缓存，不再重复计费', async () => {
    let now = 1_000_000;
    const search = vi.fn(async () => [SAMPLE]);
    const metrics = { inc: vi.fn() };
    const tool = await toolOf(
      makeProvider(search, {
        now: () => now,
        cacheTtlSeconds: 60,
        metrics,
      }),
    );

    await tool.executeStructured!({ query: '缓存问题' }, context());
    now += 30_000;
    const second = await tool.executeStructured!(
      { query: '缓存问题' },
      context(),
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(second.citations).toHaveLength(1);
    expect(metrics.inc).toHaveBeenCalledWith('web_search_requests_total', {
      result: 'cache_hit',
    });
  });

  it('缓存过期后重新请求', async () => {
    let now = 1_000_000;
    const search = vi.fn(async () => [SAMPLE]);
    const tool = await toolOf(
      makeProvider(search, { now: () => now, cacheTtlSeconds: 60 }),
    );

    await tool.executeStructured!({ query: '过期问题' }, context());
    now += 61_000;
    await tool.executeStructured!({ query: '过期问题' }, context());

    expect(search).toHaveBeenCalledTimes(2);
  });

  it('并发相同查询只发起一次请求', async () => {
    let release!: (results: WebSearchResult[]) => void;
    const gate = new Promise<WebSearchResult[]>((resolve) => {
      release = resolve;
    });
    const search = vi.fn(() => gate);
    const tool = await toolOf(makeProvider(search));

    const first = tool.executeStructured!({ query: '并发问题' }, context());
    const second = tool.executeStructured!({ query: '并发问题' }, context());
    release([SAMPLE]);
    const [a, b] = await Promise.all([first, second]);

    expect(search).toHaveBeenCalledTimes(1);
    expect(a.citations).toHaveLength(1);
    expect(b.citations).toHaveLength(1);
  });

  it('单会话小时配额用完后返回引导而不是继续计费', async () => {
    const search = vi.fn(async () => [SAMPLE]);
    const tool = await toolOf(
      makeProvider(search, { cacheTtlSeconds: 0, maxCallsPerHour: 2 }),
    );

    await tool.executeStructured!({ query: '问题一' }, context());
    await tool.executeStructured!({ query: '问题二' }, context());
    const limited = await tool.executeStructured!(
      { query: '问题三' },
      context(),
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(limited.text).toContain('2 次/小时上限');
    expect(limited.citations).toEqual([]);

    await tool.executeStructured!({ query: '问题四' }, context('conv-other'));
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('日配额跨会话共享', async () => {
    const search = vi.fn(async () => [SAMPLE]);
    const tool = await toolOf(
      makeProvider(search, { cacheTtlSeconds: 0, dailyLimit: 2 }),
    );

    await tool.executeStructured!({ query: '日配额一' }, context('conv-a'));
    await tool.executeStructured!({ query: '日配额二' }, context('conv-b'));
    const limited = await tool.executeStructured!(
      { query: '日配额三' },
      context('conv-c'),
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(limited.text).toContain('今日联网搜索总额度已用完');
  });

  it('site 支持完整 URL 并归一化为域名，非法值直接拒绝', async () => {
    const search = vi.fn(async (_input: WebSearchRequest) => [SAMPLE]);
    const tool = await toolOf(makeProvider(search));

    await tool.executeStructured!(
      { query: '站点限定', site: 'https://docs.bigmodel.cn/release' },
      context(),
    );
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      site: 'docs.bigmodel.cn',
    });
    await expect(
      tool.executeStructured!({ query: '站点限定', site: 'not a domain' }, context()),
    ).rejects.toThrow('site 必须是域名');
  });

  it('上游错误记录指标并保留错误码', async () => {
    const metrics = { inc: vi.fn() };
    const tool = await toolOf(
      makeProvider(
        async () => {
          throw new WebSearchError('触发限流', 'HTTP_429');
        },
        { metrics },
      ),
    );

    await expect(
      tool.executeStructured!({ query: '限流问题' }, context()),
    ).rejects.toThrow('触发限流');
    expect(metrics.inc).toHaveBeenCalledWith('web_search_requests_total', {
      result: 'error',
    });
  });
});
