import type { MetricsRegistry } from '../admin-api/metrics.js';
import { parseModelPricing } from '../billing/ModelPricing.js';
import { UsageGuard } from '../billing/UsageGuard.js';
import type { BackgroundUsageRecorder } from '../billing/backgroundUsage.js';
import {
  BystanderPolicyProvider,
} from '../bystander/BystanderPolicyProvider.js';
import {
  BystanderTriageEngine,
  LlmBystanderClassifier,
} from '../bystander/BystanderTriageEngine.js';
import { CooldownLimiter } from '../bystander/CooldownLimiter.js';
import { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import type { GroupTranscriptArchive } from '../bystander/GroupTranscriptArchive.js';
import { ClusterStateSync } from '../cluster/ClusterStateSync.js';
import type { SharedStateStore } from '../cluster/SharedStateStore.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { Database } from '../db/client.js';
import {
  DrizzleGroupWorkspaceStore,
} from '../db/groupSchema.js';
import { DrizzleMemoryStore } from '../db/memorySchema.js';
import {
  DrizzlePersonIdentityStore,
  DrizzlePersonaProfileStore,
} from '../db/personSchema.js';
import {
  DrizzlePersonMemoryConsentStore,
  DrizzlePersonPreferencesStore,
} from '../db/personSettingsSchema.js';
import type { DrizzleScheduledTaskStore } from '../db/schedulerSchema.js';
import { DrizzleUsageLedgerStore } from '../db/usageSchema.js';
import { GroupNotifyAllService } from '../groups/GroupNotifyAllService.js';
import { GroupReportService } from '../groups/GroupReportService.js';
import { GroupWorkspaceService } from '../groups/GroupWorkspaceService.js';
import {
  AgentHarness,
  type HarnessLogger,
} from '../harness/AgentHarness.js';
import { PersonIdentityService } from '../identity/PersonIdentityService.js';
import { ContextAssembler, type PersonaInput } from '../memory/ContextAssembler.js';
import { DrizzleConversationRepository } from '../memory/ConversationRepository.js';
import {
  HierarchicalMemoryManager,
  LlmEpisodeSummarizer,
  LlmSemanticFactExtractor,
} from '../memory/HierarchicalMemoryManager.js';
import type { OpenAIEmbeddingClient } from '../memory/EmbeddingClient.js';
import { PersonalMemoryService } from '../personal/PersonalMemoryService.js';
import { PersonSettingsService } from '../personal/PersonSettingsService.js';
import { PersonaResolver } from '../persona/PersonaResolver.js';
import { GroupWorkspaceToolProvider } from '../tools/groups/GroupWorkspaceToolProvider.js';
import { GroupQaModeToolProvider } from '../tools/groups/GroupQaModeToolProvider.js';
import { PersonalMemoryToolProvider } from '../tools/personal/PersonalMemoryToolProvider.js';
import { PersonSettingsToolProvider } from '../tools/personal/PersonSettingsToolProvider.js';
import type { TestcaseWorkspaceService } from '../testcase/TestcaseWorkspaceService.js';
import {
  isTestcaseWritingIntent,
  resolveTestcaseRunBudget,
  testcaseRunPolicy,
} from '../testcase/TestcaseRunBudget.js';
import { groupMemberSubjectKey } from '../types/bystander-and-memory.js';
import type { IToolProvider } from '../types/core.js';
import type { GlossaryService } from '../glossary/GlossaryService.js';
import type { GlossaryCandidateService } from '../glossary/GlossaryCandidateService.js';
import type { AgentRuntimesContext } from './agentRuntimes.js';
import type { WorkspaceAndExtensionsContext } from './workspaceAndExtensions.js';
import { envCount, envEnabled, envSeconds, errorText } from './envHelpers.js';

export interface MemoryAndBystanderDeps {
  db: Database;
  configCenter: DynamicConfigCenter;
  sharedState?: SharedStateStore;
  harnessLogger: HarnessLogger;
  metrics: MetricsRegistry;
  embeddingClient?: OpenAIEmbeddingClient;
  scheduledStore: DrizzleScheduledTaskStore;
  glossary: GlossaryService;
  glossaryCandidates?: GlossaryCandidateService;
  groupTranscriptArchive: GroupTranscriptArchive;
  transcriptArchiveEnabled: boolean;
  toolProviders: IToolProvider[];
  runtimes: AgentRuntimesContext;
  extensions: WorkspaceAndExtensionsContext;
  testcaseWorkspaces: TestcaseWorkspaceService;
}

export interface MemoryAndBystanderContext {
  memoryStore: DrizzleMemoryStore;
  personIdentityStore: DrizzlePersonIdentityStore;
  personaProfileStore: DrizzlePersonaProfileStore;
  usageLedger: DrizzleUsageLedgerStore;
  clusterSync?: ClusterStateSync;
  cooldown: CooldownLimiter;
  transcriptBuffer: GroupTranscriptBuffer;
  policyProvider: BystanderPolicyProvider;
  triage: BystanderTriageEngine;
  personaRef: PersonaInput;
  personaResolver: PersonaResolver;
  personSettings: PersonSettingsService;
  personIdentity: PersonIdentityService;
  groupWorkspace: GroupWorkspaceService;
  personalMemory: PersonalMemoryService;
  groupReport: GroupReportService;
  groupNotifyAll: GroupNotifyAllService;
  repository: DrizzleConversationRepository;
  harness: AgentHarness;
}

/** 初始化分级记忆、人设/身份解析、群协作、旁听漏斗与 AgentHarness */
export async function setupMemoryAndBystander(
  deps: MemoryAndBystanderDeps,
): Promise<MemoryAndBystanderContext> {
  const {
    db,
    configCenter,
    sharedState,
    harnessLogger: logger,
    metrics,
    embeddingClient,
    scheduledStore,
    glossary,
    glossaryCandidates,
    groupTranscriptArchive,
    transcriptArchiveEnabled,
    toolProviders,
    runtimes,
    extensions,
    testcaseWorkspaces,
  } = deps;
  const memoryConfig = configCenter.getMemoryConfig();
  const bystanderConfig = configCenter.getBystanderConfig();

  const memoryStore = new DrizzleMemoryStore(db);
  const personIdentityStore = new DrizzlePersonIdentityStore(db);
  const personaProfileStore = new DrizzlePersonaProfileStore(db);
  const usageLedger = new DrizzleUsageLedgerStore(db);
  const modelPricing = parseModelPricing(process.env.MODEL_PRICING_JSON);
  const usageGuard = new UsageGuard({
    ledger: usageLedger,
    policy: () => configCenter.getUsagePolicy(),
    ...(modelPricing.configured ? { pricing: modelPricing } : {}),
    onRecordFailure: (error) => {
      metrics.inc('agent_usage_record_failures_total');
      logger.warn(
        { error: errorText(error) },
        'failed to record token usage after retries',
      );
    },
  });

  // 后台维护类 LLM 调用（旁听判官 / 记忆压缩 / 语义抽取）也入账，
  // 复用 UsageGuard 的定价、重试与失败告警；proactive=true 与主动回复同口径。
  const recordBackgroundUsage: BackgroundUsageRecorder = async (record) => {
    await usageGuard.record({
      conversationId: record.conversationId,
      conversationType: record.conversationType,
      senderStaffId: record.senderStaffId,
      senderNick: record.senderNick,
      model: record.model,
      totalTokens: record.totalTokens,
      ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens } : {}),
      ...(record.outputTokens !== undefined ? { outputTokens: record.outputTokens } : {}),
      ...(record.cachedTokens !== undefined ? { cachedTokens: record.cachedTokens } : {}),
      steps: 1,
      durationMs: record.durationMs,
      proactive: true,
      jobKind: record.worker,
      worker: record.worker,
    });
  };

  let clusterSync: ClusterStateSync | undefined;
  const scheduleSharedPersist = (conversationId: string): void => {
    clusterSync?.schedulePersist(conversationId);
  };
  const cooldown = new CooldownLimiter(
    sharedState ? { onChange: scheduleSharedPersist } : {},
  );
  const transcriptBuffer = new GroupTranscriptBuffer({
    defaultWindowSize: bystanderConfig.slidingWindowSize,
    ...(sharedState ? { onChange: scheduleSharedPersist } : {}),
    ...(transcriptArchiveEnabled
      ? {
          onAppend: (entry) => {
            void groupTranscriptArchive.append(entry).catch((error) => {
              logger.warn(
                {
                  conversationId: entry.conversationId,
                  error: errorText(error),
                },
                'failed to archive group transcript',
              );
            });
          },
        }
      : {}),
  });
  if (sharedState) {
    clusterSync = new ClusterStateSync({
      store: sharedState,
      buffer: transcriptBuffer,
      cooldown,
      logger,
    });
    await clusterSync.hydrate();
    logger.info({}, 'shared cluster state hydrated');
  }

  const policyProvider = new BystanderPolicyProvider({
    defaults: configCenter.getBystanderConfig(),
    store: memoryStore,
    logger,
  });
  const triage = new BystanderTriageEngine({
    buffer: transcriptBuffer,
    cooldown,
    classifier: new LlmBystanderClassifier({
      model: runtimes.proactiveModel,
      temperature: 0,
      logger,
      onUsage: recordBackgroundUsage,
    }),
    debounceMs: bystanderConfig.debounceMs,
    logger,
  });
  const hierarchicalMemory = new HierarchicalMemoryManager({
    summaryStore: memoryStore,
    semanticStore: memoryStore,
    summarizer: new LlmEpisodeSummarizer({
      model: runtimes.proactiveModel,
      onUsage: recordBackgroundUsage,
    }),
    extractor: new LlmSemanticFactExtractor({
      model: runtimes.proactiveModel,
      onUsage: recordBackgroundUsage,
    }),
    compressionThresholdTokens: memoryConfig.compressionThresholdTokens,
    compressionRatio: memoryConfig.compressionRatio,
    semanticLimit: memoryConfig.semanticLimit,
    ...(embeddingClient ? { embedding: embeddingClient } : {}),
    ...(glossaryCandidates
      ? {
          terminologyPromotionThreshold: envCount(
            process.env.MEMORY_TERMINOLOGY_PROMOTION_THRESHOLD,
            3,
          ),
          onTerminologyCandidate: async (candidate) => {
            await glossaryCandidates.submit({
              standardName: candidate.standardName,
              aliases: candidate.aliases,
              definition: candidate.definition,
              sourceConversationId: candidate.sourceConversationId,
              evidence: candidate.evidence,
              submittedBy: 'semantic_memory_auto_promote',
            });
            metrics.inc('glossary_candidates_auto_promoted_total');
          },
        }
      : {}),
    logger,
  });

  const personaRef: PersonaInput = { ...configCenter.getLLMConfig().persona };
  const personaResolver = new PersonaResolver({
    store: personaProfileStore,
    fallback: () => personaRef,
  });
  const personSettings = new PersonSettingsService({
    preferences: new DrizzlePersonPreferencesStore(db),
    consents: new DrizzlePersonMemoryConsentStore(db),
  });
  const personIdentity = new PersonIdentityService({
    store: personIdentityStore,
    memories: memoryStore,
    personas: personaProfileStore,
    settings: personSettings,
    logger,
    onBind: () => personaResolver.invalidate(),
  });
  const groupWorkspace = new GroupWorkspaceService({
    store: new DrizzleGroupWorkspaceStore(db),
    isAdmin: (staffId) => configCenter.isAdmin(staffId),
    memories: memoryStore,
    saveNote: async (note) => {
      await hierarchicalMemory.remember([
        {
          scope: 'group',
          subjectKey: note.conversationId,
          kind: 'terminology',
          content: note.content,
          keywords: note.keywords,
          shareableInGroup: true,
          sensitivity: 'normal',
          confidence: 0.95,
          sourceConversationId: note.conversationId,
          sourceConversationType: '2',
          sourceMessageId: note.sourceMessageId ?? null,
        },
      ]);
    },
    saveMemberNote: async (note) => {
      await hierarchicalMemory.remember([
        {
          scope: 'group_member',
          subjectKey: groupMemberSubjectKey(
            note.conversationId,
            note.personKey,
          ),
          kind: 'profile',
          content: note.content,
          keywords: note.keywords,
          shareableInGroup: true,
          sensitivity: 'normal',
          confidence: 0.95,
          sourceConversationId: note.conversationId,
          sourceConversationType: '2',
          sourceMessageId: note.sourceMessageId ?? null,
        },
      ]);
    },
  });
  const personalMemory = new PersonalMemoryService({
    memories: memoryStore,
    remember: async (input) => {
      await hierarchicalMemory.remember([
        {
          scope: 'user',
          subjectKey: input.personKey,
          kind: 'profile',
          content: input.content,
          shareableInGroup: input.shareableInGroup,
          sensitivity: input.shareableInGroup ? 'normal' : 'private',
          confidence: 0.95,
          sourceConversationId: input.conversationId,
          sourceConversationType: '1',
          sourceMessageId: input.messageId ?? null,
        },
      ]);
    },
  });
  const groupReport = new GroupReportService({
    store: scheduledStore,
    isAdmin: (staffId) => configCenter.isAdmin(staffId),
    buildDigest: (conversationId) => groupWorkspace.buildDigest(conversationId),
  });
  const groupNotifyAll = new GroupNotifyAllService({
    isAdmin: (staffId) => configCenter.isAdmin(staffId),
    enabled: envEnabled(process.env.GROUP_NOTIFY_ALL_ENABLED, false),
    cooldownSeconds: envSeconds(
      process.env.GROUP_NOTIFY_ALL_COOLDOWN_SECONDS,
      60,
    ),
    dailyQuota: envCount(process.env.GROUP_NOTIFY_ALL_DAILY_QUOTA, 10),
    ...(sharedState ? { sharedState } : {}),
    audit: async (record) => {
      metrics.inc('group_notify_all_total', { result: record.result });
      await configCenter.recordAudit({
        adminStaffId: record.actorStaffId,
        adminNick: record.actorNick,
        actionType: 'GROUP_NOTIFY_ALL',
        beforeSnapshot: {},
        afterSnapshot: {
          conversationId: record.conversationId,
          text:
            record.text.length > 500
              ? `${record.text.slice(0, 500)}…`
              : record.text,
          result: record.result,
          ...(record.channel ? { channel: record.channel } : {}),
          ...(record.error ? { error: record.error } : {}),
        },
      });
    },
    logger,
  });

  toolProviders.push(
    new GroupWorkspaceToolProvider({
      service: groupWorkspace,
      reports: groupReport,
      notifyAll: groupNotifyAll,
    }),
    new GroupQaModeToolProvider({ policies: configCenter }),
    new PersonSettingsToolProvider({ service: personSettings }),
    new PersonalMemoryToolProvider({ service: personalMemory }),
  );

  const repository = new DrizzleConversationRepository(db);
  const testcaseBudget = resolveTestcaseRunBudget(process.env);
  const harness = new AgentHarness({
    engine: runtimes.groupModelRouting,
    investigationEngine: runtimes.investigationEngine,
    workerRuntimes: runtimes.workerRuntimes,
    repository,
    assembler: new ContextAssembler({
      windowMessages: memoryConfig.windowMessages,
    }),
    persona: personaRef,
    personas: personaResolver,
    identity: personIdentity,
    policy: configCenter.getLoopPolicy(),
    windowMessages: memoryConfig.windowMessages,
    singleWindowMessages: memoryConfig.singleWindowMessages,
    logger,
    memory: hierarchicalMemory,
    glossary,
    resolveTestcaseWorkspace: async ({ message, requestedWorkspace }) => {
      const actor = {
        senderStaffId: message.senderStaffId,
        conversationId: message.conversationId,
        conversationType: message.conversationType,
        isAdmin: configCenter.isAdmin(message.senderStaffId),
      };
      return requestedWorkspace
        ? testcaseWorkspaces.restoreSnapshot(
            actor,
            requestedWorkspace.workspaceId,
            requestedWorkspace.baseRevision,
          )
        : testcaseWorkspaces.snapshot(actor);
    },
    resolveRunPolicy: ({ text, explicitWorkspace }) => {
      if (!testcaseBudget.enabled) return undefined;
      if (!explicitWorkspace && !isTestcaseWritingIntent(text)) return undefined;
      return testcaseRunPolicy(configCenter.getLoopPolicy(), testcaseBudget);
    },
    personSettings: {
      buildPrompt: (personKey, conversationType) =>
        personSettings.buildPrompt(personKey, conversationType),
      resolveGroupMode: (personKey, conversationId) =>
        personSettings.resolveGroupMode(personKey, conversationId),
    },
    extensions: {
      build: async ({ message, text, testcaseWorkspace }) => {
        const config = configCenter.getExtensionsConfig();
        const isAdmin = configCenter.isAdmin(message.senderStaffId);
        const sections: string[] = [];
        if (testcaseWorkspace) {
          sections.push(
            testcaseWorkspaces.buildPromptSummary(testcaseWorkspace.workspace),
          );
        }
        if (message.conversationType === '2') {
          try {
            const brief = await groupWorkspace.buildBrief(
              message.conversationId,
            );
            if (brief) sections.push(brief);
          } catch (error) {
            logger.warn(
              {
                conversationId: message.conversationId,
                error: errorText(error),
              },
              'failed to build group workspace brief, continuing without it',
            );
          }
        }
        let projectId: string | undefined;
        if (config.projectsEnabled) {
          try {
            const brief = await extensions.projects.buildBrief({
              senderStaffId: message.senderStaffId,
              isAdmin,
              conversationType: message.conversationType,
              text,
              maxChars: config.projectBriefMaxChars,
            });
            if (brief) {
              sections.push(brief.text);
              projectId = brief.projectId;
            }
          } catch (error) {
            logger.warn(
              {
                conversationId: message.conversationId,
                error: errorText(error),
              },
              'failed to build project brief, continuing without it',
            );
          }
        }
        if (config.skillsEnabled) {
          try {
            const catalog = extensions.skills.buildCatalog({
              query: text,
              conversationType: message.conversationType,
              isAdmin,
              limit: config.skillCatalogLimit,
              ...(projectId ? { projectId } : {}),
            });
            if (catalog.prompt) sections.push(catalog.prompt);
          } catch (error) {
            logger.warn(
              {
                conversationId: message.conversationId,
                error: errorText(error),
              },
              'failed to build skill catalog, continuing without it',
            );
          }
        }
        return sections.length > 0 ? sections.join('\n\n') : undefined;
      },
    },
    usageGuard,
    bystander: {
      buffer: transcriptBuffer,
      triage,
      policyProvider: (conversationId) =>
        policyProvider.getPolicy(conversationId),
    },
  });

  return {
    memoryStore,
    personIdentityStore,
    personaProfileStore,
    usageLedger,
    ...(clusterSync ? { clusterSync } : {}),
    cooldown,
    transcriptBuffer,
    policyProvider,
    triage,
    personaRef,
    personaResolver,
    personSettings,
    personIdentity,
    groupWorkspace,
    personalMemory,
    groupReport,
    groupNotifyAll,
    repository,
    harness,
  };
}
