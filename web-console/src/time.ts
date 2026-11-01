const OFFSET_MS = 8 * 60 * 60_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 控制台统一展示 Asia/Shanghai 时间，避免浏览器时区不同导致误读 */
export function formatShanghaiDateTime(
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms + OFFSET_MS);
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(' ');
}
