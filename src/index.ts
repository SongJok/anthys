import 'dotenv/config';
import { resolve } from 'node:path';
import type { DWClient } from 'dingtalk-stream';
import { MetricsRegistry } from './admin-api/metrics.js';
import { createMcpAdminPort } from './admin-api/runtime.js';
import type { startAdminServer } from './admin-api/server.js';
import { startConfiguredAdminServer } from './bootstrap/adminConsoleWiring.js';
import { setupAgentRuntimes } from './bootstrap/agentRuntimes.js';
import {
  setupBackgroundSchedulers,
  type BackgroundSchedulersContext,
} from './bootstrap/backgroundSchedulers.js';
import { setupDingTalkIngress } from './bootstrap/dingtalkIngress.js';
import {
  envEnabled,
  envSeconds,
  errorText,
  parseAdminIds,
} from './bootstrap/envHelpers.js';
import { setupMemoryAndBystander } from './bootstrap/memoryAndBystander.js';
import { setupToolsAndGovernance } from './bootstrap/toolsAndGovernance.js';
import { setupWorkspaceAndExtensions } from './bootstrap/workspaceAndExtensions.js';
import { PgAdvisoryLeadership } from './cluster/LeadershipLock.js';
import { PgSharedStateStore, type SharedStateStore } from './cluster/SharedStateStore.js';
import { DynamicConfigCenter } from './config/DynamicConfigCenter.js';
import { EnvConfigProvider } from './config/EnvConfigProvider.js';
import type { IConfigProvider } from './config/IConfigProvider.js';
import { createDatabase } from './db/client.js';
import {
  DrizzleAdminAuditStore,
  DrizzleConfigStore,
  DrizzleFeedbackStore,
  DrizzleGroupDirectory,
  DrizzleGroupPolicyStore,
  DrizzleReActTraceStore,
  type StoredDingTalkConfig,
} from './db/configSchema.js';
import { DrizzleAgentJobStore } from './db/jobSchema.js';
import { applyLLMOverrides, loadLLMOverrides, seedAgentConfigs } from './db/seed.js';
import { DrizzleAgentTaskStore } from './db/taskSchema.js';
import { DrizzleWhitelistStore } from './db/whitelistSchema.js';
import { createRedactingLogger } from './governance/logger.js';
import type { HarnessLogger } from './harness/AgentHarness.js';
import { RunControlRegistry } from './harness/RunControlRegistry.js';
import { loadMcpServerConfigs, type ToolRegistry } from './harness/ToolRegistry.js';
import type { McpAdminPort } from './types/admin-and-console.js';
import type { LLMAndPersonaConfig } from './types/core.js';
import type { EnterpriseMcpServerConfig } from './types/mcp-and-sandbox.js';
import {
  DingTalkContactDirectorySource,
  DwsContactDirectorySource,
} from './whitelist/DirectorySources.js';
import { WhitelistService } from './whitelist/WhitelistService.js';
import { DwsGroupDirectorySource } from './groups/DwsGroupDirectorySource.js';

