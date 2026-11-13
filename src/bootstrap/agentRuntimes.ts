import type { MetricsRegistry } from '../admin-api/metrics.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { Database } from '../db/client.js';
import { DrizzleGroupModelRouteStore } from '../db/groupSchema.js';
import { GroupModelRouteService } from '../groups/GroupModelRouteService.js';
import { GroupModelRoutingEngine } from '../groups/GroupModelRoutingEngine.js';
import type {
  AgentHarness,
  HarnessLogger,
  WorkerRuntime,
} from '../harness/AgentHarness.js';
import { AgentRuntimeRegistry } from '../harness/AgentRuntimeRegistry.js';
import { ModelRoutingEngine } from '../harness/ModelRoutingEngine.js';
import type { RunControlRegistry } from '../harness/RunControlRegistry.js';
import type { PersonaInput } from '../memory/ContextAssembler.js';
import { createChatModel, inferDialect } from '../react/createChatModel.js';
import { createPlanner } from '../react/Planner.js';
import { ReActRunner } from '../react/ReActRunner.js';
import { SubagentToolProvider } from '../react/SubagentToolProvider.js';
import type {
  ChatModel,
  DynamicLoopPolicy,
  ExecutionContext,
  IToolProvider,
  ModelProfile,
  ModelRole,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../types/core.js';
import type { AgentJobStore } from '../types/jobs.js';
import type { WatchdogDecision } from '../types/watchdog.js';
import type { WorkerName } from '../types/workers.js';
import { createWatchdogPolicy } from '../watchdog/RunWatchdog.js';
import { ScopedToolProvider } from '../workers/ScopedToolProvider.js';
import { createWorkerRegistry, type WorkerRegistry } from '../workers/WorkerRegistry.js';
import { WorkerToolProvider } from '../workers/WorkerToolProvider.js';
import { envCount, envEnabled, envSeconds } from './envHelpers.js';

export interface AgentRuntimesDeps {
  db: Database;
  configCenter: DynamicConfigCenter;
  harnessLogger: HarnessLogger;
  metrics: MetricsRegistry;
  runControl: RunControlRegistry;
  toolProviders: IToolProvider[];
  applyExecutionPolicy: (providers: () => IToolProvider[]) => IToolProvider[];
  resolveToolApproval: (
    request: ToolApprovalRequest,
    context: ExecutionContext,
  ) => Promise<ToolApprovalDecision>;
  jobStore: Pick<AgentJobStore, 'enqueue'>;
}

export interface AgentRuntimesContext {
  roleModelRefs: Record<ModelRole, { current: ChatModel }>;
  defaultModelRef: { current: ChatModel };
  chatModel: ChatModel;
  adminModel: ChatModel;
  proactiveModel: ChatModel;
  engine: ReActRunner;
  investigationEngine: ReActRunner;
  workerRegistry: WorkerRegistry;
  workerRuntimes: Partial<Record<WorkerName, WorkerRuntime>>;
  routedEngines: Map<ModelRole, ReActRunner>;
  routingEngine: ModelRoutingEngine;
  groupModelRouting: GroupModelRoutingEngine;
  groupModelRoutes: GroupModelRouteService;
  createRuntimeRegistry: (
    harness: AgentHarness,
    personaRef: PersonaInput,
  ) => AgentRuntimeRegistry;
}

/** 初始化多角色模型、Planner、Subagent、Worker 编排工具、主循环及群/角色路由引擎 */
export function setupAgentRuntimes(
  deps: AgentRuntimesDeps,
): AgentRuntimesContext {
  const {
    db,
    configCenter,
    harnessLogger: logger,
    metrics,
    runControl,
    toolProviders,
    applyExecutionPolicy,
    resolveToolApproval,
    jobStore,
  } = deps;

  const initialProfiles = configCenter.getModelProfiles();
  const llmConfig = configCenter.getLLMConfig();
  const roleModelRefs: Record<ModelRole, { current: ChatModel }> = {
    default: { current: createChatModel(initialProfiles.default) },
    admin: { current: createChatModel(initialProfiles.admin) },
    proactive: { current: createChatModel(initialProfiles.proactive) },
  };
  const defaultModelRef = roleModelRefs.default;
  const chatModelFor = (role: ModelRole): ChatModel => ({
    get modelName() {
      return roleModelRefs[role].current.modelName;
    },
    streamChat: (request, signal) =>
      roleModelRefs[role].current.streamChat(request, signal),
  });
  const chatModel = chatModelFor('default');
  const adminModel = chatModelFor('admin');
  const proactiveModel = chatModelFor('proactive');

  const describeProfile = (profile: ModelProfile) => ({
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    thinking: profile.thinking,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    apiKeyConfigured: Boolean(profile.apiKey),
  });
  logger.info(
    {
      modelSource: configCenter.getModelConfigSource(),
      profiles: {
        default: describeProfile(initialProfiles.default),
        admin: describeProfile(initialProfiles.admin),
        proactive: describeProfile(initialProfiles.proactive),
      },
      modelFallbacks: initialProfiles.fallbacks,
    },
    'model routing resolved',
  );

  const planner = createPlanner({
    model: proactiveModel,
    enabled: envEnabled(process.env.PLANNER_ENABLED, false),
    minQuestionChars: envCount(process.env.PLANNER_MIN_CHARS, 80),
    minTools: envCount(process.env.PLANNER_MIN_TOOLS, 8),
    logger,
  });

  if (envEnabled(process.env.SUBAGENT_ENABLED, false)) {
    let subagent: SubagentToolProvider | undefined;
    subagent = new SubagentToolProvider({
      model: adminModel,
      providers: () =>
        applyExecutionPolicy(() =>
          toolProviders.filter((provider) => provider !== subagent),
        ),
      policy: () => configCenter.getLoopPolicy(),
      timeoutMs: envSeconds(process.env.SUBAGENT_TIMEOUT_SECONDS, 90) * 1_000,
      maxTokens: envCount(process.env.SUBAGENT_MAX_TOKENS, 20_000),
      logger,
    });
    toolProviders.push(subagent);
    logger.info({}, 'subagent delegation enabled');
  }

  const toolTimeoutMs = envSeconds(process.env.TOOL_TIMEOUT_SECONDS, 300) * 1_000;
  const watchdogPolicy = createWatchdogPolicy(process.env);
  const watchdogRunOptions = {
    watchdog: { policy: watchdogPolicy },
    onWatchdog: (decision: WatchdogDecision): void => {
      metrics.inc('agent_watchdog_total', {
        action: decision.action,
        code: decision.code,
      });
      logger.warn(
        {
          action: decision.action,
          code: decision.code,
          reason: decision.reason,
        },
        'run watchdog intervened',
      );
    },
  };
  logger.info({ policy: watchdogPolicy }, 'run watchdog configured');

  const consumeSteering = (context: ExecutionContext): string[] =>
    runControl.consumeSteering(context.conversationId);

  const engine = new ReActRunner({
    model: chatModel,
    toolProviders: applyExecutionPolicy(() => toolProviders),
    policy: configCenter.getLoopPolicy(),
    temperature: llmConfig.temperature,
    enableNativeReasoning:
      (llmConfig.thinking ??
        (llmConfig.enableNativeReasoning ? 'auto' : 'off')) !== 'off',
    ...(llmConfig.maxTokens ? { maxTokens: llmConfig.maxTokens } : {}),
    approval: resolveToolApproval,
    toolTimeoutMs,
    ...(planner ? { planner } : {}),
    consumeSteering,
    ...watchdogRunOptions,
  });

  const investigationEngine = new ReActRunner({
    model: proactiveModel,
    toolProviders: applyExecutionPolicy(() => toolProviders),
    policy: configCenter.getLoopPolicy(),
    temperature: 0,
    enableNativeReasoning: false,
    approval: resolveToolApproval,
    toolTimeoutMs,
    toolFilter: (tool) => tool.risk === 'read',
    ...watchdogRunOptions,
  });

  const workerRegistry = createWorkerRegistry({
    basePolicy: configCenter.getLoopPolicy(),
    env: process.env,
  });
  const workerRuntimes: Partial<Record<WorkerName, WorkerRuntime>> = {};
  for (const profile of workerRegistry.list()) {
    const scopedProvider = new ScopedToolProvider({
      providers: () => applyExecutionPolicy(() => toolProviders),
      scope: profile.scope,
      providerName: `worker:${profile.name}`,
    });
    workerRuntimes[profile.name] = {
      profile,
      engine: new ReActRunner({
        model: profile.name === 'ops' ? adminModel : proactiveModel,
        toolProviders: [scopedProvider],
        policy: profile.policy,
        temperature: 0,
        enableNativeReasoning: false,
        approval: resolveToolApproval,
        toolTimeoutMs,
        ...watchdogRunOptions,
      }),
    };
  }
  logger.info(
    {
      workers: workerRegistry.list().map((profile) => ({
        name: profile.name,
        readOnly: profile.scope.readOnly,
        maxWallTimeMs: profile.policy.maxWallTimeMs,
        maxTotalTokens: profile.policy.maxTotalTokens,
        maxIterations: profile.policy.maxIterations,
        allow: profile.scope.allow,
        deny: profile.scope.deny,
      })),
    },
    'worker runtimes initialized',
  );

  // 注册 Router 调度工具（dispatch_worker），使主对话可显式委派 research / ops / report Worker
  if (envEnabled(process.env.WORKER_ROUTER_TOOL_ENABLED, true)) {
    const workerProvider = new WorkerToolProvider({
      jobStore,
      isReadOnlyWorker: (name) => workerRegistry.get(name).scope.readOnly,
      runInline: async (worker, task, context) => {
        const runtime = workerRuntimes[worker];
        if (!runtime) {
          throw new Error(`Worker 运行时未初始化：${worker}`);
        }
        const workerDeadline =
          Date.now() + runtime.profile.policy.maxWallTimeMs;
        const workerContext: ExecutionContext = {
          ...context,
          worker,
          deadlineAt: Math.min(context.deadlineAt, workerDeadline),
        };
        const result = await runtime.engine.run({
          messages: [
            { role: 'system', content: runtime.profile.instruction },
            { role: 'user', content: task },
          ],
          context: workerContext,
          emit: () => {},
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { answer: result.answer, usage: result.usage };
      },
    });
    toolProviders.push(workerProvider);
    logger.info({}, 'dispatch_worker router tool enabled');
  }

  const routedEngines = new Map<ModelRole, ReActRunner>();
  const runnerForRole = (role: ModelRole): ReActRunner => {
    if (role === 'default') return engine;
    const cached = routedEngines.get(role);
    if (cached) return cached;
    const profile = configCenter.getModelProfiles()[role];
    const runner = new ReActRunner({
      model: chatModelFor(role),
      toolProviders: applyExecutionPolicy(() => toolProviders),
      policy: configCenter.getLoopPolicy(),
      temperature: profile.temperature,
      enableNativeReasoning: profile.thinking !== 'off',
      ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
      approval: resolveToolApproval,
      toolTimeoutMs,
      ...(planner ? { planner } : {}),
      consumeSteering,
      ...watchdogRunOptions,
    });
    routedEngines.set(role, runner);
    return runner;
  };
  const routingEngine = new ModelRoutingEngine({
    fallback: engine,
    engineForRole: runnerForRole,
    isAdmin: (staffId) => configCenter.isAdmin(staffId),
  });
  const groupModelRouteStore = new DrizzleGroupModelRouteStore(db);
  const groupModelRouting = new GroupModelRoutingEngine({
    fallback: routingEngine,
    routes: groupModelRouteStore,
    engineForRoute: (route) => {
      if (route.apiKeyEnv && !process.env[route.apiKeyEnv]?.trim()) {
        return null;
      }
      const base = configCenter.getModelProfiles().default;
      const baseUrl = route.baseUrl || base.baseUrl;
      const apiKey = route.apiKeyEnv
        ? (process.env[route.apiKeyEnv] ?? '')
        : base.apiKey;
      const maxTokens = route.maxTokens ?? base.maxTokens;
      const profile: ModelProfile = {
        provider: route.provider || base.provider,
        dialect: inferDialect(baseUrl),
        baseUrl,
        apiKey,
        model: route.model || base.model,
        temperature: route.temperature ?? base.temperature,
        thinking: route.thinking || base.thinking,
        ...(maxTokens ? { maxTokens } : {}),
      };
      return new ReActRunner({
        model: createChatModel(profile),
        toolProviders: applyExecutionPolicy(() => toolProviders),
        policy: configCenter.getLoopPolicy(),
        temperature: profile.temperature,
        enableNativeReasoning: profile.thinking !== 'off',
        ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
        approval: resolveToolApproval,
        toolTimeoutMs,
        ...(planner ? { planner } : {}),
        consumeSteering,
        ...watchdogRunOptions,
      });
    },
    logger,
  });
  const groupModelRoutes = new GroupModelRouteService({
    store: groupModelRouteStore,
    onChange: (conversationId) => groupModelRouting.invalidate(conversationId),
  });

  const createRuntimeRegistry = (
    harness: AgentHarness,
    personaRef: PersonaInput,
  ): AgentRuntimeRegistry =>
    new AgentRuntimeRegistry({
      roleModelRefs,
      createChatModel,
      defaultEngine: engine,
      investigationEngine,
      workerRegistry,
      workerRuntimes,
      routedEngines,
      groupModelRouting,
      harness,
      personaRef,
      buildWorkerPolicy: (_worker, basePolicy: DynamicLoopPolicy) => basePolicy,
    });

  return {
    roleModelRefs,
    defaultModelRef,
    chatModel,
    adminModel,
    proactiveModel,
    engine,
    investigationEngine,
    workerRegistry,
    workerRuntimes,
    routedEngines,
    routingEngine,
    groupModelRouting,
    groupModelRoutes,
    createRuntimeRegistry,
  };
}
