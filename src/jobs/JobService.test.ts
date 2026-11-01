import { describe, expect, it } from 'vitest';
import type { AgentJob } from '../types/jobs.js';
import { formatJob, formatJobList, formatJobResultNotice } from './JobService.js';

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    conversationId: 'cid-1',
    conversationType: '1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    kind: 'worker',
    status: 'succeeded',
    prompt: '查一下网关超时原因',
    metadata: { worker: 'research' },
    result: {
      answer: '网关超时要调大',
      reasoning: '',
      usage: { totalTokens: 100, steps: 2, durationMs: 1_000 },
      metadata: {
        worker: 'research',
        workerOutput: {
          status: 'completed',
          summary: '网关超时要调大',
          findings: [
            { claim: '阈值为 3 秒', source: 'https://monitor.example.com' },
          ],
          actions: [],
          sources: ['https://monitor.example.com'],
          openQuestions: [],
        },
      },
    },
    error: null,
    priority: 0,
    attempts: 1,
    maxAttempts: 2,
    leaseOwner: 'runner',
    leaseExpiresAt: 0,
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    finishedAt: 1_000,
    ...overrides,
  };
}

describe('JobService worker formatting', () => {
  it('任务详情与列表标注 Worker 与结构化状态', () => {
    const detail = formatJob(job());
    expect(detail).toContain('research Worker');
    expect(detail).toContain('Worker 状态：已完成');
    expect(formatJobList([job()])).toContain('· research ·');
  });

  it('完成通知展示摘要、关键发现与来源', () => {
    const notice = formatJobResultNotice(job());
    expect(notice).toContain('执行单元：research Worker');
    expect(notice).toContain('网关超时要调大');
    expect(notice).toContain('关键发现：');
    expect(notice).toContain('阈值为 3 秒');
    expect(notice).toContain('来源：');
  });

  it('普通任务不显示 Worker 段落', () => {
    const plain = job({
      kind: 'task',
      metadata: {},
      result: {
        answer: '已完成',
        reasoning: '',
        usage: { totalTokens: 1, steps: 1, durationMs: 1 },
      },
    });
    expect(formatJob(plain)).not.toContain('Worker');
    expect(formatJobResultNotice(plain)).not.toContain('Worker');
  });

  it('暂停任务展示暂停原因与恢复指令', () => {
    const paused = job({
      kind: 'task',
      status: 'paused',
      metadata: {},
      result: null,
      error: 'Token 预算接近上限（已使用 95%），主动暂停执行',
      finishedAt: null,
    });
    const detail = formatJob(paused);
    expect(detail).toContain('已暂停');
    expect(detail).toContain('暂停原因：');
    expect(detail).toContain('/job-resume abcdef12');
    expect(formatJobList([paused])).toContain('/job-resume');
  });

  it('看门狗降级会写入任务详情与完成通知', () => {
    const degraded = job({
      kind: 'task',
      metadata: {},
      result: {
        answer: '基于已有信息给出结论',
        reasoning: '',
        usage: { totalTokens: 100, steps: 6, durationMs: 1_000 },
        metadata: {
          watchdog: {
            action: 'degrade',
            code: 'no-progress',
            reason: '连续 3 步工具调用没有带来新信息',
            notice: '已停用工具',
            escalate: false,
          },
        },
      },
    });
    expect(formatJob(degraded)).toContain('执行保护：');
    expect(formatJobResultNotice(degraded)).toContain('执行保护：');
  });
});
