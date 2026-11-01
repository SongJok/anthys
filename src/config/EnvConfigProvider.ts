import type {
  DynamicLoopPolicy,
  LLMAndPersonaConfig,
  LlmDialect,
  ModelConfigSource,
  ModelProfile,
  ModelProfiles,
  ModelRole,
  ThinkingMode,
} from '../types/core.js';
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_SLIDING_WINDOW_SIZE,
  DEFAULT_TRIGGER_TOPICS,
} from '../types/bystander-and-memory.js';
import { resolveEnvValue } from './envPlaceholder.js';
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
import type { UsagePolicy } from '../types/admin-and-console.js';
import type { ExtensionsConfig } from '../types/skills-plugins-projects.js';

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

const THINKING_MODES: readonly ThinkingMode[] = [
  'off',
  'auto',
  'low',
  'high',
  'max',
];

function parseThinking(
  value: string | undefined,
  fallback: ThinkingMode,
): ThinkingMode {
  const mode = (value ?? '').trim().toLowerCase();
  return (THINKING_MODES as readonly string[]).includes(mode)
    ? (mode as ThinkingMode)
    : fallback;
}

function parseDialect(value: string | undefined, baseUrl: string): LlmDialect {
  const explicit = (value ?? '').trim().toLowerCase();
  if (
    explicit === 'openai' ||
    explicit === 'deepseek' ||
    explicit === 'moonshot' ||
    explicit === 'zhipu'
  ) {
    return explicit;
  }
  const url = baseUrl.toLowerCase();
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('moonshot') || url.includes('kimi')) return 'moonshot';
  if (url.includes('bigmodel') || url.includes('zhipu')) return 'zhipu';
  return 'openai';
}

function parseMaxTokens(value: string | undefined): number | undefined {
  const parsed = parseNumber(value, 0);
  return parsed > 0 ? Math.trunc(parsed) : undefined;
}

function parseModelProvider(
  value: string | undefined,
  fallback: 'openai-compatible' | 'anthropic',
): 'openai-compatible' | 'anthropic' {
  const provider = (value ?? '').trim() || fallback;
  if (provider !== 'openai-compatible' && provider !== 'anthropic') {
    throw new Error(
      `LLM_PROVIDER must be "openai-compatible" or "anthropic", got "${provider}"`,
    );
  }
  return provider;
}

function profileUsable(profile: ModelProfile): boolean {
  return Boolean(profile.baseUrl && profile.apiKey && profile.model);
}

