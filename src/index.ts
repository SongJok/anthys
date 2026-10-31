import 'dotenv/config';
import { resolve } from 'node:path';
import { DWClient } from 'dingtalk-stream';
import { EnvConfigProvider } from './config/EnvConfigProvider.js';
import type { IConfigProvider } from './config/IConfigProvider.js';
import { DynamicConfigCenter } from './config/DynamicConfigCenter.js';
import { createDatabase } from './db/client.js';
import { seedAgentConfigs, loadLLMOverrides, applyLLMOverrides } from './db/seed.js';
import {
  DrizzleAdminAuditStore,
  DrizzleConfigStore,
  DrizzleFeedbackStore,
  DrizzleGroupDirectory,
  DrizzleGroupPolicyStore,
  DrizzleReActTraceStore,
  type StoredDingTalkConfig,
} from './db/configSchema.js';
import {
  CardStreamer,
  OpenApiCardApi,
  type CardLogger,
} from './dingtalk/CardStreamer.js';
import { StreamGateway, type StreamGatewayLogger } from './dingtalk/StreamGateway.js';
import {
  EmotionReplier,
  OpenApiRobotEmotionApi,
} from './dingtalk/EmotionReplier.js';
import { replyMention, webhookMention } from './dingtalk/Mentions.js';
import { sendTextFallback } from './dingtalk/TextFallback.js';
import { DingTalkMediaSender } from './dingtalk/MediaSender.js';
import { DingTalkAdminTextSender } from './dingtalk/AdminTextSender.js';
import { formatDwsPermissionNotice } from './tools/dws/DwsPermissionNotice.js';
import { AttachmentStore } from './multimodal/AttachmentStore.js';
import { enrichInboundMessage } from './multimodal/MessageEnricher.js';
import { OpenAiVisionDescriber } from './multimodal/VisionDescriber.js';
import { ArtifactToolProvider } from './tools/artifacts/ArtifactToolProvider.js';
import type { CardActionEvent } from './dingtalk/CardActions.js';
import {
  AgentHarness,
  conversationKeyFor,
  conversationTitleFor,
  type HarnessLogger,
} from './harness/AgentHarness.js';
import { RunControlRegistry } from './harness/RunControlRegistry.js';
import {
  createToolApprovalGate,
  PendingActionStore,
} from './harness/ToolApprovalGate.js';
import { ModelRoutingEngine } from './harness/ModelRoutingEngine.js';
import { UsageGuard } from './billing/UsageGuard.js';
import { DrizzleUsageLedgerStore } from './db/usageSchema.js';
import { DrizzleScheduledTaskStore } from './db/schedulerSchema.js';
import {
  ScheduledTaskScheduler,
  computeNextRun,
} from './scheduler/ScheduledTaskScheduler.js';
import { CommandRouter, parseCommand } from './commands/CommandRouter.js';
import { ToolRegistry, loadMcpServerConfigs } from './harness/ToolRegistry.js';
import { GroupTranscriptBuffer } from './bystander/GroupTranscriptBuffer.js';
import { CooldownLimiter } from './bystander/CooldownLimiter.js';
import { DwsGroupMessageListener } from './bystander/DwsGroupMessageListener.js';
import { BystanderPolicyProvider } from './bystander/BystanderPolicyProvider.js';
import {
  BystanderTriageEngine,
  LlmBystanderClassifier,
} from './bystander/BystanderTriageEngine.js';
import { ContextAssembler } from './memory/ContextAssembler.js';
import { DrizzleConversationRepository } from './memory/ConversationRepository.js';
import {
  HierarchicalMemoryManager,
  LlmEpisodeSummarizer,
  LlmSemanticFactExtractor,
} from './memory/HierarchicalMemoryManager.js';
import { DrizzleMemoryStore } from './db/memorySchema.js';
import { DrizzleGlossaryStore } from './db/glossarySchema.js';
import { GlossaryService } from './glossary/GlossaryService.js';
import { GlossaryToolProvider } from './tools/glossary/GlossaryToolProvider.js';
import { WebSearchClient } from './tools/web/WebSearchClient.js';
import { WebSearchToolProvider } from './tools/web/WebSearchToolProvider.js';
import { OpenAIEmbeddingClient } from './memory/EmbeddingClient.js';
import { createChatModel } from './react/createChatModel.js';
import { ReActRunner } from './react/ReActRunner.js';
import { createPlanner } from './react/Planner.js';
import { SubagentToolProvider } from './react/SubagentToolProvider.js';
import { ClusterStateSync } from './cluster/ClusterStateSync.js';
import { PgAdvisoryLeadership } from './cluster/LeadershipLock.js';
import {
  PgSharedStateStore,
  type SharedStateStore,
} from './cluster/SharedStateStore.js';
import { AdminChatOpsToolProvider } from './tools/admin/AdminChatOpsToolProvider.js';
import { DwsAuthManager } from './tools/dws/DwsAuthManager.js';
import { TraceCollector, createMcpAdminPort } from './admin-api/runtime.js';
import { startAdminServer } from './admin-api/server.js';
import { MetricsRegistry } from './admin-api/metrics.js';
import { createRedactingLogger } from './governance/logger.js';
import { redactTraceRecord } from './governance/redaction.js';
import {
  DataRetentionService,
  resolveRetentionPolicy,
} from './governance/DataRetention.js';
import {
  PgRetentionStore,
  loadGovernanceSetting,
  saveGovernanceSetting,
} from './db/governanceSchema.js';
import type { ConsoleChatHandler } from './admin-api/chatStream.js';
import type {
  AgentStreamEvent,
  ChatModel,
  ExecutionContext,
  InboundMessage,
  LLMAndPersonaConfig,
  RunResult,
} from './types/core.js';
import type {
  LlmSandboxTestResult,
  McpServerTestResult,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
} from './types/admin-and-console.js';
import type { BystanderEvaluationResult } from './types/bystander-and-memory.js';
import type { EnterpriseMcpServerConfig } from './types/mcp-and-sandbox.js';

