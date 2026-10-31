import { describe, expect, it } from 'vitest';
import { EnvConfigProvider } from './EnvConfigProvider.js';

describe('EnvConfigProvider web search', () => {
  it('默认 search_pro，并复用智谱的 baseUrl 与 API Key', () => {
    const provider = new EnvConfigProvider({
      LLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      LLM_API_KEY: 'zhipu-key',
      LLM_MODEL: 'glm-5.3-flash',
    });

    expect(provider.getWebSearchConfig()).toEqual({
      enabled: true,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'zhipu-key',
      engine: 'search_pro',
      count: 5,
      contentSize: 'medium',
      timeoutMs: 12_000,
      redactOutbound: true,
    });
  });

  it('非智谱大模型不会复用别家 Key', () => {
    const provider = new EnvConfigProvider({
      LLM_BASE_URL: 'https://api.deepseek.com/v1',
      LLM_API_KEY: 'deepseek-key',
    });

    const config = provider.getWebSearchConfig();
    expect(config.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(config.apiKey).toBe('');
  });

  it('支持显式覆盖并对搜狗引擎归一化条数', () => {
    const provider = new EnvConfigProvider({
      LLM_BASE_URL: 'https://api.deepseek.com/v1',
      LLM_API_KEY: 'deepseek-key',
      WEB_SEARCH_ENABLED: 'false',
      WEB_SEARCH_BASE_URL: 'https://proxy.example.com/paas/v4/',
      WEB_SEARCH_API_KEY: 'search-key',
      WEB_SEARCH_ENGINE: 'search_pro_sogou',
      WEB_SEARCH_COUNT: '7',
      WEB_SEARCH_CONTENT_SIZE: 'high',
      WEB_SEARCH_TIMEOUT_MS: '9000',
      WEB_SEARCH_REDACT: 'false',
    });

    expect(provider.getWebSearchConfig()).toEqual({
      enabled: false,
      baseUrl: 'https://proxy.example.com/paas/v4/',
      apiKey: 'search-key',
      engine: 'search_pro_sogou',
      count: 10,
      contentSize: 'high',
      timeoutMs: 9_000,
      redactOutbound: false,
    });
  });

  it('非法引擎与内容长度回退默认值', () => {
    const provider = new EnvConfigProvider({
      LLM_API_KEY: 'zhipu-key',
      WEB_SEARCH_ENGINE: 'bing',
      WEB_SEARCH_CONTENT_SIZE: 'huge',
      WEB_SEARCH_COUNT: '999',
    });

    const config = provider.getWebSearchConfig();
    expect(config.engine).toBe('search_pro');
    expect(config.contentSize).toBe('medium');
    expect(config.count).toBe(50);
  });
});
