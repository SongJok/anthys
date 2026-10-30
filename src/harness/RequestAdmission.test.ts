import { describe, expect, it } from 'vitest';
import {
  assessRequestAdmission,
  formatAdmissionRefusal,
  formatRuntimeRefusal,
} from './RequestAdmission.js';
import type { DynamicLoopPolicy } from '../types/core.js';

const policy: DynamicLoopPolicy = {
  maxWallTimeMs: 900_000,
  maxTotalTokens: 120_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: true,
};

describe('assessRequestAdmission', () => {
  it('明文写着重活时拒接', () => {
    const cases = [
      ['帮我整理季度报表，大概需要 40 分钟', '40 分钟'],
      ['需要 20 分钟以上的任务', '20 分钟'],
      ['这个任务耗时约 3 小时', '3 小时'],
      ['大概要半个小时以上', '半个小时'],
      ['帮我跑 2 小时的全量数据迁移', '2 小时'],
    ] as const;
    for (const [text, matched] of cases) {
      const decision = assessRequestAdmission(text);
      expect(decision.accepted, text).toBe(false);
      expect(decision.reason).toBe('mentioned-duration');
      expect(decision.matched, text).toContain(matched);
    }
  });

  it('长时间任务字眼直接拒接', () => {
    for (const text of [
      '通宵把这个跑完',
      '帮我持续监控几个小时看看',
      '把整个库全量迁移一遍',
    ]) {
      const decision = assessRequestAdmission(text);
      expect(decision.accepted, text).toBe(false);
    }
  });

  it('短任务与提醒类时长不误伤', () => {
    for (const text of [
      '现在几点？',
      '25 分钟后提醒我开会',
      '提醒我 30 分钟后处理邮件',
      '帮我把会议时长改成 40 分钟',
      '10 分钟能做完的周报汇总',
      '查一下明天的日程',
    ]) {
      expect(assessRequestAdmission(text).accepted, text).toBe(true);
    }
  });

  it('拒接说明明确表达不认可与关闭执行', () => {
    const decision = assessRequestAdmission('这个任务需要 40 分钟');
    const text = formatAdmissionRefusal(decision, policy);
    expect(text).toContain('机器人不认可这个需求');
    expect(text).toContain('已关闭执行');
    expect(text).toContain('15 分钟');
    expect(text).toContain('120,000 tokens');
    expect(text).toContain('40 分钟');
  });

  it('运行时拒接说明区分时间与 Token', () => {
    const wall = formatRuntimeRefusal({
      reason: 'wall-time',
      elapsedMs: 900_000,
      tokens: 42_000,
      policy,
    });
    expect(wall).toContain('机器人不认可这个需求');
    expect(wall).toContain('已停止执行');
    expect(wall).toContain('15 分钟');

    const tokens = formatRuntimeRefusal({
      reason: 'tokens',
      elapsedMs: 120_000,
      tokens: 120_000,
      policy,
    });
    expect(tokens).toContain('120,000 tokens');
  });
});
