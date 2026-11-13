import { describe, expect, it, vi } from 'vitest';
import type {
  ChatModel,
  DynamicLoopPolicy,
  LLMAndPersonaConfig,
  ModelProfile,
  ModelRole,
} from '../types/core.js';
import type { ReActRunner } from '../react/ReActRunner.js';
import type { AgentHarness, WorkerRuntime } from './AgentHarness.js';
import type { GroupModelRoutingEngine } from '../groups/GroupModelRoutingEngine.js';
import { createWorkerRegistry } from '../workers/WorkerRegistry.js';
import { AgentRuntimeRegistry } from './AgentRuntimeRegistry.js';

function profile(role: ModelRole, maxTokens: number): ModelProfile {
  return {
    provider: 'openai-compatible',
    dialect: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: `key-${role}`,
    model: `model-${role}`,
    temperature: 0.2,
    thinking: 'off',
    maxTokens,
  };
}

function fakeEngine() {
  return {
    updateModel: vi.fn(),
    updatePolicy: vi.fn(),
    updateTemperature: vi.fn(),
    updateNativeReasoning: vi.fn(),
    updateMaxTokens: vi.fn(),
  } as unknown as ReActRunner & {
    updatePolicy: ReturnType<typeof vi.fn>;
    updateTemperature: ReturnType<typeof vi.fn>;
    updateNativeReasoning: ReturnType<typeof vi.fn>;
    updateMaxTokens: ReturnType<typeof vi.fn>;
  };
}

