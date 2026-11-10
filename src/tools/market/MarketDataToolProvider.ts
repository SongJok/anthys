import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../../types/core.js';
import type { WorkspacePaths } from '../../types/mcp-and-sandbox.js';
import { WebFetchClient } from '../web/WebFetchClient.js';

export type MarketKind = 'quote' | 'daily';
export type MarketCode = 'SH' | 'SZ' | 'HK' | 'US';

export interface ParsedSymbol {
  /** 规范化后的代码，例如 600519.SH */
  symbol: string;
  code: string;
  market: MarketCode;
}

export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  /** 成交量，原始单位（A股为手，港美股为股） */
  volume: number;
  /** 成交额，单位为元 */
  amount: number;
  change: number;
  changePct: number;
  /** 总市值，单位为元 */
  marketCap: number;
  /** 行情时间，unix 秒 */
  updatedAt: number | null;
}

export interface MarketBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface MarketSeries {
  symbol: string;
  name: string | null;
  quote?: MarketQuote;
  bars?: MarketBar[];
}

export interface MarketDataToolProviderOptions {
  workspace?: WorkspacePaths;
  /** 测试注入；默认走带 DNS 固定与私网拦截的 HTTP 客户端 */
  fetchClient?: WebFetchClient;
  logger?: {
    info?(obj: Record<string, unknown>, msg: string): void;
    warn?(obj: Record<string, unknown>, msg: string): void;
    error?(obj: Record<string, unknown>, msg: string): void;
  };
  now?: () => number;
}

const SYMBOL_PATTERN = /^([A-Za-z0-9][A-Za-z0-9.-]{0,11})\.(SH|SZ|HK|US)$/iu;
const MARKET_CODES: readonly MarketCode[] = ['SH', 'SZ', 'HK', 'US'];
const MAX_SYMBOLS = 30;
const MAX_DAYS = 500;
const DEFAULT_DAYS = 120;
const MIN_DAYS = 5;
/** 小体量结果直接内联返回，超过就落盘让沙箱读 */
const INLINE_LIMIT = 6_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const QUOTE_ENDPOINT = 'https://push2.eastmoney.com/api/qt/stock/get';
const DAILY_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
/** 只允许这两个行情主机，URL 由代码拼装、不接受调用方传入 */
const ALLOWED_HOSTS = new Set(['push2.eastmoney.com', 'web.ifzq.gtimg.cn']);
const QUOTE_FIELDS = [
  'f43',
  'f44',
  'f45',
  'f46',
  'f47',
  'f48',
  'f57',
  'f58',
  'f59',
  'f60',
  'f86',
  'f116',
  'f169',
  'f170',
].join(',');

/** 美股在东财要按交易所前缀取，纳斯达克 105 / 纽交所 106 / 交易所 107 */
const US_SECID_PREFIXES = ['105', '106', '107'] as const;

function parseSymbol(input: string): ParsedSymbol {
  const text = input.trim();
  const matched = SYMBOL_PATTERN.exec(text);
  if (!matched) {
    throw new Error(
      `行情代码格式不合法: ${text}（正确写法形如 600519.SH、000001.SZ、00700.HK、AAPL.US）`,
    );
  }
  const code = matched[1]!.toUpperCase();
  const market = matched[2]!.toUpperCase() as MarketCode;
  if (market === 'SH' || market === 'SZ') {
    if (!/^\d{6}$/u.test(code)) {
      throw new Error(`${market} 代码必须是 6 位数字: ${text}`);
    }
  } else if (market === 'HK') {
    if (!/^\d{1,5}$/u.test(code)) {
      throw new Error(`HK 代码必须是 1-5 位数字: ${text}`);
    }
  } else if (!/^[A-Z][A-Z0-9.-]{0,9}$/u.test(code)) {
    throw new Error(`US 代码必须是字母开头的代码: ${text}`);
  }
  return { symbol: `${code}.${market}`, code, market };
}

function scaleOf(decimals: unknown): number {
  const digits = typeof decimals === 'number' ? decimals : 2;
  return 10 ** Math.min(6, Math.max(0, Math.trunc(digits)));
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeQuote(
  symbol: ParsedSymbol,
  data: Record<string, unknown>,
): MarketQuote {
  const scale = scaleOf(data.f59);
  return {
    symbol: symbol.symbol,
    name: typeof data.f58 === 'string' ? data.f58 : symbol.code,
    price: toNumber(data.f43) / scale,
    prevClose: toNumber(data.f60) / scale,
    open: toNumber(data.f46) / scale,
    high: toNumber(data.f44) / scale,
    low: toNumber(data.f45) / scale,
    volume: toNumber(data.f47),
    amount: toNumber(data.f48),
    change: toNumber(data.f169) / 100,
    changePct: toNumber(data.f170) / 100,
    marketCap: toNumber(data.f116),
    updatedAt: typeof data.f86 === 'number' ? data.f86 : null,
  };
}

function normalizeBar(row: unknown): MarketBar | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [date, open, close, high, low, volume] = row as unknown[];
  if (typeof date !== 'string') return null;
  const num = (value: unknown): number => {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    date,
    open: num(open),
    close: num(close),
    high: num(high),
    low: num(low),
    volume: num(volume),
  };
}

