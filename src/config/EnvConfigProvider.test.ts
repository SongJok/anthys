import { describe, expect, it } from 'vitest';
import { EnvConfigProvider } from './EnvConfigProvider.js';

describe('EnvConfigProvider model profiles', () => {
  const multiVendorEnv = {
    LLM_MODEL_SOURCE: 'env',
    DEEPSEEK_API_KEY: 'ds-key',
    KIMI_API_KEY: 'kimi-key',
    GLM_API_KEY: 'glm-key',
    LLM_BASE_URL: 'https://api.deepseek.com/v1',
    LLM_API_KEY: '${DEEPSEEK_API_KEY}',
    LLM_MODEL: 'deepseek-flash',
    LLM_TEMPERATURE: '0.3',
    LLM_THINKING: 'high',
    LLM_MAX_TOKENS: '8192',
    LLM_ADMIN_BASE_URL: 'https://api.moonshot.cn/v1',
    LLM_ADMIN_API_KEY: '${KIMI_API_KEY}',
    LLM_ADMIN_MODEL: 'kimi-k3.1-pro',
    LLM_ADMIN_THINKING: 'max',
    LLM_PROACTIVE_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
    LLM_PROACTIVE_API_KEY: '${GLM_API_KEY}',
    LLM_PROACTIVE_MODEL: 'glm-5.3-flash',
    LLM_PROACTIVE_THINKING: 'low',
  } as NodeJS.ProcessEnv;

  it('按角色解析三家供应商并展开密钥占位符', () => {
    const provider = new EnvConfigProvider(multiVendorEnv);
    const profiles = provider.getModelProfiles();

    expect(provider.getModelConfigSource()).toBe('env');
    expect(profiles.default).toMatchObject({
      provider: 'openai-compatible',
      dialect: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'ds-key',
      model: 'deepseek-flash',
      thinking: 'high',
      maxTokens: 8192,
    });
    expect(profiles.admin).toMatchObject({
      dialect: 'moonshot',
      apiKey: 'kimi-key',
      model: 'kimi-k3.1-pro',
      thinking: 'max',
    });
    expect(profiles.proactive).toMatchObject({
      dialect: 'zhipu',
      apiKey: 'glm-key',
      model: 'glm-5.3-flash',
      thinking: 'low',
    });
    expect(profiles.fallbacks).toEqual({});
    expect(provider.getLLMConfig()).toMatchObject({
      model: 'deepseek-flash',
      apiKey: 'ds-key',
      thinking: 'high',
      enableNativeReasoning: true,
    });
  });

  it('默认模型密钥缺失时回退到可用的 GLM 旁听配置', () => {
    const provider = new EnvConfigProvider({
      ...multiVendorEnv,
      DEEPSEEK_API_KEY: '',
    });

    const profiles = provider.getModelProfiles();
    expect(profiles.default.model).toBe('glm-5.3-flash');
    expect(profiles.fallbacks.default).toContain('LLM_PROACTIVE_*');
  });

  it('管理员密钥缺失时回退默认模型并记录原因', () => {
    const provider = new EnvConfigProvider({
      ...multiVendorEnv,
      KIMI_API_KEY: '',
    });

    const profiles = provider.getModelProfiles();
    expect(profiles.default.model).toBe('deepseek-flash');
    expect(profiles.admin).toEqual(profiles.default);
    expect(profiles.fallbacks.admin).toContain('LLM_ADMIN_*');
  });

  it('database 模式保留旧版覆盖语义', () => {
    const provider = new EnvConfigProvider({
      ...multiVendorEnv,
      LLM_MODEL_SOURCE: 'database',
    });
    expect(provider.getModelConfigSource()).toBe('database');
  });

  it('视觉与搜索在默认模型切到别家后仍复用 GLM 密钥', () => {
    const provider = new EnvConfigProvider({
      ...multiVendorEnv,
      VISION_ENABLED: 'true',
    });

    expect(provider.getVisionConfig()).toEqual({
      enabled: true,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'glm-key',
      model: 'glm-5.3-flash',
    });
    expect(provider.getWebSearchConfig().apiKey).toBe('glm-key');
  });
});

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
      cacheTtlSeconds: 300,
      maxCallsPerHour: 30,
      dailyLimit: 500,
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
      WEB_SEARCH_CACHE_TTL_SECONDS: '0',
      WEB_SEARCH_MAX_CALLS_PER_HOUR: '12',
      WEB_SEARCH_DAILY_LIMIT: '80',
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
      cacheTtlSeconds: 0,
      maxCallsPerHour: 12,
      dailyLimit: 80,
    });
  });

  it('非法引擎与内容长度回退默认值', () => {
    const provider = new EnvConfigProvider({
      LLM_API_KEY: 'zhipu-key',
      WEB_SEARCH_ENGINE: 'bing',
      WEB_SEARCH_CONTENT_SIZE: 'huge',
      WEB_SEARCH_COUNT: '999',
      WEB_SEARCH_CACHE_TTL_SECONDS: '-5',
      WEB_SEARCH_MAX_CALLS_PER_HOUR: '-1',
      WEB_SEARCH_DAILY_LIMIT: 'abc',
    });

    const config = provider.getWebSearchConfig();
    expect(config.engine).toBe('search_pro');
    expect(config.contentSize).toBe('medium');
    expect(config.count).toBe(50);
    expect(config.cacheTtlSeconds).toBe(0);
    expect(config.maxCallsPerHour).toBe(0);
    expect(config.dailyLimit).toBe(500);
  });
});
