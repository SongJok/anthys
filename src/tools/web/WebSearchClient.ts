import { randomUUID } from 'node:crypto';
import type {
  WebSearchContentSize,
  WebSearchEngine,
} from '../../config/IConfigProvider.js';
import { redactText } from '../../governance/redaction.js';

export type WebSearchRecency = 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';

export interface WebSearchClientOptions {
  baseUrl: string;
  apiKey: string;
  engine: WebSearchEngine;
  count: number;
  contentSize: WebSearchContentSize;
  timeoutMs: number;
  redactOutbound?: boolean;
  fetchImpl?: typeof fetch;
}

export interface WebSearchRequest {
  query: string;
  count?: number;
  recency?: WebSearchRecency;
  site?: string;
  signal?: AbortSignal;
}

export interface WebSearchResult {
  title: string;
  content: string;
  link: string;
  media?: string;
  icon?: string;
  refer?: string;
  publishDate?: string;
}

export interface WebSearchExecutor {
  search(input: WebSearchRequest): Promise<WebSearchResult[]>;
}

export class WebSearchError extends Error {
  public readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WebSearchError';
    if (code !== undefined) this.code = code;
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseResults(payload: unknown): WebSearchResult[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebSearchError('联网搜索返回格式异常');
  }
  const list = (payload as { search_result?: unknown }).search_result;
  if (!Array.isArray(list)) return [];
  const results: WebSearchResult[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = stringField(record.title);
    const content = stringField(record.content);
    const link = stringField(record.link);
    if (!link || (!title && !content)) continue;
    results.push({
      title: title || link,
      content,
      link,
      ...(stringField(record.media)
        ? { media: stringField(record.media) }
        : {}),
      ...(stringField(record.icon) ? { icon: stringField(record.icon) } : {}),
      ...(stringField(record.refer)
        ? { refer: stringField(record.refer) }
        : {}),
      ...(stringField(record.publish_date)
        ? { publishDate: stringField(record.publish_date) }
        : {}),
    });
  }
  return results;
}

function describeHttpError(status: number, payload: unknown): string {
  if (status === 401 || status === 403) {
    return '联网搜索鉴权失败，请检查 WEB_SEARCH_API_KEY';
  }
  if (status === 429) {
    return '联网搜索触发限流，请稍后重试';
  }
  if (status >= 500) {
    return `联网搜索服务暂不可用（HTTP ${status}）`;
  }
  const error = (payload as { error?: { message?: unknown; code?: unknown } })
    ?.error;
  const detail =
    typeof error?.message === 'string' ? error.message.slice(0, 200) : '';
  const code =
    typeof error?.code === 'string' || typeof error?.code === 'number'
      ? String(error.code)
      : '';
  const suffix = [code, detail].filter(Boolean).join(' ');
  return suffix
    ? `联网搜索失败（HTTP ${status}）：${suffix}`
    : `联网搜索失败（HTTP ${status}）`;
}

/**
 * 智谱 Web Search API 客户端。
 * 文档：POST {baseUrl}/web_search，返回 search_result[]。
 */
export class WebSearchClient implements WebSearchExecutor {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: WebSearchClientOptions) {
    this.fetchFn = options.fetchImpl ?? fetch;
  }

  public async search(input: WebSearchRequest): Promise<WebSearchResult[]> {
    const query = input.query.trim();
    if (!query) throw new WebSearchError('搜索词不能为空');
    const outbound =
      this.options.redactOutbound === false ? query : redactText(query);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    timer.unref?.();

    const external = input.signal;
    const onAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await this.fetchFn(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          search_query: outbound,
          search_engine: this.options.engine,
          search_intent: false,
          count: input.count ?? this.options.count,
          content_size: this.options.contentSize,
          request_id: randomUUID(),
          ...(input.recency
            ? { search_recency_filter: input.recency }
            : {}),
          ...(input.site ? { search_domain_filter: input.site } : {}),
        }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new WebSearchError(
          describeHttpError(response.status, payload),
          `HTTP_${response.status}`,
        );
      }
      return parseResults(payload);
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      if (timedOut) {
        throw new WebSearchError(
          `联网搜索超时（>${Math.round(this.options.timeoutMs / 1000)}s）`,
          'TIMEOUT',
        );
      }
      if (controller.signal.aborted) {
        throw new WebSearchError('联网搜索已取消', 'ABORTED');
      }
      throw new WebSearchError(
        `联网搜索请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  private endpoint(): string {
    const base = this.options.baseUrl
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/+$/, '');
    return `${base}/web_search`;
  }
}
