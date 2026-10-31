import { describe, expect, it, vi } from 'vitest';
import { WebSearchClient, WebSearchError } from './WebSearchClient.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof WebSearchClient>[0]> = {},
): WebSearchClient {
  return new WebSearchClient({
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'test-key',
    engine: 'search_pro',
    count: 5,
    contentSize: 'medium',
    timeoutMs: 1_000,
    fetchImpl,
    ...overrides,
  });
}

describe('WebSearchClient', () => {
  it('调用智谱 web_search 并解析结构化结果', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        search_result: [
          {
            title: 'GLM-5.3 发布说明',
            content: '新增联网搜索能力',
            link: 'https://docs.bigmodel.cn/release',
            media: '智谱',
            icon: 'https://docs.bigmodel.cn/icon.png',
            refer: 'ref_1',
            publish_date: '2026-10-20',
          },
          { title: '', content: '', link: '' },
        ],
      });
    }) as typeof fetch;

    const client = clientWith(fetchImpl);
    const results = await client.search({
      query: 'GLM-5.3 发布说明',
      count: 7,
      recency: 'oneWeek',
      site: 'docs.bigmodel.cn',
    });

    expect(results).toEqual([
      {
        title: 'GLM-5.3 发布说明',
        content: '新增联网搜索能力',
        link: 'https://docs.bigmodel.cn/release',
        media: '智谱',
        icon: 'https://docs.bigmodel.cn/icon.png',
        refer: 'ref_1',
        publishDate: '2026-10-20',
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://open.bigmodel.cn/api/paas/v4/web_search',
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      search_query: 'GLM-5.3 发布说明',
      search_engine: 'search_pro',
      search_intent: false,
      count: 7,
      content_size: 'medium',
      search_recency_filter: 'oneWeek',
      search_domain_filter: 'docs.bigmodel.cn',
    });
    expect(typeof body.request_id).toBe('string');
  });

  it('出站前对手机号与密钥脱敏', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(_url), init: init ?? {} });
      return jsonResponse({ search_result: [] });
    }) as typeof fetch;

    const client = clientWith(fetchImpl);
    await client.search({ query: '联系人 13812341234 密钥 sk-abcdefghijkl' });

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.search_query).not.toContain('13812341234');
    expect(body.search_query).not.toContain('sk-abcdefghijkl');
    expect(body.search_query).toContain('138****1234');
  });

  it('鉴权失败与限流返回可读错误', async () => {
    const unauthorized = (async () =>
      jsonResponse(
        { error: { code: '1000', message: 'bad api key' } },
        401,
      )) as typeof fetch;
    await expect(
      clientWith(unauthorized).search({ query: 'test' }),
    ).rejects.toThrow('联网搜索鉴权失败');

    const limited = (async () => jsonResponse({}, 429)) as typeof fetch;
    await expect(
      clientWith(limited).search({ query: 'test' }),
    ).rejects.toThrow('触发限流');
  });

  it('超时返回明确错误', async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;

    await expect(
      clientWith(hanging, { timeoutMs: 20 }).search({ query: 'test' }),
    ).rejects.toMatchObject({
      name: 'WebSearchError',
      message: expect.stringContaining('超时'),
    });
  });

  it('返回格式异常时抛错', async () => {
    const invalid = (async () => jsonResponse([])) as typeof fetch;
    await expect(
      clientWith(invalid).search({ query: 'test' }),
    ).rejects.toBeInstanceOf(WebSearchError);
  });

  it('空搜索词直接拒绝', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      clientWith(fetchImpl).search({ query: '   ' }),
    ).rejects.toThrow('搜索词不能为空');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
