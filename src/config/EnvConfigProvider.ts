import type {
  DynamicLoopPolicy,
  LLMAndPersonaConfig,
} from '../types/core.js';
import type {
  DingTalkConfig,
  IConfigProvider,
  MemoryConfig,
} from './IConfigProvider.js';

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
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
      maxWallTimeMs: parseNumber(this.env.LOOP_MAX_WALL_TIME_MS, 120_000),
      maxTotalTokens: parseNumber(this.env.LOOP_MAX_TOTAL_TOKENS, 64_000),
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
