import { resolve } from 'node:path';
import type { ConsoleChatHandler } from '../admin-api/chatStream.js';
import {
  recordStreamEventMetrics,
  type MetricsRegistry,
} from '../admin-api/metrics.js';
import { formatTraceSenderNick, TraceCollector } from '../admin-api/runtime.js';
import { startAdminServer } from '../admin-api/server.js';
import type { CardStreamer } from '../dingtalk/CardStreamer.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type {
  DrizzleFeedbackStore,
  DrizzleGroupDirectory,
  DrizzleReActTraceStore,
} from '../db/configSchema.js';
import { GroupModelRouteService } from '../groups/GroupModelRouteService.js';
import type { AgentHarness, HarnessLogger } from '../harness/AgentHarness.js';
import type { TaskService } from '../tasks/TaskService.js';
import type {
  LlmSandboxTestResult,
  McpAdminPort,
  McpServerTestResult,
} from '../types/admin-and-console.js';
import type { AgentStreamEvent, InboundMessage, RunResult } from '../types/core.js';
import type { WhitelistService } from '../whitelist/WhitelistService.js';
import type { AgentRuntimesContext } from './agentRuntimes.js';
import type { BackgroundSchedulersContext } from './backgroundSchedulers.js';
import { EMPTY_RESULT, envEnabled, errorText } from './envHelpers.js';
import type { MemoryAndBystanderContext } from './memoryAndBystander.js';
import type { ToolsAndGovernanceContext } from './toolsAndGovernance.js';
import type { WorkspaceAndExtensionsContext } from './workspaceAndExtensions.js';

export interface ConsoleChatBuilderDeps {
  harness: AgentHarness;
  metrics: MetricsRegistry;
  harnessLogger: HarnessLogger;
  recordTrace: (
    collector: TraceCollector,
    message: InboundMessage,
    result: RunResult | null,
    proactive: boolean,
  ) => Promise<void>;
}

/**
 * 构建 Web 控制台 SSE 对话处理器：
 * 统一走 AgentHarness，复用真实工具链、知识库/记忆注入、技能目录与 ReAct Trace 持久化。
 */
export function createConsoleChatHandler(
  deps: ConsoleChatBuilderDeps,
): ConsoleChatHandler {
  const { harness, metrics, harnessLogger: logger, recordTrace } = deps;
  return async (input, emit) => {
    const startedAt = Date.now();
    const conversationId = input.conversationId?.trim() || 'console:admin';
    const message: InboundMessage = {
      messageId: `console_${startedAt}`,
      conversationId,
      conversationType: '1',
      senderStaffId: 'admin-console',
      senderNick: '控制台管理员',
      isAtBot: true,
      text: input.question,
      rawPayload: { source: 'admin_console' },
      timestamp: startedAt,
    };

    const collector = new TraceCollector();
    metrics.inc('console_chat_turns_total');
    let result: RunResult | null = null;
    try {
      const trackedEmit = (event: AgentStreamEvent): void => {
        collector.handle(event);
        recordStreamEventMetrics(metrics, event);
        emit(event);
      };
      result = await harness.handleMessage(message, {
        emit: trackedEmit,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.systemPrompt ? { systemPromptOverride: input.systemPrompt } : {}),
      });
      await recordTrace(collector, message, result, false);
    } catch (error) {
      if (input.signal?.aborted) {
        emit({
          type: 'completed',
          usage: {
            totalTokens: 0,
            steps: 1,
            durationMs: Date.now() - startedAt,
            stopped: true,
          },
        });
        await recordTrace(collector, message, EMPTY_RESULT, false);
        return;
      }
      logger.warn(
        { conversationId, error: errorText(error) },
        'console chat harness run failed',
      );
      await recordTrace(collector, message, EMPTY_RESULT, false);
      throw error;
    }
  };
}

export interface AdminConsoleWiringDeps {
  configCenter: DynamicConfigCenter;
  traceStore: DrizzleReActTraceStore;
  feedbackStore: DrizzleFeedbackStore;
  groupDirectory: DrizzleGroupDirectory;
  whitelist: WhitelistService;
  mcpPort: McpAdminPort;
  metrics: MetricsRegistry;
  harnessLogger: HarnessLogger;
  extensions: WorkspaceAndExtensionsContext;
  tools: ToolsAndGovernanceContext;
  runtimes: AgentRuntimesContext;
  memory: MemoryAndBystanderContext;
  schedulers: BackgroundSchedulersContext;
  taskService: TaskService;
  groupModelRoutes: GroupModelRouteService;
  isStreamConnected: () => boolean;
  getAllowedListenConversations: () => Iterable<string>;
  resolveEmployeeDisplayName: (
    staffId: string | undefined,
  ) => Promise<string | undefined>;
  createStreamer: (
    message: InboundMessage,
    options?: { mention?: string; atAll?: boolean },
  ) => CardStreamer;
  recordTrace: (
    collector: TraceCollector,
    message: InboundMessage,
    result: RunResult | null,
    proactive: boolean,
  ) => Promise<void>;
  checkDbReady: () => Promise<void>;
  clusterEnabled: boolean;
  isLeader: () => boolean;
}