const FALLBACK_ERROR_TEXT = '抱歉，处理这条消息时出现异常，请稍后重试。';
const EMPTY_RESULT: RunResult = {
  answer: '',
  reasoning: '',
  usage: { totalTokens: 0, steps: 0, durationMs: 0 },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/** DINGTALK_ADMIN 与 ADMIN_STAFF_IDS 等价，合并去重后作为初始管理员 */
function parseAdminIds(...raw: (string | undefined)[]): string[] {
  const ids: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    for (const item of value.split(',')) {
      const id = item.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function envEnabled(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function envMegabytes(raw: string | undefined, fallbackMb: number): number {
  const mb = Number(raw);
  return (Number.isFinite(mb) && mb > 0 ? mb : fallbackMb) * 1024 * 1024;
}

function envSeconds(raw: string | undefined, fallbackSeconds: number): number {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
}

function envCount(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function runWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} 超时（>${Math.round(timeoutMs / 1000)}s）`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 卡片不可用时的文本兜底：按长度分片发送并逐片重试，
 * 避免长答案被钉钉 markdown 长度上限截断或整体丢失。
 */
async function sendSessionWebhook(
  message: InboundMessage,
  text: string,
  logger: CardLogger,
  options: { mention?: boolean } = {},
): Promise<void> {
  const webhook = message.rawPayload.sessionWebhook;
  if (typeof webhook !== 'string' || !webhook) {
    logger.warn(
      { messageId: message.messageId },
      'no sessionWebhook available for text fallback',
    );
    return;
  }
  const at = options.mention
    ? webhookMention(message)
    : { text: '', atUserIds: [] };
  const result = await sendTextFallback({
    webhook,
    text: `${at.text}${text}`,
    ...(at.atUserIds.length > 0 ? { atUserIds: at.atUserIds } : {}),
    logger,
  });
  if (result.ok) {
    logger.info?.(
      { messageId: message.messageId, chunks: result.chunks },
      'text fallback delivered',
    );
    return;
  }
  logger.warn(
    {
      messageId: message.messageId,
      chunks: result.chunks,
      error: result.error,
    },
    'text fallback partially failed',
  );
}

async function main(): Promise<void> {
  const baseConfig = new EnvConfigProvider();
  try {
    baseConfig.assertReady();
  } catch (error) {
    console.error(
      `配置校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const redactionEnabled = envEnabled(process.env.DATA_REDACTION_ENABLED, true);
  const logger = createRedactingLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: redactionEnabled,
  });
  const harnessLogger: HarnessLogger = {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
  const gatewayLogger: StreamGatewayLogger = harnessLogger;
  const cardLogger: CardLogger = harnessLogger;

  const dbHandle = createDatabase(baseConfig.getDatabaseUrl());
  let toolRegistry: ToolRegistry | undefined;
  let gateway: StreamGateway | undefined;
  let bystanderListener: DwsGroupMessageListener | undefined;
  let bystanderListenTimer: ReturnType<typeof setInterval> | undefined;
  let leadership: PgAdvisoryLeadership | undefined;
  let adminServer: ReturnType<typeof startAdminServer> | undefined;
  let retentionService: DataRetentionService | undefined;
  let dwsAuth: DwsAuthManager | undefined;
  let streamConnected = false;

  try {
    const baseLLM = baseConfig.getLLMConfig();
    await seedAgentConfigs(dbHandle.db, baseLLM);
    const seededLLM = applyLLMOverrides(
      baseLLM,
      await loadLLMOverrides(dbHandle.db),
    );
    const defaults: IConfigProvider = {
      getLLMConfig: () => seededLLM,
      getLoopPolicy: () => baseConfig.getLoopPolicy(),
      getDingTalkConfig: () => baseConfig.getDingTalkConfig(),
      getMemoryConfig: () => baseConfig.getMemoryConfig(),
      getBystanderConfig: () => baseConfig.getBystanderConfig(),
      getVisionConfig: () => baseConfig.getVisionConfig(),
      getWebSearchConfig: () => baseConfig.getWebSearchConfig(),
      getDatabaseUrl: () => baseConfig.getDatabaseUrl(),
      assertReady: () => baseConfig.assertReady(),
    };
    const memoryConfig = baseConfig.getMemoryConfig();
    const bystanderConfig = baseConfig.getBystanderConfig();

    const initialMcpServers: EnterpriseMcpServerConfig[] =
      await loadMcpServerConfigs(
        process.env.MCP_SERVERS_CONFIG ??
          resolve(process.cwd(), 'config/mcp-servers.json'),
      );

    const configCenter = await new DynamicConfigCenter({
      defaults,
      store: new DrizzleConfigStore(dbHandle.db),
      groupPolicies: new DrizzleGroupPolicyStore(dbHandle.db),
      auditStore: new DrizzleAdminAuditStore(dbHandle.db),
      initialMcpServers,
      initialAdminStaffIds: parseAdminIds(
        process.env.DINGTALK_ADMIN,
        process.env.ADMIN_STAFF_IDS,
      ),
      logger: harnessLogger,
      now: Date.now,
    }).init();
    configCenter.assertReady();

    const traceStore = new DrizzleReActTraceStore(dbHandle.db);
    const feedbackStore = new DrizzleFeedbackStore(dbHandle.db);
    const groupDirectory = new DrizzleGroupDirectory(dbHandle.db);
    const runControl = new RunControlRegistry();
    const metrics = new MetricsRegistry();

    const clusterEnabled = envEnabled(process.env.CLUSTER_ENABLED, false);
    const sharedState: SharedStateStore | undefined = clusterEnabled
      ? new PgSharedStateStore({
          query: async <T>(text: string, values?: unknown[]) => {
            const result = await dbHandle.pool.query(
              text,
              values as unknown[],
            );
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
        })
      : undefined;
    let activeClient: DWClient | undefined;
    let cachedToken: { value: string; expiresAt: number } | null = null;
    const getAccessToken = async (): Promise<string> => {
      if (!activeClient) throw new Error('钉钉 Stream 客户端尚未就绪');
      if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.value;
      }
      const value = String(await activeClient.getAccessToken());
      cachedToken = { value, expiresAt: Date.now() + 30 * 60_000 };
      return value;
    };
    const mcpPort = createMcpAdminPort(
      () => toolRegistry?.pool ?? null,
      harnessLogger,
    );
    const pendingActions = new PendingActionStore({
      ttlMs:
        Math.max(30, Number(process.env.TOOL_CONFIRMATION_TTL_SECONDS ?? 300)) *
        1000,
    });
    const resolveToolApproval = createToolApprovalGate({
      store: pendingActions,
      enabled: envEnabled(process.env.TOOL_CONFIRMATION_ENABLED, true),
      logger: harnessLogger,
    });

    const adminProvider = new AdminChatOpsToolProvider({
      configCenter,
      mcp: mcpPort,
      traces: traceStore,
      groups: groupDirectory,
      logger: harnessLogger,
    });

    const artifactDeliveryEnabled = envEnabled(
      process.env.ARTIFACT_DELIVERY_ENABLED,
      true,
    );
    const artifactMaxBytes = envMegabytes(process.env.ARTIFACT_MAX_MB, 20);
    const mediaSender = new DingTalkMediaSender({
      robotCode: () => configCenter.getDingTalkConfig().robotCode,
      getAccessToken,
      logger: harnessLogger,
      maxBytes: artifactMaxBytes,
    });
    const adminTextSender = new DingTalkAdminTextSender({
      robotCode: () => configCenter.getDingTalkConfig().robotCode,
      getAccessToken,
      logger: harnessLogger,
    });

    const authManager = new DwsAuthManager({
      binary: process.env.DWS_BINARY?.trim() || 'dws',
      logger: harnessLogger,
    });
    dwsAuth = authManager;

    const embeddingConfig = configCenter.getEmbeddingConfig();
    const embeddingClient =
      embeddingConfig?.enabled && embeddingConfig.apiKey
        ? new OpenAIEmbeddingClient({
            baseUrl: embeddingConfig.baseUrl,
            apiKey: embeddingConfig.apiKey,
            model: embeddingConfig.model,
            dimensions: embeddingConfig.dimensions,
          })
        : undefined;
    if (embeddingClient) {
      logger.info(
        { model: embeddingConfig?.model, dimensions: embeddingClient.dimensions },
        'semantic memory embedding enabled',
      );
    }

    const glossary = new GlossaryService({
      store: new DrizzleGlossaryStore(dbHandle.db),
      ...(embeddingClient ? { embedding: embeddingClient } : {}),
      logger: harnessLogger,
      promptEnabled: envEnabled(process.env.GLOSSARY_PROMPT_ENABLED, true),
      promptLimit: envCount(process.env.GLOSSARY_PROMPT_LIMIT, 80),
      retrievalLimit: envCount(process.env.GLOSSARY_RETRIEVAL_LIMIT, 4),
    });

    const webSearchConfig = configCenter.getWebSearchConfig?.();
    const webSearchProvider =
      webSearchConfig && webSearchConfig.apiKey
        ? new WebSearchToolProvider({
            client: new WebSearchClient({
              baseUrl: webSearchConfig.baseUrl,
              apiKey: webSearchConfig.apiKey,
              engine: webSearchConfig.engine,
              count: webSearchConfig.count,
              contentSize: webSearchConfig.contentSize,
              timeoutMs: webSearchConfig.timeoutMs,
              redactOutbound: webSearchConfig.redactOutbound,
            }),
            enabled: () =>
              configCenter.getWebSearchConfig?.()?.enabled ?? false,
            logger: harnessLogger,
          })
        : undefined;
    if (webSearchConfig?.enabled && !webSearchConfig.apiKey) {
      logger.warn(
        {},
        'WEB_SEARCH_ENABLED 已开启但缺少 API Key，web_search 工具不会挂载',
      );
    }
    logger.info(
      {
        enabled: webSearchConfig?.enabled ?? false,
        ready: Boolean(webSearchProvider),
        engine: webSearchConfig?.engine,
        count: webSearchConfig?.count,
        apiKeyConfigured: Boolean(webSearchConfig?.apiKey),
      },
      'web search configuration resolved',
    );

    toolRegistry = await ToolRegistry.create({
      mcpServers: configCenter.getMcpServers(),
      enableDws: configCenter.getSystemConfig().dingtalk.dwsCliEnabled,
      dwsAuth: authManager,
      dwsIsAdmin: (staffId) => configCenter.isAdmin(staffId),
      dwsPermissionNotifier: async (notice) => {
        const admins = configCenter
          .getSystemConfig()
          .dingtalk.adminStaffIds.filter(
            (staffId) =>
              staffId.trim() !== '' && staffId !== notice.senderStaffId,
          );
        if (admins.length === 0) {
          // 提问人本身是管理员时，答案会直接展示给他，无需重复私聊
          return configCenter.isAdmin(notice.senderStaffId);
        }
        const result = await adminTextSender.send(
          admins,
          formatDwsPermissionNotice(notice),
        );
        if (!result.ok) {
          logger.warn(
            {
              conversationId: notice.conversationId,
              domain: notice.domain,
              failed: result.failed.length,
            },
            'dws permission notice delivery failed',
          );
        }
        return result.ok;
      },
      ...(process.env.DWS_BINARY?.trim()
        ? { dwsBinary: process.env.DWS_BINARY.trim() }
        : {}),
      ...(webSearchProvider ? { webSearchProvider } : {}),
      adminProvider,
      glossaryProvider: new GlossaryToolProvider({
        service: glossary,
        logger: harnessLogger,
      }),
      ...(artifactDeliveryEnabled
        ? {
            artifactProvider: (workspace) => {
              const extraRoots = (process.env.ARTIFACT_ROOTS ?? '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
                .map((item) => resolve(process.cwd(), item));
              return new ArtifactToolProvider({
                sender: mediaSender,
                allowedRoots: [workspace.hostDir, ...extraRoots],
                maxBytes: artifactMaxBytes,
              });
            },
          }
        : {}),
      toolAccess: {
        policies: () => configCenter.getMcpAccessPolicies(),
        isAdmin: (staffId) => configCenter.isAdmin(staffId),
      },
      logger: harnessLogger,
    });
    logger.info(
      {
        providers: toolRegistry.providers.map((provider) => provider.providerName),
        mcpServers:
          toolRegistry.pool?.listEnabledServers().map((server) => server.id) ?? [],
        workspace: toolRegistry.workspace.hostDir,
      },
      'tool registry ready',
    );

    const toolProviders = toolRegistry.providers;
    const attachmentDir = resolve(toolRegistry.workspace.hostDir, 'attachments');
    const attachmentStore = new AttachmentStore({
      rootDir: attachmentDir,
      robotCode: () => configCenter.getDingTalkConfig().robotCode,
      getAccessToken,
      logger: harnessLogger,
      maxBytes: envMegabytes(process.env.ATTACHMENT_MAX_MB, 20),
    });
    retentionService = await new DataRetentionService({
      store: new PgRetentionStore(
        {
          query: async <T>(text: string, values?: unknown[]) => {
            const result = await dbHandle.pool.query(
              text,
              values as unknown[],
            );
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
        },
        {
          load: () => loadGovernanceSetting(dbHandle.db),
          save: (value) => saveGovernanceSetting(dbHandle.db, value),
        },
      ),
      policy: resolveRetentionPolicy(process.env),
      attachmentsDir: attachmentDir,
      logger: harnessLogger,
      canRun: () => !clusterEnabled || Boolean(leadership?.isLeader()),
      scheduledDryRun: envEnabled(process.env.DATA_CLEANUP_DRY_RUN, false),
    }).init();
    logger.info(
      { policy: retentionService.getPolicy(), redaction: redactionEnabled },
      'data governance ready',
    );
    const visionConfig = configCenter.getVisionConfig?.();
    const visionDescriber =
      visionConfig?.enabled && visionConfig.apiKey
        ? new OpenAiVisionDescriber({
            baseUrl: visionConfig.baseUrl,
            apiKey: visionConfig.apiKey,
            model: visionConfig.model,
            logger: harnessLogger,
          })
        : undefined;
    logger.info(
      {
        enabled: visionConfig?.enabled ?? false,
        ready: Boolean(visionDescriber),
        apiKeyConfigured: Boolean(visionConfig?.apiKey),
        model: visionConfig?.model,
      },
      'vision configuration resolved',
    );
    if (visionConfig?.enabled && !visionConfig.apiKey) {
      logger.warn(
        { model: visionConfig.model },
        'VISION_ENABLED 已开启但缺少 API Key，图片只落盘不识别',
      );
    }
    const modelRef: { current: ChatModel } = {
      current: createChatModel(configCenter.getLLMConfig()),
    };
    const chatModel: ChatModel = {
      get modelName() {
        return modelRef.current.modelName;
      },
      streamChat: (request, signal) =>
        modelRef.current.streamChat(request, signal),
    };

    const planner = createPlanner({
      model: chatModel,
      enabled: envEnabled(process.env.PLANNER_ENABLED, false),
      minQuestionChars: envCount(process.env.PLANNER_MIN_CHARS, 80),
      minTools: envCount(process.env.PLANNER_MIN_TOOLS, 8),
      logger: harnessLogger,
    });
    if (envEnabled(process.env.SUBAGENT_ENABLED, false)) {
      let subagent: SubagentToolProvider | undefined;
      subagent = new SubagentToolProvider({
        model: chatModel,
        providers: () => toolProviders.filter((provider) => provider !== subagent),
        policy: () => configCenter.getLoopPolicy(),
        timeoutMs:
          envSeconds(process.env.SUBAGENT_TIMEOUT_SECONDS, 90) * 1_000,
        maxTokens: envCount(process.env.SUBAGENT_MAX_TOKENS, 20_000),
        logger: harnessLogger,
      });
      toolProviders.push(subagent);
      logger.info({}, 'subagent delegation enabled');
    }

    const engine = new ReActRunner({
      model: chatModel,
      toolProviders,
      policy: configCenter.getLoopPolicy(),
      temperature: configCenter.getLLMConfig().temperature,
      enableNativeReasoning:
        configCenter.getLLMConfig().enableNativeReasoning,
      approval: resolveToolApproval,
      ...(planner ? { planner } : {}),
    });

    const routedEngines = new Map<string, ReActRunner>();
    const runnerForModel = (model: string): ReActRunner => {
      const cached = routedEngines.get(model);
      if (cached) return cached;
      const llm = configCenter.getLLMConfig();
      const runner = new ReActRunner({
        model: createChatModel({ ...llm, model }),
        toolProviders,
        policy: configCenter.getLoopPolicy(),
        temperature: llm.temperature,
        enableNativeReasoning: llm.enableNativeReasoning,
        approval: resolveToolApproval,
        ...(planner ? { planner } : {}),
      });
      routedEngines.set(model, runner);
      return runner;
    };
    const routingEngine = new ModelRoutingEngine({
      fallback: engine,
      engineForModel: runnerForModel,
      routing: () => configCenter.getModelRouting(),
      isAdmin: (staffId) => configCenter.isAdmin(staffId),
    });

    const memoryStore = new DrizzleMemoryStore(dbHandle.db);
    const usageLedger = new DrizzleUsageLedgerStore(dbHandle.db);
    const scheduledStore = new DrizzleScheduledTaskStore(dbHandle.db);
    const usageGuard = new UsageGuard({
      ledger: usageLedger,
      policy: () => configCenter.getUsagePolicy(),
    });
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
    });
    if (sharedState) {
      clusterSync = new ClusterStateSync({
        store: sharedState,
        buffer: transcriptBuffer,
        cooldown,
        logger: harnessLogger,
      });
      await clusterSync.hydrate();
      logger.info({}, 'shared cluster state hydrated');
    }
    const policyProvider = new BystanderPolicyProvider({
      defaults: configCenter.getBystanderConfig(),
      store: memoryStore,
      logger: harnessLogger,
    });
    const triage = new BystanderTriageEngine({
      buffer: transcriptBuffer,
      cooldown,
      classifier: new LlmBystanderClassifier({
        model: chatModel,
        temperature: 0,
        logger: harnessLogger,
      }),
      debounceMs: bystanderConfig.debounceMs,
      logger: harnessLogger,
    });
    const hierarchicalMemory = new HierarchicalMemoryManager({
      summaryStore: memoryStore,
      semanticStore: memoryStore,
      summarizer: new LlmEpisodeSummarizer({ model: chatModel }),
      extractor: new LlmSemanticFactExtractor({ model: chatModel }),
      compressionThresholdTokens: memoryConfig.compressionThresholdTokens,
      compressionRatio: memoryConfig.compressionRatio,
      semanticLimit: memoryConfig.semanticLimit,
      ...(embeddingClient ? { embedding: embeddingClient } : {}),
      logger: harnessLogger,
    });

    const personaRef = { ...configCenter.getLLMConfig().persona };
    const repository = new DrizzleConversationRepository(dbHandle.db);
    const harness = new AgentHarness({
      engine: routingEngine,
      repository,
      assembler: new ContextAssembler({
        windowMessages: memoryConfig.windowMessages,
      }),
      persona: personaRef,
      policy: configCenter.getLoopPolicy(),
      windowMessages: memoryConfig.windowMessages,
      logger: harnessLogger,
      memory: hierarchicalMemory,
      glossary,
      usageGuard,
      bystander: {
        buffer: transcriptBuffer,
        triage,
        policyProvider: (conversationId) =>
          policyProvider.getPolicy(conversationId),
      },
    });

    const cardApiRef: { current: OpenApiCardApi } = {
      current: new OpenApiCardApi({
        clientId: configCenter.getDingTalkConfig().clientId,
        clientSecret: configCenter.getDingTalkConfig().clientSecret,
        getAccessToken,
        logger: cardLogger,
      }),
    };

    const createStreamer = (
      message: InboundMessage,
      options: { mention?: string } = {},
    ): CardStreamer => {
      const dingtalk = configCenter.getDingTalkConfig();
      const layout = process.env.DINGTALK_CARD_LAYOUT?.trim();
      return new CardStreamer({
        api: cardApiRef.current,
        message,
        cardTemplateId: dingtalk.cardTemplateId,
        robotCode: dingtalk.robotCode,
        logger: cardLogger,
        layout:
          layout === 'v1' || layout === 'v2' || layout === 'ai'
            ? layout
            : 'ai',
        ...(process.env.DINGTALK_CARD_CONTENT_KEY?.trim()
          ? { contentKey: process.env.DINGTALK_CARD_CONTENT_KEY.trim() }
          : {}),
        ...(process.env.DINGTALK_CARD_SHOW_THINKING?.trim()
          ? {
              showThinking:
                process.env.DINGTALK_CARD_SHOW_THINKING.trim() === 'true',
            }
          : {}),
        ...(options.mention ? { mention: options.mention } : {}),
      });
    };

    const emotionReplier = new EmotionReplier({
      api: new OpenApiRobotEmotionApi({
        clientId: configCenter.getDingTalkConfig().clientId,
        clientSecret: configCenter.getDingTalkConfig().clientSecret,
        getAccessToken,
        logger: cardLogger,
      }),
      enabled: envEnabled(process.env.DINGTALK_BOT_EMOTION_ENABLED, true),
      emotionName:
        process.env.DINGTALK_BOT_EMOTION_NAME?.trim() || 'Like',
      robotCode: () => configCenter.getDingTalkConfig().robotCode,
      logger: cardLogger,
    });

    const recordTrace = async (
      collector: TraceCollector,
      message: InboundMessage,
      result: RunResult | null,
      proactive: boolean,
    ): Promise<void> => {
      if (!result) return;
      try {
        const record = collector.build({ message, result, proactive });
        await traceStore.append(
          redactionEnabled ? redactTraceRecord(record) : record,
        );
      } catch (error) {
        logger.warn(
          { messageId: message.messageId, error: errorText(error) },
          'failed to persist react trace',
        );
      }
    };

    const replyTo = async (
      message: InboundMessage,
      text: string,
      proactive = false,
    ): Promise<void> => {
      const webhook = message.rawPayload.sessionWebhook;
      if (typeof webhook === 'string' && webhook) {
        await sendSessionWebhook(message, text, cardLogger, {
          mention: !proactive,
        });
        return;
      }
      const streamer = createStreamer(message, {
        mention: replyMention(message, proactive),
      });
      await streamer.start();
      streamer.handle({ type: 'answer_delta', content: text });
      await streamer.finish();
    };

    const makeEmit = (
      collector: TraceCollector,
      streamer: CardStreamer,
    ): ((event: AgentStreamEvent) => void) => {
      return (event) => {
        collector.handle(event);
        streamer.handle(event);
        metrics.inc('agent_events_total', { type: event.type });
        if (event.type === 'tool_start') metrics.inc('agent_tool_calls_total');
        if (event.type === 'error') metrics.inc('agent_errors_total');
        if (event.type === 'completed') {
          metrics.inc('agent_tokens_total', undefined, event.usage.totalTokens);
        }
      };
    };

    const commandRouter = new CommandRouter({
      isAdmin: (staffId) => configCenter.isAdmin(staffId),
      stopRun: (conversationId) => runControl.stop(conversationId),
      retryLast: async (conversationId) => {
        const last = runControl.lastMessage(conversationId);
        if (!last) return 'none';
        void handleIncoming(last);
        return 'started';
      },
      resetConversation: async (message) => {
        const conversation = await repository.ensureConversation({
          conversationKey: conversationKeyFor(message),
          conversationType: message.conversationType,
          title: conversationTitleFor(message),
          metadata: {
            conversationId: message.conversationId,
            senderStaffId: message.senderStaffId,
          },
        });
        await repository.clearMessages(conversation.id);
      },
      status: () => {
        const llm = configCenter.getLLMConfig();
        return [
          `模型：${llm.provider} / ${llm.model}`,
          `进行中的回答：${runControl.activeCount()}`,
          `Stream：${streamConnected ? '已连接' : '未连接'}`,
          `运行时长：${Math.floor(process.uptime() / 60)} 分钟`,
        ].join('\n');
      },
      lastTrace: async (conversationId) => {
        const page = await traceStore.query({
          page: 1,
          pageSize: 1,
          conversationId,
        });
        const latest = page.items[0];
        if (!latest) return '本会话暂无执行轨迹。';
        const at = new Date(latest.createdAt).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
        });
        return [
          `最近一次执行：${at}`,
          `问题：${latest.question.slice(0, 120)}`,
          `步骤：${latest.stepCount} · tokens：${latest.totalTokens} · 耗时：${(latest.durationMs / 1000).toFixed(1)}s`,
          `答案摘要：${latest.answer.slice(0, 200)}`,
        ].join('\n');
      },
      dwsStatus: async () => {
        const status = await authManager.status({ force: true });
        const label =
          status.state === 'authenticated'
            ? '已授权'
            : status.state === 'expired'
              ? '已过期，需要重新授权'
              : '不可用';
        return [
          `DWS 授权：${label}`,
          ...(status.userName
            ? [
                `账号：${status.userName}${
                  status.corpName ? ` @ ${status.corpName}` : ''
                }`,
              ]
            : []),
          ...(status.expiresAt ? [`访问令牌到期：${status.expiresAt}`] : []),
          ...(status.refreshExpiresAt
            ? [`刷新令牌到期：${status.refreshExpiresAt}`]
            : []),
          ...(status.message ? [`说明：${status.message}`] : []),
        ].join('\n');
      },
      dwsLogin: async (message) => {
        const current = await authManager.status({ force: true });
        if (current.state === 'authenticated') {
          return 'DWS 授权当前有效，无需重新登录。';
        }
        let ticket = authManager.activeLogin();
        if (!ticket) {
          try {
            ticket = await authManager.startLogin({
              startedBy: message.senderStaffId,
            });
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            return `发起 DWS 授权失败：${reason}`;
          }
        }
        authManager.markPending(message.conversationId, { resume: false });
        return [
          '已发起 DWS 设备授权，请在钉钉中打开以下链接完成授权（15 分钟内有效）：',
          ticket.verifyUrl,
          `授权码：${ticket.userCode}`,
          '授权完成后我会在这里通知你。',
        ].join('\n');
      },
      setMuted: async (conversationId, muted) => {
        await configCenter.updateGroupPolicy(conversationId, {
          bystanderEnabled: !muted,
          proactiveReplyEnabled: !muted,
        });
      },
      recordFeedback: async (input) => {
        await feedbackStore.append({
          conversationId: input.conversationId,
          messageId: input.messageId,
          senderStaffId: input.staffId,
          senderNick: input.nick,
          content: input.text,
        });
        metrics.inc('agent_feedback_total');
      },
      confirmAction: async (message) => {
        const action = pendingActions.peek(message.conversationId);
        if (!action) {
          return '没有待确认的操作，可能已过期或已被处理。';
        }
        const isRequester = action.requestedBy.staffId === message.senderStaffId;
        if (!isRequester && !configCenter.isAdmin(message.senderStaffId)) {
          return '只有发起人或管理员可以确认该操作。';
        }
        pendingActions.take(message.conversationId);
        const registry = toolRegistry;
        if (!registry) return '工具注册表尚未就绪，操作已取消。';
        const ctx: ExecutionContext = {
          conversationId: message.conversationId,
          messageId: message.messageId,
          senderStaffId: message.senderStaffId,
          senderNick: message.senderNick,
          conversationType: message.conversationType,
          deadlineAt: Date.now() + 120_000,
          now: Date.now,
        };
        const tool = (await registry.assembleTools(ctx)).find(
          (item) => item.name === action.toolName,
        );
        if (!tool) {
          metrics.inc('agent_tool_confirmations_total', { result: 'unavailable' });
          return `工具 \`${action.toolName}\` 当前不可用，操作已取消。`;
        }
        try {
          const output = await runWithTimeout(
            tool.executeStructured
              ? tool.executeStructured(action.args, ctx).then((result) =>
                  typeof result === 'string' ? result : result.text,
                )
              : tool.execute(action.args, ctx),
            120_000,
            action.toolName,
          );
          metrics.inc('agent_tool_confirmations_total', { result: 'executed' });
          const clipped =
            output.length > 2_000 ? `${output.slice(0, 2_000)}…` : output;
          return `已执行 \`${action.toolName}\`：\n${clipped}`;
        } catch (error) {
          metrics.inc('agent_tool_confirmations_total', { result: 'failed' });
          return `执行 \`${action.toolName}\` 失败：${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      },
      cancelAction: async (conversationId) => {
        const cancelled = pendingActions.cancel(conversationId);
        metrics.inc('agent_tool_confirmations_total', {
          result: cancelled ? 'cancelled' : 'none',
        });
        return cancelled
          ? '已取消待确认的操作。'
          : '没有待确认的操作。';
      },
      reply: replyTo,
    });

    async function runTurn(
      message: InboundMessage,
      proactive = false,
      startedStreamer?: CardStreamer,
    ): Promise<void> {
      const run = runControl.begin(message);
      metrics.set('agent_active_runs', runControl.activeCount());
      const mention = replyMention(message, proactive);
      const streamer =
        startedStreamer ?? createStreamer(message, { mention });
      const collector = new TraceCollector();
      const emit = makeEmit(collector, streamer);
      if (!startedStreamer) await streamer.start();
      try {
        const result = await harness.handleMessage(message, {
          emit,
          signal: run.signal,
          proactive,
          notify: async (text) => replyTo(message, text, proactive),
        });
        await streamer.finish();
        const overflow = streamer.takeOverflowAnswer();
        if (overflow) {
          await sendSessionWebhook(message, overflow, cardLogger, {
            mention: !proactive,
          });
        }
        await recordTrace(collector, message, result, proactive);
        if (result && !streamer.isAvailable && result.answer) {
          await sendSessionWebhook(message, result.answer, cardLogger, {
            mention: !proactive,
          });
        }
      } catch (error) {
        logger.error(
          { messageId: message.messageId, error: errorText(error) },
          'turn failed',
        );
        streamer.handle({ type: 'error', message: FALLBACK_ERROR_TEXT });
        await streamer.finish();
        await recordTrace(collector, message, EMPTY_RESULT, proactive);
        if (!streamer.isAvailable) {
          await sendSessionWebhook(
            message,
            FALLBACK_ERROR_TEXT,
            cardLogger,
            { mention: !proactive },
          );
        }
      } finally {
        run.finish();
        metrics.set('agent_active_runs', runControl.activeCount());
      }
    }

    async function handleIncoming(message: InboundMessage): Promise<void> {
      if (await commandRouter.tryHandle(message)) return;
      // 先建卡贴表情再解析附件，避免视觉理解耗时期间用户看不到任何反馈
      emotionReplier.mark(message);
      const streamer = createStreamer(message, {
        mention: replyMention(message),
      });
      const cardReady = streamer.start();
      let effective = message;
      try {
        if (message.attachments && message.attachments.length > 0) {
          try {
            const enriched = await enrichInboundMessage(message, {
              store: attachmentStore,
              ...(visionDescriber ? { vision: visionDescriber } : {}),
              logger: harnessLogger,
            });
            effective = enriched.message;
            if (enriched.attachments.length > 0) {
              metrics.inc(
                'agent_attachments_total',
                undefined,
                enriched.attachments.length,
              );
            }
            if (enriched.failed.length > 0) {
              metrics.inc(
                'agent_attachment_failures_total',
                undefined,
                enriched.failed.length,
              );
            }
          } catch (error) {
            logger.warn(
              { messageId: message.messageId, error: errorText(error) },
              'attachment enrichment failed, continue with raw message',
            );
          }
        }
        await cardReady;
        runControl.remember(effective);
        metrics.inc('agent_messages_total', {
          conversationType: effective.conversationType,
        });
        await runTurn(effective, false, streamer);
      } finally {
        void emotionReplier.clear(message);
      }
    }

    async function runProactiveTurn(
      message: InboundMessage,
      decision: BystanderEvaluationResult,
    ): Promise<void> {
      const run = runControl.begin(message);
      metrics.set('agent_active_runs', runControl.activeCount());
      const streamer = createStreamer(message);
      const collector = new TraceCollector();
      const emit = makeEmit(collector, streamer);
      await streamer.start();
      try {
        const result = await harness.handleBystanderMessage(message, {
          decision,
          emit,
          signal: run.signal,
          notify: async (text) => replyTo(message, text, true),
        });
        await streamer.finish();
        const overflow = streamer.takeOverflowAnswer();
        if (overflow) {
          await sendSessionWebhook(message, overflow, cardLogger);
        }
        await recordTrace(collector, message, result, true);
        if (result && !streamer.isAvailable && result.answer) {
          await sendSessionWebhook(message, result.answer, cardLogger);
        }
      } catch (error) {
        logger.error(
          { messageId: message.messageId, error: errorText(error) },
          'proactive turn failed',
        );
        streamer.handle({ type: 'error', message: FALLBACK_ERROR_TEXT });
        await streamer.finish();
        await recordTrace(collector, message, EMPTY_RESULT, true);
        if (!streamer.isAvailable) {
          await sendSessionWebhook(message, FALLBACK_ERROR_TEXT, cardLogger);
        }
      } finally {
        run.finish();
        metrics.set('agent_active_runs', runControl.activeCount());
      }
    }

    authManager.on('login-success', ({ staffId, status }) => {
      const pending = authManager.takePending();
      logger.info(
        { staffId, user: status.userName, pending: pending.length },
        'dws authorization restored',
      );
      for (const entry of pending) {
        const last = runControl.lastMessage(entry.conversationId);
        if (!last) continue;
        if (!entry.resume) {
          void replyTo(
            last,
            `DWS 授权已恢复${status.userName ? `（${status.userName}）` : ''}，可以继续使用 DWS 查询。`,
          ).catch((error) =>
            logger.warn(
              { error: errorText(error) },
              'dws resume notice failed',
            ),
          );
          continue;
        }
        void (async () => {
          await replyTo(last, 'DWS 授权已恢复，正在继续刚才的问题…');
          await handleIncoming(last);
        })().catch((error) =>
          logger.warn(
            {
              conversationId: entry.conversationId,
              error: errorText(error),
            },
            'dws resume failed',
          ),
        );
      }
    });
    authManager.on('login-failed', ({ staffId, reason }) => {
      const pending = authManager.takePending();
      logger.warn(
        { staffId, reason, pending: pending.length },
        'dws authorization not restored',
      );
      for (const entry of pending) {
        const last = runControl.lastMessage(entry.conversationId);
        if (!last) continue;
        void replyTo(
          last,
          `DWS 重新授权未完成：${reason}。发送 /dws-login 可重试。`,
        ).catch((error) =>
          logger.warn({ error: errorText(error) }, 'dws failure notice failed'),
        );
      }
    });

    const executeScheduledTask = async (task: ScheduledTask): Promise<void> => {
      const now = Date.now();
      const message: InboundMessage = {
        messageId: `scheduled_${task.id}_${now}`,
        conversationId: task.conversationId,
        conversationType: task.conversationType,
        senderStaffId: task.createdBy || 'scheduler',
        senderNick: '定时任务',
        isAtBot: true,
        text: task.prompt,
        rawPayload: { source: 'scheduled_task', taskId: task.id },
        timestamp: now,
      };
      logger.info(
        { taskId: task.id, conversationId: task.conversationId },
        'scheduled task triggered',
      );
      metrics.inc('scheduled_task_runs_total');
      await runTurn(message, true);
    };

    const normalizeSchedule = (
      input: ScheduledTaskInput | ScheduledTaskUpdate,
      fallback?: ScheduledTask,
    ): {
      intervalSeconds: number | null;
      cron: string | null;
      enabled: boolean;
    } => {
      const intervalSeconds =
        input.intervalSeconds !== undefined
          ? input.intervalSeconds
          : (fallback?.intervalSeconds ?? null);
      const cron =
        input.cron !== undefined ? input.cron?.trim() || null : (fallback?.cron ?? null);
      const enabled = input.enabled ?? fallback?.enabled ?? true;
      if ((intervalSeconds === null || intervalSeconds === undefined) && !cron) {
        throw new Error('cron 与 intervalSeconds 至少配置一项');
      }
      if (intervalSeconds !== null && intervalSeconds !== undefined && cron) {
        throw new Error('cron 与 intervalSeconds 只能二选一');
      }
      if (intervalSeconds !== null && intervalSeconds !== undefined && intervalSeconds < 30) {
        throw new Error('intervalSeconds 不能小于 30 秒');
      }
      computeNextRun({ enabled, cron, intervalSeconds: intervalSeconds ?? null }, Date.now());
      return { intervalSeconds: intervalSeconds ?? null, cron, enabled };
    };

    const scheduledApi = {
      list: () => scheduledStore.list(),
      create: async (input: ScheduledTaskInput): Promise<ScheduledTask> => {
        if (!input.conversationId?.trim()) throw new Error('缺少 conversationId');
        if (!input.prompt?.trim()) throw new Error('缺少 prompt');
        const schedule = normalizeSchedule(input);
        const task = await scheduledStore.create(
          {
            conversationId: input.conversationId.trim(),
            conversationType: input.conversationType === '1' ? '1' : '2',
            title: input.title?.trim() || '定时播报',
            prompt: input.prompt.trim(),
            ...schedule,
            createdBy: input.createdBy?.trim() || 'admin-api',
          },
          computeNextRun(schedule, Date.now()),
        );
        await configCenter.recordAudit({
          adminStaffId: 'admin-api',
          adminNick: '管理控制台',
          actionType: 'UPDATE_SCHEDULES',
          beforeSnapshot: {},
          afterSnapshot: { task },
        });
        return task;
      },
      update: async (
        id: string,
        input: ScheduledTaskUpdate,
      ): Promise<ScheduledTask> => {
        const current = (await scheduledStore.list()).find((item) => item.id === id);
        if (!current) throw new Error(`未找到定时任务: ${id}`);
        const schedule = normalizeSchedule(input, current);
        const task = await scheduledStore.update(
          id,
          {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
            ...schedule,
          },
          computeNextRun(schedule, Date.now()),
        );
        await configCenter.recordAudit({
          adminStaffId: 'admin-api',
          adminNick: '管理控制台',
          actionType: 'UPDATE_SCHEDULES',
          beforeSnapshot: { task: current },
          afterSnapshot: { task },
        });
        return task;
      },
      remove: async (id: string): Promise<boolean> => {
        const current = (await scheduledStore.list()).find((item) => item.id === id);
        const removed = await scheduledStore.remove(id);
        if (removed) {
          await configCenter.recordAudit({
            adminStaffId: 'admin-api',
            adminNick: '管理控制台',
            actionType: 'UPDATE_SCHEDULES',
            beforeSnapshot: { task: current ?? null },
            afterSnapshot: {},
          });
        }
        return removed;
      },
      runNow: async (id: string): Promise<void> => {
        const current = (await scheduledStore.list()).find((item) => item.id === id);
        if (!current) throw new Error(`未找到定时任务: ${id}`);
        await executeScheduledTask(current);
        await scheduledStore.markRun(
          id,
          Date.now(),
          computeNextRun(current, Date.now()),
        );
      },
    };

    const taskScheduler = new ScheduledTaskScheduler({
      store: scheduledStore,
      execute: executeScheduledTask,
      logger,
    });

    /**
     * 群聊非 @ 消息的统一入口：StreamGateway（能收到 @ 消息）与
     * DWS 群消息长连接（补齐非 @ 消息）共用同一条旁听漏斗。
     */
    const handleBystanderMessage = async (
      message: InboundMessage,
    ): Promise<void> => {
      // 旁听消息不进入 ReAct，但控制台的「最近活跃」要反映真实群消息
      try {
        await repository.ensureConversation({
          conversationKey: conversationKeyFor(message),
          conversationType: message.conversationType,
          title: conversationTitleFor(message),
          metadata: {
            conversationId: message.conversationId,
            senderStaffId: message.senderStaffId,
          },
        });
      } catch (error) {
        logger.warn(
          { conversationId: message.conversationId, error: errorText(error) },
          'failed to record group activity',
        );
      }
      // 群里不 @ 也可以使用 /stop 等控制指令
      if (parseCommand(message.text)) {
        await commandRouter.tryHandle(message);
        return;
      }
      const groupPolicy = await policyProvider.getPolicy(
        message.conversationId,
      );
      let decision: BystanderEvaluationResult;
      try {
        decision = await triage.evaluate(message, groupPolicy);
      } catch (error) {
        logger.warn(
          {
            messageId: message.messageId,
            conversationId: message.conversationId,
            error: errorText(error),
          },
          'bystander triage failed',
        );
        return;
      }
      logger.info(
        {
          messageId: message.messageId,
          conversationId: message.conversationId,
          source: message.rawPayload.source ?? 'stream',
          action: decision.action,
          triggerReason: decision.triggerReason,
          confidence: decision.confidence,
          rationale: decision.rationale,
        },
        'bystander evaluation finished',
      );
      if (decision.action !== 'PROACTIVE_REPLY') return;
      await runProactiveTurn(message, decision);
    };

    const gatewayOptions = () => ({
      logger: gatewayLogger,
      transcriptBuffer,
      ...(sharedState ? { dedupeStore: sharedState } : {}),
      handler: handleIncoming,
      cardActionHandler: async (action: CardActionEvent) => {
        const message: InboundMessage = {
          messageId: `card_${action.actionId}_${action.outTrackId || action.conversationId}_${Date.now()}`,
          conversationId: action.conversationId,
          conversationType: action.conversationType,
          senderStaffId: action.userId || `card_user_${action.conversationId}`,
          senderNick: action.nick ?? '卡片用户',
          isAtBot: true,
          text: action.command,
          rawPayload: {
            source: 'card_action',
            actionId: action.actionId,
            outTrackId: action.outTrackId,
          },
          timestamp: Date.now(),
        };
        await commandRouter.tryHandle(message);
      },
      bystanderHandler: handleBystanderMessage,
    });

    const startGateway = async (): Promise<void> => {
      const dingtalk = configCenter.getDingTalkConfig();
      const client = new DWClient({
        clientId: dingtalk.clientId,
        clientSecret: dingtalk.clientSecret,
        keepAlive: true,
      });
      activeClient = client;
      cachedToken = null;
      cardApiRef.current = new OpenApiCardApi({
        clientId: dingtalk.clientId,
        clientSecret: dingtalk.clientSecret,
        getAccessToken,
        logger: cardLogger,
      });
      const next = new StreamGateway({ client, ...gatewayOptions() });
      await next.start();
      gateway = next;
      streamConnected = true;
      metrics.set('agent_stream_connected', 1);
    };

    const startGatewayIfLeader = async (): Promise<void> => {
      if (clusterEnabled && !leadership?.isLeader()) return;
      if (gateway) return;
      await startGateway();
    };

    const parseList = (raw: string | undefined): string[] =>
      (raw ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    /**
     * 旁听需要订阅哪些群：环境变量指定的群 + 控制台显式开启了旁听的群策略。
     * 只订阅长连接、按白名单本地过滤，避免把账号所在的所有群都送进漏斗。
     */
    const refreshBystanderListenGroups = async (): Promise<void> => {
      const ids = new Set(parseList(process.env.BYSTANDER_LISTEN_GROUPS));
      try {
        for (const policy of await configCenter.listGroupPolicies()) {
          if (policy.bystanderEnabled) ids.add(policy.conversationId);
        }
      } catch (error) {
        logger.warn(
          { error: errorText(error) },
          'failed to load bystander group allowlist',
        );
      }
      bystanderListener?.setAllowedConversations(ids);
    };

    const startBystanderListener = async (): Promise<void> => {
      if (!envEnabled(process.env.BYSTANDER_LISTEN_ENABLED, true)) return;
      if (bystanderListener) return;
      const listener = new DwsGroupMessageListener({
        binary: process.env.DWS_BINARY?.trim() || 'dws',
        onMessage: handleBystanderMessage,
        shouldIgnore: (messageId) => gateway?.hasSeen(messageId) === true,
        ignoreSenders: [
          ...parseList(process.env.BYSTANDER_LISTEN_IGNORE_SENDERS),
          configCenter.getLLMConfig().persona.name,
        ],
        settleMs:
          envSeconds(process.env.BYSTANDER_LISTEN_SETTLE_SECONDS, 3) * 1_000,
        logger: harnessLogger,
      });
      bystanderListener = listener;
      await refreshBystanderListenGroups();
      listener.start();
      if (listener.allowedCount === 0) {
        logger.info(
          {},
          'no group opted in to bystander listening yet, DWS listener idles until a group policy enables it',
        );
      }
      if (!bystanderListenTimer) {
        bystanderListenTimer = setInterval(
          () => void refreshBystanderListenGroups(),
          envSeconds(process.env.BYSTANDER_LISTEN_REFRESH_SECONDS, 60) * 1_000,
        );
        bystanderListenTimer.unref?.();
      }
    };

    const stopBystanderListener = (): void => {
      if (bystanderListenTimer) {
        clearInterval(bystanderListenTimer);
        bystanderListenTimer = undefined;
      }
      bystanderListener?.stop();
      bystanderListener = undefined;
    };

    let configPoll: ReturnType<typeof setInterval> | undefined;
    if (clusterEnabled) {
      leadership = new PgAdvisoryLeadership({
        pool: {
          connect: async () => {
            const client = await dbHandle.pool.connect();
            return {
              query: async <T>(text: string, values?: unknown[]) => {
                const result = await client.query(text, values as unknown[]);
                return { rows: result.rows as T[] };
              },
              release: () => client.release(),
            };
          },
        },
        key: process.env.CLUSTER_LOCK_KEY ?? 'dingtalk-agent',
        retryMs: envSeconds(process.env.CLUSTER_RETRY_SECONDS, 5) * 1_000,
        heartbeatMs:
          envSeconds(process.env.CLUSTER_HEARTBEAT_SECONDS, 10) * 1_000,
        logger: harnessLogger,
        onAcquired: async () => {
          await startGatewayIfLeader();
          void startBystanderListener().catch((error) =>
            logger.error(
              { error: errorText(error) },
              'dws group listener start failed',
            ),
          );
        },
        onLost: () => {
          streamConnected = false;
          metrics.set('agent_stream_connected', 0);
          gateway?.stop();
          gateway = undefined;
          stopBystanderListener();
          runControl.stopAll();
          logger.warn({}, 'cluster leadership lost, stream stopped');
        },
      });
      leadership.start();
      configPoll = setInterval(() => {
        void configCenter.refresh().catch((error) => {
          logger.warn(
            { error: errorText(error) },
            'failed to poll shared config',
          );
        });
      }, envSeconds(process.env.CLUSTER_CONFIG_POLL_SECONDS, 30) * 1_000);
      configPoll.unref?.();
      logger.info(
        {
          lockKey: process.env.CLUSTER_LOCK_KEY ?? 'dingtalk-agent',
          retrySeconds: envSeconds(process.env.CLUSTER_RETRY_SECONDS, 5),
          heartbeatSeconds: envSeconds(
            process.env.CLUSTER_HEARTBEAT_SECONDS,
            10,
          ),
        },
        'cluster mode enabled, waiting for leadership',
      );
    } else {
      await startGateway();
      void startBystanderListener().catch((error) =>
        logger.error(
          { error: errorText(error) },
          'dws group listener start failed',
        ),
      );
    }
    metrics.set('scheduler_enabled', 1);
    taskScheduler.start();
    retentionService.start(
      envSeconds(process.env.DATA_CLEANUP_INTERVAL_SECONDS, 86_400) * 1_000,
    );

    configCenter.on('llm:changed', (event) => {
      const next = event.after as LLMAndPersonaConfig;
      modelRef.current = createChatModel(next);
      routedEngines.clear();
      engine.updateTemperature(next.temperature);
      engine.updateNativeReasoning(next.enableNativeReasoning);
      Object.assign(personaRef, next.persona);
      logger.info(
        { model: next.model, provider: next.provider },
        'llm config applied',
      );
    });
    configCenter.on('loopPolicy:changed', (event) => {
      routedEngines.clear();
      const next = event.after as ReturnType<typeof configCenter.getLoopPolicy>;
      engine.updatePolicy(next);
      harness.updatePolicy(next);
      logger.info({ policy: event.after }, 'loop policy applied');
    });
    configCenter.on('defaultBystanderPolicy:changed', () => {
      policyProvider.setDefaults(configCenter.getBystanderConfig());
      logger.info({}, 'default bystander policy applied');
    });
    configCenter.on('groupPolicy:changed', (event) => {
      void refreshBystanderListenGroups();
      logger.info(
        { conversationId: event.conversationId, policy: event.after },
        'group policy applied',
      );
    });
    configCenter.on('dingtalk:changed', (event) => {
      const next = event.after as StoredDingTalkConfig;
      const previous = event.before as StoredDingTalkConfig;
      toolRegistry?.setDwsEnabled(next.dwsCliEnabled);
      if (previous.webSearchEnabled !== next.webSearchEnabled) {
        logger.info(
          { webSearchEnabled: next.webSearchEnabled },
          'web search tool toggled',
        );
      }
      const credentialsChanged =
        previous.clientId !== next.clientId ||
        previous.clientSecret !== next.clientSecret;
      if (credentialsChanged) {
        streamConnected = false;
        metrics.set('agent_stream_connected', 0);
        gateway?.stop();
        gateway = undefined;
        void startGatewayIfLeader()
          .then(() => logger.info({}, 'stream gateway rebuilt'))
          .catch((error) =>
            logger.error({ error: errorText(error) }, 'stream gateway rebuild failed'),
          );
      }
      logger.info(
        {
          robotCode: next.robotCode,
          cardTemplateId: next.aiCardTemplateId,
          dwsCliEnabled: next.dwsCliEnabled,
          webSearchEnabled: next.webSearchEnabled,
          credentialsChanged,
        },
        'dingtalk config applied',
      );
    });

    const llmTester = async (input: {
      question: string;
      systemPrompt?: string;
    }): Promise<LlmSandboxTestResult> => {
      const startedAt = Date.now();
      const current = configCenter.getLLMConfig();
      let answer = '';
      let reasoning = '';
      let totalTokens = 0;
      const stream = modelRef.current.streamChat({
        messages: [
          {
            role: 'system',
            content: input.systemPrompt ?? current.persona.rolePrompt,
          },
          { role: 'user', content: input.question },
        ],
        tools: [],
        toolChoice: 'none',
        temperature: current.temperature,
        enableNativeReasoning: current.enableNativeReasoning,
      });
      for await (const chunk of stream) {
        if (chunk.contentDelta) answer += chunk.contentDelta;
        if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta;
        if (chunk.usage?.totalTokens) totalTokens = chunk.usage.totalTokens;
      }
      return {
        answer,
        reasoning,
        usage: { totalTokens, durationMs: Date.now() - startedAt },
      };
    };

    const dingtalkTester = {
      streamStatus: () => ({
        connected: streamConnected,
        ...(streamConnected ? {} : { detail: 'Stream 客户端未连接' }),
      }),
      sendTestCard: async (
        staffId?: string,
      ): Promise<{ ok: boolean; error?: string }> => {
        const target =
          staffId?.trim() || configCenter.getSystemConfig().dingtalk.adminStaffIds[0];
        if (!target) {
          return { ok: false, error: '未配置管理员 StaffId，无法发送测试卡片' };
        }
        const now = Date.now();
        const streamer = createStreamer({
          messageId: `admin-test-${now}`,
          conversationId: target,
          conversationType: '1',
          senderStaffId: target,
          senderNick: '管理员',
          isAtBot: true,
          text: '管理后台连通性测试',
          rawPayload: {},
          timestamp: now,
        });
        await streamer.start();
        streamer.handle({
          type: 'answer_delta',
          content: '这是一条来自管理后台的测试卡片，链路正常。',
        });
        await streamer.finish();
        return streamer.isAvailable
          ? { ok: true }
          : { ok: false, error: '卡片创建失败，请检查模板 ID 与 RobotCode' };
      },
    };

    const consoleChat: ConsoleChatHandler = async (input, emit) => {
      const startedAt = Date.now();
      const turnId = `console_${startedAt}`;
      const current = configCenter.getLLMConfig();
      emit({ type: 'turn_start', turnId, step: 1 });
      let totalTokens = 0;
      metrics.inc('console_chat_turns_total');
      try {
        const stream = modelRef.current.streamChat(
          {
            messages: [
              {
                role: 'system',
                content: input.systemPrompt ?? current.persona.rolePrompt,
              },
              { role: 'user', content: input.question },
            ],
            tools: [],
            toolChoice: 'none',
            temperature: current.temperature,
            enableNativeReasoning: current.enableNativeReasoning,
          },
          input.signal,
        );
        for await (const chunk of stream) {
          if (chunk.reasoningDelta) {
            emit({
              type: 'reasoning_delta',
              content: chunk.reasoningDelta,
              turnId,
            });
          }
          if (chunk.contentDelta) {
            emit({ type: 'answer_delta', content: chunk.contentDelta, turnId });
          }
          if (chunk.usage?.totalTokens) {
            totalTokens = chunk.usage.totalTokens;
          }
        }
        emit({
          type: 'completed',
          usage: { totalTokens, steps: 1, durationMs: Date.now() - startedAt },
        });
      } catch (error) {
        if (input.signal?.aborted) {
          emit({
            type: 'completed',
            usage: {
              totalTokens,
              steps: 1,
              durationMs: Date.now() - startedAt,
              stopped: true,
            },
          });
          return;
        }
        throw error;
      }
    };

    adminServer = startAdminServer({
      configCenter,
      traces: traceStore,
      groups: groupDirectory,
      listeningGroups: () => bystanderListener?.allowedConversations ?? [],
      glossary,
      mcp: {
        status: () => mcpPort.status(),
        applyServers: async (servers) => {
          if (!toolRegistry?.pool) return [];
          return toolRegistry.pool.applyServers(servers);
        },
        testServer: (serverId): Promise<McpServerTestResult> =>
          mcpPort.testServer!(serverId),
      },
      llmTester,
      dingtalkTester,
      chatStream: consoleChat,
      feedback: { list: (limit) => feedbackStore.list(limit) },
      scheduledTasks: scheduledApi,
      usage: {
        summary: (days = 1) =>
          usageLedger.summarySince(Date.now() - days * 24 * 60 * 60 * 1_000),
      },
      governance: retentionService,
      metrics,
      readiness: async () => {
        try {
          await dbHandle.pool.query('select 1');
        } catch (error) {
          return { ready: false, detail: `数据库不可用：${errorText(error)}` };
        }
        if (clusterEnabled && !leadership?.isLeader()) {
          return { ready: true, detail: 'standby（本实例未持有 Stream 主锁）' };
        }
        return streamConnected
          ? { ready: true }
          : { ready: false, detail: '钉钉 Stream 未连接' };
      },
      staticDir: resolve(process.cwd(), 'web-console/dist'),
      authToken: process.env.ADMIN_API_TOKEN,
      logger: harnessLogger,
    });

    logger.info(
      {
        model: configCenter.getLLMConfig().model,
        provider: configCenter.getLLMConfig().provider,
        persona: configCenter.getLLMConfig().persona.name,
        nativeReasoning:
          configCenter.getLLMConfig().enableNativeReasoning,
        maxWallTimeMs: configCenter.getLoopPolicy().maxWallTimeMs,
        maxTotalTokens: configCenter.getLoopPolicy().maxTotalTokens,
        bystanderEnabled: configCenter.getBystanderConfig().bystanderEnabled,
        proactiveReplyEnabled:
          configCenter.getBystanderConfig().proactiveReplyEnabled,
        cooldownSeconds: configCenter.getBystanderConfig().cooldownSeconds,
        confidenceThreshold:
          configCenter.getBystanderConfig().confidenceThreshold,
        debounceMs: configCenter.getBystanderConfig().debounceMs,
        compressionThresholdTokens: memoryConfig.compressionThresholdTokens,
        glossaryEmbeddingEnabled: Boolean(embeddingClient),
        adminApiPort: adminServer.port,
      },
      'dingtalk agent is ready',
    );

    void glossary.backfillEmbeddings().catch((error) => {
      logger.warn(
        { error: errorText(error) },
        'glossary embedding backfill failed',
      );
    });

    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      if (configPoll) clearInterval(configPoll);
      await leadership?.stop();
      runControl.stopAll();
      dwsAuth?.dispose();
      await taskScheduler.stop();
      retentionService?.stop();
      gateway?.stop();
      stopBystanderListener();
      await clusterSync?.flush().catch((error) => {
        logger.warn({ error: errorText(error) }, 'failed to flush cluster state');
      });
      await adminServer?.close().catch((error) => {
        logger.warn({ error: errorText(error) }, 'admin server close failed');
      });
      await harness.flushMemoryTasks();
      await toolRegistry?.close();
      await dbHandle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    logger.error({ error: errorText(error) }, 'startup failed');
    await adminServer?.close().catch(() => undefined);
    await toolRegistry?.close();
    await dbHandle.close();
    process.exitCode = 1;
  }
}

void main();
