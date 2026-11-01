import type { AgentJob, AgentJobStatus } from '../types/jobs.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const STATUS_LABELS: Record<AgentJobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

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
  const lines = [
    `任务 ${job.id.slice(0, 8)} · ${formatJobStatus(job.status)}`,
    `需求：${job.prompt.replace(/\s+/gu, ' ').slice(0, 160)}`,
    `创建：${formatShanghaiDateTime(job.createdAt)} · 耗时：${formatJobDuration(job)}`,
  ];
  if (job.attempts > 0) {
    lines.push(`尝试：${job.attempts}/${job.maxAttempts}`);
  }
  if (job.error) {
    lines.push(`错误：${job.error.slice(0, 300)}`);
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
    ...jobs.map(
      (job) =>
        `- ${job.id.slice(0, 8)} · ${formatJobStatus(job.status)} · ${formatJobDuration(job)} · ${job.prompt.replace(/\s+/gu, ' ').slice(0, 60)}`,
    ),
    '查看详情：`/job-status <id>`；取消：`/job-cancel <id>`。',
  ].join('\n');
}

export function formatJobResultNotice(job: AgentJob): string {
  const answer = job.result?.answer?.trim();
  return [
    `后台任务 ${job.id.slice(0, 8)} 已完成。`,
    answer
      ? answer.length > 3_000
        ? `${answer.slice(0, 3_000)}\n…（完整结果已写入会话记录）`
        : answer
      : '任务已完成，但没有产生回答。',
  ].join('\n\n');
}
