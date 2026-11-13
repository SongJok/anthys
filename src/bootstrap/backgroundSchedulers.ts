import { randomUUID } from 'node:crypto';
import { formatTraceSenderNick } from '../admin-api/runtime.js';
import type { MetricsRegistry } from '../admin-api/metrics.js';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { DrizzleScheduledTaskStore } from '../db/schedulerSchema.js';
import type { DingTalkAdminTextSender } from '../dingtalk/AdminTextSender.js';
import type { CardStreamer } from '../dingtalk/CardStreamer.js';
import { isStaffUserId } from '../dingtalk/userIds.js';
import type { GroupWorkspaceService } from '../groups/GroupWorkspaceService.js';
import type { AgentHarness, HarnessLogger } from '../harness/AgentHarness.js';
import { JobPauseError, JobRunner } from '../jobs/JobRunner.js';
import { formatJobResultNotice } from '../jobs/JobService.js';
import type { TaskResultMemory } from '../memory/TaskResultMemory.js';
import type { PersonalAssistantService } from '../personal/PersonalAssistantService.js';
import {
  computeNextRun,
  ScheduledTaskScheduler,
} from '../scheduler/ScheduledTaskScheduler.js';
import { TaskService, taskIdFromJob } from '../tasks/TaskService.js';
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  SystemLoopStatus,
} from '../types/admin-and-console.js';
import type { InboundMessage } from '../types/core.js';
import type { AgentJob, AgentJobStore } from '../types/jobs.js';
import type { AgentTaskStore } from '../types/tasks.js';
import { isWorkerName } from '../types/workers.js';
import {
  envCount,
  envSeconds,
  errorText,
  splitForDelivery,
} from './envHelpers.js';

export interface BackgroundSchedulersDeps {
  configCenter: DynamicConfigCenter;
  jobStore: AgentJobStore;
  taskStore: AgentTaskStore;
  scheduledStore: DrizzleScheduledTaskStore;
  harness: AgentHarness;
  taskMemory: TaskResultMemory | null;
  personalAssistant: PersonalAssistantService;
  groupWorkspace: GroupWorkspaceService;
  adminTextSender: DingTalkAdminTextSender;
  metrics: MetricsRegistry;
  harnessLogger: HarnessLogger;
  resolveEmployeeDisplayName: (
    staffId: string | undefined,
  ) => Promise<string | undefined>;
  createStreamer: (
    message: InboundMessage,
    options?: { mention?: string; atAll?: boolean },
  ) => CardStreamer;
  clusterEnabled: boolean;
  isLeader: () => boolean;
  isProjectSyncRunning: () => boolean;
  isBystanderListenRunning: () => boolean;
}

export interface BackgroundSchedulersContext {
  taskService: TaskService;
  jobRunner: JobRunner;
  taskScheduler: ScheduledTaskScheduler;
  scheduledApi: {
    list: () => Promise<ScheduledTask[]>;
    create: (input: ScheduledTaskInput) => Promise<ScheduledTask>;
    update: (id: string, input: ScheduledTaskUpdate) => Promise<ScheduledTask>;
    remove: (id: string) => Promise<boolean>;
    runNow: (id: string) => Promise<void>;
    systemLoops: () => SystemLoopStatus[];
  };
  resolveJobForMessage: (
    message: InboundMessage,
    id: string,
  ) => Promise<{ job: AgentJob } | { error: string }>;
}

