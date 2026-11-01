import type { AgentJob, AgentJobStatus } from '../types/jobs.js';
import type { WorkerOutput, WorkerRunStatus } from '../types/workers.js';
import type { WatchdogOutcome } from '../types/watchdog.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const STATUS_LABELS: Record<AgentJobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const WORKER_STATUS_LABELS: Record<WorkerRunStatus, string> = {
  completed: '已完成',
  partial: '部分完成',
  blocked: '待确认或受阻',
};

function taskIdOf(job: AgentJob): string | undefined {
  const taskId = job.metadata.taskId;
  return typeof taskId === 'string' && taskId.trim()
    ? taskId.trim()
    : undefined;
}

function workerNameOf(job: AgentJob): string | undefined {
  const worker = job.metadata.worker;
  return typeof worker === 'string' && worker.trim() ? worker.trim() : undefined;
}

function workerOutputOf(job: AgentJob): WorkerOutput | undefined {
  const value = job.result?.metadata?.workerOutput;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const output = value as Partial<WorkerOutput>;
  if (
    output.status !== 'completed' &&
    output.status !== 'partial' &&
    output.status !== 'blocked'
  ) {
    return undefined;
  }
  if (typeof output.summary !== 'string') return undefined;
  return output as WorkerOutput;
}

function watchdogOf(job: AgentJob): WatchdogOutcome | undefined {
  const value = job.result?.metadata?.watchdog;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const outcome = value as Partial<WatchdogOutcome>;
  if (
    outcome.action !== 'inject' &&
    outcome.action !== 'degrade' &&
    outcome.action !== 'pause' &&
    outcome.action !== 'cancel'
  ) {
    return undefined;
  }
  if (typeof outcome.reason !== 'string') return undefined;
  return outcome as WatchdogOutcome;
}

export function formatJobStatus(status: AgentJobStatus): string {
  return STATUS_LABELS[status];
}

export function formatJobDuration(job: AgentJob): string {
  const end = job.finishedAt ?? Date.now();
  const start = job.startedAt ?? job.createdAt;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function formatJob(job: AgentJob): string {
  const worker = workerNameOf(job);
  const workerOutput = workerOutputOf(job);
  const watchdog = watchdogOf(job);
  const taskId = taskIdOf(job);
  const lines = [
    `任务 ${job.id.slice(0, 8)} · ${formatJobStatus(job.status)}${worker ? ` · ${worker} Worker` : ''}${taskId ? ` · 线程:${taskId.slice(0, 8)}` : ''}`,
    `需求：${job.prompt.replace(/\s+/gu, ' ').slice(0, 160)}`,
    `创建：${formatShanghaiDateTime(job.createdAt)} · 耗时：${formatJobDuration(job)}`,
  ];
  if (workerOutput) {
    lines.push(`Worker 状态：${WORKER_STATUS_LABELS[workerOutput.status]}`);
  }
  if (job.attempts > 0) {
    lines.push(`尝试：${job.attempts}/${job.maxAttempts}`);
  }
  if (job.status === 'paused' && job.error) {
    lines.push(`暂停原因：${job.error.slice(0, 300)}`);
    lines.push(`恢复：\`/job-resume ${job.id.slice(0, 8)}\`；终止：\`/job-cancel ${job.id.slice(0, 8)}\``);
  } else if (job.error) {
    lines.push(`错误：${job.error.slice(0, 300)}`);
  }
  if (watchdog && watchdog.action !== 'inject') {
    lines.push(`执行保护：${watchdog.reason.slice(0, 200)}`);
  }
  if (job.result?.answer) {
    lines.push(`结果：${job.result.answer.slice(0, 800)}`);
  }
  return lines.join('\n');
}

export function formatJobList(jobs: AgentJob[]): string {
  if (jobs.length === 0) return '本会话暂无后台任务。';
  return [
    '本会话最近的后台任务：',
    ...jobs.map((job) => {
      const worker = workerNameOf(job);
      const taskId = taskIdOf(job);
      return `- ${job.id.slice(0, 8)} · ${formatJobStatus(job.status)}${worker ? ` · ${worker}` : ''}${taskId ? ` · 线程:${taskId.slice(0, 8)}` : ''} · ${formatJobDuration(job)} · ${job.prompt.replace(/\s+/gu, ' ').slice(0, 60)}`;
    }),
    '查看详情：`/job-status <id>`；暂停后恢复：`/job-resume <id>`；取消：`/job-cancel <id>`。',
  ].join('\n');
}

export function formatJobResultNotice(job: AgentJob): string {
  const answer = job.result?.answer?.trim();
  const worker = workerNameOf(job);
  const workerOutput = workerOutputOf(job);
  const watchdog = watchdogOf(job);
  const taskId = taskIdOf(job);
  const findings = Array.isArray(workerOutput?.findings)
    ? workerOutput.findings.slice(0, 3)
    : [];
  const sources = Array.isArray(workerOutput?.sources)
    ? workerOutput.sources.slice(0, 3)
    : [];
  return [
    [
      `后台任务 ${job.id.slice(0, 8)} 已完成。`,
      worker ? `执行单元：${worker} Worker` : '',
      workerOutput
        ? `Worker 状态：${WORKER_STATUS_LABELS[workerOutput.status]}`
        : '',
      taskId
        ? `任务线程：${taskId.slice(0, 8)}（\`/task show ${taskId.slice(0, 8)}\`）`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    answer
      ? answer.length > 3_000
        ? `${answer.slice(0, 3_000)}\n…（完整结果已写入会话记录）`
        : answer
      : '任务已完成，但没有产生回答。',
    ...(findings.length > 0
      ? [
          `关键发现：\n${findings
            .map(
              (item) =>
                `- ${item.claim}${item.source ? `（${item.source}）` : ''}`,
            )
            .join('\n')}`,
        ]
      : []),
    ...(sources.length > 0 ? [`来源：\n${sources.join('\n')}`] : []),
    ...(watchdog?.action === 'degrade'
      ? ['执行保护：多次提醒后仍无有效进展，本结果基于已有信息生成。']
      : []),
  ].join('\n\n');
}
