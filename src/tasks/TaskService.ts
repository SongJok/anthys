import type { InboundMessage } from '../types/core.js';
import type { AgentJob } from '../types/jobs.js';
import type {
  AgentTask,
  AgentTaskLink,
  AgentTaskLinkKind,
  AgentTaskStatus,
  AgentTaskStore,
  AgentTaskSubscription,
  ExternalTaskLinkRef,
} from '../types/tasks.js';
import { AGENT_TASK_LINK_KINDS } from '../types/tasks.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const TASK_TITLE_LIMIT = 60;
const TASK_SUMMARY_LIMIT = 2_000;
const MAX_EXTERNAL_EVENTS = 20;
const DEFAULT_CONTINUATION_COOLDOWN_MS = 60_000;
const URL_REF_PATTERN = /https?:\/\/[^\s"'<>）)]+/gi;
const ISSUE_REF_PATTERN = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)\b/g;

const TASK_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  active: '进行中',
  completed: '已完成',
  failed: '失败',
  closed: '已关闭',
};

const LINK_KIND_LABELS: Record<AgentTaskLinkKind, string> = {
  message: '消息',
  conversation: '会话',
  job: '后台任务',
  url: '链接',
  doc: '文档',
  issue: '议题',
  card: '卡片',
  other: '其他',
};

export interface ExternalTaskEvent {
  source: string;
  eventType: string;
  deliveryId?: string;
  summary: string;
  refs: ExternalTaskLinkRef[];
  payload?: Record<string, unknown>;
}

export interface ExternalTaskMatch {
  task: AgentTask;
  subscribers: AgentTaskSubscription[];
}

export interface TaskContinuationInput {
  task: AgentTask;
  event: ExternalTaskEvent;
  prompt: string;
}

export interface RouteExternalEventResult {
  matchedTasks: ExternalTaskMatch[];
  notificationsSent: number;
  continuationsEnqueued: number;
}

export interface TaskServiceOptions {
  store: AgentTaskStore;
  enqueue: (
    message: InboundMessage,
    prompt: string,
    taskId: string,
  ) => Promise<AgentJob>;
  isAdmin: (staffId: string) => boolean;
  onExternalEvent?: (
    event: ExternalTaskEvent,
    match: ExternalTaskMatch,
  ) => Promise<void> | void;
  /** 外部事件命中活跃任务线程时自动派生后台 Worker 增量续跑任务 */
  enqueueContinuation?: (
    input: TaskContinuationInput,
  ) => Promise<AgentJob | null>;
  /** 同一任务线程两次自动续跑的最小冷却间隔，默认 60s，防 Webhook 风暴 */
  continuationCooldownMs?: number;
  now?: () => number;
}

export interface CreateTaskResult {
  task: AgentTask;
  job: AgentJob;
}

export function taskIdFromJob(job: AgentJob): string | undefined {
  const value = job.metadata.taskId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isTaskLinkKind(value: string): value is AgentTaskLinkKind {
  return (AGENT_TASK_LINK_KINDS as readonly string[]).includes(value);
}

function taskTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  return normalized.length > TASK_TITLE_LIMIT
    ? `${normalized.slice(0, TASK_TITLE_LIMIT)}…`
    : normalized;
}

const TASK_USAGE = [
  '任务线程用法：',
  '- `/task new <需求>` 创建线程并提交后台任务',
  '- `/task list` 查看本会话任务线程',
  '- `/task show <ID>` 查看详情（ID 支持前缀）',
  `- \`/task link <ID> <${AGENT_TASK_LINK_KINDS.join('|')}> <引用> [说明]\` 关联外部实体`,
  '- `/task subscribe <ID>` 订阅更新；`/task unsubscribe <ID>` 取消订阅',
  '- `/task follow <ID> <on|off>` 开启或关闭外部事件自动跟进续跑',
  '- `/task close <ID>` 关闭线程（不会自动取消后台任务）',
].join('\n');

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatLink(link: AgentTaskLink): string {
  const label = link.label ? `（${link.label}）` : '';
  return `${LINK_KIND_LABELS[link.kind]}:${link.ref}${label}`;
}

