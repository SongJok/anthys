import { Resolver, lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Readable, Transform } from 'node:stream';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from 'node:zlib';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_URL_CHARS = 2_000;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 600;
// 官方源（SEC、企业新闻站）会拒绝或挂起自我标识的爬虫 UA，浏览器 UA 才能读到正文
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
]);
const TEXT_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
]);

export interface WebFetchExecutor {
  fetch(input: {
    url: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<FetchedPage>;
}

export interface FetchedPage {
  /** 原始请求地址 */
  requestedUrl: string;
  /** 跟随重定向后的最终地址 */
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  description: string;
  text: string;
  /** 正文是否因为大小上限被截断 */
  truncated: boolean;
  bytes: number;
  redirects: number;
}

export interface RawHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** 响应体超过上限时被截断 */
  truncated: boolean;
}

export type HttpFetcher = (
  url: URL,
  options: {
    address: string;
    family: 4 | 6;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
  },
) => Promise<RawHttpResponse>;

export interface WebFetchClientOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** 测试注入；默认使用经过 DNS 固定与私网校验的 HTTP 客户端 */
  fetcher?: HttpFetcher;
  /** 测试注入 DNS 解析 */
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** 指定独立 DNS 服务器 IP；默认使用系统 DNS，可绕开本地代理返回的 fake-IP */
  dnsServers?: string[];
}

export class WebFetchError extends Error {
  public readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WebFetchError';
    if (code !== undefined) this.code = code;
  }
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
}

function assertHttpUrl(raw: string): URL {
  const text = raw.trim();
  if (!text) throw new WebFetchError('链接不能为空', 'EMPTY_URL');
  if (text.length > MAX_URL_CHARS) {
    throw new WebFetchError(`链接过长（上限 ${MAX_URL_CHARS} 字符）`, 'URL_TOO_LONG');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text)
    ? text
    : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WebFetchError('链接格式不合法，请提供完整的 http(s) 地址', 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError('只支持打开 http/https 链接', 'UNSUPPORTED_PROTOCOL');
  }
  if (url.username || url.password) {
    throw new WebFetchError('链接不能携带用户名或密码', 'URL_CREDENTIALS');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new WebFetchError('只支持 80/443 端口的标准网页链接', 'UNSUPPORTED_PORT');
  }
  const hostname = hostnameOf(url);
  if (!hostname) throw new WebFetchError('链接缺少主机名', 'INVALID_URL');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new WebFetchError('不允许访问本机或内网地址', 'PRIVATE_ADDRESS');
  }
  if (isIP(hostname) === 0) {
    if (!hostname.includes('.')) {
      throw new WebFetchError('不允许访问单标签内网主机名', 'PRIVATE_ADDRESS');
    }
  } else if (isPrivateAddress(hostname)) {
    throw new WebFetchError('不允许访问本机或内网地址', 'PRIVATE_ADDRESS');
  }
  return url;
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return numbers;
}

function isPrivateIPv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (normalized === '::' || normalized === '::1') return true;
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }
  if (normalized.startsWith('2001:db8')) return true;
  if (normalized.startsWith('100::')) return true;
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length);
    return isIP(embedded) === 4 ? isPrivateIPv4(embedded) : true;
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

type ResolvedHost = Array<{ address: string; family: 4 | 6 }>;

async function defaultResolveHost(hostname: string): Promise<ResolvedHost> {
  if (isIP(hostname) !== 0) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
}

function createResolveHost(servers: string[]): (hostname: string) => Promise<ResolvedHost> {
  if (servers.length === 0) return defaultResolveHost;
  const resolver = new Resolver();
  resolver.setServers(servers);
  return async (hostname) => {
    const family = isIP(hostname);
    if (family !== 0) {
      return [{ address: hostname, family: family as 4 | 6 }];
    }
    const [v4, v6] = await Promise.all([
      resolver.resolve4(hostname).catch(() => [] as string[]),
      resolver.resolve6(hostname).catch(() => [] as string[]),
    ]);
    return [
      ...v4.map((address) => ({ address, family: 4 as const })),
      ...v6.map((address) => ({ address, family: 6 as const })),
    ];
  };
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

function decoderFor(encoding: string): Transform | null {
  const value = encoding.toLowerCase().trim();
  if (value === 'gzip' || value === 'x-gzip') return createGunzip();
  if (value === 'deflate') return createInflate();
  if (value === 'br') return createBrotliDecompress();
  return null;
}

/**
 * 固定 DNS 结果供 net.connect 使用。
 * Node 24 默认 autoSelectFamily 会以 { all: true } 调用 lookup，
 * 此时回调第二个参数必须是地址数组，否则会报 Invalid IP address。
 */
export function createPinnedLookup(pinned: {
  address: string;
  family: 4 | 6;
}): (
  hostname: string,
  options: number | { all?: boolean } | undefined,
  callback: (...args: unknown[]) => void,
) => void {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options !== null && options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

async function collectBody(
  response: Readable,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, Math.max(0, maxBytes - total)));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
  } catch {
    // 达到上限后主动销毁连接，部分服务器会抛出中止错误
  }
  return { body: Buffer.concat(chunks), truncated };
}

