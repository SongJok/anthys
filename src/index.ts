import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { isStaffUserId } from './dingtalk/userIds.js';
import { sendTextFallback } from './dingtalk/TextFallback.js';
import { DingTalkMediaSender } from './dingtalk/MediaSender.js';
import { DingTalkAdminTextSender } from './dingtalk/AdminTextSender.js';
import { formatDwsPermissionNotice } from './tools/dws/DwsPermissionNotice.js';
import { AttachmentStore } from './multimodal/AttachmentStore.js';
import { enrichInboundMessage } from './multimodal/MessageEnricher.js';
import { OpenAiVisionDescriber } from './multimodal/VisionDescriber.js';
import { ArtifactToolProvider } from './tools/artifacts/ArtifactToolProvider.js';
import { WorkspaceReadToolProvider } from './tools/workspace/WorkspaceReadToolProvider.js';
import type { CardActionEvent } from './dingtalk/CardActions.js';
import {
  findMentionOnlyContext,
  MENTION_ONLY_FALLBACK_REPLY,
} from './dingtalk/MentionOnlyMessage.js';
import {
  AgentHarness,
  conversationKeyFor,
  conversationTitleFor,
  type HarnessLogger,
  type WorkerRuntime,
} from './harness/AgentHarness.js';
import {
  RunControlRegistry,
  type BeginRunResult,
} from './harness/RunControlRegistry.js';
import {
  classifyToolRisk,
  createToolApprovalGate,
  formatApprovalPrompt,
  PendingActionStore,
} from './harness/ToolApprovalGate.js';
import { buildConfirmedActionContext } from './harness/approvalContext.js';
import { ModelRoutingEngine } from './harness/ModelRoutingEngine.js';
import {
  parseToolExecutionPolicy,
  PolicyToolProvider,
} from './harness/ToolExecutionPolicy.js';
import { UsageGuard } from './billing/UsageGuard.js';
import { parseModelPricing } from './billing/ModelPricing.js';
import { formatShanghaiDateTime } from './time/shanghaiTime.js';
import { DrizzleUsageLedgerStore } from './db/usageSchema.js';
import { DrizzleScheduledTaskStore } from './db/schedulerSchema.js';
import { DrizzleAgentJobStore } from './db/jobSchema.js';
import { DrizzleTaskResultStore } from './db/taskMemorySchema.js';
import { DrizzleAgentTaskStore } from './db/taskSchema.js';
import { TaskService, taskIdFromJob } from './tasks/TaskService.js';
import { DrizzlePendingActionPersistence } from './db/approvalSchema.js';
import { DrizzleSilentInvestigationStore } from './db/investigationSchema.js';
import { JobPauseError, JobRunner } from './jobs/JobRunner.js';
import { createWorkerRegistry } from './workers/WorkerRegistry.js';
import { ScopedToolProvider } from './workers/ScopedToolProvider.js';
import { isWorkerName, type WorkerName } from './types/workers.js';
import { createWatchdogPolicy } from './watchdog/RunWatchdog.js';
import type { WatchdogDecision } from './types/watchdog.js';
import {
  formatJob,
  formatJobList,
  formatJobResultNotice,
  formatJobStatus,
} from './jobs/JobService.js';
import {
  ScheduledTaskScheduler,
  computeNextRun,
} from './scheduler/ScheduledTaskScheduler.js';
import { CommandRouter, parseCommand } from './commands/CommandRouter.js';
import { ToolRegistry, loadMcpServerConfigs } from './harness/ToolRegistry.js';
import { SkillService } from './skills/SkillService.js';
import { DrizzleSkillStore } from './skills/SkillStore.js';
import { LocalSkillManager } from './skills/LocalSkillManager.js';
import { SkillToolProvider } from './tools/skills/SkillToolProvider.js';
import { PluginService } from './plugins/PluginService.js';
import { DrizzlePluginStore } from './plugins/PluginStore.js';
import {
  ProjectService,
  type ProjectGithubHistoryPort,
} from './projects/ProjectService.js';
import { DrizzleProjectStore } from './projects/ProjectStore.js';
import { RepoSource } from './projects/RepoSource.js';
import { seedProjectsFromRoot } from './projects/ProjectSeed.js';
import { ProjectToolProvider } from './tools/projects/ProjectToolProvider.js';
import { GithubClient } from './github/GithubClient.js';
import { createGithubAdminPort } from './github/GithubAdminPort.js';
import { GithubToolProvider } from './tools/github/GithubToolProvider.js';
import type { SkillScanRoot } from './skills/SkillRegistry.js';
import { GroupTranscriptBuffer } from './bystander/GroupTranscriptBuffer.js';
import { CooldownLimiter } from './bystander/CooldownLimiter.js';
import { DwsGroupMessageListener } from './bystander/DwsGroupMessageListener.js';
import { BystanderPolicyProvider } from './bystander/BystanderPolicyProvider.js';
import {
  BystanderTriageEngine,
  LlmBystanderClassifier,
} from './bystander/BystanderTriageEngine.js';
import {
  SilentInvestigationService,
  resolveSilentInvestigationConfig,
} from './bystander/SilentInvestigationService.js';
import { ContextAssembler } from './memory/ContextAssembler.js';
import { DrizzleConversationRepository } from './memory/ConversationRepository.js';
import {
  HierarchicalMemoryManager,
  LlmEpisodeSummarizer,
  LlmSemanticFactExtractor,
} from './memory/HierarchicalMemoryManager.js';
import { DrizzleMemoryStore } from './db/memorySchema.js';
import { groupMemberSubjectKey } from './types/bystander-and-memory.js';
import {
  DrizzlePersonIdentityStore,
  DrizzlePersonaProfileStore,
} from './db/personSchema.js';
import {
  PersonIdentityService,
  defaultPersonKeyFor,
  normalizeIdentityAlias,
} from './identity/PersonIdentityService.js';
import { PersonaResolver } from './persona/PersonaResolver.js';
import {
  DrizzleGroupModelRouteStore,
  DrizzleGroupWorkspaceStore,
} from './db/groupSchema.js';
import {
  DrizzlePersonMemoryConsentStore,
  DrizzlePersonPreferencesStore,
} from './db/personSettingsSchema.js';
import { GroupWorkspaceService } from './groups/GroupWorkspaceService.js';
import { GroupModelRoutingEngine } from './groups/GroupModelRoutingEngine.js';
import { GroupModelRouteService } from './groups/GroupModelRouteService.js';
import { PersonSettingsService } from './personal/PersonSettingsService.js';
import { GroupWorkspaceToolProvider } from './tools/groups/GroupWorkspaceToolProvider.js';
import { PersonSettingsToolProvider } from './tools/personal/PersonSettingsToolProvider.js';
import { PersonalMemoryToolProvider } from './tools/personal/PersonalMemoryToolProvider.js';
import { PersonalMemoryService } from './personal/PersonalMemoryService.js';
import { GroupReportService } from './groups/GroupReportService.js';
import { DwsGroupDirectorySource } from './groups/DwsGroupDirectorySource.js';
import { DrizzleGlossaryStore } from './db/glossarySchema.js';
import { GlossaryService } from './glossary/GlossaryService.js';
import { GlossaryToolProvider } from './tools/glossary/GlossaryToolProvider.js';
import { WebSearchClient } from './tools/web/WebSearchClient.js';
import { WebSearchToolProvider } from './tools/web/WebSearchToolProvider.js';
import { WebFetchClient } from './tools/web/WebFetchClient.js';
import { WebFetchToolProvider } from './tools/web/WebFetchToolProvider.js';
import { OpenAIEmbeddingClient } from './memory/EmbeddingClient.js';
import { createChatModel, inferDialect } from './react/createChatModel.js';
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
import { DwsCliRunner } from './tools/dws/DwsCliRunner.js';
import {
  DWS_CONSENT_VERSION,
  DwsIdentityError,
  DwsIdentityService,
  formatDwsConsentText,
} from './tools/dws/DwsIdentityService.js';
import { DrizzleDwsIdentityStore } from './db/dwsIdentitySchema.js';
import { DrizzleDwsWriteTaskStore } from './db/dwsWriteTaskSchema.js';
import { DwsWriteTaskService } from './tools/dws/DwsWriteTaskService.js';
import type { DwsWriteTask } from './types/dws-write-task.js';
import { PersonalReportBuilder } from './personal/PersonalReportBuilder.js';
import { PersonalAssistantService } from './personal/PersonalAssistantService.js';
import { PersonalAssistantToolProvider } from './tools/personal/PersonalAssistantToolProvider.js';
import { TaskResultMemory } from './memory/TaskResultMemory.js';
import { TaskMemoryToolProvider } from './tools/taskMemory/TaskMemoryToolProvider.js';
import {
  TraceCollector,
  createMcpAdminPort,
  formatTraceSenderNick,
  isNonEmployeeTraceLabel,
} from './admin-api/runtime.js';
import { startAdminServer } from './admin-api/server.js';
import { DrizzleWhitelistStore } from './db/whitelistSchema.js';
import { WhitelistService } from './whitelist/WhitelistService.js';
import {
  DingTalkContactDirectorySource,
  DwsContactDirectorySource,
} from './whitelist/DirectorySources.js';
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
  ModelProfile,
  ModelRole,
  RunResult,
  ToolApprovalDecision,
  ToolApprovalRequest,
  IToolProvider,
} from './types/core.js';
import type {
  LlmSandboxTestResult,
  McpAdminPort,
  McpServerTestResult,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
} from './types/admin-and-console.js';
import type { BystanderEvaluationResult } from './types/bystander-and-memory.js';
import type { AgentJob } from './types/jobs.js';
import type { EnterpriseMcpServerConfig } from './types/mcp-and-sandbox.js';
import type {
  PluginAdminPort,
  ProjectAdminPort,
  ProjectMemberContextInput,
  SkillAdminPort,
  SkillFileAdminPort,
} from './types/skills-plugins-projects.js';

