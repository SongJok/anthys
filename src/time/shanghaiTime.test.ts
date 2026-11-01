import { describe, expect, it } from 'vitest';
import {
  formatShanghaiDate,
  formatShanghaiDateTime,
  formatShanghaiDayWithWeekday,
  formatShanghaiMessageStamp,
  formatShanghaiMinute,
  shanghaiParts,
  shanghaiPromptClock,
  startOfShanghaiDay,
} from './shanghaiTime.js';

describe('shanghaiTime', () => {
  it('跨 UTC 日界仍按 Asia/Shanghai 计算日期', () => {
    const ms = Date.UTC(2026, 9, 31, 16, 30, 5);
    expect(shanghaiParts(ms)).toMatchObject({
      year: 2026,
      month: 11,
      day: 1,
      hour: 0,
      minute: 30,
      second: 5,
      weekday: 0,
    });
    expect(formatShanghaiDate(ms)).toBe('2026-11-01');
    expect(formatShanghaiMinute(ms)).toBe('2026-11-01 00:30');
    expect(formatShanghaiDateTime(ms)).toBe('2026-11-01 00:30:05');
    expect(formatShanghaiDayWithWeekday(ms)).toBe('2026-11-01（周日）');
    expect(formatShanghaiMessageStamp(ms)).toBe('2026-11-01 00:30 周日');
  });

  it('北京自然日零点按 UTC+08:00 回推', () => {
    const ms = Date.UTC(2026, 10, 1, 9, 42, 48);
    expect(startOfShanghaiDay(ms)).toBe(Date.UTC(2026, 9, 31, 16));
  });

  it('系统时钟块给出今天/明天且强调历史相对时间已过期', () => {
    const clock = shanghaiPromptClock(Date.UTC(2026, 10, 1, 9, 42, 48));
    expect(clock).toContain('当前时间（Asia/Shanghai，UTC+08:00）：2026-11-01 17:42:48');
    expect(clock).toContain('今天是 2026-11-01（周日）');
    expect(clock).toContain('明天是 2026-11-02（周一）');
    expect(clock).toContain('Unix 毫秒时间戳');
    expect(clock).toContain('不代表现在');
  });

  it('修复“明天被说成 11 月 1 号”的场景：10 月 31 日以系统时间为准', () => {
    const clock = shanghaiPromptClock(Date.UTC(2026, 9, 31, 8, 12, 19));
    expect(clock).toContain('今天是 2026-10-31（周六）');
    expect(clock).toContain('明天是 2026-11-01（周日）');

    const nextDay = shanghaiPromptClock(Date.UTC(2026, 10, 1, 9, 42, 48));
    expect(nextDay).toContain('今天是 2026-11-01（周日）');
    expect(nextDay).toContain('明天是 2026-11-02（周一）');
  });
});
