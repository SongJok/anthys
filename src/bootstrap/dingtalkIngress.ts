import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { DWClient } from 'dingtalk-stream';
import {
  recordStreamEventMetrics,
  type MetricsRegistry,
} from '../admin-api/metrics.js';
import {
  TraceCollector,
  formatTraceSenderNick,
  isNonEmployeeTraceLabel,
} from '../admin-api/runtime.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { DrizzleReActTraceStore } from '../db/configSchema.js';
import { DrizzleDwsWriteTaskStore } from '../db/dwsWriteTaskSchema.js';
import type { Database } from '../db/client.js';
import { toTranscriptEntry } from '../bystander/GroupTranscriptBuffer.js';
import { CooldownLimiter } from '../bystander/CooldownLimiter.js';
import { DwsGroupMessageListener } from '../bystander/DwsGroupMessageListener.js';
import {
  SilentInvestigationService,
  resolveSilentInvestigationConfig,
} from '../bystander/SilentInvestigationService.js';
import { DrizzleSilentInvestigationStore } from '../db/investigationSchema.js';
import type { CardActionEvent } from '../dingtalk/CardActions.js';
import {
  CardStreamer,
  OpenApiCardApi,
  type CardLogger,
} from '../dingtalk/CardStreamer.js';
import {
  EmotionReplier,
  OpenApiRobotEmotionApi,
} from '../dingtalk/EmotionReplier.js';
import {
  findMentionOnlyContext,
  MENTION_ONLY_FALLBACK_REPLY,
} from '../dingtalk/MentionOnlyMessage.js';
import { replyMention } from '../dingtalk/Mentions.js';
import { StreamGateway, type StreamGatewayLogger } from '../dingtalk/StreamGateway.js';
import { sendTextFallback } from '../dingtalk/TextFallback.js';
import { CommandRouter, parseCommand } from '../commands/CommandRouter.js';
import { redactTraceRecord } from '../governance/redaction.js';
import {
  conversationKeyFor,
  conversationTitleFor,
  type HarnessLogger,
} from '../harness/AgentHarness.js';
import { buildConfirmedActionContext } from '../harness/approvalContext.js';
import { runTurnWithAsyncHandoff } from '../harness/AsyncTurnHandoff.js';
import type {
  BeginRunResult,
  RunControlRegistry,
} from '../harness/RunControlRegistry.js';
import {
  formatApprovalPrompt,
} from '../harness/ToolApprovalGate.js';
import { isReadOnlyToolName } from '../tools/toolRisk.js';
import {
  defaultPersonKeyFor,
  normalizeIdentityAlias,
} from '../identity/PersonIdentityService.js';
import { enrichInboundMessage } from '../multimodal/MessageEnricher.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';
import {
  DWS_CONSENT_VERSION,
  DwsIdentityError,
  formatDwsConsentText,
} from '../tools/dws/DwsIdentityService.js';
import { DwsWriteTaskService } from '../tools/dws/DwsWriteTaskService.js';
import { formatJob, formatJobList, formatJobStatus } from '../jobs/JobService.js';
import type { SharedStateStore } from '../cluster/SharedStateStore.js';
import type { DwsWriteTask } from '../types/dws-write-task.js';
import type { BystanderEvaluationResult } from '../types/bystander-and-memory.js';
import type {
  AgentStreamEvent,
  ExecutionContext,
  InboundMessage,
  RunResult,
} from '../types/core.js';
import type { AgentJobStore } from '../types/jobs.js';
import { isWorkerName } from '../types/workers.js';
import type { AgentRuntimesContext } from './agentRuntimes.js';
import type { BackgroundSchedulersContext } from './backgroundSchedulers.js';
import type { MemoryAndBystanderContext } from './memoryAndBystander.js';
import type { ToolsAndGovernanceContext } from './toolsAndGovernance.js';
import {
  EMPTY_RESULT,
  FALLBACK_ERROR_TEXT,
  envEnabled,
  envSeconds,
  errorText,
  requiresExplicitDwsConfirmation,
  runWithTimeout,
  sendSessionWebhook,
  splitForDelivery,
} from './envHelpers.js';
import type { WhitelistService } from '../whitelist/WhitelistService.js';
import type { DrizzleWhitelistStore } from '../db/whitelistSchema.js';
import type { DrizzleGroupDirectory } from '../db/configSchema.js';

