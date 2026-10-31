import { randomUUID } from 'node:crypto';
import type {
  WebSearchContentSize,
  WebSearchEngine,
} from '../../config/IConfigProvider.js';
import { redactText } from '../../governance/redaction.js';

export type WebSearchRecency = 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';

const MAX_QUERY_CHARS = 70;
const MAX_COUNT = 50;
const MAX_TITLE_CHARS = 300;
const MAX_CONTENT_CHARS = 4_000;

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

/** 去掉网页摘要里的标签、控制字符并压缩空白，避免脏内容进入提示词 */
function sanitizeField(value: string, maxChars: number): string {
  return value
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return MAX_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, Math.trunc(value)));
}

function parseResults(payload: unknown, limit: number): WebSearchResult[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebSearchError('联网搜索返回格式异常');
  }
  const list = (payload as { search_result?: unknown }).search_result;
  if (!Array.isArray(list)) return [];
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (results.length >= limit) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = sanitizeField(stringField(record.title), MAX_TITLE_CHARS);
    const content = sanitizeField(
      stringField(record.content),
      MAX_CONTENT_CHARS,
    );
    const link = stringField(record.link);
    if (!isHttpUrl(link) || seen.has(link)) continue;
    if (!title && !content) continue;
    seen.add(link);
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
    const rawQuery = input.query.trim();
    if (!rawQuery) throw new WebSearchError('搜索词不能为空');
    if (rawQuery.length > MAX_QUERY_CHARS) {
      throw new WebSearchError(
        `搜索词过长（${rawQuery.length} 字符），请控制在 ${MAX_QUERY_CHARS} 字以内`,
        'QUERY_TOO_LONG',
      );
    }
    const query =
      this.options.redactOutbound === false
        ? rawQuery
        : redactText(rawQuery);
    const count = clampCount(input.count ?? this.options.count);
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
          search_query: query,
          search_engine: this.options.engine,
          search_intent: false,
          count,
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
      return parseResults(payload, count);
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
