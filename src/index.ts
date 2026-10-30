import 'dotenv/config';
import { resolve } from 'node:path';
import pino from 'pino';
import { DWClient } from 'dingtalk-stream';
import { EnvConfigProvider } from './config/EnvConfigProvider.js';
import type { IConfigProvider } from './config/IConfigProvider.js';
import { DynamicConfigCenter } from './config/DynamicConfigCenter.js';
import { createDatabase } from './db/client.js';
import { seedAgentConfigs, loadLLMOverrides, applyLLMOverrides } from './db/seed.js';
import {
  DrizzleAdminAuditStore,
  DrizzleConfigStore,
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
import { AgentHarness, type HarnessLogger } from './harness/AgentHarness.js';
import { ToolRegistry, loadMcpServerConfigs } from './harness/ToolRegistry.js';
import { GroupTranscriptBuffer } from './bystander/GroupTranscriptBuffer.js';
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
import { createChatModel } from './react/createChatModel.js';
import { ReActRunner } from './react/ReActRunner.js';
import { AdminChatOpsToolProvider } from './tools/admin/AdminChatOpsToolProvider.js';
import { TraceCollector, createMcpAdminPort } from './admin-api/runtime.js';
import { startAdminServer } from './admin-api/server.js';
import type {
  ChatModel,
  InboundMessage,
  LLMAndPersonaConfig,
  RunResult,
} from './types/core.js';
import type {
  LlmSandboxTestResult,
  McpServerTestResult,
} from './types/admin-and-console.js';
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

function parseAdminIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function sendSessionWebhook(
  message: InboundMessage,
  text: string,
  logger: CardLogger,
): Promise<void> {
  const webhook = message.rawPayload.sessionWebhook;
  if (typeof webhook !== 'string' || !webhook) {
    logger.warn(
      { messageId: message.messageId },
      'no sessionWebhook available for text fallback',
    );
    return;
  }
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '智能助手', text },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      logger.warn(
        { messageId: message.messageId, status: response.status },
        'sessionWebhook fallback failed',
      );
    }
  } catch (error) {
    logger.warn(
      { messageId: message.messageId, error: errorText(error) },
      'sessionWebhook fallback failed',
    );
  }
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

  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
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
  let adminServer: ReturnType<typeof startAdminServer> | undefined;
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
      initialAdminStaffIds: parseAdminIds(process.env.ADMIN_STAFF_IDS),
      logger: harnessLogger,
      now: Date.now,
    }).init();
    configCenter.assertReady();

    const traceStore = new DrizzleReActTraceStore(dbHandle.db);
    const groupDirectory = new DrizzleGroupDirectory(dbHandle.db);
    const mcpPort = createMcpAdminPort(
      () => toolRegistry?.pool ?? null,
      harnessLogger,
    );

    const adminProvider = new AdminChatOpsToolProvider({
      configCenter,
      mcp: mcpPort,
      traces: traceStore,
      groups: groupDirectory,
      logger: harnessLogger,
    });

    toolRegistry = await ToolRegistry.create({
      mcpServers: configCenter.getMcpServers(),
      enableDws: configCenter.getSystemConfig().dingtalk.dwsCliEnabled,
      adminProvider,
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

    const engine = new ReActRunner({
      model: chatModel,
      toolProviders: toolRegistry.providers,
      policy: configCenter.getLoopPolicy(),
      temperature: configCenter.getLLMConfig().temperature,
      enableNativeReasoning:
        configCenter.getLLMConfig().enableNativeReasoning,
    });

    const memoryStore = new DrizzleMemoryStore(dbHandle.db);
    const transcriptBuffer = new GroupTranscriptBuffer({
      defaultWindowSize: bystanderConfig.slidingWindowSize,
    });
    const policyProvider = new BystanderPolicyProvider({
      defaults: configCenter.getBystanderConfig(),
      store: memoryStore,
      logger: harnessLogger,
    });
    const triage = new BystanderTriageEngine({
      buffer: transcriptBuffer,
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
      logger: harnessLogger,
    });

    const personaRef = { ...configCenter.getLLMConfig().persona };
    const harness = new AgentHarness({
      engine,
      repository: new DrizzleConversationRepository(dbHandle.db),
      assembler: new ContextAssembler({
        windowMessages: memoryConfig.windowMessages,
      }),
      persona: personaRef,
      policy: configCenter.getLoopPolicy(),
      windowMessages: memoryConfig.windowMessages,
      logger: harnessLogger,
      memory: hierarchicalMemory,
      bystander: {
        buffer: transcriptBuffer,
        triage,
        policyProvider: (conversationId) =>
          policyProvider.getPolicy(conversationId),
      },
    });

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

    const cardApiRef: { current: OpenApiCardApi } = {
      current: new OpenApiCardApi({
        clientId: configCenter.getDingTalkConfig().clientId,
        clientSecret: configCenter.getDingTalkConfig().clientSecret,
        getAccessToken,
        logger: cardLogger,
      }),
    };

    const createStreamer = (message: InboundMessage): CardStreamer => {
      const dingtalk = configCenter.getDingTalkConfig();
      return new CardStreamer({
        api: cardApiRef.current,
        message,
        cardTemplateId: dingtalk.cardTemplateId,
        robotCode: dingtalk.robotCode,
        logger: cardLogger,
      });
    };

    const recordTrace = async (
      collector: TraceCollector,
      message: InboundMessage,
      result: RunResult | null,
      proactive: boolean,
    ): Promise<void> => {
      if (!result) return;
      try {
        await traceStore.append(
          collector.build({ message, result, proactive }),
        );
      } catch (error) {
        logger.warn(
          { messageId: message.messageId, error: errorText(error) },
          'failed to persist react trace',
        );
      }
    };

    const gatewayOptions = () => ({
      logger: gatewayLogger,
      transcriptBuffer,
      handler: async (message: InboundMessage) => {
        const streamer = createStreamer(message);
        const collector = new TraceCollector();
        const emit = (event: Parameters<typeof collector.handle>[0]) => {
          collector.handle(event);
          streamer.handle(event);
        };
        await streamer.start();
        try {
          const result = await harness.handleMessage(message, { emit });
          await streamer.finish();
          await recordTrace(collector, message, result, false);
          if (result && !streamer.isAvailable && result.answer) {
            await sendSessionWebhook(message, result.answer, cardLogger);
          }
        } catch (error) {
          logger.error(
            { messageId: message.messageId, error: errorText(error) },
            'turn failed',
          );
          streamer.handle({ type: 'error', message: FALLBACK_ERROR_TEXT });
          await streamer.finish();
          await recordTrace(collector, message, EMPTY_RESULT, false);
          if (!streamer.isAvailable) {
            await sendSessionWebhook(message, FALLBACK_ERROR_TEXT, cardLogger);
          }
        }
      },
      bystanderHandler: async (message: InboundMessage) => {
        const groupPolicy = await policyProvider.getPolicy(
          message.conversationId,
        );
        let decision;
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
            action: decision.action,
            triggerReason: decision.triggerReason,
            confidence: decision.confidence,
            rationale: decision.rationale,
          },
          'bystander evaluation finished',
        );
        if (decision.action !== 'PROACTIVE_REPLY') return;

        const streamer = createStreamer(message);
        const collector = new TraceCollector();
        const emit = (event: Parameters<typeof collector.handle>[0]) => {
          collector.handle(event);
          streamer.handle(event);
        };
        await streamer.start();
        try {
          const result = await harness.handleBystanderMessage(message, {
            decision,
            emit,
          });
          await streamer.finish();
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
        }
      },
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
    };

    await startGateway();

    configCenter.on('llm:changed', (event) => {
      const next = event.after as LLMAndPersonaConfig;
      modelRef.current = createChatModel(next);
      engine.updateTemperature(next.temperature);
      engine.updateNativeReasoning(next.enableNativeReasoning);
      Object.assign(personaRef, next.persona);
      logger.info(
        { model: next.model, provider: next.provider },
        'llm config applied',
      );
    });
    configCenter.on('loopPolicy:changed', (event) => {
      engine.updatePolicy(event.after as ReturnType<typeof configCenter.getLoopPolicy>);
      logger.info({ policy: event.after }, 'loop policy applied');
    });
    configCenter.on('defaultBystanderPolicy:changed', () => {
      policyProvider.setDefaults(configCenter.getBystanderConfig());
      logger.info({}, 'default bystander policy applied');
    });
    configCenter.on('groupPolicy:changed', (event) => {
      logger.info(
        { conversationId: event.conversationId, policy: event.after },
        'group policy applied',
      );
    });
    configCenter.on('dingtalk:changed', (event) => {
      const next = event.after as StoredDingTalkConfig;
      const previous = event.before as StoredDingTalkConfig;
      toolRegistry?.setDwsEnabled(next.dwsCliEnabled);
      const credentialsChanged =
        previous.clientId !== next.clientId ||
        previous.clientSecret !== next.clientSecret;
      if (credentialsChanged) {
        streamConnected = false;
        gateway?.stop();
        void startGateway()
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

    adminServer = startAdminServer({
      configCenter,
      traces: traceStore,
      groups: groupDirectory,
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
        adminApiPort: adminServer.port,
      },
      'dingtalk agent is ready',
    );

    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      gateway?.stop();
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