/** 组装并启动后台 HTTP Console 服务 */
export function startConfiguredAdminServer(
  deps: AdminConsoleWiringDeps,
): ReturnType<typeof startAdminServer> {
  const {
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
    taskService,
    groupModelRoutes,
    isStreamConnected,
    getAllowedListenConversations,
    resolveEmployeeDisplayName,
    createStreamer,
    recordTrace,
    checkDbReady,
    clusterEnabled,
    isLeader,
  } = deps;

  const llmTester = async (input: {
    question: string;
    systemPrompt?: string;
  }): Promise<LlmSandboxTestResult> => {
    const startedAt = Date.now();
    const current = configCenter.getLLMConfig();
    let answer = '';
    let reasoning = '';
    let totalTokens = 0;
    const stream = runtimes.defaultModelRef.current.streamChat({
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
      connected: isStreamConnected(),
      ...(isStreamConnected() ? {} : { detail: 'Stream 客户端未连接' }),
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

  const consoleChat = createConsoleChatHandler({
    harness: memory.harness,
    metrics,
    harnessLogger,
    recordTrace,
  });

  return startAdminServer({
    configCenter,
    traces: traceStore,
    groups: groupDirectory,
    listeningGroups: getAllowedListenConversations,
    glossary: tools.glossary,
    glossaryCandidates: tools.glossaryCandidates,
    skills: extensions.skillAdminPort,
    skillFiles: extensions.skillFilePort,
    plugins: extensions.pluginAdminPort,
    projects: extensions.projectAdminPort,
    github: extensions.githubAdminPort,
    personas: {
      list: (scope) => memory.personaProfileStore.list(scope),
      get: (scope, subjectKey) =>
        memory.personaProfileStore.get(scope, subjectKey),
      upsert: async (scope, subjectKey, input, actor) => {
        const before = await memory.personaProfileStore.get(scope, subjectKey);
        const saved = await memory.personaProfileStore.upsert({
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
        memory.personaResolver.invalidate(scope, subjectKey);
        return saved;
      },
      remove: async (scope, subjectKey) => {
        const removed = await memory.personaProfileStore.remove(
          scope,
          subjectKey,
        );
        if (removed) memory.personaResolver.invalidate(scope, subjectKey);
        return removed;
      },
    },
    identities: memory.personIdentity,
    memories: memory.memoryStore,
    groupWorkspace: memory.groupWorkspace,
    groupModelRoutes,
    personSettings: memory.personSettings,
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
    scheduledTasks: schedulers.scheduledApi,
    usage: {
      summary: (days = 1) =>
        memory.usageLedger.summarySince(Date.now() - days * 24 * 60 * 60 * 1_000),
    },
    governance: tools.retentionService,
    metrics,
    githubWebhook: {
      ...(process.env.GITHUB_WEBHOOK_SECRET !== undefined
        ? { secret: process.env.GITHUB_WEBHOOK_SECRET }
        : {}),
      onEvent: (event) => taskService.routeExternalEvent(event),
    },
    readiness: async () => {
      try {
        await checkDbReady();
      } catch (error) {
        harnessLogger.warn(
          { error: errorText(error) },
          'readyz database check failed',
        );
        return { ready: false, detail: '数据库不可用' };
      }
      if (clusterEnabled && !isLeader()) {
        return { ready: true, detail: 'standby（本实例未持有 Stream 主锁）' };
      }
      return isStreamConnected()
        ? { ready: true }
        : { ready: false, detail: '钉钉 Stream 未连接' };
    },
    staticDir: resolve(process.cwd(), 'web-console/dist'),
    authToken: process.env.ADMIN_API_TOKEN,
    viewerToken: process.env.ADMIN_VIEWER_TOKEN,
    trustActorHeader: envEnabled(process.env.ADMIN_TRUST_ACTOR_HEADER, false),
    logger: harnessLogger,
  });
}
