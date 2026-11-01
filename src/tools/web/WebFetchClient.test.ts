import { describe, expect, it, vi } from 'vitest';
import {
  WebFetchClient,
  WebFetchError,
  createPinnedLookup,
  decodeHtmlEntities,
  extractHtmlContent,
  isPrivateAddress,
  type HttpFetcher,
  type RawHttpResponse,
} from './WebFetchClient.js';

function response(
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): RawHttpResponse {
  return {
    status,
    headers,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
    truncated: false,
  };
}

function clientWith(
  fetcher: HttpFetcher,
  resolveHost: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>> = async () => [
    { address: '93.184.216.34', family: 4 },
  ],
): WebFetchClient {
  return new WebFetchClient({ fetcher, resolveHost, maxRedirects: 3 });
}

describe('isPrivateAddress', () => {
  it('拦截常见内网与保留地址', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('放行公网地址', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('createPinnedLookup', () => {
  it('兼容 autoSelectFamily 的 all:true 数组回调', () => {
    const lookup = createPinnedLookup({
      address: '93.184.216.34',
      family: 4,
    });
    const args: unknown[] = [];
    lookup('example.com', { all: true }, (...received) => {
      args.push(...received);
    });
    expect(args).toEqual([
      null,
      [{ address: '93.184.216.34', family: 4 }],
    ]);
  });

  it('兼容单地址回调', () => {
    const lookup = createPinnedLookup({
      address: '2606:4700:4700::1111',
      family: 6,
    });
    const args: unknown[] = [];
    lookup('example.com', 6, (...received) => {
      args.push(...received);
    });
    expect(args).toEqual([null, '2606:4700:4700::1111', 6]);
  });
});

describe('dnsServers', () => {
  it('拒绝非 IP 的 DNS 服务器配置', () => {
    expect(
      () => new WebFetchClient({ dnsServers: ['not-an-ip'] }),
    ).toThrow('WEB_FETCH_DNS_SERVERS');
  });
});

describe('WebFetchClient 安全边界', () => {
  it('拒绝非 http(s)、带凭据、非标准端口和本机地址', async () => {
    const fetcher = vi.fn<HttpFetcher>();
    const client = clientWith(fetcher);
    await expect(client.fetch({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL',
    });
    await expect(
      client.fetch({ url: 'https://user:pass@example.com/a' }),
    ).rejects.toMatchObject({ code: 'URL_CREDENTIALS' });
    await expect(
      client.fetch({ url: 'https://example.com:8443/a' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PORT' });
    await expect(
      client.fetch({ url: 'http://localhost:80/admin' }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    await expect(
      client.fetch({ url: 'http://[::1]/admin' }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('DNS 解析到内网时拒绝，防止域名绕过', async () => {
    const fetcher = vi.fn<HttpFetcher>();
    const client = clientWith(fetcher, async () => [
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(
      client.fetch({ url: 'https://internal.example.com/a' }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('重定向目标重新校验，禁止跳到内网', async () => {
    const fetcher = vi.fn<HttpFetcher>(async () =>
      response(302, { location: 'http://169.254.169.254/latest/meta-data' }, ''),
    );
    const client = clientWith(fetcher);
    await expect(
      client.fetch({ url: 'https://example.com/start' }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('重定向次数超限时报错', async () => {
    let counter = 0;
    const fetcher = vi.fn<HttpFetcher>(async () => {
      counter += 1;
      return response(302, { location: `https://example.com/${counter}` }, '');
    });
    const client = clientWith(fetcher);
    await expect(
      client.fetch({ url: 'https://example.com/start' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('跟随重定向到公开页面', async () => {
    const fetcher = vi.fn<HttpFetcher>(async (url) =>
      url.pathname === '/old'
        ? response(301, { location: '/new' }, '')
        : response(
            200,
            { 'content-type': 'text/html; charset=utf-8' },
            '<html><head><title>新页面</title></head><body><p>正文</p></body></html>',
          ),
    );
    const page = await clientWith(fetcher).fetch({
      url: 'https://example.com/old',
    });
    expect(page.redirects).toBe(1);
    expect(page.finalUrl).toBe('https://example.com/new');
    expect(page.title).toBe('新页面');
  });
});

describe('WebFetchClient 正文提取', () => {
  it('提取标题、描述与正文，剔除脚本与样式', async () => {
    const html = `<!doctype html>
      <html><head>
        <title>示例 &amp; 文章</title>
        <meta name="description" content="这是一篇示例文章">
        <style>.a{color:red}</style>
        <script>alert('x')</script>
      </head><body>
        <nav>导航</nav>
        <h1>标题一</h1>
        <p>第一段&nbsp;内容</p>
        <ul><li>条目一</li><li>条目二</li></ul>
        <table><tr><th>名称</th><th>数量</th></tr><tr><td>A</td><td>1</td></tr></table>
      </body></html>`;
    const fetcher = vi.fn<HttpFetcher>(async () =>
      response(200, { 'content-type': 'text/html' }, html),
    );
    const page = await clientWith(fetcher).fetch({
      url: 'https://example.com/article',
    });
    expect(page.title).toBe('示例 & 文章');
    expect(page.description).toBe('这是一篇示例文章');
    expect(page.text).toContain('# 标题一');
    expect(page.text).toContain('- 条目一');
    expect(page.text).toContain('第一段 内容');
    expect(page.text).toContain('名称 | 数量');
    expect(page.text).not.toContain('alert');
    expect(page.text).not.toContain('color:red');
  });

  it('JSON 内容格式化输出', async () => {
    const fetcher = vi.fn<HttpFetcher>(async () =>
      response(
        200,
        { 'content-type': 'application/json' },
        '{"name":"anthys","stars":1}',
      ),
    );
    const page = await clientWith(fetcher).fetch({
      url: 'https://api.example.com/repo',
    });
    expect(page.contentType).toBe('application/json');
    expect(page.text).toContain('"name": "anthys"');
  });

  it('拒绝二进制内容', async () => {
    const fetcher = vi.fn<HttpFetcher>(async () =>
      response(200, { 'content-type': 'application/pdf' }, '%PDF-1.7'),
    );
    await expect(
      clientWith(fetcher).fetch({ url: 'https://example.com/a.pdf' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
  });

  it('把 401/403/404 映射为可读错误', async () => {
    const notFound = clientWith(async () => response(404, {}, ''));
    await expect(
      notFound.fetch({ url: 'https://example.com/missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const forbidden = clientWith(async () => response(403, {}, ''));
    await expect(
      forbidden.fetch({ url: 'https://example.com/private' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('标记响应体被截断', async () => {
    const fetcher = vi.fn<HttpFetcher>(async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('hello'),
      truncated: true,
    }));
    const page = await clientWith(fetcher).fetch({
      url: 'https://example.com/big',
    });
    expect(page.truncated).toBe(true);
  });

  it('对 HTML 实体与抽取函数直接做单元校验', () => {
    expect(decodeHtmlEntities('a &lt; b &amp; c &#65; &#x42;')).toBe(
      'a < b & c A B',
    );
    expect(extractHtmlContent('<title>T</title><p>x</p>').text).toBe('x');
  });

  it('错误类型可识别', () => {
    const error = new WebFetchError('失败', 'TEST');
    expect(error.name).toBe('WebFetchError');
    expect(error.code).toBe('TEST');
  });
});