const defaultHttpFetcher: HttpFetcher = async (url, options) => {
  const hostname = hostnameOf(url);
  const secure = url.protocol === 'https:';
  const request = secure ? httpsRequest : httpRequest;
  return new Promise<RawHttpResponse>((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,text/plain,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'accept-encoding': 'gzip, deflate, br',
        },
        // 固定 DNS 结果，避免校验后再次解析造成 DNS rebinding
        lookup: createPinnedLookup({
          address: options.address,
          family: options.family,
        }) as never,
        ...(secure && isIP(hostname) === 0
          ? { servername: hostname }
          : {}),
        signal: options.signal,
        timeout: options.timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          response.resume();
          response.destroy();
          resolve({
            status,
            headers: response.headers,
            body: Buffer.alloc(0),
            truncated: false,
          });
          return;
        }
        const decoder = decoderFor(headerValue(response.headers, 'content-encoding'));
        const stream = decoder ? response.pipe(decoder) : response;
        collectBody(stream, options.maxBytes)
          .then(({ body, truncated }) => {
            response.destroy();
            resolve({ status, headers: response.headers, body, truncated });
          })
          .catch((error) => {
            response.destroy();
            reject(error);
          });
      },
    );
    req.on('timeout', () => {
      req.destroy(new WebFetchError('网页请求超时', 'TIMEOUT'));
    });
    req.on('error', (error) => {
      reject(
        error instanceof WebFetchError
          ? error
          : new WebFetchError(`网页请求失败：${error.message}`, 'NETWORK'),
      );
    });
    req.end();
  });
};

function headerLooksLikeHtml(body: Buffer): boolean {
  const head = body.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

function normalizeContentType(
  raw: string,
  body: Buffer,
): { contentType: string; html: boolean } {
  const contentType = raw.split(';')[0]?.trim().toLowerCase() || '';
  if (!contentType) {
    if (headerLooksLikeHtml(body)) {
      return { contentType: 'text/html', html: true };
    }
    const head = body.subarray(0, 128).toString('utf8').trimStart();
    if (head.startsWith('{') || head.startsWith('[')) {
      return { contentType: 'application/json', html: false };
    }
    return { contentType: 'text/plain', html: false };
  }
  return {
    contentType,
    html: HTML_CONTENT_TYPES.has(contentType),
  };
}

function detectCharset(contentType: string, body: Buffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/iu.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = body.subarray(0, 4096).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/iu.exec(head)?.[1];
  return fromMeta ? fromMeta.toLowerCase() : 'utf-8';
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = detectCharset(contentType, body);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×',
  divide: '÷',
  yen: '¥',
  euro: '€',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function compactLine(text: string): string {
  return text.replace(/[ \t\f\v\u00a0]+/gu, ' ').trim();
}

function extractMeta(html: string, name: string): string {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    'iu',
  );
  return compactLine(decodeHtmlEntities(pattern.exec(html)?.[1] ?? ''));
}

/** 轻量 HTML 正文提取：保留标题层级、列表与段落，不引入 DOM 依赖 */
export function extractHtmlContent(html: string): {
  title: string;
  description: string;
  text: string;
} {
  const title =
    compactLine(
      decodeHtmlEntities(
        /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? '',
      ),
    ).slice(0, MAX_TITLE_CHARS) ||
    extractMeta(html, 'og:title').slice(0, MAX_TITLE_CHARS);
  const description =
    extractMeta(html, 'description') ||
    extractMeta(html, 'og:description') ||
    extractMeta(html, 'twitter:description');

  let body = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<!(?:doctype|\[CDATA)[^>]*>/giu, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/giu, ' ')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/giu, ' ')
    .replace(
      /<(script|style|noscript|template|svg|canvas|iframe|object|embed|form|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/giu,
      ' ',
    );
  body = body
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<hr\b[^>]*>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '\n- ')
    .replace(
      /<h([1-6])\b[^>]*>/giu,
      (_match, level: string) => `\n\n${'#'.repeat(Number(level))} `,
    )
    .replace(/<\/h[1-6]>/giu, '\n')
    .replace(
      /<\/?(?:p|div|section|article|main|aside|header|footer|nav|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption)\b[^>]*>/giu,
      '\n',
    )
    .replace(/<\/t[dh]>/giu, ' | ')
    .replace(/<[^>]+>/gu, ' ');

  const lines = decodeHtmlEntities(body)
    .split('\n')
    .map(compactLine)
    .filter(Boolean);
  const text = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  return {
    title,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    text,
  };
}

