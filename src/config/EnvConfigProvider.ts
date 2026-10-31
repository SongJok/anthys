import type {
  DynamicLoopPolicy,
  LLMAndPersonaConfig,
} from '../types/core.js';
import type {
  DingTalkConfig,
  BystanderConfig,
  EmbeddingConfig,
  IConfigProvider,
  MemoryConfig,
  VisionConfig,
  WebSearchConfig,
  WebSearchContentSize,
  WebSearchEngine,
} from './IConfigProvider.js';
import type {
  ModelRoutingPolicy,
  UsagePolicy,
} from '../types/admin-and-console.js';
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_SLIDING_WINDOW_SIZE,
  DEFAULT_TRIGGER_TOPICS,
} from '../types/bystander-and-memory.js';

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const WEB_SEARCH_ENGINES: readonly WebSearchEngine[] = [
  'search_std',
  'search_pro',
  'search_pro_sogou',
  'search_pro_quark',
];
const SOGOU_COUNTS = [10, 20, 30, 40, 50] as const;

function parseWebSearchEngine(value: string | undefined): WebSearchEngine {
  const engine = (value ?? '').trim();
  return (WEB_SEARCH_ENGINES as readonly string[]).includes(engine)
    ? (engine as WebSearchEngine)
    : 'search_pro';
}

function parseWebSearchCount(
  value: string | undefined,
  engine: WebSearchEngine,
): number {
  const parsed = Math.trunc(parseNumber(value, 5));
  if (engine === 'search_pro_sogou') {
    return SOGOU_COUNTS.find((count) => count >= parsed) ?? 50;
  }
  return Math.min(50, Math.max(1, parsed));
}

function parseContentSize(value: string | undefined): WebSearchContentSize {
  return value?.trim() === 'high' ? 'high' : 'medium';
}