export class EnvConfigProvider implements IConfigProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getLLMConfig(): LLMAndPersonaConfig {
    const profile = this.getModelProfiles().default;
    return {
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
      enableNativeReasoning: profile.thinking !== 'off',
      thinking: profile.thinking,
      temperature: profile.temperature,
      ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
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

  /**
   * 默认角色来自 LLM_*，管理员来自 LLM_ADMIN_*，旁听/主动回复来自 LLM_PROACTIVE_*。
   * 某个角色未配置或密钥为空时回退默认模型，并把原因写进 fallbacks 供启动日志展示。
   */
  getModelProfiles(): ModelProfiles {
    const rawDefault = this.buildProfile('LLM');
    const defaultProfile = rawDefault.profile;
    const rawAdmin = this.buildProfile('LLM_ADMIN', defaultProfile);
    const rawProactive = this.buildProfile('LLM_PROACTIVE', defaultProfile);
    const fallbacks: Partial<Record<ModelRole, string>> = {};

    let effectiveDefault = defaultProfile;
    if (!profileUsable(effectiveDefault)) {
      if (rawProactive.configured && profileUsable(rawProactive.profile)) {
        effectiveDefault = rawProactive.profile;
        fallbacks.default = `默认模型配置不完整，回退到 LLM_PROACTIVE_*（${rawProactive.profile.model}）`;
      }
    }

    let admin = effectiveDefault;
    if (rawAdmin.configured) {
      if (profileUsable(rawAdmin.profile)) {
        admin = rawAdmin.profile;
      } else {
        fallbacks.admin = `LLM_ADMIN_* 缺少 baseUrl/apiKey/model，回退默认模型 ${effectiveDefault.model}`;
      }
    }

    let proactive = effectiveDefault;
    if (rawProactive.configured) {
      if (profileUsable(rawProactive.profile)) {
        proactive = rawProactive.profile;
      } else {
        fallbacks.proactive = `LLM_PROACTIVE_* 缺少 baseUrl/apiKey/model，回退默认模型 ${effectiveDefault.model}`;
      }
    }

    return { default: effectiveDefault, admin, proactive, fallbacks };
  }

  getModelConfigSource(): ModelConfigSource {
    const source = (this.env.LLM_MODEL_SOURCE ?? 'env').trim().toLowerCase();
    return source === 'database' ? 'database' : 'env';
  }

  private buildProfile(
    prefix: string,
    fallback?: ModelProfile,
  ): { profile: ModelProfile; configured: boolean } {
    const read = (suffix: string): string | undefined =>
      this.env[`${prefix}_${suffix}`];
    const configured = Boolean(
      read('BASE_URL')?.trim() ||
        read('API_KEY')?.trim() ||
        read('MODEL')?.trim(),
    );
    const baseUrl = resolveEnvValue(read('BASE_URL'), this.env);
    const apiKey = resolveEnvValue(read('API_KEY'), this.env);
    const model = (read('MODEL') ?? '').trim();
    const provider = parseModelProvider(
      read('PROVIDER'),
      fallback?.provider ?? 'openai-compatible',
    );
    const temperature = parseNumber(
      read('TEMPERATURE'),
      fallback?.temperature ?? 0.3,
    );
    const thinking = parseThinking(
      read('THINKING'),
      fallback?.thinking ??
        (parseBoolean(this.env.LLM_ENABLE_NATIVE_REASONING, true)
          ? 'auto'
          : 'off'),
    );
    const maxTokens =
      parseMaxTokens(read('MAX_TOKENS')) ?? fallback?.maxTokens;
    return {
      configured,
      profile: {
        provider,
        dialect: parseDialect(read('DIALECT'), baseUrl),
        baseUrl,
        apiKey,
        model,
        temperature,
        thinking,
        ...(maxTokens ? { maxTokens } : {}),
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
      maxIterations: Math.max(
        1,
        parseNumber(this.env.LOOP_MAX_ITERATIONS, 40),
      ),
      maxParallelTools: Math.max(
        1,
        parseNumber(this.env.LOOP_MAX_PARALLEL_TOOLS, 4),
      ),
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
      silentInvestigationEnabled: parseBoolean(
        this.env.BYSTANDER_SILENT_INVESTIGATION_ENABLED,
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
    const glmKey = resolveEnvValue(this.env.GLM_API_KEY, this.env);
    const explicitBaseUrl = (this.env.VISION_BASE_URL ?? '').trim();
    const baseUrl =
      explicitBaseUrl || (glmKey ? ZHIPU_BASE_URL : llm.baseUrl);
    const apiKey =
      resolveEnvValue(this.env.VISION_API_KEY, this.env) ||
      glmKey ||
      llm.apiKey;
    const model =
      (this.env.VISION_MODEL ?? '').trim() ||
      (glmKey && !explicitBaseUrl ? 'glm-5.3-flash' : llm.model);
    return {
      enabled: parseBoolean(this.env.VISION_ENABLED, false),
      baseUrl,
      apiKey,
      model,
    };
  }

  getWebSearchConfig(): WebSearchConfig {
    const llm = this.getLLMConfig();
    const explicitBaseUrl = this.env.WEB_SEARCH_BASE_URL?.trim();
    // 大模型不是智谱时不能把别家的 baseUrl/Key 复用给搜索接口
    const llmIsZhipu = llm.baseUrl.includes('bigmodel.cn');
    const baseUrl =
      explicitBaseUrl || (llmIsZhipu ? llm.baseUrl : ZHIPU_BASE_URL);
    const glmKey =
      resolveEnvValue(this.env.GLM_API_KEY, this.env) ||
      resolveEnvValue(this.env.LLM_PROACTIVE_API_KEY, this.env);
    const apiKey =
      resolveEnvValue(this.env.WEB_SEARCH_API_KEY, this.env) ||
      (llmIsZhipu ? llm.apiKey : '') ||
      glmKey;
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
      cacheTtlSeconds: Math.max(
        0,
        Math.trunc(
          parseNumber(this.env.WEB_SEARCH_CACHE_TTL_SECONDS, 300),
        ),
      ),
      maxCallsPerHour: Math.max(
        0,
        Math.trunc(
          parseNumber(this.env.WEB_SEARCH_MAX_CALLS_PER_HOUR, 30),
        ),
      ),
      dailyLimit: Math.max(
        0,
        Math.trunc(parseNumber(this.env.WEB_SEARCH_DAILY_LIMIT, 500)),
      ),
    };
  }

  getExtensionsConfig(): ExtensionsConfig {
    return {
      skillsEnabled: parseBoolean(this.env.EXTENSIONS_SKILLS_ENABLED, true),
      pluginsEnabled: parseBoolean(this.env.EXTENSIONS_PLUGINS_ENABLED, true),
      projectsEnabled: parseBoolean(this.env.EXTENSIONS_PROJECTS_ENABLED, true),
      defaultProjectId: (this.env.EXTENSIONS_DEFAULT_PROJECT_ID ?? '').trim(),
      skillCatalogLimit: Math.min(
        50,
        Math.max(1, Math.trunc(parseNumber(this.env.SKILL_CATALOG_LIMIT, 20))),
      ),
      projectBriefMaxChars: Math.min(
        8_000,
        Math.max(
          200,
          Math.trunc(parseNumber(this.env.PROJECT_BRIEF_MAX_CHARS, 2_000)),
        ),
      ),
    };
  }

  getDatabaseUrl(): string {
    return (
      this.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent'
    );
  }

  assertReady(): void {
    const profiles = this.getModelProfiles();
    const llm = profiles.default;
    const ding = this.getDingTalkConfig();
    const missing: string[] = [];
    if (!ding.clientId) missing.push('DINGTALK_CLIENT_ID');
    if (!ding.clientSecret) missing.push('DINGTALK_CLIENT_SECRET');
    if (!ding.robotCode) missing.push('DINGTALK_ROBOT_CODE');
    if (!ding.cardTemplateId) missing.push('DINGTALK_CARD_TEMPLATE_ID');
    if (!llm.baseUrl) missing.push('LLM_BASE_URL');
    if (!llm.apiKey) missing.push('LLM_API_KEY（或其引用的密钥变量）');
    if (!llm.model) missing.push('LLM_MODEL');
    if (!this.getDatabaseUrl()) missing.push('DATABASE_URL');
    if (missing.length > 0) {
      throw new Error(`缺少必需环境变量: ${missing.join(', ')}`);
    }
  }
}