/**
 * 任务线程：把一次后台需求、外部实体与订阅者聚合在一起。
 * 线程状态跟随派生后台任务更新，关闭线程不会隐式取消作业。
 */
export class TaskService {
  private readonly store: AgentTaskStore;
  private readonly enqueue: TaskServiceOptions['enqueue'];
  private readonly isAdmin: (staffId: string) => boolean;
  private readonly onExternalEvent: TaskServiceOptions['onExternalEvent'];
  private readonly enqueueContinuation: TaskServiceOptions['enqueueContinuation'];
  private readonly continuationCooldownMs: number;
  private readonly now: () => number;

  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.enqueue = options.enqueue;
    this.isAdmin = options.isAdmin;
    this.onExternalEvent = options.onExternalEvent;
    this.enqueueContinuation = options.enqueueContinuation;
    this.continuationCooldownMs = Math.max(
      0,
      options.continuationCooldownMs ?? DEFAULT_CONTINUATION_COOLDOWN_MS,
    );
    this.now = options.now ?? Date.now;
  }

  public usage(): string {
    return TASK_USAGE;
  }

  public async createFromMessage(
    message: InboundMessage,
    prompt: string,
  ): Promise<CreateTaskResult> {
    const text = prompt.trim();
    if (!text) throw new Error('任务线程缺少需求描述');
    const task = await this.store.create({
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      ownerStaffId: message.senderStaffId,
      ownerNick: message.senderNick,
      title: taskTitle(text),
      prompt: text,
      metadata: { source: 'command' },
    });
    await this.store.subscribe({
      taskId: task.id,
      staffId: message.senderStaffId,
      nick: message.senderNick,
    });
    if (message.messageId) {
      await this.store.addLink({
        taskId: task.id,
        kind: 'message',
        ref: message.messageId,
        label: '发起消息',
      });
    }
    await this.store.addLink({
      taskId: task.id,
      kind: 'conversation',
      ref: message.conversationId,
      label: '所属会话',
    });

    let job: AgentJob;
    try {
      job = await this.enqueue(message, text, task.id);
    } catch (error) {
      await this.store
        .update(task.id, {
          status: 'failed',
          summary: '创建后台任务失败',
        })
        .catch(() => undefined);
      throw error;
    }
    await this.store.addLink({
      taskId: task.id,
      kind: 'job',
      ref: job.id,
      label: '后台任务',
    });
    return { task, job };
  }

  public async handleCommand(
    message: InboundMessage,
    args: string[],
  ): Promise<string> {
    const [subcommand, ...rest] = args;
    switch (subcommand?.toLowerCase()) {
      case 'new': {
        const prompt = rest.join(' ').trim();
        if (!prompt) return TASK_USAGE;
        const { task, job } = await this.createFromMessage(message, prompt);
        return [
          `已创建任务线程 ${shortId(task.id)}，后台任务 ${shortId(job.id)} 已入队。`,
          `你已自动订阅更新。查看：\`/task show ${shortId(task.id)}\`；取消订阅：\`/task unsubscribe ${shortId(task.id)}\`。`,
        ].join('\n');
      }
      case 'list':
        return this.formatList(message);
      case 'show': {
        const resolved = await this.resolve(message, rest[0] ?? '');
        if ('error' in resolved) return resolved.error;
        return this.formatDetail(resolved.task);
      }
      case 'link':
        return this.link(message, rest);
      case 'subscribe':
        return this.subscribe(message, rest[0] ?? '');
      case 'unsubscribe':
        return this.unsubscribe(message, rest[0] ?? '');
      case 'follow':
        return this.setAutoFollowUp(message, rest[0] ?? '', rest[1] ?? '');
      case 'close':
        return this.close(message, rest[0] ?? '');
      default:
        return TASK_USAGE;
    }
  }

  /** 后台任务完成/失败后同步线程；已关闭的线程不再被改写 */
  public async completeForJob(
    job: AgentJob,
    status: Extract<AgentTaskStatus, 'completed' | 'failed'>,
    summary: string | null,
  ): Promise<AgentTask | null> {
    const taskId = taskIdFromJob(job);
    if (!taskId) return null;
    const task = await this.store.get(taskId);
    if (!task) return null;
    await this.store
      .addLink({
        taskId,
        kind: 'job',
        ref: job.id,
        label: '后台任务',
      })
      .catch(() => undefined);
    if (task.status === 'closed') return task;
    const clipped =
      summary && summary.trim()
        ? summary.trim().slice(0, TASK_SUMMARY_LIMIT)
        : null;
    return this.store.update(taskId, { status, summary: clipped });
  }

  /** 将外部系统事件（如 GitHub PR/Issue Webhook）按关联链接路由至活跃任务线程，通知订阅者并按需唤醒 Worker 增量续跑 */
  public async routeExternalEvent(
    event: ExternalTaskEvent,
  ): Promise<RouteExternalEventResult> {
    if (!this.store.findActiveByLinks) {
      return { matchedTasks: [], notificationsSent: 0, continuationsEnqueued: 0 };
    }
    const candidates = await this.store.findActiveByLinks(event.refs);
    if (candidates.length === 0) {
      return { matchedTasks: [], notificationsSent: 0, continuationsEnqueued: 0 };
    }

    const matchedTasks: ExternalTaskMatch[] = [];
    let notificationsSent = 0;
    let continuationsEnqueued = 0;
    const timestamp = this.now();
    const noteLine = `[${event.source}:${event.eventType}] ${event.summary}`.trim();

    for (const task of candidates) {
      if (task.status !== 'active') continue;
      const existingEvents = Array.isArray(task.metadata.externalEvents)
        ? (task.metadata.externalEvents as Array<Record<string, unknown>>)
        : [];
      if (
        event.deliveryId &&
        existingEvents.some((item) => item?.deliveryId === event.deliveryId)
      ) {
        continue;
      }

      const nextEvents = [
        ...existingEvents,
        {
          source: event.source,
          eventType: event.eventType,
          ...(event.deliveryId ? { deliveryId: event.deliveryId } : {}),
          summary: event.summary,
          receivedAt: timestamp,
          ...(event.payload ? { payload: event.payload } : {}),
        },
      ].slice(-MAX_EXTERNAL_EVENTS);

      const nextSummary = [task.summary?.trim(), noteLine]
        .filter((part): part is string => Boolean(part))
        .join('\n')
        .slice(-TASK_SUMMARY_LIMIT);

      const lastContinuationAt =
        typeof task.metadata.lastContinuationAt === 'number'
          ? task.metadata.lastContinuationAt
          : 0;
      const canAutoFollowUp =
        Boolean(this.enqueueContinuation) &&
        task.metadata.autoFollowUp !== false &&
        timestamp - lastContinuationAt >= this.continuationCooldownMs;

      let updated =
        (await this.store.update(task.id, {
          summary: nextSummary,
          metadata: {
            ...task.metadata,
            externalEvents: nextEvents,
            lastExternalEventAt: timestamp,
          },
        })) ?? task;

      if (canAutoFollowUp && this.enqueueContinuation) {
        const continuationPrompt = [
          `你正在增量跟进已有任务线程「${updated.title}」（ID: ${updated.id.slice(0, 8)}）。`,
          `原始需求：${updated.prompt}`,
          updated.summary ? `此前进展摘要：\n${updated.summary}` : '',
          `最新到达的外部事件：\n来源：${event.source}\n事件类型：${event.eventType}\n摘要：${event.summary}`,
          event.payload
            ? `事件载荷：${JSON.stringify(event.payload).slice(0, 1_500)}`
            : '',
          '请基于新事件与既有进展做只读查证与增量分析，直接给出最新结论、风险变化与下一步建议。',
        ]
          .filter(Boolean)
          .join('\n\n');
        const continuationJob = await this.enqueueContinuation({
          task: updated,
          event,
          prompt: continuationPrompt,
        });
        if (continuationJob) {
          continuationsEnqueued += 1;
          await this.store
            .addLink({
              taskId: updated.id,
              kind: 'job',
              ref: continuationJob.id,
              label: `事件续跑:${event.eventType}`,
            })
            .catch(() => undefined);
          updated =
            (await this.store.update(updated.id, {
              metadata: {
                ...updated.metadata,
                lastContinuationAt: timestamp,
                lastContinuationJobId: continuationJob.id,
              },
            })) ?? updated;
        }
      }

      const subscribers = await this.store.listSubscribers(task.id);
      const match: ExternalTaskMatch = { task: updated, subscribers };
      matchedTasks.push(match);

      if (this.onExternalEvent) {
        await this.onExternalEvent(event, match);
        notificationsSent += subscribers.length > 0 ? subscribers.length : 1;
      }
    }

    return { matchedTasks, notificationsSent, continuationsEnqueued };
  }

  /** 检查群/单聊新消息是否显式提及了本会话活跃任务线程关联的外部引用（URL / owner/repo#num） */
  public async matchConversationTask(
    message: InboundMessage,
  ): Promise<AgentTask | null> {
    if (!this.store.findActiveByLinks) return null;
    const refs: ExternalTaskLinkRef[] = [];
    for (const match of message.text.matchAll(URL_REF_PATTERN)) {
      const ref = match[0].replace(/[.,;，。；]+$/u, '');
      if (ref) refs.push({ kind: 'url', ref });
    }
    for (const match of message.text.matchAll(ISSUE_REF_PATTERN)) {
      if (match[1]) refs.push({ kind: 'issue', ref: match[1] });
    }
    if (refs.length === 0) return null;
    const matched = await this.store.findActiveByLinks(refs);
    return (
      matched.find(
        (task) =>
          task.status === 'active' &&
          task.conversationId === message.conversationId,
      ) ?? null
    );
  }

  public async subscribers(taskId: string): Promise<AgentTaskSubscription[]> {
    return this.store.listSubscribers(taskId);
  }

  public async get(id: string): Promise<AgentTask | null> {
    return this.store.get(id);
  }

  private async formatList(message: InboundMessage): Promise<string> {
    const tasks = await this.store.list({
      conversationId: message.conversationId,
      limit: 10,
    });
    if (tasks.length === 0) {
      return '本会话暂无任务线程。发送 `/task new <需求>` 创建。';
    }
    const counts = await Promise.all(
      tasks.map(async (task) => (await this.store.listSubscribers(task.id)).length),
    );
    return [
      '本会话最近的任务线程：',
      ...tasks.map(
        (task, index) =>
          `- ${shortId(task.id)} · ${TASK_STATUS_LABELS[task.status]} · ${task.title} · ${counts[index] ?? 0} 人订阅`,
      ),
      '查看详情：`/task show <ID>`。',
    ].join('\n');
  }

  private async formatDetail(task: AgentTask): Promise<string> {
    const [links, subscribers] = await Promise.all([
      this.store.listLinks(task.id),
      this.store.listSubscribers(task.id),
    ]);
    const lines = [
      `任务 ${shortId(task.id)} · ${TASK_STATUS_LABELS[task.status]}`,
      `标题：${task.title}`,
      `创建：${formatShanghaiDateTime(task.createdAt)} · 更新：${formatShanghaiDateTime(task.updatedAt)}`,
    ];
    if (task.status === 'closed' && task.closedAt) {
      lines.push(`关闭：${formatShanghaiDateTime(task.closedAt)}`);
    }
    if (task.summary) lines.push(`摘要：${task.summary}`);
    if (links.length > 0) {
      lines.push(`关联：${links.map(formatLink).join('；')}`);
    }
    lines.push(
      subscribers.length > 0
        ? `订阅：${subscribers.length} 人（${subscribers.map((item) => item.nick || item.staffId).join('、')}）`
        : '订阅：暂无',
    );
    lines.push(
      `操作：\`/task subscribe ${shortId(task.id)}\` · \`/task link ${shortId(task.id)} url <链接>\` · \`/task close ${shortId(task.id)}\``,
    );
    return lines.join('\n');
  }

  private async link(
    message: InboundMessage,
    args: string[],
  ): Promise<string> {
    const [id, kindToken, ref, ...labelParts] = args;
    const resolved = await this.resolve(message, id ?? '');
    if ('error' in resolved) return resolved.error;
    const { task } = resolved;
    if (!this.canManage(task, message)) {
      return '只有任务发起人或管理员可以关联外部实体。';
    }
    const kind = kindToken?.toLowerCase();
    if (!kind || !isTaskLinkKind(kind) || !ref?.trim()) {
      return TASK_USAGE;
    }
    const link = await this.store.addLink({
      taskId: task.id,
      kind,
      ref: ref.trim(),
      ...(labelParts.join(' ').trim()
        ? { label: labelParts.join(' ').trim() }
        : {}),
    });
    await this.store.update(task.id, {});
    return `已关联${LINK_KIND_LABELS[link.kind]}：${link.ref}${link.label ? `（${link.label}）` : ''}。`;
  }

  private async subscribe(
    message: InboundMessage,
    id: string,
  ): Promise<string> {
    const resolved = await this.resolve(message, id);
    if ('error' in resolved) return resolved.error;
    const { task } = resolved;
    const inserted = await this.store.subscribe({
      taskId: task.id,
      staffId: message.senderStaffId,
      nick: message.senderNick,
    });
    return inserted
      ? `已订阅任务 ${shortId(task.id)} 的更新。`
      : `你已订阅任务 ${shortId(task.id)}。`;
  }

  private async unsubscribe(
    message: InboundMessage,
    id: string,
  ): Promise<string> {
    const resolved = await this.resolve(message, id);
    if ('error' in resolved) return resolved.error;
    const { task } = resolved;
    const removed = await this.store.unsubscribe(task.id, message.senderStaffId);
    return removed
      ? `已取消订阅任务 ${shortId(task.id)}。`
      : `你尚未订阅任务 ${shortId(task.id)}。`;
  }

  private async setAutoFollowUp(
    message: InboundMessage,
    id: string,
    flag: string,
  ): Promise<string> {
    const resolved = await this.resolve(message, id);
    if ('error' in resolved) return resolved.error;
    const { task } = resolved;
    if (!this.canManage(task, message)) {
      return '只有任务发起人或管理员可以调整外部事件自动跟进开关。';
    }
    const normalized = flag.trim().toLowerCase();
    if (!['on', 'off', 'true', 'false'].includes(normalized)) {
      return '用法：`/task follow <ID> <on|off>`';
    }
    const enabled = normalized === 'on' || normalized === 'true';
    await this.store.update(task.id, {
      metadata: {
        ...task.metadata,
        autoFollowUp: enabled,
      },
    });
    return enabled
      ? `已为任务 ${shortId(task.id)} 开启外部事件自动跟进续跑。`
      : `已为任务 ${shortId(task.id)} 关闭外部事件自动跟进续跑（仍会保留事件通知）。`;
  }

  private async close(message: InboundMessage, id: string): Promise<string> {
    const resolved = await this.resolve(message, id);
    if ('error' in resolved) return resolved.error;
    const { task } = resolved;
    if (!this.canManage(task, message)) {
      return '只有任务发起人或管理员可以关闭任务线程。';
    }
    if (task.status === 'closed') {
      return `任务线程 ${shortId(task.id)} 已关闭。`;
    }
    await this.store.update(task.id, {
      status: 'closed',
      closedAt: this.now(),
    });
    return [
      `已关闭任务线程 ${shortId(task.id)}。`,
      '线程关闭不会取消关联的后台任务；如需停止执行，请使用 `/job-cancel <任务ID>`。',
    ].join('\n');
  }

  private canManage(task: AgentTask, message: InboundMessage): boolean {
    return (
      task.ownerStaffId === message.senderStaffId ||
      this.isAdmin(message.senderStaffId)
    );
  }

  private async resolve(
    message: InboundMessage,
    id: string,
  ): Promise<{ task: AgentTask } | { error: string }> {
    const needle = id.trim().toLowerCase();
    if (!needle) return { error: '请输入任务线程 ID 前缀。' };
    const tasks = await this.store.list({
      conversationId: message.conversationId,
      limit: 100,
    });
    const exact = tasks.find((task) => task.id.toLowerCase() === needle);
    if (exact) return { task: exact };
    const matches = tasks.filter((task) =>
      task.id.toLowerCase().startsWith(needle),
    );
    if (matches.length === 1 && matches[0]) return { task: matches[0] };
    if (matches.length > 1) {
      return { error: `ID 前缀 ${id} 匹配到多个任务线程，请多输入几位。` };
    }
    return { error: `未找到任务线程 ${id}，发送 /task list 查看本会话线程。` };
  }
}
