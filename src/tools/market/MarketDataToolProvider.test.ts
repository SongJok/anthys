import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/core.js';
import {
  WebFetchClient,
  type HttpFetcher,
  type RawHttpResponse,
} from '../web/WebFetchClient.js';
import {
  MarketDataToolProvider,
  parseSymbol,
} from './MarketDataToolProvider.js';

function jsonResponse(body: unknown): RawHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    truncated: false,
  };
}

function emptyResponse(): RawHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{}', 'utf8'),
    truncated: false,
  };
}

function client(fetcher: HttpFetcher): WebFetchClient {
  return new WebFetchClient({
    fetcher,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });
}

function ctx(): ExecutionContext {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: 'tester',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: () => 1_700_000_000_000,
  };
}

const QUOTE_PAYLOAD = {
  rc: 0,
  data: {
    f43: 168_500,
    f44: 170_000,
    f45: 167_000,
    f46: 167_800,
    f47: 30_000,
    f48: 5_050_000_000,
    f57: '600519',
    f58: '贵州茅台',
    f59: 2,
    f60: 169_000,
    f86: 1_700_000_000,
    f116: 2_117_000_000_000,
    f169: -500,
    f170: -30,
  },
};

describe('parseSymbol', () => {
  it('接受 A股、港股、美股代码并统一大写', () => {
    expect(parseSymbol('600519.sh')).toEqual({
      symbol: '600519.SH',
      code: '600519',
      market: 'SH',
    });
    expect(parseSymbol('00700.hk').symbol).toBe('00700.HK');
    expect(parseSymbol('aapl.us').symbol).toBe('AAPL.US');
  });

  it('拒绝缺少市场后缀与不合规代码', () => {
    expect(() => parseSymbol('600519')).toThrow(/格式不合法/u);
    expect(() => parseSymbol('60051.SH')).toThrow(/6 位数字/u);
    expect(() => parseSymbol('700000.HK')).toThrow(/1-5 位数字/u);
    expect(() => parseSymbol('1AAPL.US')).toThrow(/字母开头/u);
  });
});