async function main(): Promise<void> {
  const baseConfig = new EnvConfigProvider();
  baseConfig.assertReady();

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

  const dbHandle = createDatabase(baseConfig.getDatabaseUrl());
  let toolRegistryRef: ToolRegistry | undefined;
  let adminServer: ReturnType<typeof startAdminServer> | undefined;
  let leadership: PgAdvisoryLeadership | undefined;
  let configPoll: ReturnType<typeof setInterval> | undefined;
  let activeClient: DWClient | undefined;
  let cachedToken: { value: string; expiresAt: number } | null = null;

  const cleanupRefs: Array<() => void | Promise<void>> = [];

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
    const isLeader = (): boolean => !clusterEnabled || Boolean(leadership?.isLeader());

    const sharedState: SharedStateStore | undefined = clusterEnabled
      ? new PgSharedStateStore({
          query: async <T>(text: string, values?: unknown[]) => {
            const result = await dbHandle.pool.query(text, values as unknown[]);
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
        })
      : undefined;

    let applyMcpFn: (manual?: EnterpriseMcpServerConfig[]) => Promise<unknown> =
      async () => undefined;
    const extensions = await setupWorkspaceAndExtensions({
      db: dbHandle.db,
      configCenter,
      clusterEnabled,
      harnessLogger,
      applyMergedMcpServers: (manual) => applyMcpFn(manual),
    });

    const baseMcpPort = createMcpAdminPort(
      () => toolRegistryRef?.pool ?? null,
      harnessLogger,
    );
    const mcpPort: McpAdminPort = {
      ...baseMcpPort,
      applyServers: async (manual) =>
        baseMcpPort.applyServers(await extensions.mergeMcpServers(manual)),
    };
    applyMcpFn = (manual = configCenter.getMcpServers()) =>
      mcpPort.applyServers(manual);

    const getAccessToken = async (): Promise<string> => {
      if (!activeClient) throw new Error('钉钉 Stream 客户端尚未就绪');
      if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.value;
      }
      const value = String(await activeClient.getAccessToken());
      cachedToken = { value, expiresAt: Date.now() + 30 * 60_000 };
      return value;
    };

    let dwsWriteTasksRef: Awaited<ReturnType<typeof setupDingTalkIngress>>['dwsWriteTasksService'] | null = null;
    const tools = await setupToolsAndGovernance({
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
      getDwsWriteTasksService: () => dwsWriteTasksRef,
    });
    toolRegistryRef = tools.toolRegistry;

    const jobStore = new DrizzleAgentJobStore(dbHandle.db);
    const taskStore = new DrizzleAgentTaskStore(dbHandle.db);

    const runtimes = setupAgentRuntimes({
      db: dbHandle.db,
      configCenter,
      harnessLogger,
      metrics,
      runControl,
      toolProviders: tools.toolRegistry.providers,
      applyExecutionPolicy: tools.applyExecutionPolicy,
      resolveToolApproval: tools.resolveToolApproval,
      jobStore,
    });

    const memory = await setupMemoryAndBystander({
      db: dbHandle.db,
      configCenter,
      ...(sharedState ? { sharedState } : {}),
      harnessLogger,
      metrics,
      ...(extensions.embeddingClient
        ? { embeddingClient: extensions.embeddingClient }
        : {}),
      scheduledStore: tools.scheduledStore,
      glossary: tools.glossary,
      groupTranscriptArchive: tools.groupTranscriptArchive,
      transcriptArchiveEnabled: tools.transcriptArchiveEnabled,
      toolProviders: tools.toolRegistry.providers,
      runtimes,
      extensions,
    });

    const runtimeRegistry = runtimes.createRuntimeRegistry(
      memory.harness,
      memory.personaRef,
    );

    let schedulersRef: BackgroundSchedulersContext | undefined;
    const ingress = await setupDingTalkIngress({
      db: dbHandle.db,
      configCenter,
      traceStore,
      feedbackStore,
      groupDirectory,
      whitelistStore,
      whitelist,
      runControl,
      metrics,
      ...(sharedState ? { sharedState } : {}),
      clusterEnabled,
      isLeader,
      redactionEnabled,
      harnessLogger,
      gatewayLogger: harnessLogger,
      cardLogger: harnessLogger,
      tools,
      runtimes,
      memory,
      jobStore,
      getSchedulers: () => {
        if (!schedulersRef) throw new Error('background schedulers not ready');
        return schedulersRef;
      },
      setActiveClient: (client) => {
        activeClient = client;
      },
      resetTokenCache: () => {
        cachedToken = null;
      },
      getAccessToken,
    });
    dwsWriteTasksRef = ingress.dwsWriteTasksService;

    const schedulers = setupBackgroundSchedulers({
      configCenter,
      jobStore,
      taskStore,
      scheduledStore: tools.scheduledStore,
      harness: memory.harness,
      taskMemory: tools.taskMemory,
      personalAssistant: tools.personalAssistant,
      groupWorkspace: memory.groupWorkspace,
      adminTextSender: tools.adminTextSender,
      metrics,
      harnessLogger,
      resolveEmployeeDisplayName: ingress.resolveEmployeeDisplayName,
      createStreamer: ingress.createStreamer,
      groupTextSender: tools.mediaSender,
      clusterEnabled,
      isLeader,
      isProjectSyncRunning: extensions.isProjectSyncRunning,
      isBystanderListenRunning: ingress.isBystanderListenRunning,
    });
    schedulersRef = schedulers;

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
        heartbeatMs: envSeconds(process.env.CLUSTER_HEARTBEAT_SECONDS, 10) * 1_000,
        logger: harnessLogger,
        onAcquired: async () => {
          await ingress.startGatewayIfLeader();
          extensions.startProjectSync();
          schedulers.taskScheduler.start();
          schedulers.jobRunner.start();
          void ingress.startBystanderListener().catch((error) =>
            logger.error(
              { error: errorText(error) },
              'dws group listener start failed',
            ),
          );
        },
        onLost: () => {
          ingress.stopGateway();
          ingress.stopBystanderListener();
          extensions.stopProjectSync();
          void schedulers.taskScheduler.stop();
          void schedulers.jobRunner.stop();
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
    } else {
      await ingress.startGateway();
      schedulers.taskScheduler.start();
      schedulers.jobRunner.start();
      void ingress.startBystanderListener().catch((error) =>
        logger.error(
          { error: errorText(error) },
          'dws group listener start failed',
        ),
      );
    }

    metrics.set('scheduler_enabled', 1);
    tools.retentionService.start(
      envSeconds(process.env.DATA_CLEANUP_INTERVAL_SECONDS, 86_400) * 1_000,
    );

    configCenter.on('llm:changed', (event) => {
      const next = event.after as LLMAndPersonaConfig;
      runtimeRegistry.applyLlmChange(next, configCenter.getModelProfiles());
      logger.info({ model: next.model, provider: next.provider }, 'llm config applied');
    });
    configCenter.on('loopPolicy:changed', (event) => {
      const next = event.after as ReturnType<typeof configCenter.getLoopPolicy>;
      runtimeRegistry.applyLoopPolicyChange(next);
      logger.info({ policy: event.after }, 'loop policy applied');
    });
    configCenter.on('defaultBystanderPolicy:changed', () => {
      memory.policyProvider.setDefaults(configCenter.getBystanderConfig());
      logger.info({}, 'default bystander policy applied');
    });
    configCenter.on('groupPolicy:changed', (event) => {
      void ingress.refreshBystanderListenGroups();
      logger.info(
        { conversationId: event.conversationId, policy: event.after },
        'group policy applied',
      );
    });
    configCenter.on('dingtalk:changed', (event) => {
      const next = event.after as StoredDingTalkConfig;
      const previous = event.before as StoredDingTalkConfig;
      tools.toolRegistry.setDwsEnabled(next.dwsCliEnabled);
      if (previous.clientId !== next.clientId || previous.clientSecret !== next.clientSecret) {
        ingress.rebuildGatewayForCredentials();
      }
      logger.info(
        {
          robotCode: next.robotCode,
          dwsCliEnabled: next.dwsCliEnabled,
          webSearchEnabled: next.webSearchEnabled,
        },
        'dingtalk config applied',
      );
    });

    adminServer = startConfiguredAdminServer({
      configCenter,
      traceStore,
      feedbackStore,
      groupDirectory,
      whitelist,
      mcpPort,
      metrics,
      harnessLogger,
      extensions,
      tools,
      runtimes,
      memory,
      schedulers,
      taskService: schedulers.taskService,
      groupModelRoutes: runtimes.groupModelRoutes,
      isStreamConnected: ingress.isStreamConnected,
      getAllowedListenConversations: ingress.getAllowedListenConversations,
      resolveEmployeeDisplayName: ingress.resolveEmployeeDisplayName,
      createStreamer: ingress.createStreamer,
      recordTrace: ingress.recordTrace,
      checkDbReady: async () => {
        await dbHandle.pool.query('select 1');
      },
      clusterEnabled,
      isLeader,
    });

    cleanupRefs.push(
      () => {
        if (configPoll) clearInterval(configPoll);
        extensions.stopProjectSync();
        extensions.stopSkillWatch();
      },
      async () => leadership?.stop(),
      () => {
        runControl.stopAll();
      },
      () => tools.authManager.dispose(),
      () => tools.identityService.dispose(),
      () => ingress.dwsWriteTasksService.dispose(),
      () => schedulers.taskScheduler.stop(),
      () => schedulers.jobRunner.stop(),
      () => tools.retentionService.stop(),
      () => ingress.stopGateway(),
      () => ingress.stopBystanderListener(),
      async () => memory.clusterSync?.flush(),
      async () => adminServer?.close(),
      () => memory.harness.flushMemoryTasks(),
    );

    logger.info(
      {
        model: configCenter.getLLMConfig().model,
        provider: configCenter.getLLMConfig().provider,
        persona: configCenter.getLLMConfig().persona.name,
        compressionThresholdTokens: memoryConfig.compressionThresholdTokens,
        glossaryEmbeddingEnabled: Boolean(extensions.embeddingClient),
        adminApiPort: adminServer.port,
      },
      'dingtalk agent is ready',
    );

    void tools.glossary.backfillEmbeddings().catch((error) => {
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
      for (const fn of cleanupRefs) {
        await Promise.resolve(fn()).catch((error) =>
          logger.warn({ error: errorText(error) }, 'cleanup step failed'),
        );
      }
      await tools.toolRegistry.close();
      await dbHandle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    logger.error({ error: errorText(error) }, 'startup failed');
    await adminServer?.close().catch(() => undefined);
    await toolRegistryRef?.close();
    await dbHandle.close();
    process.exitCode = 1;
  }
}

void main();