describe('AgentRuntimeRegistry', () => {
  const basePolicy: DynamicLoopPolicy = {
    maxWallTimeMs: 120_000,
    maxTotalTokens: 40_000,
    maxConsecutiveSameTool: 4,
    convergenceCheck: true,
    maxIterations: 20,
  };

  it('applyLlmChange refreshes all role models, engines, worker maxTokens, and persona', () => {
    const defaultModel = { name: 'initial' } as unknown as ChatModel;
    const roleModelRefs: Record<ModelRole, { current: ChatModel }> = {
      default: { current: defaultModel },
      admin: { current: defaultModel },
      proactive: { current: defaultModel },
    };
    const defaultEngine = fakeEngine();
    const investigationEngine = fakeEngine();
    const workerRegistry = createWorkerRegistry({ basePolicy });
    const researchEngine = fakeEngine();
    const opsEngine = fakeEngine();
    const workerRuntimes: Partial<Record<'research' | 'ops', WorkerRuntime>> = {
      research: {
        profile: workerRegistry.get('research'),
        engine: researchEngine,
      },
      ops: {
        profile: workerRegistry.get('ops'),
        engine: opsEngine,
      },
    };
    const routedEngines = new Map<ModelRole, ReActRunner>([
      ['admin', fakeEngine()],
    ]);
    const groupModelRouting = {
      invalidate: vi.fn(),
    } as unknown as GroupModelRoutingEngine & {
      invalidate: ReturnType<typeof vi.fn>;
    };
    const harness = {
      updatePolicy: vi.fn(),
      updatePersona: vi.fn(),
    } as unknown as AgentHarness & {
      updatePolicy: ReturnType<typeof vi.fn>;
      updatePersona: ReturnType<typeof vi.fn>;
    };
    const personaRef = {
      name: 'OldBot',
      rolePrompt: 'old',
      speakingStyle: 'plain',
    };

    const registry = new AgentRuntimeRegistry({
      roleModelRefs,
      createChatModel: (p) => ({ modelId: p.model } as unknown as ChatModel),
      defaultEngine,
      investigationEngine,
      workerRegistry,
      workerRuntimes,
      routedEngines,
      groupModelRouting,
      harness,
      personaRef,
    });

    const nextLlm: LLMAndPersonaConfig = {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'secret',
      model: 'claude-sonnet',
      enableNativeReasoning: true,
      thinking: 'auto',
      temperature: 0.4,
      maxTokens: 4096,
      persona: {
        name: 'NewBot',
        rolePrompt: 'helpful',
        speakingStyle: 'concise',
      },
    };

    registry.applyLlmChange(nextLlm, {
      default: profile('default', 4096),
      admin: profile('admin', 8192),
      proactive: profile('proactive', 2048),
    });

    expect((roleModelRefs.default.current as unknown as { modelId: string }).modelId).toBe('model-default');
    expect((roleModelRefs.admin.current as unknown as { modelId: string }).modelId).toBe('model-admin');
    expect((roleModelRefs.proactive.current as unknown as { modelId: string }).modelId).toBe('model-proactive');
    expect(routedEngines.size).toBe(0);
    expect(groupModelRouting.invalidate).toHaveBeenCalledTimes(1);

    expect(defaultEngine.updateTemperature).toHaveBeenCalledWith(0.4);
    expect(defaultEngine.updateNativeReasoning).toHaveBeenCalledWith(true);
    expect(defaultEngine.updateMaxTokens).toHaveBeenCalledWith(4096);
    expect(investigationEngine.updateMaxTokens).toHaveBeenCalledWith(2048);
    expect(researchEngine.updateMaxTokens).toHaveBeenCalledWith(2048);
    expect(opsEngine.updateMaxTokens).toHaveBeenCalledWith(8192);
    expect(personaRef.name).toBe('NewBot');
    expect(harness.updatePersona).toHaveBeenCalledWith(personaRef);
  });

  it('applyLoopPolicyChange updates main engine, investigation engine, harness, workerRegistry and worker engines', () => {
    const dummyModel = {} as ChatModel;
    const defaultEngine = fakeEngine();
    const investigationEngine = fakeEngine();
    const workerRegistry = createWorkerRegistry({ basePolicy });
    const researchEngine = fakeEngine();
    const opsEngine = fakeEngine();
    const workerRuntimes: Partial<Record<'research' | 'ops', WorkerRuntime>> = {
      research: {
        profile: workerRegistry.get('research'),
        engine: researchEngine,
      },
      ops: {
        profile: workerRegistry.get('ops'),
        engine: opsEngine,
      },
    };
    const routedEngines = new Map<ModelRole, ReActRunner>([
      ['proactive', fakeEngine()],
    ]);
    const groupModelRouting = {
      invalidate: vi.fn(),
    } as unknown as GroupModelRoutingEngine & {
      invalidate: ReturnType<typeof vi.fn>;
    };
    const harness = {
      updatePolicy: vi.fn(),
      updatePersona: vi.fn(),
    } as unknown as AgentHarness & {
      updatePolicy: ReturnType<typeof vi.fn>;
      updatePersona: ReturnType<typeof vi.fn>;
    };

    const registry = new AgentRuntimeRegistry({
      roleModelRefs: {
        default: { current: dummyModel },
        admin: { current: dummyModel },
        proactive: { current: dummyModel },
      },
      createChatModel: () => dummyModel,
      defaultEngine,
      investigationEngine,
      workerRegistry,
      workerRuntimes,
      routedEngines,
      groupModelRouting,
      harness,
      personaRef: { name: 'Bot', rolePrompt: '', speakingStyle: '' },
    });

    const nextPolicy: DynamicLoopPolicy = {
      ...basePolicy,
      maxConsecutiveSameTool: 7,
      convergenceCheck: false,
      maxIterations: 35,
    };

    registry.applyLoopPolicyChange(nextPolicy);

    expect(routedEngines.size).toBe(0);
    expect(groupModelRouting.invalidate).toHaveBeenCalledTimes(1);
    expect(defaultEngine.updatePolicy).toHaveBeenCalledWith(nextPolicy);
    expect(investigationEngine.updatePolicy).toHaveBeenCalledWith(nextPolicy);
    expect(harness.updatePolicy).toHaveBeenCalledWith(nextPolicy);

    expect(workerRuntimes.research?.profile.policy.maxConsecutiveSameTool).toBe(7);
    expect(workerRuntimes.research?.profile.policy.convergenceCheck).toBe(false);
    expect(researchEngine.updatePolicy).toHaveBeenCalledWith(
      workerRegistry.get('research').policy,
    );
    expect(opsEngine.updatePolicy).toHaveBeenCalledWith(
      workerRegistry.get('ops').policy,
    );
  });
});