/** 初始化任务线程路由、持久化后台队列 Runner（含定时 Prompt 异步化）与定时调度器 */
export function setupBackgroundSchedulers(
  deps: BackgroundSchedulersDeps,
): BackgroundSchedulersContext {
  const {
    configCenter,
    jobStore,
    taskStore,
    scheduledStore,
    harness,
    taskMemory,
    personalAssistant,
    groupWorkspace,
    adminTextSender,
    metrics,
    harnessLogger: logger,
    resolveEmployeeDisplayName,
    createStreamer,
    clusterEnabled,
    isLeader,
    isProjectSyncRunning,
    isBystanderListenRunning,
  } = deps;

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
    onExternalEvent: async (event, match) => {
      const targets = [
        ...new Set(
          (match.subscribers.length > 0
            ? match.subscribers.map((sub) => sub.staffId)
            : [match.task.ownerStaffId]
          ).filter((id) => isStaffUserId(id)),
        ),
      ];
      if (targets.length === 0) return;
      const notice = [
        `任务线程「${match.task.title}」（${match.task.id.slice(0, 8)}）收到外部事件：`,
        `[${event.source}:${event.eventType}] ${event.summary}`,
      ].join('\n');
      for (const staffId of targets) {
        const sent = await adminTextSender.send([staffId], notice);
        if (!sent.ok) {
          logger.warn(
            { taskId: match.task.id, staffId, failed: sent.failed },
            'external task event subscriber notification failed',
          );
        }
      }
    },
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

  const sendPersonalMessages = async (
    input: { id: string; conversationType: '1' | '2'; createdBy: string; kind?: string },
    text: string,
  ): Promise<void> => {
    if (input.conversationType !== '1') {
      throw new Error(`个人任务 ${input.id} 仅允许在单聊投递`);
    }
    const staffId = input.createdBy.trim();
    if (!isStaffUserId(staffId)) {
      throw new Error(`个人任务 ${input.id} 缺少有效的创建人`);
    }
    const chunks = splitForDelivery(text);
    for (const chunk of chunks) {
      const result = await adminTextSender.send([staffId], chunk);
      if (!result.ok) {
        throw new Error(result.failed[0]?.error ?? '单聊消息发送失败');
      }
    }
    logger.info(
      { taskId: input.id, staffId, kind: input.kind ?? 'scheduled', chunks: chunks.length },
      'personal task delivered',
    );
  };

  const sendGroupMessages = async (
    input: { id: string; conversationId: string; conversationType: '1' | '2'; createdBy: string },
    text: string,
  ): Promise<void> => {
    if (input.conversationType !== '2') {
      throw new Error(`群任务 ${input.id} 仅允许在群聊投递`);
    }
    const now = Date.now();
    const creatorName = await resolveEmployeeDisplayName(input.createdBy);
    const message: InboundMessage = {
      messageId: `group_report_${input.id}_${now}`,
      conversationId: input.conversationId,
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
        taskId: input.id,
        createdBy: input.createdBy,
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
      { taskId: input.id, conversationId: input.conversationId },
      'group report delivered',
    );
  };

  const deliverScheduledJobResult = async (
    job: AgentJob,
    answer: string,
  ): Promise<void> => {
    if (!answer.trim()) return;
    const scheduledTaskId =
      typeof job.metadata.scheduledTaskId === 'string'
        ? job.metadata.scheduledTaskId
        : job.id;
    const createdBy =
      typeof job.metadata.createdBy === 'string'
        ? job.metadata.createdBy
        : job.senderStaffId;
    if (job.conversationType === '2') {
      await sendGroupMessages(
        {
          id: scheduledTaskId,
          conversationId: job.conversationId,
          conversationType: '2',
          createdBy,
        },
        answer,
      );
      return;
    }
    await sendPersonalMessages(
      {
        id: scheduledTaskId,
        conversationType: '1',
        createdBy: createdBy || job.senderStaffId,
        kind: 'prompt',
      },
      answer,
    );
  };

  const jobRunner = new JobRunner({
    store: jobStore,
    logger,
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
      if (job.metadata.source === 'scheduled_task') {
        try {
          await deliverScheduledJobResult(job, job.result?.answer ?? '');
        } catch (error) {
          logger.warn(
            { jobId: job.id, error: errorText(error) },
            'failed to deliver scheduled job result',
          );
        }
        return;
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
      if (job.metadata.source === 'scheduled_task') {
        const createdBy =
          typeof job.metadata.createdBy === 'string' ? job.metadata.createdBy : '';
        if (isStaffUserId(createdBy)) {
          await adminTextSender
            .send(
              [createdBy],
              `定时任务执行失败（${job.id.slice(0, 8)}）：${error.slice(0, 400)}`,
            )
            .catch(() => {});
        }
        return;
      }
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
    metrics.inc('scheduled_task_runs_total', { kind: task.kind });

    // prompt 类定时任务转入持久化后台队列异步执行，避免慢 LLM 调用阻塞调度器时钟 tick
    const enqueued = await jobStore.enqueue({
      conversationId: task.conversationId,
      conversationType: task.conversationType,
      messageId: `scheduled_${task.id}_${now}`,
      senderStaffId: isPersonal ? targetStaffId : 'scheduler',
      senderNick: formatTraceSenderNick({
        senderNick: '定时任务',
        source: 'scheduled_task',
        ...(creatorName ? { employeeName: creatorName } : {}),
      }),
      kind: 'scheduled',
      prompt: task.prompt,
      metadata: {
        source: 'scheduled_task',
        scheduledTaskId: task.id,
        createdBy: task.createdBy,
        ...(creatorName ? { creatorNick: creatorName } : {}),
      },
    });
    logger.info(
      {
        taskId: task.id,
        jobId: enqueued.id,
        conversationId: task.conversationId,
      },
      'scheduled prompt task enqueued into job runner',
    );
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
      const kind = input.kind ?? 'prompt';
      const prompt = input.prompt?.trim() ?? '';
      if (!prompt && (kind === 'prompt' || kind === 'reminder')) {
        throw new Error('缺少 prompt');
      }
      const schedule = normalizeSchedule(input);
      const task = await scheduledStore.create(
        {
          conversationId: input.conversationId.trim(),
          conversationType: input.conversationType === '1' ? '1' : '2',
          kind,
          title: input.title?.trim() || '定时播报',
          prompt,
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
    systemLoops: (): SystemLoopStatus[] => {
      const leaderActive = !clusterEnabled || isLeader();
      const label = (seconds: number): string => {
        if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
        if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
        if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
        return `${seconds} 秒`;
      };
      const loop = (
        id: string,
        name: string,
        purpose: string,
        intervalSeconds: number,
        source: string,
        running: boolean,
        leaderGated: boolean,
        notes?: string,
      ): SystemLoopStatus => ({
        id,
        name,
        purpose,
        intervalSeconds,
        intervalLabel: label(intervalSeconds),
        source,
        running,
        leaderGated,
        ...(notes ? { notes } : {}),
      });
      const loops: SystemLoopStatus[] = [
        loop(
          'scheduled-task-scheduler',
          '定时任务调度',
          '轮询到期的定时任务并执行（提醒 / 报告 / 群播报 / 定时 prompt 入队）',
          15,
          '内置默认 15 秒（ScheduledTaskScheduler）',
          leaderActive,
          true,
        ),
        loop(
          'job-runner',
          '后台任务执行',
          '轮询后台长任务队列并按租约执行',
          envSeconds(process.env.JOB_RUNNER_INTERVAL_SECONDS, 5),
          'JOB_RUNNER_INTERVAL_SECONDS',
          leaderActive,
          true,
        ),
        loop(
          'project-auto-sync',
          '项目知识库自动同步',
          '按各项目 autoSyncMinutes 周期同步知识库',
          Math.max(60, envSeconds(process.env.PROJECT_SYNC_INTERVAL_SECONDS, 900)),
          'PROJECT_SYNC_INTERVAL_SECONDS',
          isProjectSyncRunning(),
          true,
          '每个项目的同步周期可在「项目」页单独配置',
        ),
        loop(
          'data-retention',
          '数据保留清理',
          '按保留期清理过期轨迹 / 消息等数据',
          envSeconds(process.env.DATA_CLEANUP_INTERVAL_SECONDS, 86_400),
          'DATA_CLEANUP_INTERVAL_SECONDS',
          true,
          true,
          '保留策略可在「数据治理」页配置；清理仅主实例执行',
        ),
        loop(
          'bystander-listen-refresh',
          '旁听订阅刷新',
          '刷新群旁听长连接订阅的群列表',
          envSeconds(process.env.BYSTANDER_LISTEN_REFRESH_SECONDS, 60),
          'BYSTANDER_LISTEN_REFRESH_SECONDS',
          isBystanderListenRunning(),
          true,
        ),
        loop(
          'dws-write-task-poller',
          'DWS 写操作授权轮询',
          '轮询等待本人 DWS 授权的写操作任务，授权通过后自动续跑',
          5,
          '内置默认 5 秒（DwsWriteTaskService）',
          true,
          false,
          '所有实例运行，靠 CAS 抢锁去重',
        ),
      ];
      if (clusterEnabled) {
        loops.push(
          loop(
            'cluster-config-poll',
            '集群共享配置轮询',
            '周期拉取共享配置中心变更',
            envSeconds(process.env.CLUSTER_CONFIG_POLL_SECONDS, 30),
            'CLUSTER_CONFIG_POLL_SECONDS',
            true,
            false,
            '仅集群模式',
          ),
          loop(
            'cluster-leadership',
            'Stream 主锁心跳',
            '主锁心跳与竞选，决定哪个实例接管 Stream',
            envSeconds(process.env.CLUSTER_HEARTBEAT_SECONDS, 10),
            'CLUSTER_HEARTBEAT_SECONDS',
            true,
            false,
            '仅集群模式',
          ),
        );
      }
      return loops;
    },
  };

  const taskScheduler = new ScheduledTaskScheduler({
    store: scheduledStore,
    execute: executeScheduledTask,
    maxConcurrency: envCount(process.env.SCHEDULED_TASK_MAX_CONCURRENCY, 3),
    logger,
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

  return {
    taskService,
    jobRunner,
    taskScheduler,
    scheduledApi,
    resolveJobForMessage,
  };
}