const FALLBACK_ERROR_TEXT = '抱歉，处理这条消息时出现异常，请稍后重试。';
const EMPTY_RESULT: RunResult = {
  answer: '',
  reasoning: '',
  usage: { totalTokens: 0, steps: 0, durationMs: 0 },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * DWS 普通写操作在本人已授权后直接执行；
 * 取消日程、覆盖文档这类不可逆操作仍要求 /confirm。
 */
function requiresExplicitDwsConfirmation(
  request: Pick<ToolApprovalRequest, 'toolName' | 'args' | 'risk'>,
): boolean {
  if (request.risk === 'destructive') return true;
  if (request.toolName === 'dws_calendar_cancel') return true;
  return (
    request.toolName === 'dws_doc_manage' &&
    request.args.action === 'overwrite'
  );
}

function readAgentVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 钉钉单聊文本单条有长度上限，按行切块后分条发送 */
function splitForDelivery(text: string, limit = 1_200): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    const candidate = current === '' ? piece : `${current}\n${piece}`;
    if (candidate.length > limit) {
      if (current !== '') chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
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

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
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
  let dwsIdentity: DwsIdentityService | undefined;
  let skillService: SkillService | undefined;
  let pluginService: PluginService | undefined;
  let projectService: ProjectService | undefined;
  let projectSyncTimer: ReturnType<typeof setInterval> | undefined;
  let skillWatchStop: (() => void) | undefined;
  let streamConnected = false;

  try {
    const baseLLM = baseConfig.getLLMConfig();
    const modelSource = baseConfig.getModelConfigSource();
    await seedAgentConfigs(dbHandle.db, baseLLM);
    const seededLLM =
      modelSource === 'env'
        ? baseLLM
        : applyLLMOverrides(baseLLM, await loadLLMOverrides(dbHandle.db));
    const defaults: IConfigProvider = {
      getLLMConfig: () => seededLLM,
      getLoopPolicy: () => baseConfig.getLoopPolicy(),
      getDingTalkConfig: () => baseConfig.getDingTalkConfig(),
      getMemoryConfig: () => baseConfig.getMemoryConfig(),
      getBystanderConfig: () => baseConfig.getBystanderConfig(),
      getUsagePolicy: () => baseConfig.getUsagePolicy(),
      getModelProfiles: () => baseConfig.getModelProfiles(),
      getModelConfigSource: () => modelSource,
      getEmbeddingConfig: () => baseConfig.getEmbeddingConfig(),
      getVisionConfig: () => baseConfig.getVisionConfig(),
      getWebSearchConfig: () => baseConfig.getWebSearchConfig(),
      getExtensionsConfig: () => baseConfig.getExtensionsConfig(),
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
    const dwsGroupDirectorySource = new DwsGroupDirectorySource({
      binary: process.env.DWS_BINARY?.trim() || 'dws',
      logger: harnessLogger,
    });
    const groupDirectory = new DrizzleGroupDirectory(dbHandle.db, {
      botName: () => configCenter.getLLMConfig().persona.name,
      dwsSource: dwsGroupDirectorySource,
    });
    const dwsContactDirectory = new DwsContactDirectorySource({
      binary: process.env.DWS_BINARY?.trim() || 'dws',
      logger: harnessLogger,
    });
    const whitelistStore = new DrizzleWhitelistStore(dbHandle.db);
    const whitelist = new WhitelistService({
      store: whitelistStore,
      configCenter,
      directorySources: [
        new DingTalkContactDirectorySource(
          () => configCenter.getDingTalkConfig(),
          harnessLogger,
        ),
        dwsContactDirectory,
      ],
      resolveOpenId: (openId, senderName) =>
        dwsContactDirectory.resolveOpenId(openId, senderName),
      logger: harnessLogger,
    });
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

    const extensionsConfig = configCenter.getExtensionsConfig();
    const stateRoot = resolve(
      process.cwd(),
      process.env.AGENT_STATE_DIR?.trim() || '.state',
    );
    const builtinSkillsDir = resolve(
      process.cwd(),
      process.env.SKILLS_BUILTIN_DIR?.trim() || 'skills/builtin',
    );
    const localSkillsDir = resolve(
      process.cwd(),
      process.env.SKILLS_LOCAL_DIR?.trim() || 'skills/local',
    );
    const embeddingConfig = configCenter.getEmbeddingConfig();
    const embeddingDimensionsMismatch =
      Boolean(embeddingConfig?.enabled && embeddingConfig.apiKey) &&
      (embeddingConfig?.dimensions ?? 1536) !== 1536;
    if (embeddingDimensionsMismatch) {
      logger.error(
        {
          dimensions: embeddingConfig?.dimensions,
          required: 1536,
        },
        'EMBEDDING_DIMENSIONS 与数据库 vector(1536) 不一致，已禁用 embedding；请改回 1536 或同步调整表结构',
      );
    }
    const embeddingClient =
      embeddingConfig?.enabled &&
      embeddingConfig.apiKey &&
      !embeddingDimensionsMismatch
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
        'embedding client enabled for semantic memory and project search',
      );
    }

    const mergeMcpServers = async (
      manual: EnterpriseMcpServerConfig[] = configCenter.getMcpServers(),
    ): Promise<EnterpriseMcpServerConfig[]> => {
      if (
        !pluginService ||
        !configCenter.getExtensionsConfig().pluginsEnabled
      ) {
        return manual;
      }
      try {
        return [...manual, ...(await pluginService.getEnabledMcpServers())];
      } catch (error) {
        logger.warn(
          { error: errorText(error) },
          'failed to load plugin MCP servers',
        );
        return manual;
      }
    };

    pluginService = new PluginService({
      store: new DrizzlePluginStore(dbHandle.db),
      pluginsRoot: resolve(stateRoot, 'plugins'),
      agentVersion: readAgentVersion(),
      env: process.env,
      ...(process.env.PLUGIN_ALLOWED_COMMANDS?.trim()
        ? {
            allowedCommands: process.env.PLUGIN_ALLOWED_COMMANDS.split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {}),
      reservedSkillNames: () =>
        (skillService?.getAll() ?? [])
          .filter((skill) => skill.source !== 'plugin')
          .map((skill) => skill.name),
      manualMcpServerIds: () =>
        configCenter.getMcpServers().map((server) => server.id),
      onChanged: async () => {
        await skillService?.reload();
        await applyMergedMcpServers();
      },
      allowMissingSecrets: envEnabled(
        process.env.PLUGIN_ALLOW_MISSING_SECRETS,
        false,
      ),
      logger: harnessLogger,
    });
    const plugins = pluginService;

    skillService = new SkillService({
      roots: async () => {
        const roots: SkillScanRoot[] = [
          { source: 'builtin', dir: builtinSkillsDir },
          { source: 'local', dir: localSkillsDir },
        ];
        if (
          plugins &&
          configCenter.getExtensionsConfig().pluginsEnabled
        ) {
          try {
            roots.push(...(await plugins.getSkillRoots()));
          } catch (error) {
            logger.warn(
              { error: errorText(error) },
              'failed to load plugin skill roots',
            );
          }
        }
        return roots;
      },
      store: new DrizzleSkillStore(dbHandle.db),
      catalogLimit: extensionsConfig.skillCatalogLimit,
      logger: harnessLogger,
    });
    const skills = skillService;
    try {
      await skills.init();
      skillWatchStop = skills.startWatching(() => {
        void skills
          .reload()
          .then((result) =>
            logger.info(
              { loaded: result.loaded, errors: result.errors.length },
              'skills reloaded after directory change',
            ),
          )
          .catch((error) =>
            logger.warn(
              { error: errorText(error) },
              'skill reload after directory change failed',
            ),
          );
      });
      const loaded = skills.getAll();
      const failed = loaded.filter((skill) => skill.loadError);
      logger.info(
        {
          loaded: loaded.length - failed.length,
          errors: failed.length,
          sample: failed
            .slice(0, 5)
            .map((skill) => `${skill.id}: ${skill.loadError}`),
          roots: [builtinSkillsDir, localSkillsDir],
        },
        'skill registry ready',
      );
    } catch (error) {
      logger.error(
        { error: errorText(error) },
        'skill registry init failed, continuing without skills',
      );
    }

    const projectAllowedRoots = (process.env.PROJECT_ALLOWED_ROOTS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => resolve(process.cwd(), item));
    const githubEnabled = envEnabled(process.env.GITHUB_ENABLED, false);
    const githubApiBase =
      process.env.GITHUB_API_BASE?.trim() || 'https://api.github.com';
    const githubAllowedHosts = (process.env.GITHUB_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const githubCacheTtlSeconds = envSeconds(
      process.env.GITHUB_CACHE_TTL_SECONDS,
      300,
    );
    let githubClient: GithubClient | undefined;
    let githubInitError = '';
    if (githubEnabled) {
      try {
        githubClient = new GithubClient({
          token: process.env.GITHUB_TOKEN?.trim() ?? '',
          apiBase: githubApiBase,
          allowedHosts: githubAllowedHosts,
          cacheTtlMs: githubCacheTtlSeconds * 1000,
          logger: harnessLogger,
        });
      } catch (error) {
        githubInitError =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          { error: githubInitError },
          'github client init failed; github tools disabled',
        );
      }
    }
    const projectGithubPort: ProjectGithubHistoryPort | undefined = githubClient
      ? {
          search: async (repoRef, query, options) => {
            const result = await githubClient.search(repoRef, query, {
              kind: options.kind,
              ...(options.limit ? { limit: options.limit } : {}),
            });
            if ('kind' in result) {
              return { items: result.items, total: result.total };
            }
            return { items: [], total: 0 };
          },
        }
      : undefined;
    projectService = new ProjectService({
      store: new DrizzleProjectStore(dbHandle.db, harnessLogger),
      repoSource: new RepoSource({
        allowedRoots:
          projectAllowedRoots.length > 0
            ? projectAllowedRoots
            : [process.cwd()],
        stateDir: resolve(stateRoot, 'projects'),
        logger: harnessLogger,
      }),
      ...(embeddingClient ? { embedder: embeddingClient } : {}),
      ...(projectGithubPort ? { github: projectGithubPort } : {}),
      defaultProjectId: () =>
        configCenter.getExtensionsConfig().defaultProjectId,
      logger: harnessLogger,
      briefMaxChars: extensionsConfig.projectBriefMaxChars,
    });
    const projects = projectService;
    const defaultGithubRepo = async (): Promise<string> => {
      const defaultId = configCenter.getExtensionsConfig().defaultProjectId;
      if (!defaultId) return '';
      const record = await projects.getProject(defaultId);
      return record?.source.type === 'github' ? record.source.repo : '';
    };
    const projectSeedRoot = resolve(
      process.cwd(),
      process.env.PROJECT_SEED_DIR?.trim() || 'projects',
    );
    if (extensionsConfig.projectsEnabled) {
      try {
        await seedProjectsFromRoot({
          service: projects,
          root: projectSeedRoot,
          logger: harnessLogger,
        });
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            root: projectSeedRoot,
          },
          'project seed import failed',
        );
      }
    }
    logger.info(
      {
        skillsEnabled: extensionsConfig.skillsEnabled,
        pluginsEnabled: extensionsConfig.pluginsEnabled,
        pluginsRoot: resolve(stateRoot, 'plugins'),
        projectsEnabled: extensionsConfig.projectsEnabled,
        projectSeedRoot,
        projectAllowedRoots:
          projectAllowedRoots.length > 0
            ? projectAllowedRoots
            : [process.cwd()],
        defaultProjectId: extensionsConfig.defaultProjectId,
        githubEnabled,
        githubReady: Boolean(githubClient),
        githubTokenConfigured: githubClient?.hasToken ?? false,
        ...(githubInitError ? { githubInitError } : {}),
      },
      'extension services configured',
    );
    const githubAdminPort = createGithubAdminPort({
      enabled: githubEnabled,
      ...(githubClient ? { client: githubClient } : {}),
      ...(githubInitError ? { initError: githubInitError } : {}),
      toolsEnabled: () => configCenter.getExtensionsConfig().projectsEnabled,
      defaultRepo: defaultGithubRepo,
      apiBase: githubApiBase,
      allowedHosts: githubAllowedHosts,
      cacheTtlSeconds: githubCacheTtlSeconds,
    });

    const adminProjectMember: ProjectMemberContextInput = {
      senderStaffId: 'admin-console',
      isAdmin: true,
      conversationType: '1',
    };
    const skillAdminPort: SkillAdminPort = {
      list: () => skills.listAdmin(),
      reload: () => skills.reload(),
      setEnabled: (id, enabled) => skills.setEnabled(id, enabled),
      preview: async (input) => skills.preview(input),
      readResource: (input) => skills.readResource({ ...input, isAdmin: true }),
      usage: async (days) => Object.fromEntries(await skills.usageSince(days)),
    };
    const skillFilePort: SkillFileAdminPort = new LocalSkillManager({
      root: localSkillsDir,
      service: skills,
      logger: harnessLogger,
    });
    const pluginAdminPort: PluginAdminPort = {
      list: () => plugins.list(),
      get: (id) => plugins.get(id),
      versions: (id) => plugins.versions(id),
      validatePackage: (input) => plugins.validatePackage(input),
      install: (input) => plugins.install(input),
      installFromZip: (input) => plugins.installFromZip(input),
      enable: (id) => plugins.enable(id),
      disable: (id) => plugins.disable(id),
      upgrade: (input) => plugins.upgrade(input),
      rollback: (id, version) => plugins.rollback(id, version),
      uninstall: (id, options) => plugins.uninstall(id, options),
    };
    const projectAdminPort: ProjectAdminPort = {
      list: (includeUnavailable) =>
        projects.listProjects(adminProjectMember, includeUnavailable !== false),
      get: (id) => projects.getProject(id),
      create: (input) => projects.createProject(input),
      update: (id, patch) => projects.updateProject(id, patch),
      remove: (id) => projects.deleteProject(id),
      queueSync: (id, trigger) => projects.queueSync(id, trigger),
      listSyncJobs: (id, limit) => projects.listSyncJobs(id, limit),
      listSnapshots: (id, limit) => projects.listSnapshots(id, limit),
      search: (id, query, limit) =>
        projects.searchProject({
          projectRef: id,
          query,
          ...(limit !== undefined ? { limit } : {}),
          member: adminProjectMember,
        }),
      status: (id) => projects.getProjectStatus(id),
      handbook: (id) =>
        projects.getHandbook({ projectRef: id, member: adminProjectMember }),
      handbookDraft: (id) => projects.getHandbookDraft(id),
      manualEntries: (id) => projects.listManualEntries(id),
      handbookVersions: (id, limit) => projects.listHandbookVersions(id, limit),
      generateHandbook: (id) => projects.generateHandbook(id),
      saveHandbookDraft: (id, input) =>
        projects.saveHandbookDraft(
          id,
          input,
          adminProjectMember.senderStaffId,
        ),
      publishHandbook: (id, version) =>
        projects.publishHandbook(id, version),
      createManualEntry: (id, input) =>
        projects.createManualEntry(id, input, adminProjectMember.senderStaffId),
      updateManualEntry: (id, entryId, patch) =>
        projects.updateManualEntry(
          id,
          entryId,
          patch,
          adminProjectMember.senderStaffId,
        ),
      deleteManualEntry: (id, entryId) =>
        projects.deleteManualEntry(id, entryId),
    };

    const projectSyncIntervalSeconds = Math.max(
      60,
      envSeconds(process.env.PROJECT_SYNC_INTERVAL_SECONDS, 900),
    );
    const startProjectSync = (): void => {
      if (projectSyncTimer) return;
      projectSyncTimer = setInterval(() => {
        void projects
          .syncDueProjects('schedule')
          .then((results) => {
            if (results.length === 0) return;
            const failed = results.filter((item) => !item.ok);
            if (failed.length > 0) {
              logger.warn(
                { total: results.length, failed: failed.slice(0, 5) },
                'project auto sync completed with failures',
              );
              return;
            }
            logger.info(
              { synced: results.length },
              'project auto sync completed',
            );
          })
          .catch((error) =>
            logger.warn(
              { error: errorText(error) },
              'project auto sync failed',
            ),
          );
      }, projectSyncIntervalSeconds * 1_000);
      projectSyncTimer.unref?.();
    };
    const stopProjectSync = (): void => {
      if (!projectSyncTimer) return;
      clearInterval(projectSyncTimer);
      projectSyncTimer = undefined;
    };
    if (!clusterEnabled) startProjectSync();

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
    const baseMcpPort = createMcpAdminPort(
      () => toolRegistry?.pool ?? null,
      harnessLogger,
    );
    const mcpPort: McpAdminPort = {
      ...baseMcpPort,
      applyServers: async (manual) =>
        baseMcpPort.applyServers(await mergeMcpServers(manual)),
    };
    const applyMergedMcpServers = async (
      manual: EnterpriseMcpServerConfig[] = configCenter.getMcpServers(),
    ) => mcpPort.applyServers(manual);
    const pendingActions = new PendingActionStore({
      ttlMs:
        Math.max(30, Number(process.env.TOOL_CONFIRMATION_TTL_SECONDS ?? 300)) *
        1000,
      persistence: new DrizzlePendingActionPersistence(dbHandle.db),
      logger: harnessLogger,
    });
    await pendingActions.hydrate();
    /** 原始消息不在内存时，用执行上下文拼一条只含本人标识的快照 */
    const approvalMessageFor = (
      context: ExecutionContext,
    ): InboundMessage => ({
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
      logger: harnessLogger,
    });
    // 写工具先校验本人 DWS 授权；已授权且非高危的普通写操作直接执行
    let dwsWriteTasksService: DwsWriteTaskService | null = null;
    const resolveToolApproval = async (
      request: ToolApprovalRequest,
      context: ExecutionContext,
    ): Promise<ToolApprovalDecision> => {
      const risk = classifyToolRisk({
        name: request.toolName,
        ...(request.risk ? { risk: request.risk } : {}),
        ...(request.source ? { source: request.source } : {}),
      });
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
        const gate = await toolRegistry?.dwsAuthorizationGate(context, true);
        if (gate) {
          if (gate.loginStarted) {
            const message =
              runControl.messageById(context.messageId) ??
              approvalMessageFor(context);
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
    const scheduledStore = new DrizzleScheduledTaskStore(dbHandle.db);
    const identityService = new DwsIdentityService({
      store: new DrizzleDwsIdentityStore(dbHandle.db),
      binary: process.env.DWS_BINARY?.trim() || 'dws',
      logger: harnessLogger,
      ...(process.env.DWS_CORP_ID?.trim()
        ? { corpId: process.env.DWS_CORP_ID.trim() }
        : {}),
      ...(process.env.DWS_PROFILE_ROOT?.trim()
        ? { profileRoot: resolve(process.cwd(), process.env.DWS_PROFILE_ROOT.trim()) }
        : {}),
    });
    dwsIdentity = identityService;
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

    // 系统级身份仅用于旁听等基础设施能力，业务查询一律走员工本人身份
    const authManager = new DwsAuthManager({
      binary: process.env.DWS_BINARY?.trim() || 'dws',
      logger: harnessLogger,
    });
    dwsAuth = authManager;

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
            timeoutMs: envSeconds(process.env.WEB_FETCH_TIMEOUT_MS, 12),
            maxBytes: envMegabytes(process.env.WEB_FETCH_MAX_MB, 2),
            ...(webFetchDnsServers.length > 0
              ? { dnsServers: webFetchDnsServers }
              : {}),
          }),
          logger: harnessLogger,
          metrics,
          cacheTtlSeconds: envCount(
            process.env.WEB_FETCH_CACHE_TTL_SECONDS,
            600,
          ),
          maxCallsPerHour: envCount(
            process.env.WEB_FETCH_MAX_CALLS_PER_HOUR,
            20,
          ),
          dailyLimit: envCount(process.env.WEB_FETCH_DAILY_LIMIT, 300),
          defaultMaxChars: envCount(process.env.WEB_FETCH_MAX_CHARS, 2_500),
        })
      : undefined;
    logger.info(
      {
        enabled: webFetchEnabled,
        timeoutMs: envSeconds(process.env.WEB_FETCH_TIMEOUT_MS, 12) * 1_000,
        maxBytes: envMegabytes(process.env.WEB_FETCH_MAX_MB, 2),
        cacheTtlSeconds: envCount(process.env.WEB_FETCH_CACHE_TTL_SECONDS, 600),
        maxCallsPerHour: envCount(
          process.env.WEB_FETCH_MAX_CALLS_PER_HOUR,
          20,
        ),
        dailyLimit: envCount(process.env.WEB_FETCH_DAILY_LIMIT, 300),
        dnsServers: webFetchDnsServers,
      },
      'web fetch configuration resolved',
    );

    const taskMemoryEnabled = envEnabled(
      process.env.TASK_MEMORY_ENABLED,
      true,
    );
    const taskMemory = taskMemoryEnabled
      ? new TaskResultMemory({
          store: new DrizzleTaskResultStore(dbHandle.db),
          logger: harnessLogger,
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

    toolRegistry = await ToolRegistry.create({
      mcpServers: await mergeMcpServers(),
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
      ...(webFetchProvider ? { webFetchProvider } : {}),
      adminProvider,
      glossaryProvider: new GlossaryToolProvider({
        service: glossary,
        logger: harnessLogger,
      }),
      skillProvider: new SkillToolProvider({
        service: skills,
        isAdmin: (staffId) => configCenter.isAdmin(staffId),
        enabled: () => configCenter.getExtensionsConfig().skillsEnabled,
      }),
      projectProvider: new ProjectToolProvider({
        service: projects,
        isAdmin: (staffId) => configCenter.isAdmin(staffId),
        enabled: () => configCenter.getExtensionsConfig().projectsEnabled,
      }),
      ...(githubClient
        ? {
            githubProvider: new GithubToolProvider({
              client: githubClient,
              defaultRepo: defaultGithubRepo,
              enabled: () =>
                configCenter.getExtensionsConfig().projectsEnabled,
            }),
          }
        : {}),
      personalAssistantProvider: new PersonalAssistantToolProvider({
        service: personalAssistant,
      }),
      ...(taskMemory
        ? {
            taskMemoryProvider: new TaskMemoryToolProvider({
              memory: taskMemory,
            }),
          }
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
    try {
      const pluginRuntimeApplied = await plugins.refreshRuntime({
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

    const toolProviders = toolRegistry.providers;
    const applyExecutionPolicy = (
      providers: () => IToolProvider[],
    ): IToolProvider[] =>
      executionPolicy.isDefault()
        ? providers()
        : [
            new PolicyToolProvider({
              providers,
              policy: executionPolicy,
            }),
          ];
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
      logger: harnessLogger,
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
        timeoutMs:
          envSeconds(process.env.SUBAGENT_TIMEOUT_SECONDS, 90) * 1_000,
        maxTokens: envCount(process.env.SUBAGENT_MAX_TOKENS, 20_000),
        logger: harnessLogger,
      });
      toolProviders.push(subagent);
      logger.info({}, 'subagent delegation enabled');
    }

    // 企业 MCP 普遍较慢，单次工具等待默认 300 秒（MCP 自身 480 秒上限之内）
    const toolTimeoutMs =
      envSeconds(process.env.TOOL_TIMEOUT_SECONDS, 300) * 1_000;
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
      ...watchdogRunOptions,
    });

    // 静默调查只允许只读工具，执行层过滤保证模型即使被诱导也看不到写操作
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

    // 后台 Worker：独立画像、工具白名单与预算；研究/报表走只读，执行单元写操作仍需确认
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
    const groupModelRouteStore = new DrizzleGroupModelRouteStore(dbHandle.db);
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
          ...watchdogRunOptions,
        });
      },
      logger: harnessLogger,
    });
    const groupModelRoutes = new GroupModelRouteService({
      store: groupModelRouteStore,
      onChange: (conversationId) => groupModelRouting.invalidate(conversationId),
    });

    const memoryStore = new DrizzleMemoryStore(dbHandle.db);
    const personIdentityStore = new DrizzlePersonIdentityStore(dbHandle.db);
    const personaProfileStore = new DrizzlePersonaProfileStore(dbHandle.db);
    const usageLedger = new DrizzleUsageLedgerStore(dbHandle.db);
    const modelPricing = parseModelPricing(process.env.MODEL_PRICING_JSON);
    const usageGuard = new UsageGuard({
      ledger: usageLedger,
      policy: () => configCenter.getUsagePolicy(),
      ...(modelPricing.configured ? { pricing: modelPricing } : {}),
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
        model: proactiveModel,
        temperature: 0,
        logger: harnessLogger,
      }),
      debounceMs: bystanderConfig.debounceMs,
      logger: harnessLogger,
    });
    const hierarchicalMemory = new HierarchicalMemoryManager({
      summaryStore: memoryStore,
      semanticStore: memoryStore,
      summarizer: new LlmEpisodeSummarizer({ model: proactiveModel }),
      extractor: new LlmSemanticFactExtractor({ model: proactiveModel }),
      compressionThresholdTokens: memoryConfig.compressionThresholdTokens,
      compressionRatio: memoryConfig.compressionRatio,
      semanticLimit: memoryConfig.semanticLimit,
      ...(embeddingClient ? { embedding: embeddingClient } : {}),
      logger: harnessLogger,
    });

    const personaRef = { ...configCenter.getLLMConfig().persona };
    const personaResolver = new PersonaResolver({
      store: personaProfileStore,
      fallback: () => personaRef,
    });
    const personSettings = new PersonSettingsService({
      preferences: new DrizzlePersonPreferencesStore(dbHandle.db),
      consents: new DrizzlePersonMemoryConsentStore(dbHandle.db),
    });
    const personIdentity = new PersonIdentityService({
      store: personIdentityStore,
      memories: memoryStore,
      personas: personaProfileStore,
      settings: personSettings,
      logger: harnessLogger,
      onBind: () => personaResolver.invalidate(),
    });
    const groupWorkspace = new GroupWorkspaceService({
      store: new DrizzleGroupWorkspaceStore(dbHandle.db),
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
    const interactionProviders = [
      new GroupWorkspaceToolProvider({ service: groupWorkspace, reports: groupReport }),
      new PersonSettingsToolProvider({ service: personSettings }),
      new PersonalMemoryToolProvider({ service: personalMemory }),
    ];
    toolProviders.push(...interactionProviders);
    logger.info(
      {
        providers: interactionProviders.map((provider) => provider.providerName),
      },
      'group and person tool providers registered',
    );
    const repository = new DrizzleConversationRepository(dbHandle.db);
    const harness = new AgentHarness({
      engine: groupModelRouting,
      investigationEngine,
      workerRuntimes,
      repository,
      assembler: new ContextAssembler({
        windowMessages: memoryConfig.windowMessages,
      }),
      persona: personaRef,
      personas: personaResolver,
      identity: personIdentity,
      policy: configCenter.getLoopPolicy(),
      windowMessages: memoryConfig.windowMessages,
      logger: harnessLogger,
      memory: hierarchicalMemory,
      glossary,
      personSettings: {
        buildPrompt: (personKey, conversationType) =>
          personSettings.buildPrompt(personKey, conversationType),
        resolveGroupMode: (personKey, conversationId) =>
          personSettings.resolveGroupMode(personKey, conversationId),
      },
      extensions: {
        build: async ({ message, text }) => {
          const config = configCenter.getExtensionsConfig();
          const isAdmin = configCenter.isAdmin(message.senderStaffId);
          const sections: string[] = [];
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
              const brief = await projects.buildBrief({
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
              const catalog = skills.buildCatalog({
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

    const jobStore = new DrizzleAgentJobStore(dbHandle.db);
    const taskStore = new DrizzleAgentTaskStore(dbHandle.db);
    const taskService = new TaskService({
      store: taskStore,
      isAdmin: (staffId) => configCenter.isAdmin(staffId),
      enqueue: async (message, prompt, taskId) =>
        jobStore.enqueue({
          conversationId: message.conversationId,
          conversationType: message.conversationType,
          messageId: `job_${randomUUID()}`,
          senderStaffId: message.senderStaffId,
          senderNick: message.senderNick,
          kind: 'task',
          prompt,
          metadata: {
            source: 'task',
            taskId,
            requestedAt: Date.now(),
          },
        }),
    });
    const notifyJobOwner = async (
      job: AgentJob,
      text: string,
    ): Promise<void> => {
      const staffId = job.senderStaffId.trim();
      if (!staffId || staffId === 'scheduler' || staffId === 'admin-api') return;
      try {
        const sent = await adminTextSender.send([staffId], text);
        if (!sent.ok) {
          logger.warn(
            { jobId: job.id, failed: sent.failed },
            'job result notification failed',
          );
        }
      } catch (error) {
        logger.warn(
          { jobId: job.id, error: errorText(error) },
          'job result notification failed',
        );
      }
    };
    const syncTaskForJob = async (
      job: AgentJob,
      status: 'completed' | 'failed',
      summary: string | null,
    ): Promise<void> => {
      const taskId = taskIdFromJob(job);
      if (!taskId) return;
      try {
        const task = await taskService.completeForJob(job, status, summary);
        if (!task) return;
        const subscribers = await taskService.subscribers(task.id);
        const targets = subscribers.filter(
          (sub) => sub.staffId && sub.staffId !== job.senderStaffId,
        );
        if (targets.length === 0) return;
        const text = [
          `任务线程「${task.title}」有更新。`,
          formatJobResultNotice(job),
        ].join('\n\n');
        for (const sub of targets) {
          const sent = await adminTextSender.send([sub.staffId], text);
          if (!sent.ok) {
            logger.warn(
              {
                jobId: job.id,
                taskId: task.id,
                staffId: sub.staffId,
                failed: sent.failed,
              },
              'task subscriber notification failed',
            );
          }
        }
      } catch (error) {
        logger.warn(
          { jobId: job.id, taskId, error: errorText(error) },
          'failed to sync task thread',
        );
      }
    };
    const jobRunner = new JobRunner({
      store: jobStore,
      logger: harnessLogger,
      intervalMs: envSeconds(process.env.JOB_RUNNER_INTERVAL_SECONDS, 5) * 1_000,
      leaseMs: envSeconds(process.env.JOB_LEASE_SECONDS, 1_800) * 1_000,
      maxConcurrency: envCount(process.env.JOB_MAX_CONCURRENCY, 2),
      execute: async (job, context) => {
        const worker =
          typeof job.metadata.worker === 'string' &&
          isWorkerName(job.metadata.worker)
            ? job.metadata.worker
            : undefined;
        const result = await harness.runJob(job, {
          emit: context.emit,
          signal: context.signal,
          ...(worker ? { worker } : {}),
        });
        if (result.watchdog?.action === 'pause') {
          throw new JobPauseError(result.watchdog.reason, result.watchdog.code);
        }
        const metadata = {
          ...(worker ? { worker } : {}),
          ...(result.workerOutput ? { workerOutput: result.workerOutput } : {}),
          ...(result.watchdog ? { watchdog: result.watchdog } : {}),
        };
        return {
          answer: result.answer,
          reasoning: result.reasoning,
          ...(result.model ? { model: result.model } : {}),
          usage: result.usage,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        };
      },
      onCompleted: async (job) => {
        const worker =
          typeof job.metadata.worker === 'string' ? job.metadata.worker : undefined;
        metrics.inc('agent_jobs_total', {
          kind: job.kind,
          status: 'succeeded',
          ...(worker ? { worker } : {}),
        });
        if (taskMemory) {
          try {
            await taskMemory.rememberJob(job);
          } catch (error) {
            logger.warn(
              { jobId: job.id, error: errorText(error) },
              'failed to save task result memory',
            );
          }
        }
        await notifyJobOwner(job, formatJobResultNotice(job));
        await syncTaskForJob(job, 'completed', job.result?.answer ?? null);
      },
      onFailed: async (job, error) => {
        const worker =
          typeof job.metadata.worker === 'string' ? job.metadata.worker : undefined;
        metrics.inc('agent_jobs_total', {
          kind: job.kind,
          status: job.status,
          ...(worker ? { worker } : {}),
        });
        await notifyJobOwner(
          job,
          `后台任务 ${job.id.slice(0, 8)} 执行失败：${error.slice(0, 500)}`,
        );
        await syncTaskForJob(job, 'failed', error);
      },
      onPaused: async (job, reason) => {
        const worker =
          typeof job.metadata.worker === 'string' ? job.metadata.worker : undefined;
        metrics.inc('agent_jobs_total', {
          kind: job.kind,
          status: 'paused',
          ...(worker ? { worker } : {}),
        });
        const shortId = job.id.slice(0, 8);
        await notifyJobOwner(
          job,
          [
            `后台任务 ${shortId} 已暂停：${reason.slice(0, 500)}`,
            `恢复：\`/job-resume ${shortId} 补充要求\`（可附一句约束，例如“只基于已有信息作答”）；终止：\`/job-cancel ${shortId}\`。`,
          ].join('\n'),
        );
      },
    });

    const resolveJobForMessage = async (
      message: InboundMessage,
      id: string,
    ): Promise<{ job: AgentJob } | { error: string }> => {
      const needle = id.trim().toLowerCase();
      if (!needle) return { error: '请输入任务 ID 前缀。' };
      const jobs = await jobStore.list({
        conversationId: message.conversationId,
        limit: 100,
      });
      const exact = jobs.find((job) => job.id.toLowerCase() === needle);
      if (exact) return { job: exact };
      const matches = jobs.filter((job) =>
        job.id.toLowerCase().startsWith(needle),
      );
      if (matches.length === 1 && matches[0]) return { job: matches[0] };
      if (matches.length > 1) {
        return { error: `ID 前缀 ${id} 匹配到多个任务，请多输入几位。` };
      }
      return { error: `未找到任务 ${id}，发送 /jobs 查看本会话任务。` };
    };

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

    const resolveEmployeeDisplayName = async (
      staffId: string | undefined,
    ): Promise<string | undefined> => {
      const trimmed = staffId?.trim() ?? '';
      if (
        !trimmed ||
        trimmed === 'scheduler' ||
        trimmed === 'admin-api' ||
        trimmed === 'job-runner'
      ) {
        return undefined;
      }
      const normalized = normalizeIdentityAlias(trimmed);
      if (normalized) {
        const found = await personIdentityStore
          .findPersonByAlias(normalized.alias)
          .catch(() => null);
        const displayName = found?.displayName?.trim();
        if (displayName && !isNonEmployeeTraceLabel(displayName)) {
          return displayName;
        }
      }
      const wl = await whitelistStore.get(trimmed).catch(() => null);
      const wlName = wl?.name?.trim();
      if (wlName && !isNonEmployeeTraceLabel(wlName)) {
        return wlName;
      }
      const dwsRecord = await identityService.getRecord(trimmed).catch(() => null);
      const dwsName = dwsRecord?.userName?.trim();
      if (dwsName && !isNonEmployeeTraceLabel(dwsName)) {
        return dwsName;
      }
      return undefined;
    };

    const recordTrace = async (
      collector: TraceCollector,
      message: InboundMessage,
      result: RunResult | null,
      proactive: boolean,
    ): Promise<void> => {
      if (!result) return;
      try {
        const record = collector.build({ message, result, proactive });
        const rawSource =
          typeof message.rawPayload?.source === 'string'
            ? message.rawPayload.source
            : undefined;
        if (isNonEmployeeTraceLabel(record.senderNick) || rawSource) {
          const creatorStaffId =
            typeof message.rawPayload?.createdBy === 'string' &&
            message.rawPayload.createdBy.trim()
              ? message.rawPayload.createdBy.trim()
              : record.senderStaffId;
          const employeeName =
            (typeof message.rawPayload?.creatorNick === 'string' &&
            message.rawPayload.creatorNick.trim()
              ? message.rawPayload.creatorNick.trim()
              : undefined) ??
            (await resolveEmployeeDisplayName(creatorStaffId));
          record.senderNick = formatTraceSenderNick({
            senderNick: record.senderNick,
            ...(rawSource ? { source: rawSource } : {}),
            ...(employeeName ? { employeeName } : {}),
          });
        }
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

    const deliverFallbackText = async (
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
      if (message.conversationType === '1') {
        const staffId = (
          message.cardDeliverUserId ||
          message.senderStaffId ||
          ''
        ).trim();
        if (staffId && staffId !== 'scheduler' && staffId !== 'admin-api') {
          for (const chunk of splitForDelivery(text)) {
            await adminTextSender.send([staffId], chunk);
          }
          return;
        }
      }
      await sendSessionWebhook(message, text, cardLogger, {
        mention: !proactive,
      });
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
      if (!streamer.isAvailable) {
        await deliverFallbackText(message, text, proactive);
      }
    };

    const notifyDwsWriteTask = async (
      message: InboundMessage,
      text: string,
    ): Promise<void> => {
      try {
        await replyTo(message, text);
      } catch (error) {
        logger.warn(
          {
            conversationId: message.conversationId,
            error: errorText(error),
          },
          'dws write task reply failed, fallback to direct message',
        );
        const result = await adminTextSender.send([message.senderStaffId], text);
        if (!result.ok) {
          throw new Error(result.failed[0]?.error ?? '单聊消息发送失败');
        }
      }
    };

    dwsWriteTasksService = new DwsWriteTaskService({
      store: new DrizzleDwsWriteTaskStore(dbHandle.db),
      identity: identityService,
      resume: (task) => executeDwsWriteTask(task),
      notify: notifyDwsWriteTask,
      logger: harnessLogger,
    });
    await dwsWriteTasksService.start();

    const surfaceSilentInvestigation = async (
      message: InboundMessage,
      text: string,
    ): Promise<void> => {
      const webhook = message.rawPayload.sessionWebhook;
      if (typeof webhook === 'string' && webhook) {
        await sendSessionWebhook(message, text, cardLogger, { mention: false });
        return;
      }
      const streamer = createStreamer(message);
      await streamer.start();
      streamer.handle({ type: 'answer_delta', content: text });
      await streamer.finish();
      if (!streamer.isAvailable) {
        throw new Error('卡片创建失败，且该消息没有可用的 sessionWebhook');
      }
    };

    const silentInvestigationConfig = resolveSilentInvestigationConfig(
      process.env,
    );
    const silentInvestigation = new SilentInvestigationService({
      config: silentInvestigationConfig,
      cooldown: new CooldownLimiter(),
      investigate: ({ message, query, signal, maxWallTimeMs }) =>
        harness.investigate(message, {
          query,
          maxWallTimeMs,
          ...(signal ? { signal } : {}),
        }),
      surface: surfaceSilentInvestigation,
      auditStore: new DrizzleSilentInvestigationStore(dbHandle.db),
      logger: harnessLogger,
      onSurfaced: (message) => cooldown.markReplied(message.conversationId),
    });
    logger.info(
      { ...silentInvestigationConfig },
      'silent investigation configured',
    );

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

    const resolveCommandPersonKey = async (
      message: InboundMessage,
    ): Promise<string> => {
      try {
        return (await personIdentity.resolve(message)).personKey;
      } catch (error) {
        logger.warn(
          {
            conversationId: message.conversationId,
            senderStaffId: message.senderStaffId,
            error: errorText(error),
          },
          'command identity resolution failed, using isolated fallback',
        );
        return defaultPersonKeyFor(message);
      }
    };

    /**
     * 登录事件只回复发起授权的那条消息；消息快照缺失时才退回会话最后一条。
     * 个人授权传入 staffId，避免在群里回复到别人的消息上。
     */
    const pendingNoticeMessage = (
      entry: { conversationId: string; messageId?: string },
      staffId?: string,
    ): InboundMessage | null => {
      const byId = entry.messageId
        ? runControl.messageById(entry.messageId)
        : null;
      if (byId) {
        return staffId && byId.senderStaffId !== staffId ? null : byId;
      }
      const last = runControl.lastMessage(entry.conversationId);
      if (!last) return null;
      return staffId && last.senderStaffId !== staffId ? null : last;
    };

    /**
     * 授权完成后按保存的工具与参数精确执行，不重新跑模型规划。
     * 执行失败直接抛出，由 DwsWriteTaskService 保留失败记录并通知用户。
     */
    const executeDwsWriteTask = async (task: DwsWriteTask): Promise<void> => {
      const registry = toolRegistry;
      if (!registry) throw new Error('工具注册表尚未就绪');
      if (!executionPolicy.allows(task.toolName)) {
        throw new Error(`工具 ${task.toolName} 已被执行策略禁用`);
      }
      const requester = task.message;
      const personKey = await resolveCommandPersonKey(requester);
      const ctx: ExecutionContext = {
        conversationId: requester.conversationId,
        messageId: requester.messageId,
        senderStaffId: requester.senderStaffId,
        senderNick: requester.senderNick,
        conversationType: requester.conversationType,
        personKey,
        deadlineAt: Date.now() + 120_000,
        now: Date.now,
        notify: async (text) => {
          await notifyDwsWriteTask(requester, text);
        },
      };
      const gate = await registry.dwsAuthorizationGate(ctx, true);
      if (gate) throw new Error(gate.userText);
      if (requiresExplicitDwsConfirmation(task)) {
        const action = pendingActions.put({
          conversationId: task.conversationId,
          toolName: task.toolName,
          args: task.args,
          risk: task.risk,
          requestedBy: {
            staffId: requester.senderStaffId,
            ...(requester.senderNick ? { nick: requester.senderNick } : {}),
            ...(requester.messageId ? { messageId: requester.messageId } : {}),
            ...(requester.conversationType
              ? { conversationType: requester.conversationType }
              : {}),
            ...(personKey ? { personKey } : {}),
          },
        });
        await notifyDwsWriteTask(
          requester,
          `${formatApprovalPrompt(action, pendingActions.ttlSeconds)}\n\n这是授权前你发起的写操作，确认后才会执行。`,
        );
        return;
      }
      const tool = (await registry.assembleTools(ctx)).find(
        (item) => item.name === task.toolName,
      );
      if (!tool) throw new Error(`工具 ${task.toolName} 当前不可用`);
      const output = await runWithTimeout(
        tool.executeStructured
          ? tool.executeStructured(task.args, ctx).then((result) =>
              typeof result === 'string' ? result : result.text,
            )
          : tool.execute(task.args, ctx),
        120_000,
        task.toolName,
      );
      const clipped =
        output.length > 2_000 ? `${output.slice(0, 2_000)}…` : output;
      await notifyDwsWriteTask(
        requester,
        `已按本人授权自动执行 \`${task.toolName}\`：\n${clipped}`,
      );
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
          `排队中的问题：${runControl.pendingCount()}`,
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
        const at = formatShanghaiDateTime(Date.parse(latest.createdAt));
        return [
          `最近一次执行：${at}`,
          `问题：${latest.question.slice(0, 120)}`,
          `步骤：${latest.stepCount} · tokens：${latest.totalTokens} · 耗时：${(latest.durationMs / 1000).toFixed(1)}s`,
          `答案摘要：${latest.answer.slice(0, 200)}`,
        ].join('\n');
      },
      dwsStatus: async (message) => {
        const status = await identityService.status(message.senderStaffId, {
          force: true,
        });
        const label =
          status.state === 'authenticated'
            ? '已授权'
            : status.state === 'expired'
              ? '已过期，需要重新授权'
              : status.state === 'unbound'
                ? status.record
                  ? status.record.consentVersion === DWS_CONSENT_VERSION
                    ? '已同意，尚未完成设备授权'
                    : '授权范围已更新，需要重新同意'
                  : '尚未同意授权'
                : '不可用';
        const record = status.record;
        return [
          `本人 DWS 授权：${label}`,
          ...(record?.userName
            ? [
                `账号：${record.userName}${
                  record.corpName ? ` @ ${record.corpName}` : ''
                }`,
              ]
            : []),
          ...(record?.profile ? [`profile：${record.profile}`] : []),
          ...(record
            ? [
                `授权范围：${
                  record.writeEnabled
                    ? '只读 + 自动写操作'
                    : record.writeOptOut
                      ? '仅只读（已手动关闭自动写）'
                      : '仅只读（下次写请求会自动升级）'
                }`,
              ]
            : []),
          ...(status.token?.expiresAt
            ? [`访问令牌到期：${status.token.expiresAt}`]
            : []),
          ...(status.token?.refreshExpiresAt
            ? [`刷新令牌到期：${status.token.refreshExpiresAt}`]
            : []),
          ...(status.message ? [`说明：${status.message}`] : []),
          ...(status.state !== 'authenticated'
            ? ['发送「授权范围」查看授权说明，同意后发送「授权」完成设备码授权。']
            : []),
        ].join('\n');
      },
      dwsLogin: async (message) => {
        const current = await identityService.status(message.senderStaffId, {
          force: true,
        });
        if (current.state === 'authenticated') {
          return `本人 DWS 授权当前有效${
            current.record?.userName ? `（${current.record.userName}）` : ''
          }，无需重新登录。如需切换到其他账号或撤销授权，先发送「退出授权」或「撤销授权」。`;
        }
        let ticket;
        try {
          ticket = await identityService.startLogin(message.senderStaffId);
        } catch (error) {
          if (error instanceof DwsIdentityError && error.code === 'consent-required') {
            return '请先发送「授权范围」查看授权说明，再发送「同意授权」表示同意。';
          }
          const reason =
            error instanceof Error ? error.message : String(error);
          return `发起本人 DWS 授权失败：${reason}`;
        }
        identityService.markPending(message.senderStaffId, message.conversationId, {
          resume: false,
          messageId: message.messageId,
        });
        return [
          '已发起本人 DWS 设备授权，请在钉钉中打开以下链接完成授权（15 分钟内有效）：',
          ticket.verifyUrl,
          `授权码：${ticket.userCode}`,
          '请务必使用你本人的钉钉账号完成授权，授权完成后我会在这里通知你。',
        ].join('\n');
      },
      dwsConsent: async (message, args) => {
        const action = args[0]?.toLowerCase();
        if (!action || action === 'show') {
          return formatDwsConsentText(
            await identityService.getRecord(message.senderStaffId),
          );
        }
        if (action === 'agree') {
          const record = await identityService.recordConsent(
            message.senderStaffId,
          );
          return [
            '已记录你对 DWS 授权范围的同意（日程、待办、审批、通讯录、文档 / 知识库）。',
            '下一步请在单聊发送「授权」完成设备码授权。',
            record.writeEnabled
              ? '授权完成后普通写操作会直接执行，高危操作仍需回复「确认」。'
              : '授权完成后，你提出创建或修改日程、待办、审批时，我会自动获得写权限并直接执行；只想只读可随时发送「改回只读」。',
          ]
            .filter(Boolean)
            .join('\n');
        }
        if (action === 'write' || action === 'read') {
          try {
            await identityService.setWriteEnabled(
              message.senderStaffId,
              action === 'write',
            );
          } catch (error) {
            if (
              error instanceof DwsIdentityError &&
              error.code === 'consent-required'
            ) {
              return '请先发送「同意授权」同意只读授权范围。';
            }
            throw error;
          }
          if (action === 'write') {
            return '已允许写操作：日程、待办、审批等普通写操作会直接执行；取消日程、覆盖文档等高危操作仍需回复「确认」。发送「改回只读」可改回只读。';
          }
          await dwsWriteTasksService?.cancelForStaff(
            message.senderStaffId,
            '用户已改回只读',
            '已改回只读，等待授权后自动执行的写操作已取消。',
          );
          return '已改回只读：后续写操作不会自动执行，需要时发送「允许写操作」重新允许。';
        }
        if (action === 'revoke') {
          await dwsWriteTasksService?.cancelForStaff(
            message.senderStaffId,
            '用户已撤销 DWS 授权',
            '已撤销 DWS 授权，等待中的写操作已取消。',
          );
          await identityService.revokeConsent(message.senderStaffId);
          return '已撤销 DWS 授权同意，并清除本机绑定的加密凭据目录。如需再次使用，请重新发送「同意授权」并发送「授权」。';
        }
        return '可用口令：发送「授权范围」、「同意授权」、「允许写操作」、「改回只读」、「撤销授权」';
      },
      dwsLogout: async (message) => {
        await dwsWriteTasksService?.cancelForStaff(
          message.senderStaffId,
          '用户已退出 DWS 登录',
          '已退出 DWS 登录，等待授权后自动执行的写操作已取消。',
        );
        const cleared = await identityService.logout(message.senderStaffId);
        return cleared
          ? '已清除你本机的 DWS 登录态，授权同意记录仍保留。如需重新授权，发送「重新授权」；如需彻底撤销同意，发送「撤销授权」。'
          : '当前没有可清除的 DWS 登录态。如需撤销同意记录，发送「撤销授权」。';
      },
      dwsSystemStatus: async () => {
        const status = await authManager.status({ force: true });
        const label =
          status.state === 'authenticated'
            ? '已授权'
            : status.state === 'expired'
              ? '已过期，需要重新授权'
              : '不可用';
        return [
          `系统级 DWS 授权（仅用于旁听等基础设施）：${label}`,
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
      dwsSystemLogin: async (message) => {
        const current = await authManager.status({ force: true });
        if (current.state === 'authenticated') {
          return '系统级 DWS 授权当前有效，无需重新登录。员工个人业务请让他们自行发送「授权」。';
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
            return `发起系统级 DWS 授权失败：${reason}`;
          }
        }
        authManager.markPending(message.conversationId, {
          resume: false,
          messageId: message.messageId,
        });
        return [
          '已发起系统级 DWS 设备授权（仅用于旁听等基础设施），请在钉钉中打开以下链接完成授权（15 分钟内有效）：',
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
        if (!executionPolicy.allows(action.toolName)) {
          metrics.inc('agent_tool_confirmations_total', { result: 'blocked' });
          return `工具 \`${action.toolName}\` 已被执行策略禁用，操作已取消。`;
        }
        const registry = toolRegistry;
        if (!registry) return '工具注册表尚未就绪，操作已取消。';
        const base = buildConfirmedActionContext({ action, fallback: message });
        const personKey =
          action.requestedBy.personKey ??
          (await resolveCommandPersonKey(base.requesterMessage));
        const ctx: ExecutionContext = {
          ...base.context,
          personKey,
          notify: async (text) => {
            await replyTo(message, text);
          },
        };
        if (!isRequester) {
          logger.info(
            {
              conversationId: action.conversationId,
              toolName: action.toolName,
              requester: action.requestedBy.staffId,
              confirmer: message.senderStaffId,
            },
            'admin confirmed tool action on behalf of requester',
          );
        }
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
        const cancelledWrite =
          (await dwsWriteTasksService?.cancelByConversation(conversationId)) ??
          false;
        metrics.inc('agent_tool_confirmations_total', {
          result: cancelled || cancelledWrite ? 'cancelled' : 'none',
        });
        return cancelled || cancelledWrite
          ? '已取消待确认或待授权后自动执行的操作。'
          : '没有待确认的操作。';
      },
      remind: (message, args) =>
        personalAssistant.handleRemindCommand(message, args),
      reports: (message, args) =>
        personalAssistant.handleReportCommand(message, args),
      submitJob: async (message, prompt) => {
        const job = await jobStore.enqueue({
          conversationId: message.conversationId,
          conversationType: message.conversationType,
          messageId: `job_${randomUUID()}`,
          senderStaffId: message.senderStaffId,
          senderNick: message.senderNick,
          kind: 'task',
          prompt,
          metadata: { source: 'command', requestedAt: Date.now() },
        });
        metrics.inc('agent_jobs_total', { kind: 'task', status: 'queued' });
        logger.info(
          { jobId: job.id, conversationId: job.conversationId },
          'agent job enqueued',
        );
        return [
          `已提交后台任务 ${job.id.slice(0, 8)}，完成后会通过机器人单聊通知你。`,
          '查看进度：`/jobs`；查看详情：`/job-status <id>`；取消：`/job-cancel <id>`。',
        ].join('\n');
      },
      submitWorker: async (message, worker, prompt) => {
        if (!isWorkerName(worker)) {
          return '未知 Worker，可选：research、ops、report。';
        }
        const profile = workerRegistry.get(worker);
        const job = await jobStore.enqueue({
          conversationId: message.conversationId,
          conversationType: message.conversationType,
          messageId: `job_${randomUUID()}`,
          senderStaffId: message.senderStaffId,
          senderNick: message.senderNick,
          kind: 'worker',
          prompt,
          metadata: {
            source: 'command',
            worker,
            requestedAt: Date.now(),
          },
        });
        metrics.inc('agent_jobs_total', {
          kind: 'worker',
          status: 'queued',
          worker,
        });
        logger.info(
          {
            jobId: job.id,
            conversationId: job.conversationId,
            worker,
          },
          'worker job enqueued',
        );
        return [
          `已提交 ${profile.title} 任务 ${job.id.slice(0, 8)}，完成后会通过机器人单聊通知你。`,
          `执行范围：${profile.description}。查看进度：\`/jobs\`；详情：\`/job-status <id>\`；取消：\`/job-cancel <id>\`。`,
        ].join('\n');
      },
      tasks: (message, args) => taskService.handleCommand(message, args),
      group: async (message, args) => {
        const personKey = await resolveCommandPersonKey(message);
        if (args[0]?.toLowerCase() === 'report') {
          return groupReport.handleCommand(message, args.slice(1));
        }
        return groupWorkspace.handleCommand(message, args, personKey);
      },
      pref: async (message, args) =>
        personSettings.handlePreferenceCommand(
          message,
          args,
          await resolveCommandPersonKey(message),
        ),
      privacy: async (message, args) =>
        personSettings.handleConsentCommand(
          message,
          args,
          await resolveCommandPersonKey(message),
        ),
      memory: async (message, args) =>
        personalMemory.handleCommand(
          message,
          args,
          await resolveCommandPersonKey(message),
        ),
      listJobs: async (message) =>
        formatJobList(
          await jobStore.list({
            conversationId: message.conversationId,
            limit: 10,
          }),
        ),
      jobStatus: async (message, id) => {
        const resolved = await resolveJobForMessage(message, id);
        if ('error' in resolved) return resolved.error;
        return formatJob(resolved.job);
      },
      cancelJob: async (message, id) => {
        const resolved = await resolveJobForMessage(message, id);
        if ('error' in resolved) return resolved.error;
        const { job } = resolved;
        if (
          job.senderStaffId !== message.senderStaffId &&
          !configCenter.isAdmin(message.senderStaffId)
        ) {
          return '只有任务发起人或管理员可以取消该任务。';
        }
        if (
          job.status === 'succeeded' ||
          job.status === 'failed' ||
          job.status === 'cancelled'
        ) {
          return `任务 ${job.id.slice(0, 8)} 已${formatJobStatus(job.status)}，无需取消。`;
        }
        const cancelled = await jobStore.cancel(job.id);
        if (!cancelled) return '任务状态已变化，请发送 /jobs 重新查看。';
        metrics.inc('agent_jobs_total', {
          kind: cancelled.kind,
          status: 'cancelled',
        });
        logger.info({ jobId: job.id }, 'agent job cancelled');
        try {
          await taskService.completeForJob(
            cancelled,
            'failed',
            '后台任务已取消',
          );
        } catch (error) {
          logger.warn(
            { jobId: job.id, error: errorText(error) },
            'failed to sync cancelled task thread',
          );
        }
        return `已取消后台任务 ${job.id.slice(0, 8)}。`;
      },
      resumeJob: async (message, id, note) => {
        const resolved = await resolveJobForMessage(message, id);
        if ('error' in resolved) return resolved.error;
        const { job } = resolved;
        if (
          job.senderStaffId !== message.senderStaffId &&
          !configCenter.isAdmin(message.senderStaffId)
        ) {
          return '只有任务发起人或管理员可以恢复该任务。';
        }
        if (job.status !== 'paused') {
          return `任务 ${job.id.slice(0, 8)} 当前为「${formatJobStatus(job.status)}」，只有已暂停的任务可以恢复。`;
        }
        const trimmedNote = note?.trim().slice(0, 500) || undefined;
        const prompt = trimmedNote
          ? `${job.prompt}\n\n恢复时补充要求：${trimmedNote}`
          : undefined;
        const resumed = await jobStore.resume(
          job.id,
          prompt ? { prompt } : {},
        );
        if (!resumed) return '任务状态已变化，请发送 /jobs 重新查看。';
        metrics.inc('agent_jobs_total', {
          kind: resumed.kind,
          status: 'queued',
        });
        logger.info(
          { jobId: job.id, withNote: Boolean(trimmedNote) },
          'agent job resumed',
        );
        return [
          `已恢复后台任务 ${resumed.id.slice(0, 8)}，将重新排队执行。`,
          trimmedNote ? `已追加补充要求：${trimmedNote.slice(0, 200)}` : '',
          '查看进度：`/jobs`；再次取消：`/job-cancel <id>`。',
        ]
          .filter(Boolean)
          .join('\n');
      },
      reply: replyTo,
    });

    const QUEUE_CANCELLED_TEXT = '这条问题已按 /stop 取消，没有执行。';

    /** 排队时在卡片上给出位置，避免用户以为机器人没收到 */
    function markQueued(streamer: CardStreamer, run: BeginRunResult): void {
      if (run.queuedAhead <= 0) return;
      streamer.handle({
        type: 'status',
        message: `已收到，正在按顺序处理（前面还有 ${run.queuedAhead} 条问题）…`,
      });
    }

    async function runTurn(
      message: InboundMessage,
      run: BeginRunResult,
      proactive = false,
      startedStreamer?: CardStreamer,
    ): Promise<void> {
      const mention = replyMention(message, proactive);
      const streamer =
        startedStreamer ?? createStreamer(message, { mention });
      const collector = new TraceCollector();
      const emit = makeEmit(collector, streamer);
      if (!startedStreamer) await streamer.start();
      markQueued(streamer, run);
      try {
        await run.started;
        if (run.signal.aborted) {
          streamer.handle({
            type: 'answer_delta',
            content: QUEUE_CANCELLED_TEXT,
          });
          await streamer.finish();
          return;
        }
        const result = await harness.handleMessage(message, {
          emit,
          signal: run.signal,
          proactive,
          notify: async (text) => replyTo(message, text, proactive),
        });
        await streamer.finish();
        const overflow = streamer.takeOverflowAnswer();
        if (overflow) {
          await deliverFallbackText(message, overflow, proactive);
        }
        await recordTrace(collector, message, result, proactive);
        if (result && !streamer.isAvailable && result.answer) {
          await deliverFallbackText(message, result.answer, proactive);
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
          await deliverFallbackText(
            message,
            FALLBACK_ERROR_TEXT,
            proactive,
          );
        }
      } finally {
        run.finish();
        metrics.set('agent_active_runs', runControl.activeCount());
      }
    }

    async function handleIncoming(message: InboundMessage): Promise<void> {
      if (message.conversationType === '2') {
        if (message.conversationTitle?.trim()) {
          void groupDirectory
            .upsertGroupTitle(
              message.conversationId,
              message.conversationTitle,
              'stream',
            )
            .catch(() => {});
        } else {
          const dirGroup = await groupDirectory
            .getGroup(message.conversationId)
            .catch(() => null);
          if (dirGroup?.name) {
            message = { ...message, conversationTitle: dirGroup.name };
          }
        }
      }
      if (message.mentionOnly) {
        const context = findMentionOnlyContext(message, transcriptBuffer);
        if (!context) {
          logger.info(
            {
              messageId: message.messageId,
              conversationId: message.conversationId,
              senderStaffId: message.senderStaffId,
            },
            'mention-only message without recent context, replying fallback',
          );
          await replyTo(message, MENTION_ONLY_FALLBACK_REPLY);
          return;
        }
        logger.info(
          {
            messageId: message.messageId,
            conversationId: message.conversationId,
            mergedFromMessageId: context.messageId,
          },
          'mention-only message merged with recent context',
        );
        message = {
          ...message,
          text: context.text,
          mentionOnly: false,
          rawPayload: {
            ...message.rawPayload,
            mentionOnly: true,
            mergedFromMessageId: context.messageId,
          },
        };
      }
      if (await commandRouter.tryHandle(message)) return;
      // 先入队再解析附件：同一会话按到达顺序执行，慢附件不能把后一条问题插到前面
      const run = runControl.begin(message);
      metrics.set('agent_active_runs', runControl.activeCount());
      let effective = message;
      try {
        // 先建卡贴表情再解析附件，避免视觉理解耗时期间用户看不到任何反馈
        emotionReplier.mark(message);
        const streamer = createStreamer(message, {
          mention: replyMention(message),
        });
        const cardReady = streamer.start();
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
        await runTurn(effective, run, false, streamer);
      } finally {
        // runTurn 已释放时是幂等空操作；异常提前退出时靠这里归还队列
        run.finish();
        metrics.set('agent_active_runs', runControl.activeCount());
        void emotionReplier.clear(message);
      }
    }

    async function runProactiveTurn(
      message: InboundMessage,
      decision: BystanderEvaluationResult,
    ): Promise<void> {
      const run = runControl.begin(message);
      metrics.set('agent_active_runs', runControl.activeCount());
      let streamer: CardStreamer | null = null;
      const collector = new TraceCollector();
      try {
        streamer = createStreamer(message);
        const emit = makeEmit(collector, streamer);
        await streamer.start();
        markQueued(streamer, run);
        await run.started;
        if (run.signal.aborted) {
          streamer.handle({
            type: 'answer_delta',
            content: QUEUE_CANCELLED_TEXT,
          });
          await streamer.finish();
          return;
        }
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
        streamer?.handle({ type: 'error', message: FALLBACK_ERROR_TEXT });
        await streamer?.finish();
        await recordTrace(collector, message, EMPTY_RESULT, true);
        if (!streamer || !streamer.isAvailable) {
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
        const last = pendingNoticeMessage(entry);
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
        const last = pendingNoticeMessage(entry);
        if (!last) continue;
        void replyTo(
          last,
          `DWS 重新授权未完成：${reason}。发送「系统重新授权」可重试。`,
        ).catch((error) =>
          logger.warn({ error: errorText(error) }, 'dws failure notice failed'),
        );
      }
    });

    identityService.on('login-success', ({ staffId, status }) => {
      const pending = identityService.takePending(staffId);
      logger.info(
        {
          staffId,
          user: status.record?.userName,
          profile: status.record?.profile,
          pending: pending.length,
        },
        'personal dws identity linked',
      );
      void (async () => {
        const claimed = new Set(
          (await dwsWriteTasksService?.resumeForStaff(staffId)) ?? [],
        );
        for (const entry of pending) {
          if (claimed.has(entry.conversationId)) continue;
          const last = pendingNoticeMessage(entry, staffId);
          if (!last) continue;
          if (!entry.resume) {
            await replyTo(
              last,
              `本人 DWS 授权已完成${
                status.record?.userName ? `（${status.record.userName}）` : ''
              }，可以继续使用 DWS 查询。`,
            );
            continue;
          }
          await replyTo(last, '本人 DWS 授权已完成，正在继续刚才的问题…');
          await handleIncoming(last);
        }
      })().catch((error) =>
        logger.warn(
          { staffId, error: errorText(error) },
          'personal dws resume failed',
        ),
      );
    });
    identityService.on('login-failed', ({ staffId, reason }) => {
      const pending = identityService.takePending(staffId);
      logger.warn(
        { staffId, reason, pending: pending.length },
        'personal dws identity not linked',
      );
      void (async () => {
        const failed = new Set(
          (await dwsWriteTasksService?.failForStaff(staffId, reason)) ?? [],
        );
        for (const entry of pending) {
          if (failed.has(entry.conversationId)) continue;
          const last = pendingNoticeMessage(entry, staffId);
          if (!last) continue;
          await replyTo(
            last,
            `本人 DWS 授权未完成：${reason}。发送「授权范围」查看授权说明后，再发送「重新授权」重试。`,
          );
        }
      })().catch((error) =>
        logger.warn(
          { staffId, error: errorText(error) },
          'personal dws failure notice failed',
        ),
      );
    });

    const sendPersonalMessages = async (
      task: ScheduledTask,
      text: string,
    ): Promise<void> => {
      if (task.conversationType !== '1') {
        throw new Error(`个人任务 ${task.id} 仅允许在单聊投递`);
      }
      const staffId = task.createdBy.trim();
      if (!isStaffUserId(staffId)) {
        throw new Error(`个人任务 ${task.id} 缺少有效的创建人`);
      }
      const chunks = splitForDelivery(text);
      for (const chunk of chunks) {
        const result = await adminTextSender.send([staffId], chunk);
        if (!result.ok) {
          throw new Error(
            result.failed[0]?.error ?? '单聊消息发送失败',
          );
        }
      }
      logger.info(
        { taskId: task.id, staffId, kind: task.kind, chunks: chunks.length },
        'personal task delivered',
      );
    };

    const sendGroupMessages = async (
      task: ScheduledTask,
      text: string,
    ): Promise<void> => {
      if (task.conversationType !== '2') {
        throw new Error(`群任务 ${task.id} 仅允许在群聊投递`);
      }
      const now = Date.now();
      const creatorName = await resolveEmployeeDisplayName(task.createdBy);
      const message: InboundMessage = {
        messageId: `group_report_${task.id}_${now}`,
        conversationId: task.conversationId,
        conversationType: '2',
        senderStaffId: 'scheduler',
        senderNick: formatTraceSenderNick({
          senderNick: '群定时播报',
          ...(creatorName ? { employeeName: creatorName } : {}),
        }),
        cardDeliverUserId: '',
        isAtBot: false,
        text: '',
        rawPayload: {
          source: 'scheduled_task',
          taskId: task.id,
          createdBy: task.createdBy,
          ...(creatorName ? { creatorNick: creatorName } : {}),
        },
        timestamp: now,
      };
      const streamer = createStreamer(message);
      await streamer.start();
      for (const chunk of splitForDelivery(text)) {
        streamer.handle({ type: 'answer_delta', content: chunk });
      }
      await streamer.finish();
      logger.info(
        { taskId: task.id, conversationId: task.conversationId },
        'group report delivered',
      );
    };

    const executeScheduledTask = async (task: ScheduledTask): Promise<void> => {
      const now = Date.now();
      if (task.kind === 'reminder') {
        metrics.inc('scheduled_task_runs_total', { kind: task.kind });
        const text = personalAssistant.reminderDeliveryText(task);
        if (task.conversationType === '2') {
          await sendGroupMessages(task, text);
        } else {
          await sendPersonalMessages(task, text);
        }
        return;
      }
      if (task.kind === 'group_report') {
        metrics.inc('scheduled_task_runs_total', { kind: task.kind });
        const text = await groupWorkspace.buildDigest(task.conversationId);
        await sendGroupMessages(task, text);
        return;
      }
      if (
        task.kind === 'daily_report' ||
        task.kind === 'weekly_report' ||
        task.kind === 'monthly_report'
      ) {
        metrics.inc('scheduled_task_runs_total', { kind: task.kind });
        const text = await personalAssistant.reportDeliveryText(task);
        await sendPersonalMessages(task, text);
        return;
      }
      const isPersonal = task.conversationType === '1';
      const targetStaffId = isPersonal
        ? isStaffUserId(task.createdBy)
          ? task.createdBy.trim()
          : isStaffUserId(task.conversationId)
            ? task.conversationId.trim()
            : ''
        : '';
      if (isPersonal && !targetStaffId) {
        throw new Error(`个人定时任务 ${task.id} 缺少有效的创建人 staffId`);
      }
      const creatorStaffId = isStaffUserId(task.createdBy)
        ? task.createdBy.trim()
        : targetStaffId;
      const creatorName = await resolveEmployeeDisplayName(creatorStaffId);
      const message: InboundMessage = {
        messageId: `scheduled_${task.id}_${now}`,
        conversationId: task.conversationId,
        conversationType: task.conversationType,
        senderStaffId: isPersonal ? targetStaffId : 'scheduler',
        senderNick: formatTraceSenderNick({
          senderNick: '定时任务',
          source: 'scheduled_task',
          ...(creatorName ? { employeeName: creatorName } : {}),
        }),
        cardDeliverUserId: isPersonal ? targetStaffId : '',
        isAtBot: isPersonal,
        text: task.prompt,
        rawPayload: {
          source: 'scheduled_task',
          taskId: task.id,
          createdBy: task.createdBy,
          ...(creatorName ? { creatorNick: creatorName } : {}),
        },
        timestamp: now,
      };
      logger.info(
        { taskId: task.id, conversationId: task.conversationId },
        'scheduled task triggered',
      );
      metrics.inc('scheduled_task_runs_total', { kind: task.kind });
      const run = runControl.begin(message);
      metrics.set('agent_active_runs', runControl.activeCount());
      try {
        await runTurn(message, run, true);
      } finally {
        run.finish();
        metrics.set('agent_active_runs', runControl.activeCount());
      }
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
        if (current.kind !== 'prompt') {
          throw new Error('个人提醒与定时报告请由本人在单聊中管理（管理端仅支持删除）');
        }
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
        if (current.kind !== 'prompt') {
          throw new Error('个人提醒与定时报告不支持由管理端立即执行');
        }
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
      if (message.conversationType === '2') {
        if (message.conversationTitle?.trim()) {
          void groupDirectory
            .upsertGroupTitle(
              message.conversationId,
              message.conversationTitle,
              'stream',
            )
            .catch(() => {});
        } else {
          const dirGroup = await groupDirectory
            .getGroup(message.conversationId)
            .catch(() => null);
          if (dirGroup?.name) {
            message = { ...message, conversationTitle: dirGroup.name };
          }
        }
      }
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
      if (decision.action === 'PROACTIVE_REPLY') {
        await runProactiveTurn(message, decision);
        return;
      }
      // SILENT 不打扰群成员，但可疑问题转入只读后台调查，证据达标才浮出
      void silentInvestigation.consider({
        message,
        decision,
        policy: groupPolicy,
      });
    };

    const gatewayOptions = () => ({
      logger: gatewayLogger,
      transcriptBuffer,
      ...(sharedState ? { dedupeStore: sharedState } : {}),
      whitelist,
      handler: handleIncoming,
      cardActionHandler: async (action: CardActionEvent) => {
        const allowed = await whitelist.isStaffAllowed(
          action.userId ?? '',
          action.nick,
        );
        if (!allowed) {
          logger.info(
            {
              actionId: action.actionId,
              conversationId: action.conversationId,
              userId: action.userId,
            },
            'card action denied by user whitelist',
          );
          return;
        }
        const cardUserName =
          action.nick?.trim() ||
          (await resolveEmployeeDisplayName(action.userId));
        const message: InboundMessage = {
          messageId: `card_${action.actionId}_${action.outTrackId || action.conversationId}_${Date.now()}`,
          conversationId: action.conversationId,
          conversationType: action.conversationType,
          senderStaffId: action.userId || `card_user_${action.conversationId}`,
          senderNick: formatTraceSenderNick({
            senderNick: '卡片用户',
            source: 'card_action',
            ...(cardUserName ? { employeeName: cardUserName } : {}),
          }),
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
      const knownBotNames = await groupDirectory
        .listDistinctBotNames()
        .catch(() => [] as string[]);
      const listener = new DwsGroupMessageListener({
        binary: process.env.DWS_BINARY?.trim() || 'dws',
        onMessage: handleBystanderMessage,
        shouldIgnore: (messageId) => gateway?.hasSeen(messageId) === true,
        isSenderAllowed: (message) =>
          whitelist.isOpenIdAllowed(
            message.senderStaffId,
            message.senderNick,
          ),
        ignoreSenders: [
          ...new Set([
            ...parseList(process.env.BYSTANDER_LISTEN_IGNORE_SENDERS),
            configCenter.getLLMConfig().persona.name,
            ...knownBotNames,
          ]),
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
          startProjectSync();
          taskScheduler.start();
          jobRunner.start();
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
          stopProjectSync();
          void taskScheduler.stop();
          void jobRunner.stop();
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
      taskScheduler.start();
      jobRunner.start();
      void startBystanderListener().catch((error) =>
        logger.error(
          { error: errorText(error) },
          'dws group listener start failed',
        ),
      );
    }
    metrics.set('scheduler_enabled', 1);
    retentionService.start(
      envSeconds(process.env.DATA_CLEANUP_INTERVAL_SECONDS, 86_400) * 1_000,
    );

    configCenter.on('llm:changed', (event) => {
      const next = event.after as LLMAndPersonaConfig;
      const profiles = configCenter.getModelProfiles();
      defaultModelRef.current = createChatModel(profiles.default);
      roleModelRefs.admin.current = createChatModel(profiles.admin);
      roleModelRefs.proactive.current = createChatModel(profiles.proactive);
      routedEngines.clear();
      groupModelRouting.invalidate();
      engine.updateTemperature(next.temperature);
      engine.updateNativeReasoning(
        (next.thinking ?? (next.enableNativeReasoning ? 'auto' : 'off')) !==
          'off',
      );
      engine.updateMaxTokens(next.maxTokens);
      Object.assign(personaRef, next.persona);
      logger.info(
        { model: next.model, provider: next.provider },
        'llm config applied',
      );
    });
    configCenter.on('loopPolicy:changed', (event) => {
      routedEngines.clear();
      groupModelRouting.invalidate();
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
      const stream = defaultModelRef.current.streamChat({
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
        const adminName = await resolveEmployeeDisplayName(target);
        const streamer = createStreamer({
          messageId: `admin-test-${now}`,
          conversationId: target,
          conversationType: '1',
          senderStaffId: target,
          senderNick: formatTraceSenderNick({
            senderNick: '管理员',
            ...(adminName ? { employeeName: adminName } : {}),
          }),
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
      const adminProfile = configCenter.getModelProfiles().admin;
      emit({ type: 'turn_start', turnId, step: 1 });
      let totalTokens = 0;
      metrics.inc('console_chat_turns_total');
      try {
        const stream = adminModel.streamChat(
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
            temperature: adminProfile.temperature,
            enableNativeReasoning: adminProfile.thinking !== 'off',
            ...(adminProfile.maxTokens
              ? { maxTokens: adminProfile.maxTokens }
              : {}),
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
      skills: skillAdminPort,
      skillFiles: skillFilePort,
      plugins: pluginAdminPort,
      projects: projectAdminPort,
      github: githubAdminPort,
      personas: {
        list: (scope) => personaProfileStore.list(scope),
        get: (scope, subjectKey) =>
          personaProfileStore.get(scope, subjectKey),
        upsert: async (scope, subjectKey, input, actor) => {
          const before = await personaProfileStore.get(scope, subjectKey);
          const saved = await personaProfileStore.upsert({
            scope,
            subjectKey,
            name: input.name ?? before?.name ?? '',
            rolePrompt: input.rolePrompt ?? before?.rolePrompt ?? '',
            speakingStyle: input.speakingStyle ?? before?.speakingStyle ?? '',
            enabled: input.enabled ?? before?.enabled ?? true,
            updatedBy: actor,
            createdAt: before?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
          personaResolver.invalidate(scope, subjectKey);
          return saved;
        },
        remove: async (scope, subjectKey) => {
          const removed = await personaProfileStore.remove(scope, subjectKey);
          if (removed) personaResolver.invalidate(scope, subjectKey);
          return removed;
        },
      },
      identities: personIdentity,
      memories: memoryStore,
      groupWorkspace,
      groupModelRoutes,
      personSettings,
      whitelist,
      mcp: {
        status: () => mcpPort.status(),
        applyServers: (servers) => mcpPort.applyServers(servers),
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
      stopProjectSync();
      skillWatchStop?.();
      await leadership?.stop();
      runControl.stopAll();
      dwsAuth?.dispose();
      dwsIdentity?.dispose();
      dwsWriteTasksService?.dispose();
      await taskScheduler.stop();
      await jobRunner.stop();
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
