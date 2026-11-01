const OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = [
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
] as const;

export interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 统一按 Asia/Shanghai（UTC+08:00，无夏令时）拆解时间，
 * 避免依赖服务器本地时区或浏览器时区。
 */
export function shanghaiParts(ms: number): ShanghaiParts {
  const date = new Date(ms + OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

export function weekdayLabel(ms: number): string {
  return WEEKDAYS[shanghaiParts(ms).weekday] ?? '周日';
}

export function startOfShanghaiDay(ms: number): number {
  const parts = shanghaiParts(ms);
  return Date.UTC(parts.year, parts.month - 1, parts.day) - OFFSET_MS;
}

export function formatShanghaiDate(ms: number): string {
  const parts = shanghaiParts(ms);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function formatShanghaiMinute(ms: number): string {
  const parts = shanghaiParts(ms);
  return `${formatShanghaiDate(ms)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatShanghaiDateTime(ms: number): string {
  const parts = shanghaiParts(ms);
  return `${formatShanghaiDate(ms)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function formatShanghaiDayWithWeekday(ms: number): string {
  return `${formatShanghaiDate(ms)}（${weekdayLabel(ms)}）`;
}

/** 历史消息前缀，让模型看到绝对时间而不是复用旧消息里的“今天/明天” */
export function formatShanghaiMessageStamp(ms: number): string {
  const parts = shanghaiParts(ms);
  return `${formatShanghaiDate(ms)} ${pad(parts.hour)}:${pad(parts.minute)} ${weekdayLabel(ms)}`;
}

/** 系统提示里的时钟块：绝对时间 + 今天/明天 + 相对日期失效声明 */
export function shanghaiPromptClock(ms: number): string {
  const tomorrow = startOfShanghaiDay(ms) + DAY_MS;
  return [
    `当前时间（Asia/Shanghai，UTC+08:00）：${formatShanghaiDateTime(ms)}`,
    `今天是 ${formatShanghaiDayWithWeekday(ms)}；明天是 ${formatShanghaiDayWithWeekday(tomorrow)}；Unix 毫秒时间戳：${ms}`,
    '对话历史里的“今天/明天/昨天/本周/下周”等相对时间只在其消息标注的日期成立，不代表现在；涉及日期时一律以本段当前时间为准。',
  ].join('\n');
}

export const SHANGHAI_OFFSET_MS = OFFSET_MS;
export const SHANGHAI_DAY_MS = DAY_MS;
