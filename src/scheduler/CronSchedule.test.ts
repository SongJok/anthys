import { describe, expect, it } from 'vitest';
import { nextCronRun } from './CronSchedule.js';

describe('nextCronRun', () => {
  it('按 Asia/Shanghai 计算每 5 分钟触发', () => {
    expect(nextCronRun('*/5 * * * *', Date.UTC(2026, 9, 30, 2, 2, 0))).toBe(
      Date.UTC(2026, 9, 30, 2, 5, 0),
    );
  });

  it('每天 09:00 触发时跨日推进', () => {
    expect(nextCronRun('0 9 * * *', Date.UTC(2026, 9, 30, 2, 0, 0))).toBe(
      Date.UTC(2026, 9, 31, 1, 0, 0),
    );
  });

  it('支持列表、区间与周日=7', () => {
    expect(
      nextCronRun('30 8,18 * * 1-5', Date.UTC(2026, 9, 30, 10, 0, 0)),
    ).toBe(Date.UTC(2026, 9, 30, 10, 30, 0));
    expect(nextCronRun('0 0 * * 7', Date.UTC(2026, 9, 30, 2, 0, 0))).toBe(
      Date.UTC(2026, 9, 31, 16, 0, 0),
    );
  });

  it('非法表达式直接抛错', () => {
    expect(() => nextCronRun('* * *', Date.now())).toThrow('5 段');
    expect(() => nextCronRun('61 * * * *', Date.now())).toThrow('超出范围');
    expect(() => nextCronRun('*/0 * * * *', Date.now())).toThrow('步长');
  });
});
