import 'dotenv/config';
import { createDatabase, type Database } from './client.js';
import { agentConfigs } from './schema.js';
import type { LLMAndPersonaConfig } from '../types/core.js';

export const PERSONA_CONFIG_KEY = 'persona';
export const LLM_CONFIG_KEY = 'llm';

export type LLMOverrides = Partial<
  Pick<
    LLMAndPersonaConfig,
    'provider' | 'baseUrl' | 'model' | 'enableNativeReasoning' | 'temperature'
  >
> & {
  persona?: Partial<LLMAndPersonaConfig['persona']>;
};

export async function seedAgentConfigs(
  db: Database,
  config: LLMAndPersonaConfig,
): Promise<void> {
  await db
    .insert(agentConfigs)
    .values([
      {
        key: PERSONA_CONFIG_KEY,
        value: { ...config.persona },
      },
      {
        key: LLM_CONFIG_KEY,
        value: {
          provider: config.provider,
          baseUrl: config.baseUrl,
          model: config.model,
          enableNativeReasoning: config.enableNativeReasoning,
          temperature: config.temperature,
        },
      },
    ])
    .onConflictDoNothing();
}

export async function loadLLMOverrides(db: Database): Promise<LLMOverrides> {
  const rows = await db.select().from(agentConfigs);
  const overrides: LLMOverrides = {};
  for (const row of rows) {
    if (row.key === PERSONA_CONFIG_KEY) {
      const value = row.value as Partial<LLMAndPersonaConfig['persona']>;
      overrides.persona = { ...value };
    } else if (row.key === LLM_CONFIG_KEY) {
      const value = row.value as LLMOverrides;
      Object.assign(overrides, {
        provider: value.provider,
        baseUrl: value.baseUrl,
        model: value.model,
        enableNativeReasoning: value.enableNativeReasoning,
        temperature: value.temperature,
      });
    }
  }
  return overrides;
}

/** 数据库配置覆盖 .env，apiKey 只从环境变量读取，不落库 */
export function applyLLMOverrides(
  base: LLMAndPersonaConfig,
  overrides: LLMOverrides,
): LLMAndPersonaConfig {
  return {
    ...base,
    provider: overrides.provider ?? base.provider,
    baseUrl: overrides.baseUrl || base.baseUrl,
    model: overrides.model || base.model,
    enableNativeReasoning:
      overrides.enableNativeReasoning ?? base.enableNativeReasoning,
    temperature: overrides.temperature ?? base.temperature,
    persona: {
      name: overrides.persona?.name || base.persona.name,
      rolePrompt: overrides.persona?.rolePrompt || base.persona.rolePrompt,
      speakingStyle:
        overrides.persona?.speakingStyle || base.persona.speakingStyle,
    },
  };
}

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent';
  const handle = createDatabase(url);
  try {
    const { EnvConfigProvider } = await import('../config/EnvConfigProvider.js');
    const config = new EnvConfigProvider().getLLMConfig();
    await seedAgentConfigs(handle.db, config);
    console.log('agent_configs seeded (existing rows untouched)');
  } finally {
    await handle.close();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === new URL(`file://${entry}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
