import { resolve } from 'node:path';
import type { MetricsRegistry } from '../admin-api/metrics.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import { DrizzlePendingActionPersistence } from '../db/approvalSchema.js';
import type { DatabaseHandle } from '../db/client.js';
import type {
  DrizzleGroupDirectory,
  DrizzleReActTraceStore,
} from '../db/configSchema.js';
import { DrizzleDwsIdentityStore } from '../db/dwsIdentitySchema.js';
import { DrizzleGlossaryCandidateStore } from '../db/glossaryCandidateSchema.js';
import { DrizzleGlossaryStore } from '../db/glossarySchema.js';
import {
  PgRetentionStore,
  loadGovernanceSetting,
  saveGovernanceSetting,
} from '../db/governanceSchema.js';
import { DrizzleScheduledTaskStore } from '../db/schedulerSchema.js';
import { DrizzleTaskResultStore } from '../db/taskMemorySchema.js';
import { DingTalkAdminTextSender } from '../dingtalk/AdminTextSender.js';
import { DingTalkMediaSender } from '../dingtalk/MediaSender.js';
import { GroupTranscriptArchive } from '../bystander/GroupTranscriptArchive.js';
import { GlossaryCandidateService } from '../glossary/GlossaryCandidateService.js';
import { GlossaryService } from '../glossary/GlossaryService.js';
import {
  DataRetentionService,
  resolveRetentionPolicy,
} from '../governance/DataRetention.js';
import type { HarnessLogger } from '../harness/AgentHarness.js';
import type { RunControlRegistry } from '../harness/RunControlRegistry.js';
import {
  classifyToolRisk,
  createToolApprovalGate,
  PendingActionStore,
} from '../harness/ToolApprovalGate.js';
import {
  parseToolExecutionPolicy,
  PolicyToolProvider,
} from '../harness/ToolExecutionPolicy.js';
import { ToolRegistry } from '../harness/ToolRegistry.js';
import { TaskResultMemory } from '../memory/TaskResultMemory.js';
import { AttachmentStore } from '../multimodal/AttachmentStore.js';
import { OpenAiVisionDescriber } from '../multimodal/VisionDescriber.js';
import { PersonalAssistantService } from '../personal/PersonalAssistantService.js';
import { PersonalReportBuilder } from '../personal/PersonalReportBuilder.js';
import { AdminChatOpsToolProvider } from '../tools/admin/AdminChatOpsToolProvider.js';
import { ArtifactToolProvider } from '../tools/artifacts/ArtifactToolProvider.js';
import { DwsAuthManager } from '../tools/dws/DwsAuthManager.js';
import { DwsCliRunner } from '../tools/dws/DwsCliRunner.js';
import { DwsIdentityService } from '../tools/dws/DwsIdentityService.js';
import { formatDwsPermissionNotice } from '../tools/dws/DwsPermissionNotice.js';
import type { DwsWriteTaskService } from '../tools/dws/DwsWriteTaskService.js';
import { GithubToolProvider } from '../tools/github/GithubToolProvider.js';
import { GlossaryToolProvider } from '../tools/glossary/GlossaryToolProvider.js';
import { JargonToolProvider } from '../tools/glossary/JargonToolProvider.js';
import { PersonalAssistantToolProvider } from '../tools/personal/PersonalAssistantToolProvider.js';
import { ProjectToolProvider } from '../tools/projects/ProjectToolProvider.js';
import { SkillToolProvider } from '../tools/skills/SkillToolProvider.js';
import { TaskMemoryToolProvider } from '../tools/taskMemory/TaskMemoryToolProvider.js';
import { WebFetchClient } from '../tools/web/WebFetchClient.js';
import { WebFetchToolProvider } from '../tools/web/WebFetchToolProvider.js';
import { WebSearchClient } from '../tools/web/WebSearchClient.js';
import { WebSearchToolProvider } from '../tools/web/WebSearchToolProvider.js';
import { WorkspaceReadToolProvider } from '../tools/workspace/WorkspaceReadToolProvider.js';
import type { McpAdminPort } from '../types/admin-and-console.js';
import type {
  ExecutionContext,
  InboundMessage,
  IToolProvider,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '../types/core.js';
import {
  envBool,
  envCount,
  envEnabled,
  envMegabytes,
  envSeconds,
  errorText,
  requiresExplicitDwsConfirmation,
} from './envHelpers.js';
import type { WorkspaceAndExtensionsContext } from './workspaceAndExtensions.js';

export interface ToolsAndGovernanceDeps {
  dbHandle: DatabaseHandle;
  configCenter: DynamicConfigCenter;
  traceStore: DrizzleReActTraceStore;
  groupDirectory: DrizzleGroupDirectory;
  mcpPort: McpAdminPort;
  runControl: RunControlRegistry;
  metrics: MetricsRegistry;
  harnessLogger: HarnessLogger;
  getAccessToken: () => Promise<string>;
  extensions: WorkspaceAndExtensionsContext;
  clusterEnabled: boolean;
  isLeader: () => boolean;
  redactionEnabled: boolean;
  getDwsWriteTasksService: () => DwsWriteTaskService | null;
}

export interface ToolsAndGovernanceContext {
  pendingActions: PendingActionStore;
  resolveToolApproval: (
    request: ToolApprovalRequest,
    context: ExecutionContext,
  ) => Promise<ToolApprovalDecision>;
  mediaSender: DingTalkMediaSender;
  adminTextSender: DingTalkAdminTextSender;
  scheduledStore: DrizzleScheduledTaskStore;
  identityService: DwsIdentityService;
  personalAssistant: PersonalAssistantService;
  authManager: DwsAuthManager;
  glossary: GlossaryService;
  glossaryCandidates: GlossaryCandidateService;
  groupTranscriptArchive: GroupTranscriptArchive;
  transcriptArchiveEnabled: boolean;
  taskMemory: TaskResultMemory | null;
  executionPolicy: ReturnType<typeof parseToolExecutionPolicy>;
  toolRegistry: ToolRegistry;
  applyExecutionPolicy: (providers: () => IToolProvider[]) => IToolProvider[];
  attachmentStore: AttachmentStore;
  visionDescriber?: OpenAiVisionDescriber;
  retentionService: DataRetentionService;
}

/** 初始化工具注册表、DWS 鉴权、审批闸门、多模态附件与数据治理保留策略 */
export async function setupToolsAndGovernance(
  deps: ToolsAndGovernanceDeps,
): Promise<ToolsAndGovernanceContext> {
  const {
    dbHandle,
    configCenter,
    traceStore,
    groupDirectory,
    mcpPort,
    runControl,
    metrics,
    harnessLogger,
    getAccessToken,
    extensions,
    clusterEnabled,
    isLeader,
    redactionEnabled,
    getDwsWriteTasksService,
  } = deps;
  const logger = harnessLogger;

  const pendingActions = new PendingActionStore({
    ttlMs:
      Math.max(30, Number(process.env.TOOL_CONFIRMATION_TTL_SECONDS ?? 300)) *
      1000,
    multiPending: true,
    persistence: new DrizzlePendingActionPersistence(dbHandle.db),
    logger,
  });
  await pendingActions.hydrate();

  const approvalMessageFor = (context: ExecutionContext): InboundMessage => ({
    messageId: context.messageId,
    conversationId: context.conversationId,
    conversationType: context.conversationType,
    senderStaffId: context.senderStaffId,
    senderNick: context.senderNick,
    isAtBot: true,
    text: '',
    rawPayload: { source: 'approval_snapshot' },
    timestamp: Date.now(),
  });

  const approvalGate = createToolApprovalGate({
    store: pendingActions,
    enabled: envEnabled(process.env.TOOL_CONFIRMATION_ENABLED, true),
    logger,
  });

  let toolRegistryRef: ToolRegistry | undefined;

  const resolveToolApproval = async (
    request: ToolApprovalRequest,
    context: ExecutionContext,
  ): Promise<ToolApprovalDecision> => {
    const risk = classifyToolRisk({
      name: request.toolName,
      ...(request.risk ? { risk: request.risk } : {}),
      ...(request.source ? { source: request.source } : {}),
    });
    if (request.toolName === 'glossary_candidate_submit') {
      return { approved: true };
    }
    if (
      !context.proactive &&
      risk === 'write' &&
      ((context.conversationType === '1' &&
        (request.source === 'personal-assistant' ||
          request.source === 'personal-memory' ||
          request.toolName === 'personal_reminder_manage' ||
          request.toolName === 'personal_report_manage')) ||
        (context.conversationType === '2' &&
          (request.toolName === 'group_schedule_manage' ||
            request.toolName === 'group_memory_save' ||
            request.toolName === 'group_member_memory_save' ||
            request.toolName === 'group_member_memory_forget')))
    ) {
      return { approved: true };
    }
    const dwsWrite = request.source === 'dws' && risk !== 'read';
    if (dwsWrite) {
      const gate = await toolRegistryRef?.dwsAuthorizationGate(context, true);
      if (gate) {
        if (gate.loginStarted) {
          const message =
            runControl.messageById(context.messageId) ??
            approvalMessageFor(context);
          const dwsWriteTasksService = getDwsWriteTasksService();
          if (dwsWriteTasksService) {
            try {
              await dwsWriteTasksService.create({
                message,
                toolName: request.toolName,
                args: request.args,
                risk: risk === 'destructive' ? 'destructive' : 'write',
              });
            } catch (error) {
              logger.warn(
                {
                  conversationId: context.conversationId,
                  toolName: request.toolName,
                  error: errorText(error),
                },
                'failed to persist dws write task',
              );
            }
          }
        }
        return { approved: false, reason: gate.userText };
      }
      if (risk === 'write' && !requiresExplicitDwsConfirmation(request)) {
        return { approved: true };
      }
    }
    return approvalGate(request, context);
  };

  const adminProvider = new AdminChatOpsToolProvider({
    configCenter,
    mcp: mcpPort,
    traces: traceStore,
    groups: groupDirectory,
    logger,
  });

  const artifactDeliveryEnabled = envEnabled(
    process.env.ARTIFACT_DELIVERY_ENABLED,
    true,
  );
  const artifactMaxBytes = envMegabytes(process.env.ARTIFACT_MAX_MB, 20);
  const mediaSender = new DingTalkMediaSender({
    robotCode: () => configCenter.getDingTalkConfig().robotCode,
    getAccessToken,
    logger,
    maxBytes: artifactMaxBytes,
  });
  const adminTextSender = new DingTalkAdminTextSender({
    robotCode: () => configCenter.getDingTalkConfig().robotCode,
    getAccessToken,
    logger,
  });
  const scheduledStore = new DrizzleScheduledTaskStore(dbHandle.db);
  const identityService = new DwsIdentityService({
    store: new DrizzleDwsIdentityStore(dbHandle.db),
    binary: process.env.DWS_BINARY?.trim() || 'dws',
    logger,
    ...(process.env.DWS_CORP_ID?.trim()
      ? { corpId: process.env.DWS_CORP_ID.trim() }
      : {}),
    ...(process.env.DWS_PROFILE_ROOT?.trim()
      ? { profileRoot: resolve(process.cwd(), process.env.DWS_PROFILE_ROOT.trim()) }
      : {}),
  });
  const personalAssistant = new PersonalAssistantService({
    store: scheduledStore,
    report: new PersonalReportBuilder({
      identity: identityService,
      runner: new DwsCliRunner({
        binary: process.env.DWS_BINARY?.trim() || 'dws',
        timeoutMs: 20_000,
        maxOutputChars: 2_000_000,
      }),
    }),
  });
  const authManager = new DwsAuthManager({
    binary: process.env.DWS_BINARY?.trim() || 'dws',
    logger,
  });

  const glossary = new GlossaryService({
    store: new DrizzleGlossaryStore(dbHandle.db),
    ...(extensions.embeddingClient ? { embedding: extensions.embeddingClient } : {}),
    logger,
    promptEnabled: envEnabled(process.env.GLOSSARY_PROMPT_ENABLED, true),
    promptLimit: envCount(process.env.GLOSSARY_PROMPT_LIMIT, 80),
    promptCharBudget: envCount(process.env.GLOSSARY_PROMPT_CHAR_BUDGET, 4_000),
    retrievalLimit: envCount(process.env.GLOSSARY_RETRIEVAL_LIMIT, 4),
  });
  const glossaryCandidates = new GlossaryCandidateService({
    store: new DrizzleGlossaryCandidateStore(dbHandle.db),
    glossary,
  });
  const groupTranscriptArchive = new GroupTranscriptArchive({
    dir: process.env.GROUP_TRANSCRIPT_DIR?.trim()
      ? resolve(process.env.GROUP_TRANSCRIPT_DIR.trim())
      : resolve(extensions.stateRoot, 'group-transcripts'),
    logger,
  });
  const transcriptArchiveEnabled = envEnabled(
    process.env.GROUP_TRANSCRIPT_ARCHIVE_ENABLED,
    true,
  );
  if (transcriptArchiveEnabled) {
    logger.info(
      { dir: groupTranscriptArchive.root },
      'group transcript archive enabled',
    );
  }

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
          enabled: () => configCenter.getWebSearchConfig?.()?.enabled ?? false,
          logger,
          metrics,
          cacheTtlSeconds: webSearchConfig.cacheTtlSeconds,
          maxCallsPerHour: webSearchConfig.maxCallsPerHour,
          dailyLimit: webSearchConfig.dailyLimit,
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
      cacheTtlSeconds: webSearchConfig?.cacheTtlSeconds,
      maxCallsPerHour: webSearchConfig?.maxCallsPerHour,
      dailyLimit: webSearchConfig?.dailyLimit,
      apiKeyConfigured: Boolean(webSearchConfig?.apiKey),
    },
    'web search configuration resolved',
  );

  const webFetchEnabled = envBool(process.env.WEB_FETCH_ENABLED, true);
  const webFetchDnsServers = (process.env.WEB_FETCH_DNS_SERVERS ?? '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  const webFetchProvider = webFetchEnabled
    ? new WebFetchToolProvider({
        client: new WebFetchClient({
          timeoutMs: envSeconds(process.env.WEB_FETCH_TIMEOUT_MS, 20),
          maxBytes: envMegabytes(process.env.WEB_FETCH_MAX_MB, 2),
          ...(webFetchDnsServers.length > 0
            ? { dnsServers: webFetchDnsServers }
            : {}),
        }),
        logger,
        metrics,
        cacheTtlSeconds: envCount(process.env.WEB_FETCH_CACHE_TTL_SECONDS, 600),
        maxCallsPerHour: envCount(process.env.WEB_FETCH_MAX_CALLS_PER_HOUR, 20),
        dailyLimit: envCount(process.env.WEB_FETCH_DAILY_LIMIT, 300),
        defaultMaxChars: envCount(process.env.WEB_FETCH_MAX_CHARS, 2_500),
      })
    : undefined;
  logger.info(
    {
      enabled: webFetchEnabled,
      timeoutMs: envSeconds(process.env.WEB_FETCH_TIMEOUT_MS, 20) * 1_000,
      maxBytes: envMegabytes(process.env.WEB_FETCH_MAX_MB, 2),
      cacheTtlSeconds: envCount(process.env.WEB_FETCH_CACHE_TTL_SECONDS, 600),
      maxCallsPerHour: envCount(process.env.WEB_FETCH_MAX_CALLS_PER_HOUR, 20),
      dailyLimit: envCount(process.env.WEB_FETCH_DAILY_LIMIT, 300),
      dnsServers: webFetchDnsServers,
    },
    'web fetch configuration resolved',
  );

  const taskMemoryEnabled = envEnabled(process.env.TASK_MEMORY_ENABLED, true);
  const taskMemory = taskMemoryEnabled
    ? new TaskResultMemory({
        store: new DrizzleTaskResultStore(dbHandle.db),
        logger,
      })
    : null;

  const executionPolicy = parseToolExecutionPolicy(process.env);
  logger.info(
    {
      ...executionPolicy.describe(),
      enabled: !executionPolicy.isDefault(),
    },
    'tool execution policy resolved',
  );

  const toolRegistry = await ToolRegistry.create({
    mcpServers: await extensions.mergeMcpServers(),
    enableDws: configCenter.getSystemConfig().dingtalk.dwsCliEnabled,
    dwsIdentity: identityService,
    dwsPersonalNotifier: async (staffId, text) => {
      const result = await adminTextSender.send([staffId], text);
      if (!result.ok) {
        logger.warn(
          { staffId, failed: result.failed.length },
          'dws authorization link private delivery failed',
        );
      }
      return result.ok;
    },
    dwsPermissionNotifier: async (notice) => {
      const admins = configCenter
        .getSystemConfig()
        .dingtalk.adminStaffIds.filter(
          (staffId) => staffId.trim() !== '' && staffId !== notice.senderStaffId,
        );
      if (admins.length === 0) {
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
    ...(webFetchProvider ? { webFetchProvider } : {}),
    adminProvider,
    glossaryProvider: new GlossaryToolProvider({ service: glossary, logger }),
    jargonProvider: new JargonToolProvider({
      archive: groupTranscriptArchive,
      candidates: glossaryCandidates,
      isAdmin: (staffId) => configCenter.isAdmin(staffId),
      enabled: () => transcriptArchiveEnabled,
      logger,
    }),
    skillProvider: new SkillToolProvider({
      service: extensions.skills,
      isAdmin: (staffId) => configCenter.isAdmin(staffId),
      enabled: () => configCenter.getExtensionsConfig().skillsEnabled,
    }),
    projectProvider: new ProjectToolProvider({
      service: extensions.projects,
      isAdmin: (staffId) => configCenter.isAdmin(staffId),
      enabled: () => configCenter.getExtensionsConfig().projectsEnabled,
    }),
    ...(extensions.githubClient
      ? {
          githubProvider: new GithubToolProvider({
            client: extensions.githubClient,
            defaultRepo: extensions.defaultGithubRepo,
            enabled: () => configCenter.getExtensionsConfig().projectsEnabled,
          }),
        }
      : {}),
    personalAssistantProvider: new PersonalAssistantToolProvider({
      service: personalAssistant,
    }),
    ...(taskMemory
      ? { taskMemoryProvider: new TaskMemoryToolProvider({ memory: taskMemory }) }
      : {}),
    workspaceReadProvider: (workspace) =>
      new WorkspaceReadToolProvider({ workspace }),
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
    logger,
  });
  toolRegistryRef = toolRegistry;

  logger.info(
    {
      providers: toolRegistry.providers.map((provider) => provider.providerName),
      mcpServers:
        toolRegistry.pool?.listEnabledServers().map((server) => server.id) ?? [],
      workspace: toolRegistry.workspace.hostDir,
    },
    'tool registry ready',
  );

  try {
    const pluginRuntimeApplied = await extensions.plugins.refreshRuntime({
      type: 'refresh',
      pluginId: '*',
    });
    if (!pluginRuntimeApplied) {
      logger.warn({}, 'plugin runtime refresh failed after startup');
    }
  } catch (error) {
    logger.warn(
      { error: errorText(error) },
      'plugin runtime refresh failed after startup',
    );
  }

  const applyExecutionPolicy = (
    providers: () => IToolProvider[],
  ): IToolProvider[] =>
    executionPolicy.isDefault()
      ? providers()
      : [new PolicyToolProvider({ providers, policy: executionPolicy })];

  const attachmentDir = resolve(toolRegistry.workspace.hostDir, 'attachments');
  const attachmentStore = new AttachmentStore({
    rootDir: attachmentDir,
    robotCode: () => configCenter.getDingTalkConfig().robotCode,
    getAccessToken,
    logger,
    maxBytes: envMegabytes(process.env.ATTACHMENT_MAX_MB, 20),
  });

  const retentionService = await new DataRetentionService({
    store: new PgRetentionStore(
      {
        query: async <T>(text: string, values?: unknown[]) => {
          const result = await dbHandle.pool.query(text, values as unknown[]);
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
    transcriptArchive: groupTranscriptArchive,
    logger,
    canRun: () => !clusterEnabled || isLeader(),
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
          logger,
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

  return {
    pendingActions,
    resolveToolApproval,
    mediaSender,
    adminTextSender,
    scheduledStore,
    identityService,
    personalAssistant,
    authManager,
    glossary,
    glossaryCandidates,
    groupTranscriptArchive,
    transcriptArchiveEnabled,
    taskMemory,
    executionPolicy,
    toolRegistry,
    applyExecutionPolicy,
    attachmentStore,
    ...(visionDescriber ? { visionDescriber } : {}),
    retentionService,
  };
}