export class EnvConfigProvider implements IConfigProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getLLMConfig(): LLMAndPersonaConfig {
    const provider = this.env.LLM_PROVIDER ?? 'openai-compatible';
    if (provider !== 'openai-compatible' && provider !== 'anthropic') {
      throw new Error(
        `LLM_PROVIDER must be "openai-compatible" or "anthropic", got "${provider}"`,
      );
    }
    return {
      provider,
      baseUrl: this.env.LLM_BASE_URL ?? '',
      apiKey: this.env.LLM_API_KEY ?? '',
      model: this.env.LLM_MODEL ?? 'deepseek-reasoner',
      enableNativeReasoning: parseBoolean(
        this.env.LLM_ENABLE_NATIVE_REASONING,
        true,
      ),
      temperature: parseNumber(this.env.LLM_TEMPERATURE, 0.3),
      persona: {
        name: this.env.PERSONA_NAME ?? '小钉',
        rolePrompt:
          this.env.PERSONA_ROLE_PROMPT ??
          '你是企业内部智能助手，负责解答员工的工作问题，回答准确、简洁、可执行。',
        speakingStyle:
          this.env.PERSONA_SPEAKING_STYLE ??
          '语气专业友好，先给结论再给要点；不确定时明确说明而不是编造。',
      },
    };
  }

  getLoopPolicy(): DynamicLoopPolicy {
    return {
      maxWallTimeMs: parseNumber(this.env.LOOP_MAX_WALL_TIME_MS, 900_000),
      maxTotalTokens: parseNumber(this.env.LOOP_MAX_TOTAL_TOKENS, 120_000),
      maxConsecutiveSameTool: Math.max(
        1,
        parseNumber(this.env.LOOP_MAX_CONSECUTIVE_SAME_TOOL, 2),
      ),
      convergenceCheck: parseBoolean(this.env.LOOP_CONVERGENCE_CHECK, true),
    };
  }

  getDingTalkConfig(): DingTalkConfig {
    return {
      clientId: this.env.DINGTALK_CLIENT_ID ?? '',
      clientSecret: this.env.DINGTALK_CLIENT_SECRET ?? '',
      robotCode: this.env.DINGTALK_ROBOT_CODE ?? '',
      cardTemplateId: this.env.DINGTALK_CARD_TEMPLATE_ID ?? '',
    };
  }

  getMemoryConfig(): MemoryConfig {
    return {
      windowMessages: Math.max(
        1,
        parseNumber(this.env.MEMORY_WINDOW_MESSAGES, 20),
      ),
      compressionThresholdTokens: Math.max(
        1,
        parseNumber(this.env.MEMORY_COMPRESSION_THRESHOLD_TOKENS, 12_000),
      ),
      compressionRatio: Math.min(
        0.9,
        Math.max(0.1, parseNumber(this.env.MEMORY_COMPRESSION_RATIO, 0.6)),
      ),
      semanticLimit: Math.max(1, parseNumber(this.env.MEMORY_SEMANTIC_LIMIT, 6)),
    };
  }

  getBystanderConfig(): BystanderConfig {
    const topics = (this.env.BYSTANDER_TRIGGER_TOPICS ?? '')
      .split(',')
      .map((topic) => topic.trim())
      .filter(Boolean);
    return {
      bystanderEnabled: parseBoolean(this.env.BYSTANDER_ENABLED, true),
      proactiveReplyEnabled: parseBoolean(
        this.env.BYSTANDER_PROACTIVE_REPLY,
        true,
      ),
      slidingWindowSize: Math.max(
        1,
        parseNumber(
          this.env.BYSTANDER_SLIDING_WINDOW_SIZE,
          DEFAULT_SLIDING_WINDOW_SIZE,
        ),
      ),
      cooldownSeconds: Math.max(
        0,
        parseNumber(
          this.env.BYSTANDER_COOLDOWN_SECONDS,
          DEFAULT_COOLDOWN_SECONDS,
        ),
      ),
      confidenceThreshold: Math.min(
        1,
        Math.max(
          0,
          parseNumber(
            this.env.BYSTANDER_CONFIDENCE_THRESHOLD,
            DEFAULT_CONFIDENCE_THRESHOLD,
          ),
        ),
      ),
      triggerTopics: topics.length > 0 ? topics : [...DEFAULT_TRIGGER_TOPICS],
      debounceMs: Math.max(
        0,
        parseNumber(this.env.BYSTANDER_DEBOUNCE_MS, 8_000),
      ),
    };
  }

  getUsagePolicy(): UsagePolicy {
    return {
      enabled: parseBoolean(this.env.USAGE_QUOTA_ENABLED, false),
      dailyTokensPerUser: Math.max(
        0,
        parseNumber(this.env.USAGE_DAILY_TOKENS_PER_USER, 0),
      ),
      dailyTokensPerConversation: Math.max(
        0,
        parseNumber(this.env.USAGE_DAILY_TOKENS_PER_CONVERSATION, 0),
      ),
    };
  }

  getModelRouting(): ModelRoutingPolicy {
    const pick = (value: string | undefined): string | undefined => {
      const model = value?.trim();
      return model ? model : undefined;
    };
    return {
      defaultModel: pick(this.env.LLM_ROUTE_DEFAULT_MODEL),
      proactiveModel: pick(this.env.LLM_ROUTE_PROACTIVE_MODEL),
      adminModel: pick(this.env.LLM_ROUTE_ADMIN_MODEL),
    };
  }

  getEmbeddingConfig(): EmbeddingConfig {
    const llm = this.getLLMConfig();
    return {
      enabled: parseBoolean(this.env.EMBEDDING_ENABLED, false),
      baseUrl: (this.env.EMBEDDING_BASE_URL ?? llm.baseUrl).trim(),
      apiKey: (this.env.EMBEDDING_API_KEY ?? llm.apiKey).trim(),
      model: (this.env.EMBEDDING_MODEL ?? 'text-embedding-3-small').trim(),
      dimensions: Math.max(
        1,
        parseNumber(this.env.EMBEDDING_DIMENSIONS, 1536),
      ),
    };
  }

  getVisionConfig(): VisionConfig {
    const llm = this.getLLMConfig();
    return {
      enabled: parseBoolean(this.env.VISION_ENABLED, false),
      baseUrl: (this.env.VISION_BASE_URL ?? llm.baseUrl).trim(),
      apiKey: (this.env.VISION_API_KEY ?? llm.apiKey).trim(),
      model: (this.env.VISION_MODEL ?? llm.model).trim(),
    };
  }

  getWebSearchConfig(): WebSearchConfig {
    const llm = this.getLLMConfig();
    const explicitBaseUrl = this.env.WEB_SEARCH_BASE_URL?.trim();
    // 大模型不是智谱时不能把别家的 baseUrl/Key 复用给搜索接口
    const llmIsZhipu = llm.baseUrl.includes('bigmodel.cn');
    const baseUrl =
      explicitBaseUrl || (llmIsZhipu ? llm.baseUrl : ZHIPU_BASE_URL);
    const apiKey = (
      this.env.WEB_SEARCH_API_KEY ?? (llmIsZhipu ? llm.apiKey : '')
    ).trim();
    const engine = parseWebSearchEngine(this.env.WEB_SEARCH_ENGINE);
    return {
      enabled: parseBoolean(this.env.WEB_SEARCH_ENABLED, true),
      baseUrl,
      apiKey,
      engine,
      count: parseWebSearchCount(this.env.WEB_SEARCH_COUNT, engine),
      contentSize: parseContentSize(this.env.WEB_SEARCH_CONTENT_SIZE),
      timeoutMs: Math.max(
        1_000,
        parseNumber(this.env.WEB_SEARCH_TIMEOUT_MS, 12_000),
      ),
      redactOutbound: parseBoolean(this.env.WEB_SEARCH_REDACT, true),
    };
  }

  getDatabaseUrl(): string {
    return (
      this.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent'
    );
  }

  assertReady(): void {
    const llm = this.getLLMConfig();
    const ding = this.getDingTalkConfig();
    const missing: string[] = [];
    if (!ding.clientId) missing.push('DINGTALK_CLIENT_ID');
    if (!ding.clientSecret) missing.push('DINGTALK_CLIENT_SECRET');
    if (!ding.robotCode) missing.push('DINGTALK_ROBOT_CODE');
    if (!ding.cardTemplateId) missing.push('DINGTALK_CARD_TEMPLATE_ID');
    if (!llm.baseUrl) missing.push('LLM_BASE_URL');
    if (!llm.apiKey) missing.push('LLM_API_KEY');
    if (!this.getDatabaseUrl()) missing.push('DATABASE_URL');
    if (missing.length > 0) {
      throw new Error(`缺少必需环境变量: ${missing.join(', ')}`);
    }
  }
}
