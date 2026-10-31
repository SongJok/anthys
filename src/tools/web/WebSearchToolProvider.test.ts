import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type {
  WebSearchExecutor,
  WebSearchRequest,
  WebSearchResult,
} from './WebSearchClient.js';
import { WebSearchToolProvider } from './WebSearchToolProvider.js';

function context(): ExecutionContext {
  return {
    conversationId: 'conv-web',
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

    expect(output.text).toContain('返回 2 条公开网页结果');
    expect(output.text).toContain('https://docs.bigmodel.cn/release');
    expect(output.text).toContain('新增 联网搜索能力');
    expect(output.summary).toContain('返回 2 条结果');
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
});
