import type {
  ChatModel,
  DynamicLoopPolicy,
  LLMAndPersonaConfig,
  ModelProfile,
  ModelRole,
} from '../types/core.js';
import type { PersonaInput } from '../memory/ContextAssembler.js';
import type { ReActRunner } from '../react/ReActRunner.js';
import type { AgentHarness, WorkerRuntime } from './AgentHarness.js';
import type { GroupModelRoutingEngine } from '../groups/GroupModelRoutingEngine.js';
import type { WorkerName } from '../types/workers.js';
import type { WorkerRegistry } from '../workers/WorkerRegistry.js';

export interface AgentRuntimeRegistryDeps {
  roleModelRefs: Record<ModelRole, { current: ChatModel }>;
  createChatModel: (profile: ModelProfile) => ChatModel;
  defaultEngine: ReActRunner;
  investigationEngine: ReActRunner;
  workerRegistry: WorkerRegistry;
  workerRuntimes: Partial<Record<WorkerName, WorkerRuntime>>;
  routedEngines: Map<ModelRole, ReActRunner>;
  groupModelRouting: GroupModelRoutingEngine;
  harness: AgentHarness;
  personaRef: PersonaInput;
  buildWorkerPolicy?: (worker: WorkerName, basePolicy: DynamicLoopPolicy) => DynamicLoopPolicy;
}

/**
 * 集中托管运行期全部 ReAct 引擎与热更新联动：
 * 保证 Web/ChatOps 修改模型或循环策略后，主引擎、调查引擎、多模型路由与各 Worker 同步生效。
 */
export class AgentRuntimeRegistry {
  constructor(private readonly deps: AgentRuntimeRegistryDeps) {}

  public applyLlmChange(
    next: LLMAndPersonaConfig,
    profiles: Record<ModelRole, ModelProfile>,
  ): void {
    this.deps.roleModelRefs.default.current = this.deps.createChatModel(
      profiles.default,
    );
    this.deps.roleModelRefs.admin.current = this.deps.createChatModel(
      profiles.admin,
    );
    this.deps.roleModelRefs.proactive.current = this.deps.createChatModel(
      profiles.proactive,
    );
    this.deps.routedEngines.clear();
    this.deps.groupModelRouting.invalidate();

    this.deps.defaultEngine.updateTemperature(next.temperature);
    this.deps.defaultEngine.updateNativeReasoning(
      (next.thinking ?? (next.enableNativeReasoning ? 'auto' : 'off')) !== 'off',
    );
    this.deps.defaultEngine.updateMaxTokens(next.maxTokens);

    this.deps.investigationEngine.updateMaxTokens(profiles.proactive.maxTokens);

    for (const [name, runtime] of Object.entries(this.deps.workerRuntimes)) {
      if (!runtime) continue;
      const roleProfile = name === 'ops' ? profiles.admin : profiles.proactive;
      const engine = runtime.engine as ReActRunner;
      if (typeof engine.updateMaxTokens === 'function') {
        engine.updateMaxTokens(roleProfile.maxTokens);
      }
    }

    Object.assign(this.deps.personaRef, next.persona);
    this.deps.harness.updatePersona(this.deps.personaRef);
  }

  public applyLoopPolicyChange(nextPolicy: DynamicLoopPolicy): void {
    this.deps.routedEngines.clear();
    this.deps.groupModelRouting.invalidate();
    this.deps.defaultEngine.updatePolicy(nextPolicy);
    this.deps.investigationEngine.updatePolicy(nextPolicy);
    this.deps.harness.updatePolicy(nextPolicy);

    let updatedRegistry: WorkerRegistry | null = null;
    if (typeof this.deps.workerRegistry.updateBasePolicy === 'function') {
      this.deps.workerRegistry.updateBasePolicy(nextPolicy);
      updatedRegistry = this.deps.workerRegistry;
    } else if (typeof this.deps.workerRegistry.withBasePolicy === 'function') {
      updatedRegistry = this.deps.workerRegistry.withBasePolicy(nextPolicy);
    }

    for (const [name, runtime] of Object.entries(this.deps.workerRuntimes)) {
      if (!runtime) continue;
      const workerName = name as WorkerName;
      const nextWorkerProfile = updatedRegistry?.get(workerName);
      const nextWorkerPolicy = nextWorkerProfile
        ? nextWorkerProfile.policy
        : this.deps.buildWorkerPolicy
          ? this.deps.buildWorkerPolicy(workerName, nextPolicy)
          : nextPolicy;
      if (nextWorkerProfile) {
        runtime.profile = nextWorkerProfile;
      }
      const engine = runtime.engine as ReActRunner;
      if (typeof engine.updatePolicy === 'function') {
        engine.updatePolicy(nextWorkerPolicy);
      }
    }
  }
}