export interface DingTalkIngressDeps {
  db: Database;
  configCenter: DynamicConfigCenter;
  traceStore: DrizzleReActTraceStore;
  feedbackStore: { append: (entry: { conversationId: string; messageId: string; senderStaffId: string; senderNick: string; content: string }) => Promise<unknown> };
  groupDirectory: DrizzleGroupDirectory;
  whitelistStore: DrizzleWhitelistStore;
  whitelist: WhitelistService;
  runControl: RunControlRegistry;
  metrics: MetricsRegistry;
  sharedState?: SharedStateStore;
  clusterEnabled: boolean;
  isLeader: () => boolean;
  redactionEnabled: boolean;
  harnessLogger: HarnessLogger;
  gatewayLogger: StreamGatewayLogger;
  cardLogger: CardLogger;
  tools: ToolsAndGovernanceContext;
  runtimes: AgentRuntimesContext;
  memory: MemoryAndBystanderContext;
  jobStore: AgentJobStore;
  getSchedulers: () => BackgroundSchedulersContext;
  setActiveClient: (client: DWClient | undefined) => void;
  resetTokenCache: () => void;
  getAccessToken: () => Promise<string>;
}

export interface DingTalkIngressContext {
  createStreamer: (
    message: InboundMessage,
    options?: { mention?: string; atAll?: boolean },
  ) => CardStreamer;
  resolveEmployeeDisplayName: (
    staffId: string | undefined,
  ) => Promise<string | undefined>;
  recordTrace: (
    collector: TraceCollector,
    message: InboundMessage,
    result: RunResult | null,
    proactive: boolean,
  ) => Promise<void>;
  dwsWriteTasksService: DwsWriteTaskService;
  startGateway: () => Promise<void>;
  startGatewayIfLeader: () => Promise<void>;
  stopGateway: () => void;
  rebuildGatewayForCredentials: () => void;
  refreshBystanderListenGroups: () => Promise<void>;
  startBystanderListener: () => Promise<void>;
  stopBystanderListener: () => void;
  isStreamConnected: () => boolean;
  isBystanderListenRunning: () => boolean;
  getAllowedListenConversations: () => Iterable<string>;
  getGatewaySeen: (messageId: string) => boolean;
}

const QUEUE_CANCELLED_TEXT = '这条问题已按 /stop 取消，没有执行。';