function formatJson(body: Buffer): string {
  try {
    return JSON.stringify(JSON.parse(body.toString('utf8')), null, 2);
  } catch {
    return body.toString('utf8');
  }
}

export class WebFetchClient implements WebFetchExecutor {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly fetcher: HttpFetcher;
  private readonly resolveHost: NonNullable<WebFetchClientOptions['resolveHost']>;

  constructor(options: WebFetchClientOptions = {}) {
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxBytes = Math.max(16 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxRedirects = Math.min(
      5,
      Math.max(0, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS),
    );
    this.fetcher = options.fetcher ?? defaultHttpFetcher;
    const dnsServers = (options.dnsServers ?? [])
      .map((server) => server.trim())
      .filter(Boolean);
    for (const server of dnsServers) {
      if (isIP(server) === 0) {
        throw new WebFetchError(
          `WEB_FETCH_DNS_SERVERS 包含非法 IP 地址：${server}`,
          'INVALID_DNS',
        );
      }
    }
    this.resolveHost = options.resolveHost ?? createResolveHost(dnsServers);
  }

  public async fetch(input: {
    url: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<FetchedPage> {
    const requested = assertHttpUrl(input.url);
    let current = requested;
    let redirects = 0;
    for (;;) {
      const hostname = hostnameOf(current);
      const records = await this.resolveHost(hostname);
      if (records.length === 0) {
        throw new WebFetchError('无法解析网页域名', 'DNS');
      }
      for (const record of records) {
        if (isPrivateAddress(record.address)) {
          throw new WebFetchError('不允许访问本机或内网地址', 'PRIVATE_ADDRESS');
        }
      }
      const target = records[0]!;
      const response = await this.fetcher(current, {
        address: target.address,
        family: target.family,
        timeoutMs: this.timeoutMs,
        maxBytes: input.maxBytes ?? this.maxBytes,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, 'location');
        if (!location) {
          throw new WebFetchError(`网页返回 ${response.status} 但没有跳转地址`, 'REDIRECT');
        }
        if (redirects >= this.maxRedirects) {
          throw new WebFetchError('网页重定向次数过多', 'TOO_MANY_REDIRECTS');
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new WebFetchError('网页跳转地址不合法', 'REDIRECT');
        }
        current = assertHttpUrl(next.toString());
        redirects += 1;
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new WebFetchError('该链接需要登录或没有访问权限，无法读取正文', 'AUTH_REQUIRED');
      }
      if (response.status === 404) {
        throw new WebFetchError('链接指向的页面不存在（404）', 'NOT_FOUND');
      }
      if (response.status === 429) {
        throw new WebFetchError('网页触发访问限流，请稍后再试', 'RATE_LIMITED');
      }
      if (response.status >= 400) {
        throw new WebFetchError(`网页返回 HTTP ${response.status}`, `HTTP_${response.status}`);
      }

      const rawType = headerValue(response.headers, 'content-type');
      const { contentType, html } = normalizeContentType(rawType, response.body);
      const textual =
        html || TEXT_CONTENT_TYPES.has(contentType) || contentType.startsWith('text/');
      if (!textual) {
        throw new WebFetchError(
          `暂不支持读取 ${contentType || '该类型'} 内容，请打开原链接查看`,
          'UNSUPPORTED_CONTENT',
        );
      }

      let pageTitle = '';
      let description = '';
      let text: string;
      if (html) {
        const extracted = extractHtmlContent(decodeBody(response.body, rawType));
        pageTitle = extracted.title;
        description = extracted.description;
        text = extracted.text || description;
      } else if (contentType.includes('json')) {
        text = formatJson(response.body);
      } else {
        text = decodeBody(response.body, rawType);
      }
      text = text.replace(/\r\n/gu, '\n').trim();
      if (!text) {
        throw new WebFetchError('网页正文为空，可能是脚本渲染页面', 'EMPTY_CONTENT');
      }
      return {
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        status: response.status,
        contentType,
        title:
          pageTitle ||
          description.slice(0, 80) ||
          hostnameOf(current),
        description,
        text,
        truncated: response.truncated,
        bytes: response.body.length,
        redirects,
      };
    }
  }
}