export class MarketDataToolProvider implements IToolProvider {
  public readonly providerName = 'market-data';
  private readonly workspace?: WorkspacePaths;
  private readonly fetchClient: WebFetchClient;
  private readonly logger?: MarketDataToolProviderOptions['logger'];
  private readonly now: () => number;
  /** 已确认的东财 secid 与腾讯代码，避免每次请求都重新探测 */
  private readonly secidCache = new Map<string, string>();
  private readonly tencentCache = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  constructor(options: MarketDataToolProviderOptions = {}) {
    this.workspace = options.workspace;
    this.fetchClient = options.fetchClient ?? new WebFetchClient();
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  public async getTools(_ctx: ExecutionContext): Promise<ToolDefinition[]> {
    return [this.quoteTool()];
  }

  private async fetchJson(
    url: string,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const parsed = new URL(url);
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      throw new Error(`行情源主机不在白名单内: ${parsed.hostname}`);
    }
    const page = await this.fetchClient.fetch({
      url,
      maxBytes: MAX_RESPONSE_BYTES,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    try {
      const payload = JSON.parse(page.text) as unknown;
      return payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    } catch {
      throw new Error('行情源返回的不是合法 JSON');
    }
  }

  private secidCandidates(symbol: ParsedSymbol): string[] {
    if (symbol.market === 'SH') return [`1.${symbol.code}`];
    if (symbol.market === 'SZ') return [`0.${symbol.code}`];
    if (symbol.market === 'HK') return [`116.${symbol.code.padStart(5, '0')}`];
    return US_SECID_PREFIXES.map((prefix) => `${prefix}.${symbol.code}`);
  }

  private tencentCandidates(symbol: ParsedSymbol): string[] {
    if (symbol.market === 'SH') return [`sh${symbol.code}`];
    if (symbol.market === 'SZ') return [`sz${symbol.code}`];
    if (symbol.market === 'HK') return [`hk${symbol.code.padStart(5, '0')}`];
    return [`us${symbol.code}.OQ`, `us${symbol.code}.N`];
  }

  private async fetchQuote(
    symbol: ParsedSymbol,
    ctx: ExecutionContext,
  ): Promise<MarketQuote | null> {
    const cached = this.secidCache.get(symbol.symbol);
    const candidates = cached
      ? [cached]
      : this.secidCandidates(symbol);
    let lastError: Error | null = null;
    for (const secid of candidates) {
      try {
        const url = `${QUOTE_ENDPOINT}?secid=${encodeURIComponent(secid)}&fields=${QUOTE_FIELDS}`;
        const payload = await this.fetchJson(url, ctx);
        const data = payload.data;
        if (!data || typeof data !== 'object') continue;
        this.secidCache.set(symbol.symbol, secid);
        return normalizeQuote(symbol, data as Record<string, unknown>);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  private async fetchDaily(
    symbol: ParsedSymbol,
    days: number,
    adjust: 'qfq' | 'none',
    ctx: ExecutionContext,
  ): Promise<MarketBar[] | null> {
    const cached = this.tencentCache.get(symbol.symbol);
    const candidates = cached ? [cached] : this.tencentCandidates(symbol);
    for (const code of candidates) {
      const param = `${code},day,,,${days},${adjust}`;
      const url = `${DAILY_ENDPOINT}?param=${encodeURIComponent(param)}`;
      const payload = await this.fetchJson(url, ctx);
      const data = payload.data;
      const node =
        data && typeof data === 'object'
          ? (data as Record<string, unknown>)[code]
          : undefined;
      if (!node || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      const raw =
        record.qfqday ?? record.day ?? record.hfqday;
      if (!Array.isArray(raw)) continue;
      const bars = raw
        .map((row) => normalizeBar(row))
        .filter((bar): bar is MarketBar => bar !== null);
      if (bars.length === 0) continue;
      this.tencentCache.set(symbol.symbol, code);
      // 行情源可能多返回一根当根未收盘的当日线，按请求根数截断
      return bars.slice(-days);
    }
    return null;
  }

  private nextStepId(ctx: ExecutionContext): string {
    const count = (this.counters.get(ctx.messageId) ?? 0) + 1;
    this.counters.set(ctx.messageId, count);
    if (this.counters.size > 500) {
      const oldest = this.counters.keys().next().value;
      if (oldest !== undefined) this.counters.delete(oldest);
    }
    const slug = ctx.messageId.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 24);
    return `${slug || 'message'}_${count}`;
  }

  private async offload(
    payload: unknown,
    stepId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.workspace) {
      throw new Error('未配置工作区，无法落盘大体量行情数据，请减少取数范围');
    }
    const datasetKey = `market_${stepId}.json`;
    const hostPath = join(this.workspace.hostDir, datasetKey);
    await mkdir(this.workspace.hostDir, { recursive: true });
    const text = JSON.stringify(payload);
    await writeFile(hostPath, text, 'utf8');
    this.logger?.info?.(
      { datasetKey, sizeChars: text.length },
      'market data offloaded to sandbox workspace',
    );
    return {
      offloaded: true,
      datasetKey,
      datasetPath: `${this.workspace.sandboxDir}/${datasetKey}`,
      sizeChars: text.length,
      hint:
        `数据已落盘，请调用 sandbox_analyze_and_aggregate，` +
        `用 datasetKeys: ['${datasetKey}'] 读取完整数据后计算，不要凭摘要臆测未看到的结果。`,
    };
  }

  private quoteTool(): ToolDefinition {
    return {
      name: 'market_data_fetch',
      risk: 'read',
      source: 'market',
      description:
        '受控行情取数：从固定的公开行情源拉取实时快照或日线行情，只允许 A股（沪/深）、港股、美股。' +
        '代码格式必须是 CODE.MARKET，例如 600519.SH、000001.SZ、00700.HK、AAPL.US。' +
        '取数走本工具，沙盒保持无网络，计算请用 sandbox_analyze_and_aggregate；' +
        '数据量大时会自动落盘并返回 datasetKey，用 datasetKeys 读回。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_SYMBOLS,
            description:
              '行情代码列表，格式 CODE.MARKET，如 ["600519.SH","000001.SZ","00700.HK","AAPL.US"]',
          },
          kind: {
            type: 'string',
            enum: ['quote', 'daily'],
            description: 'quote=实时快照（默认），daily=日线行情',
          },
          days: {
            type: 'integer',
            minimum: MIN_DAYS,
            maximum: MAX_DAYS,
            description: `日线根数，仅 kind=daily 时生效，默认 ${DEFAULT_DAYS}`,
          },
          adjust: {
            type: 'string',
            enum: ['qfq', 'none'],
            description: '复权方式，qfq=前复权（默认），none=不复权',
          },
        },
        required: ['symbols'],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const rawSymbols = args.symbols;
        if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) {
          throw new Error('参数 symbols 必须是非空数组');
        }
        if (rawSymbols.length > MAX_SYMBOLS) {
          throw new Error(`一次最多取 ${MAX_SYMBOLS} 个代码`);
        }
        const kind: MarketKind = args.kind === 'daily' ? 'daily' : 'quote';
        const adjust: 'qfq' | 'none' = args.adjust === 'none' ? 'none' : 'qfq';
        const days = Math.min(
          MAX_DAYS,
          Math.max(
            MIN_DAYS,
            typeof args.days === 'number' && Number.isFinite(args.days)
              ? Math.trunc(args.days)
              : DEFAULT_DAYS,
          ),
        );
        const symbols = rawSymbols.map((item) => {
          if (typeof item !== 'string') {
            throw new Error('参数 symbols 只能包含字符串');
          }
          return parseSymbol(item);
        });

        const series: MarketSeries[] = [];
        const missing: string[] = [];
        for (const symbol of symbols) {
          if (kind === 'daily') {
            const bars = await this.fetchDaily(symbol, days, adjust, ctx);
            if (!bars || bars.length === 0) {
              missing.push(symbol.symbol);
              continue;
            }
            series.push({ symbol: symbol.symbol, name: null, bars });
          } else {
            const quote = await this.fetchQuote(symbol, ctx);
            if (!quote) {
              missing.push(symbol.symbol);
              continue;
            }
            series.push({ symbol: symbol.symbol, name: quote.name, quote });
          }
        }

        const payload = {
          kind,
          provider: kind === 'daily' ? 'tencent' : 'eastmoney',
          adjust: kind === 'daily' ? adjust : undefined,
          days: kind === 'daily' ? days : undefined,
          fetchedAt: this.now(),
          symbols: series.map((item) => item.symbol),
          missing,
          series,
        };
        const text = JSON.stringify(payload);
        if (text.length <= INLINE_LIMIT) {
          return text;
        }
        const offloaded = await this.offload(payload, this.nextStepId(ctx));
        return JSON.stringify({
          ...offloaded,
          kind,
          provider: payload.provider,
          symbols: payload.symbols,
          missing,
          barCount: series.reduce((sum, item) => sum + (item.bars?.length ?? 0), 0),
          preview: series.slice(0, 3).map((item) => ({
            symbol: item.symbol,
            name: item.name,
            quote: item.quote ?? null,
            firstBar: item.bars?.[0] ?? null,
            lastBar: item.bars?.[item.bars.length - 1] ?? null,
          })),
        });
      },
    };
  }
}

export { MARKET_CODES, parseSymbol };