/** 初始化钉钉交互流水线（AI 卡片、命令路由、延迟多模态增强、Async ReAct Handoff、旁听漏斗、DWS 授权恢复） */
export async function setupDingTalkIngress(
  deps: DingTalkIngressDeps,
): Promise<DingTalkIngressContext> {
  const {
    db,
    configCenter,
    traceStore,
    feedbackStore,
    groupDirectory,
    whitelistStore,
    whitelist,
    runControl,
    metrics,
    sharedState,
    clusterEnabled,
    isLeader,
    redactionEnabled,
    harnessLogger: logger,
    gatewayLogger,
    cardLogger,
    tools,
    runtimes,
    memory,
    jobStore,
    getSchedulers,
    setActiveClient,
    resetTokenCache,
    getAccessToken,
  } = deps;

  let gateway: StreamGateway | undefined;
  let bystanderListener: DwsGroupMessageListener | undefined;
  let bystanderListenTimer: ReturnType<typeof setInterval> | undefined;
  let streamConnected = false;

  const asyncReactEnabled = envEnabled(process.env.ASYNC_REACT_ENABLED, false);
  const asyncHandoffMs = asyncReactEnabled
    ? envSeconds(process.env.ASYNC_REACT_THRESHOLD_SECONDS, 25) * 1_000
    : 0;

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
    options: { mention?: string; atAll?: boolean } = {},
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
        layout === 'v1' || layout === 'v2' || layout === 'ai' ? layout : 'ai',
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
      ...(options.atAll ? { atAll: true } : {}),
    });
  };

  memory.groupNotifyAll.deliver = async ({
    conversationId,
    text,
    requesterMessageId,
  }) => {
    const message: InboundMessage = {
      messageId: `group_notify_all_${randomUUID()}`,
      conversationId,
      conversationType: '2',
      senderStaffId: 'scheduler',
      senderNick: '全员通知',
      cardDeliverUserId: '',
      isAtBot: false,
      text: '',
      rawPayload: { source: 'group_notify_all' },
      timestamp: Date.now(),
    };
    const streamer = createStreamer(message, { atAll: true });
    await streamer.start();
    if (streamer.isAvailable) {
      for (const chunk of splitForDelivery(text)) {
        streamer.handle({ type: 'answer_delta', content: chunk });
      }
      await streamer.finish();
      return { channel: 'card' };
    }
    const original = requesterMessageId
      ? runControl.messageById(requesterMessageId)
      : null;
    const webhook = original?.rawPayload.sessionWebhook;
    if (typeof webhook !== 'string' || !webhook) {
      throw new Error('卡片创建失败，且原始消息没有可用的 sessionWebhook');
    }
    const result = await sendTextFallback({
      webhook,
      text,
      isAtAll: true,
      logger: cardLogger,
    });
    if (!result.ok) {
      throw new Error(result.error ?? '文本兜底发送失败');
    }
    return { channel: 'text' };
  };

  const emotionReplier = new EmotionReplier({
    api: new OpenApiRobotEmotionApi({
      clientId: configCenter.getDingTalkConfig().clientId,
      clientSecret: configCenter.getDingTalkConfig().clientSecret,
      getAccessToken,
      logger: cardLogger,
    }),
    enabled: envEnabled(process.env.DINGTALK_BOT_EMOTION_ENABLED, true),
    emotionName: process.env.DINGTALK_BOT_EMOTION_NAME?.trim() || 'Like',
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
      const found = await memory.personIdentityStore
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
    const dwsRecord = await tools.identityService.getRecord(trimmed).catch(() => null);
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
            : undefined) ?? (await resolveEmployeeDisplayName(creatorStaffId));
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
          await tools.adminTextSender.send([staffId], chunk);
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
        { conversationId: message.conversationId, error: errorText(error) },
        'dws write task reply failed, fallback to direct message',
      );
      const result = await tools.adminTextSender.send([message.senderStaffId], text);
      if (!result.ok) {
        throw new Error(result.failed[0]?.error ?? '单聊消息发送失败');
      }
    }
  };

  const resolveCommandPersonKey = async (
    message: InboundMessage,
  ): Promise<string> => {
    try {
      return (await memory.personIdentity.resolve(message)).personKey;
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

  const executeDwsWriteTask = async (task: DwsWriteTask): Promise<void> => {
    const registry = tools.toolRegistry;
    if (!tools.executionPolicy.allows(task.toolName)) {
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
      const action = tools.pendingActions.put({
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
        `${formatApprovalPrompt(action, tools.pendingActions.ttlSeconds)}\n\n这是授权前你发起的写操作，确认后才会执行。`,
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

  const dwsWriteTasksService = new DwsWriteTaskService({
    store: new DrizzleDwsWriteTaskStore(db),
    identity: tools.identityService,
    resume: (task) => executeDwsWriteTask(task),
    notify: notifyDwsWriteTask,
    logger,
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

  const silentInvestigationConfig = resolveSilentInvestigationConfig(process.env);
  const silentInvestigation = new SilentInvestigationService({
    config: silentInvestigationConfig,
    cooldown: new CooldownLimiter(),
    investigate: ({ message, query, signal, maxWallTimeMs }) =>
      memory.harness.investigate(message, {
        query,
        maxWallTimeMs,
        ...(signal ? { signal } : {}),
      }),
    surface: surfaceSilentInvestigation,
    auditStore: new DrizzleSilentInvestigationStore(db),
    logger,
    onSurfaced: (message) => memory.cooldown.markReplied(message.conversationId),
  });
  logger.info({ ...silentInvestigationConfig }, 'silent investigation configured');

  const makeEmit = (
    collector: TraceCollector,
    streamer: CardStreamer,
  ): ((event: AgentStreamEvent) => void) => {
    return (event) => {
      collector.handle(event);
      streamer.handle(event);
      recordStreamEventMetrics(metrics, event);
    };
  };

  const pendingNoticeMessage = (
    entry: { conversationId: string; messageId?: string },
    staffId?: string,
  ): InboundMessage | null => {
    const byId = entry.messageId ? runControl.messageById(entry.messageId) : null;
    if (byId) {
      return staffId && byId.senderStaffId !== staffId ? null : byId;
    }
    const last = runControl.lastMessage(entry.conversationId);
    if (!last) return null;
    return staffId && last.senderStaffId !== staffId ? null : last;
  };

  const commandRouter = new CommandRouter({
    isAdmin: (staffId) => configCenter.isAdmin(staffId),
    stopRun: (conversationId) => runControl.stop(conversationId),
    steerRun: (conversationId, instruction) =>
      runControl.pushSteering(conversationId, instruction)
        ? '已收到实时引导指令，将在下一轮思考前注入执行上下文。'
        : '当前没有正在进行的回答，或引导指令为空；请直接发送新问题。',
    retryLast: async (conversationId) => {
      const last = runControl.lastMessage(conversationId);
      if (!last) return 'none';
      void handleIncoming(last);
      return 'started';
    },
    resetConversation: async (message) => {
      const conversation = await memory.repository.ensureConversation({
        conversationKey: conversationKeyFor(message),
        conversationType: message.conversationType,
        title: conversationTitleFor(message),
        metadata: {
          conversationId: message.conversationId,
          senderStaffId: message.senderStaffId,
        },
      });
      await memory.repository.clearMessages(conversation.id);
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
      const status = await tools.identityService.status(message.senderStaffId, {
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
              `账号：${record.userName}${record.corpName ? ` @ ${record.corpName}` : ''}`,
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
      const current = await tools.identityService.status(message.senderStaffId, {
        force: true,
      });
      if (current.state === 'authenticated') {
        return `本人 DWS 授权当前有效${
          current.record?.userName ? `（${current.record.userName}）` : ''
        }，无需重新登录。如需切换到其他账号或撤销授权，先发送「退出授权」或「撤销授权」。`;
      }
      let ticket;
      try {
        ticket = await tools.identityService.startLogin(message.senderStaffId);
      } catch (error) {
        if (error instanceof DwsIdentityError && error.code === 'consent-required') {
          return '请先发送「授权范围」查看授权说明，再发送「同意授权」表示同意。';
        }
        const reason = error instanceof Error ? error.message : String(error);
        return `发起本人 DWS 授权失败：${reason}`;
      }
      tools.identityService.markPending(
        message.senderStaffId,
        message.conversationId,
        { resume: false, messageId: message.messageId },
      );
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
          await tools.identityService.getRecord(message.senderStaffId),
        );
      }
      if (action === 'agree') {
        const record = await tools.identityService.recordConsent(
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
          await tools.identityService.setWriteEnabled(
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
        await dwsWriteTasksService.cancelForStaff(
          message.senderStaffId,
          '用户已改回只读',
          '已改回只读，等待授权后自动执行的写操作已取消。',
        );
        return '已改回只读：后续写操作不会自动执行，需要时发送「允许写操作」重新允许。';
      }
      if (action === 'revoke') {
        await dwsWriteTasksService.cancelForStaff(
          message.senderStaffId,
          '用户已撤销 DWS 授权',
          '已撤销 DWS 授权，等待中的写操作已取消。',
        );
        await tools.identityService.revokeConsent(message.senderStaffId);
        return '已撤销 DWS 授权同意，并清除本机绑定的加密凭据目录。如需再次使用，请重新发送「同意授权」并发送「授权」。';
      }
      return '可用口令：发送「授权范围」、「同意授权」、「允许写操作」、「改回只读」、「撤销授权」';
    },
    dwsLogout: async (message) => {
      await dwsWriteTasksService.cancelForStaff(
        message.senderStaffId,
        '用户已退出 DWS 登录',
        '已退出 DWS 登录，等待授权后自动执行的写操作已取消。',
      );
      const cleared = await tools.identityService.logout(message.senderStaffId);
      return cleared
        ? '已清除你本机的 DWS 登录态，授权同意记录仍保留。如需重新授权，发送「重新授权」；如需彻底撤销同意，发送「撤销授权」。'
        : '当前没有可清除的 DWS 登录态。如需撤销同意记录，发送「撤销授权」。';
    },
    dwsSystemStatus: async () => {
      const status = await tools.authManager.status({ force: true });
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
              `账号：${status.userName}${status.corpName ? ` @ ${status.corpName}` : ''}`,
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
      const current = await tools.authManager.status({ force: true });
      if (current.state === 'authenticated') {
        return '系统级 DWS 授权当前有效，无需重新登录。员工个人业务请让他们自行发送「授权」。';
      }
      let ticket = tools.authManager.activeLogin();
      if (!ticket) {
        try {
          ticket = await tools.authManager.startLogin({
            startedBy: message.senderStaffId,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return `发起系统级 DWS 授权失败：${reason}`;
        }
      }
      tools.authManager.markPending(message.conversationId, {
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
    confirmAction: async (message, actionId) => {
      const query = actionId
        ? { actionIdPrefix: actionId }
        : { staffId: message.senderStaffId };
      const action = tools.pendingActions.peek(message.conversationId, query);
      if (!action) {
        return actionId
          ? `未找到编号以 \`${actionId}\` 开头的待确认操作，可能已过期或已被处理。`
          : '没有待确认的操作，可能已过期或已被处理。';
      }
      const isRequester = action.requestedBy.staffId === message.senderStaffId;
      if (!isRequester && !configCenter.isAdmin(message.senderStaffId)) {
        return '只有发起人或管理员可以确认该操作。';
      }
      tools.pendingActions.take(message.conversationId, {
        actionIdPrefix: action.id,
      });
      if (!tools.executionPolicy.allows(action.toolName)) {
        metrics.inc('agent_tool_confirmations_total', { result: 'blocked' });
        return `工具 \`${action.toolName}\` 已被执行策略禁用，操作已取消。`;
      }
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
      const tool = (await tools.toolRegistry.assembleTools(ctx)).find(
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
    cancelAction: async (conversationId, staffId, actionId) => {
      const isAdmin = Boolean(staffId && configCenter.isAdmin(staffId));
      const query = actionId
        ? { actionIdPrefix: actionId }
        : staffId && !isAdmin
          ? { staffId }
          : undefined;
      const cancelled = tools.pendingActions.cancel(conversationId, query);
      const cancelledWrite = actionId
        ? false
        : isAdmin
          ? await dwsWriteTasksService.cancelByConversation(conversationId)
          : staffId
            ? await dwsWriteTasksService.cancelByConversationForStaff(
                conversationId,
                staffId,
              )
            : false;
      metrics.inc('agent_tool_confirmations_total', {
        result: cancelled || cancelledWrite ? 'cancelled' : 'none',
      });
      return cancelled || cancelledWrite
        ? '已取消待确认或待授权后自动执行的操作。'
        : '没有待确认的操作。';
    },
    remind: (message, args) =>
      tools.personalAssistant.handleRemindCommand(message, args),
    reports: (message, args) =>
      tools.personalAssistant.handleReportCommand(message, args),
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
      const profile = runtimes.workerRegistry.get(worker);
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
        { jobId: job.id, conversationId: job.conversationId, worker },
        'worker job enqueued',
      );
      return [
        `已提交 ${profile.title} 任务 ${job.id.slice(0, 8)}，完成后会通过机器人单聊通知你。`,
        `执行范围：${profile.description}。查看进度：\`/jobs\`；详情：\`/job-status <id>\`；取消：\`/job-cancel <id>\`。`,
      ].join('\n');
    },
    tasks: (message, args) => getSchedulers().taskService.handleCommand(message, args),
    group: async (message, args) => {
      const personKey = await resolveCommandPersonKey(message);
      if (args[0]?.toLowerCase() === 'report') {
        return memory.groupReport.handleCommand(message, args.slice(1));
      }
      return memory.groupWorkspace.handleCommand(message, args, personKey);
    },
    pref: async (message, args) =>
      memory.personSettings.handlePreferenceCommand(
        message,
        args,
        await resolveCommandPersonKey(message),
      ),
    privacy: async (message, args) =>
      memory.personSettings.handleConsentCommand(
        message,
        args,
        await resolveCommandPersonKey(message),
      ),
    memory: async (message, args) =>
      memory.personalMemory.handleCommand(
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
      const resolved = await getSchedulers().resolveJobForMessage(message, id);
      if ('error' in resolved) return resolved.error;
      return formatJob(resolved.job);
    },
    cancelJob: async (message, id) => {
      const resolved = await getSchedulers().resolveJobForMessage(message, id);
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
        await getSchedulers().taskService.completeForJob(
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
      const resolved = await getSchedulers().resolveJobForMessage(message, id);
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
      const resumed = await jobStore.resume(job.id, prompt ? { prompt } : {});
      if (!resumed) return '任务状态已变化，请发送 /jobs 重新查看。';
      metrics.inc('agent_jobs_total', { kind: resumed.kind, status: 'queued' });
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

  function markQueued(streamer: CardStreamer, run: BeginRunResult): void {
    if (run.queuedAhead <= 0) return;
    streamer.handle({
      type: 'status',
      message: `前方还有 ${run.queuedAhead} 条消息正在处理，已加入队列按顺序回复；发送 /stop 可取消排队。`,
    });
  }

  async function enrichMessageInTurn(
    message: InboundMessage,
    signal: AbortSignal,
  ): Promise<InboundMessage> {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }
    try {
      const enriched = await enrichInboundMessage(message, {
        store: tools.attachmentStore,
        ...(tools.visionDescriber ? { vision: tools.visionDescriber } : {}),
        logger,
        signal,
        onDocument: (info) =>
          metrics.inc('agent_document_extract_total', {
            format:
              info.format ??
              (extname(info.fileName).slice(1).toLowerCase() || 'unknown'),
            result: info.ok ? 'ok' : (info.reason ?? 'failed'),
          }),
      });
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
      return enriched.message;
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warn(
        { messageId: message.messageId, error: errorText(error) },
        'attachment enrichment failed, continue with raw message',
      );
      return message;
    }
  }

  async function runTurn(
    message: InboundMessage,
    run: BeginRunResult,
    proactive = false,
    startedStreamer?: CardStreamer,
  ): Promise<void> {
    const mention = replyMention(message, proactive);
    const streamer = startedStreamer ?? createStreamer(message, { mention });
    const collector = new TraceCollector();
    const emit = makeEmit(collector, streamer);
    if (!startedStreamer) await streamer.start();
    markQueued(streamer, run);
    try {
      await run.started;
      if (run.signal.aborted) {
        streamer.handle({ type: 'answer_delta', content: QUEUE_CANCELLED_TEXT });
        await streamer.finish();
        return;
      }

      // 将耗时的附件下载与多模态识图延后至拿到队列执行权后再运行，支持 /stop 瞬时取消
      const effective = proactive
        ? message
        : await enrichMessageInTurn(message, run.signal);
      if (!proactive) {
        runControl.remember(effective);
      }
      if (run.signal.aborted) {
        streamer.handle({ type: 'answer_delta', content: QUEUE_CANCELLED_TEXT });
        await streamer.finish();
        return;
      }

      metrics.inc('agent_messages_total', {
        conversationType: effective.conversationType,
      });

      let sawMutatingTool = false;
      const trackingEmit = (event: AgentStreamEvent): void => {
        if (event.type === 'tool_start' && !isReadOnlyToolName(event.toolName)) {
          sawMutatingTool = true;
        }
        emit(event);
      };

      const outcome = await runTurnWithAsyncHandoff({
        handoffAfterMs: !proactive ? asyncHandoffMs : 0,
        signal: run.signal,
        hasSideEffects: () => sawMutatingTool,
        runForeground: (fgSignal) =>
          memory.harness.handleMessage(effective, {
            emit: trackingEmit,
            signal: fgSignal,
            proactive,
            notify: async (text) => replyTo(effective, text, proactive),
          }),
        enqueueBackground: () =>
          jobStore.enqueue({
            conversationId: effective.conversationId,
            conversationType: effective.conversationType,
            messageId: `async_${effective.messageId}_${Date.now()}`,
            senderStaffId: effective.senderStaffId,
            senderNick: effective.senderNick,
            kind: 'task',
            prompt: effective.text,
            metadata: {
              source: 'async_handoff',
              originalMessageId: effective.messageId,
              requestedAt: Date.now(),
            },
          }),
        cancelBackground: async (job) => {
          await jobStore.cancel(job.id);
        },
        onHandoff: async (job) => {
          metrics.inc('agent_async_handoff_total');
          const shortId = job.id.slice(0, 8);
          streamer.handle({
            type: 'answer_delta',
            content: [
              '',
              `⏳ 该问题步骤较多，已转入后台持久化队列执行（任务 ID：\`${shortId}\`），完成后将通过单聊通知你。`,
              `当前对话队列已释放，可继续发送新问题；使用 \`/job-status ${shortId}\` 可随时查询进度。`,
            ].join('\n'),
          });
          await streamer.finish();
        },
      });

      if (outcome.mode === 'background') {
        return;
      }

      const result = outcome.result;
      await streamer.finish();
      const overflow = streamer.takeOverflowAnswer();
      if (overflow) {
        await deliverFallbackText(effective, overflow, proactive);
      }
      await recordTrace(collector, effective, result, proactive);
      if (result && !streamer.isAvailable && result.answer) {
        await deliverFallbackText(effective, result.answer, proactive);
      }
    } catch (error) {
      if (run.signal.aborted) {
        streamer.handle({ type: 'answer_delta', content: QUEUE_CANCELLED_TEXT });
        await streamer.finish();
        return;
      }
      logger.error(
        { messageId: message.messageId, error: errorText(error) },
        'turn failed',
      );
      streamer.handle({ type: 'error', message: FALLBACK_ERROR_TEXT });
      await streamer.finish();
      await recordTrace(collector, message, EMPTY_RESULT, proactive);
      if (!streamer.isAvailable) {
        await deliverFallbackText(message, FALLBACK_ERROR_TEXT, proactive);
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
      const context = findMentionOnlyContext(message, memory.transcriptBuffer);
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

    const run = runControl.begin(message);
    runControl.remember(message);
    metrics.set('agent_active_runs', runControl.activeCount());
    try {
      emotionReplier.mark(message);
      const streamer = createStreamer(message, {
        mention: replyMention(message),
      });
      await streamer.start();
      await runTurn(message, run, false, streamer);
    } finally {
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
        streamer.handle({ type: 'answer_delta', content: QUEUE_CANCELLED_TEXT });
        await streamer.finish();
        return;
      }
      const result = await memory.harness.handleBystanderMessage(message, {
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

  tools.authManager.on('login-success', ({ staffId, status }) => {
    const pending = tools.authManager.takePending();
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
          logger.warn({ error: errorText(error) }, 'dws resume notice failed'),
        );
        continue;
      }
      void (async () => {
        await replyTo(last, 'DWS 授权已恢复，正在继续刚才的问题…');
        await handleIncoming(last);
      })().catch((error) =>
        logger.warn(
          { conversationId: entry.conversationId, error: errorText(error) },
          'dws resume failed',
        ),
      );
    }
  });

  tools.authManager.on('login-failed', ({ staffId, reason }) => {
    const pending = tools.authManager.takePending();
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

  tools.identityService.on('login-success', ({ staffId, status }) => {
    const pending = tools.identityService.takePending(staffId);
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
      const claimed = new Set(await dwsWriteTasksService.resumeForStaff(staffId));
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
      logger.warn({ staffId, error: errorText(error) }, 'personal dws resume failed'),
    );
  });

  tools.identityService.on('login-failed', ({ staffId, reason }) => {
    const pending = tools.identityService.takePending(staffId);
    logger.warn(
      { staffId, reason, pending: pending.length },
      'personal dws identity not linked',
    );
    void (async () => {
      const failed = new Set(
        await dwsWriteTasksService.failForStaff(staffId, reason),
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
    try {
      await memory.repository.ensureConversation({
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
    if (parseCommand(message.text)) {
      await commandRouter.tryHandle(message);
      return;
    }
    const groupPolicy = await memory.policyProvider.getPolicy(
      message.conversationId,
    );
    let decision: BystanderEvaluationResult;
    try {
      decision = await memory.triage.evaluate(message, groupPolicy);
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
    void silentInvestigation.consider({
      message,
      decision,
      policy: groupPolicy,
    });
  };

  const gatewayOptions = () => ({
    logger: gatewayLogger,
    transcriptBuffer: memory.transcriptBuffer,
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
        action.nick?.trim() || (await resolveEmployeeDisplayName(action.userId));
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
    setActiveClient(client);
    resetTokenCache();
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
    if (clusterEnabled && !isLeader()) return;
    if (gateway) return;
    await startGateway();
  };

  const stopGateway = (): void => {
    streamConnected = false;
    metrics.set('agent_stream_connected', 0);
    gateway?.stop();
    gateway = undefined;
  };

  const rebuildGatewayForCredentials = (): void => {
    stopGateway();
    void startGatewayIfLeader()
      .then(() => logger.info({}, 'stream gateway rebuilt'))
      .catch((error) =>
        logger.error({ error: errorText(error) }, 'stream gateway rebuild failed'),
      );
  };

  const parseList = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

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
      ...(tools.transcriptArchiveEnabled
        ? {
            onTranscript: (message: InboundMessage) => {
              void tools.groupTranscriptArchive
                .append(toTranscriptEntry(message))
                .catch((error) => {
                  logger.warn(
                    {
                      conversationId: message.conversationId,
                      error: errorText(error),
                    },
                    'failed to archive non-subscribed group transcript',
                  );
                });
            },
          }
        : {}),
      shouldIgnore: (messageId) => gateway?.hasSeen(messageId) === true,
      isSenderAllowed: (message) =>
        whitelist.isOpenIdAllowed(message.senderStaffId, message.senderNick),
      ignoreSenders: [
        ...new Set([
          ...parseList(process.env.BYSTANDER_LISTEN_IGNORE_SENDERS),
          configCenter.getLLMConfig().persona.name,
          ...knownBotNames,
        ]),
      ],
      settleMs: envSeconds(process.env.BYSTANDER_LISTEN_SETTLE_SECONDS, 3) * 1_000,
      logger,
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

  return {
    createStreamer,
    resolveEmployeeDisplayName,
    recordTrace,
    dwsWriteTasksService,
    startGateway,
    startGatewayIfLeader,
    stopGateway,
    rebuildGatewayForCredentials,
    refreshBystanderListenGroups,
    startBystanderListener,
    stopBystanderListener,
    isStreamConnected: () => streamConnected,
    isBystanderListenRunning: () => Boolean(bystanderListenTimer),
    getAllowedListenConversations: () =>
      bystanderListener?.allowedConversations ?? [],
    getGatewaySeen: (messageId) => gateway?.hasSeen(messageId) === true,
  };
}