describe('market_data_fetch', () => {
  it('返回东财快照并按小数位还原价格', async () => {
    const urls: string[] = [];
    const provider = new MarketDataToolProvider({
      fetchClient: client(async (url) => {
        urls.push(url.toString());
        return jsonResponse(QUOTE_PAYLOAD);
      }),
    });
    const [tool] = await provider.getTools(ctx());
    const result = JSON.parse(
      await tool!.execute({ symbols: ['600519.SH'] }, ctx()),
    );
    expect(urls[0]).toContain('push2.eastmoney.com');
    expect(urls[0]).toContain('secid=1.600519');
    expect(result.series[0].quote.name).toBe('贵州茅台');
    expect(result.series[0].quote.price).toBe(1685);
    expect(result.series[0].quote.prevClose).toBe(1690);
    expect(result.series[0].quote.change).toBe(-5);
    expect(result.series[0].quote.changePct).toBe(-0.3);
    expect(result.series[0].quote.marketCap).toBe(2_117_000_000_000);
    expect(result.missing).toEqual([]);
  });

  it('行情源没有数据时列入 missing，不影响其他代码', async () => {
    const provider = new MarketDataToolProvider({
      fetchClient: client(async (url) =>
        url.toString().includes('600519')
          ? jsonResponse(QUOTE_PAYLOAD)
          : jsonResponse({ rc: 0, data: null }),
      ),
    });
    const [tool] = await provider.getTools(ctx());
    const result = JSON.parse(
      await tool!.execute({ symbols: ['600519.SH', '000001.SZ'] }, ctx()),
    );
    expect(result.series).toHaveLength(1);
    expect(result.missing).toEqual(['000001.SZ']);
  });

  it('美股按交易所前缀依次探测', async () => {
    const urls: string[] = [];
    const provider = new MarketDataToolProvider({
      fetchClient: client(async (url) => {
        urls.push(url.toString());
        if (url.toString().includes('secid=106.AAPL')) {
          return jsonResponse({ data: { ...QUOTE_PAYLOAD.data, f58: '苹果' } });
        }
        return emptyResponse();
      }),
    });
    const [tool] = await provider.getTools(ctx());
    const result = JSON.parse(
      await tool!.execute({ symbols: ['AAPL.US'] }, ctx()),
    );
    expect(urls.map((item) => item.match(/secid=([^&]+)/u)![1])).toEqual([
      '105.AAPL',
      '106.AAPL',
    ]);
    expect(result.series[0].quote.name).toBe('苹果');
  });

  it('日线走腾讯源并归一化 K 线', async () => {
    const urls: string[] = [];
    const provider = new MarketDataToolProvider({
      fetchClient: client(async (url) => {
        urls.push(url.toString());
        return jsonResponse({
          data: {
            sh600519: {
              qfqday: [
                ['2026-01-02', '1680.00', '1690.00', '1700.00', '1675.00', '20000'],
                ['2026-01-03', '1690.00', '1710.00', '1720.00', '1688.00', '25000'],
              ],
            },
          },
        });
      }),
    });
    const [tool] = await provider.getTools(ctx());
    const result = JSON.parse(
      await tool!.execute({ symbols: ['600519.SH'], kind: 'daily', days: 30 }, ctx()),
    );
    expect(urls[0]).toContain('web.ifzq.gtimg.cn');
    expect(urls[0]).toContain('sh600519%2Cday');
    expect(result.provider).toBe('tencent');
    expect(result.series[0].bars).toHaveLength(2);
    expect(result.series[0].bars[0]).toEqual({
      date: '2026-01-02',
      open: 1680,
      close: 1690,
      high: 1700,
      low: 1675,
      volume: 20_000,
    });
  });

  it('数据量大时落盘并返回 datasetKey 供沙箱读取', async () => {
    const hostDir = await mkdtemp(join(tmpdir(), 'market-'));
    const bars = Array.from({ length: 200 }, (_, index) => [
      `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
      '1680.00',
      '1690.00',
      '1700.00',
      '1675.00',
      '20000',
    ]);
    const provider = new MarketDataToolProvider({
      workspace: { hostDir, sandboxDir: '/workspace' },
      fetchClient: client(async () =>
        jsonResponse({ data: { sh600519: { qfqday: bars } } }),
      ),
    });
    const [tool] = await provider.getTools(ctx());
    const result = JSON.parse(
      await tool!.execute({ symbols: ['600519.SH'], kind: 'daily', days: 200 }, ctx()),
    );
    expect(result.offloaded).toBe(true);
    expect(result.datasetKey).toMatch(/^market_msg1_\d+\.json$/u);
    expect(result.datasetPath).toBe(`/workspace/${result.datasetKey}`);
    expect(result.barCount).toBe(200);
    expect(result.hint).toContain('sandbox_analyze_and_aggregate');
    const written = JSON.parse(
      await readFile(join(hostDir, result.datasetKey), 'utf8'),
    );
    expect(written.series[0].bars).toHaveLength(200);
  });

  it('拒绝非法代码与超量请求', async () => {
    const provider = new MarketDataToolProvider({
      fetchClient: client(async () => emptyResponse()),
    });
    const [tool] = await provider.getTools(ctx());
    await expect(
      tool!.execute({ symbols: ['600519'] }, ctx()),
    ).rejects.toThrow(/格式不合法/u);
    await expect(
      tool!.execute({ symbols: Array.from({ length: 31 }, () => '600519.SH') }, ctx()),
    ).rejects.toThrow(/最多取 30 个代码/u);
    await expect(
      tool!.execute({ symbols: [] }, ctx()),
    ).rejects.toThrow(/非空数组/u);
  });
});
