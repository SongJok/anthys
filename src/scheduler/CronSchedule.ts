/** 最小 5 段 cron 解析：分 时 日 月 周（Asia/Shanghai，周日=0/7） */

const MINUTE_MS = 60_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

function parseField(raw: string, spec: FieldSpec, label: string): Set<number> {
  const result = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`cron ${label} 字段存在空项`);
    const [rangePart, stepPart] = token.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron ${label} 字段步长非法: ${token}`);
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart?.includes('-')) {
      const [left, right] = rangePart.split('-');
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : spec.max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < spec.min ||
      end > spec.max ||
      start > end
    ) {
      throw new Error(`cron ${label} 字段超出范围: ${token}`);
    }
    for (let value = start; value <= end; value += step) result.add(value);
  }
  if (result.size === 0) throw new Error(`cron ${label} 字段为空`);
  return result;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('cron 表达式必须为 5 段：分 时 日 月 周');
  }
  const weekdays = parseField(parts[4] ?? '', FIELDS[4]!, '周');
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes: parseField(parts[0] ?? '', FIELDS[0]!, '分'),
    hours: parseField(parts[1] ?? '', FIELDS[1]!, '时'),
    days: parseField(parts[2] ?? '', FIELDS[2]!, '日'),
    months: parseField(parts[3] ?? '', FIELDS[3]!, '月'),
    weekdays,
  };
}

/**
 * 返回严格晚于 fromMs 的下一次触发时间；按 Asia/Shanghai 解释字段。
 * 最多向后搜索 366 天，找不到则抛错。
 */
export function nextCronRun(expression: string, fromMs: number): number {
  const cron = parseCron(expression);
  let cursor =
    Math.floor((fromMs + SHANGHAI_OFFSET_MS) / MINUTE_MS) * MINUTE_MS +
    MINUTE_MS;
  const limit = cursor + 366 * 86_400_000;

  while (cursor <= limit) {
    const local = new Date(cursor);
    const minute = local.getUTCMinutes();
    const hour = local.getUTCHours();
    const day = local.getUTCDate();
    const month = local.getUTCMonth() + 1;
    const weekday = local.getUTCDay();

    if (!cron.months.has(month)) {
      cursor = Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth() + 1,
        1,
      );
      continue;
    }
    if (
      !cron.days.has(day) ||
      !cron.weekdays.has(weekday) ||
      !cron.hours.has(hour) ||
      !cron.minutes.has(minute)
    ) {
      cursor += MINUTE_MS;
      continue;
    }
    return cursor - SHANGHAI_OFFSET_MS;
  }
  throw new Error(`cron 在一年内不会触发: ${expression}`);
}
