import type { DynamicLoopPolicy } from '../types/core.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** 明文里提到、且明确指向任务耗时的时长达到该值即拒接 */
export const MENTIONED_DURATION_LIMIT_MS = 20 * MINUTE_MS;

export interface AdmissionDecision {
  accepted: boolean;
  reason?: 'mentioned-duration';
  /** 命中的原文片段，用于向提问者解释 */
  matched?: string;
  /** 从原文解析出的时长；关键词命中时为空 */
  durationMs?: number;
}

const ARABIC_DURATION =
  /(\d+(?:\.\d+)?)\s*(个\s*半\s*小时|个\s*小时|小时|分钟|钟头|hours?|hrs?|mins?|minutes?)/giu;

const CHINESE_DURATION =
  /([零一二两三四五六七八九十百半几个数]+)\s*(个?\s*(?:小时|钟头)|分钟)/gu;

/** 时长前出现这些词，才说明描述的是「这个任务要花多久」而不是「多久之后提醒我」 */
const WORK_CUE =
  /(需要|需|要花|耗时|预计|大概|大约|至少|超过|执行|运行|跑|等待|持续|占用|花上|花掉)[^，。！？；\n]{0,3}$/u;

/** 时长后紧跟「以上」这类限定，同样说明是任务耗时 */
const WORK_CUE_SUFFIX = /^[^\u3002\uff01\uff1f\uff1b\uff0c\n]{0,4}(以上|起步)/u;

const LONG_TASK_PHRASES: readonly string[] = [
  '通宵',
  '一整夜',
  '跑一整天',
  '干一整天',
  '一整天',
  '数小时',
  '好几个小时',
  '好几个钟头',
  '几个小时',
  '好几天',
  '持续数天',
  '长期运行',
  '长期监控',
  '持续监控',
  '7x24',
  '7×24',
  '全量迁移',
  '全量重建',
  '全量扫描',
  '大规模迁移',
  '大规模重建',
  '爬取全网',
  '爬完全网',
  '批量爬取',
];

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseNumber(raw: string): number | null {
  const text = raw.replace(/个/gu, '');
  if (!text) return null;
  if (text.includes('半')) {
    const head = text.replace(/半/gu, '');
    const base = head ? parseChineseNumber(head) : 0;
    return base === null ? 0.5 : base + 0.5;
  }
  if (/^[几数]/u.test(text)) return 3;
  if (/^十几|^十多/u.test(text)) return 15;
  if (/^二十几|^二十多/u.test(text)) return 25;
  if (/^[几数]十/u.test(text)) return 30;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    const tensValue = tens ? CN_DIGITS[tens] : 1;
    if (tensValue === undefined) return null;
    const onesValue = ones ? CN_DIGITS[ones] : 0;
    if (onesValue === undefined) return null;
    return tensValue * 10 + onesValue;
  }
  return CN_DIGITS[text] ?? null;
}

function unitToMs(unit: string): number {
  return /小时|钟头|hour|hr/iu.test(unit) ? HOUR_MS : MINUTE_MS;
}

function segmentBounds(
  text: string,
  index: number,
): { start: number; end: number } {
  const breaks = /[。！？!?；;\n，,]/gu;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(breaks)) {
    const at = match.index ?? 0;
    if (at < index) start = at + 1;
    else {
      end = at;
      break;
    }
  }
  return { start, end };
}

/**
 * 判定「明文里是否已经写明这是一个 20 分钟以上的任务」。
 * 只有时长与工作语境（需要/耗时/预计/跑…）出现在同一句，或出现长时间任务字眼时才拒绝，
 * 避免把「25 分钟后提醒我」这类短任务误判为长任务。
 */
export function assessRequestAdmission(text: string): AdmissionDecision {
  const phrase = LONG_TASK_PHRASES.find((item) =>
    text.toLowerCase().includes(item.toLowerCase()),
  );
  if (phrase) {
    return { accepted: false, reason: 'mentioned-duration', matched: phrase };
  }

  const candidates: { matched: string; durationMs: number }[] = [];
  for (const match of text.matchAll(ARABIC_DURATION)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    candidates.push({
      matched: match[0],
      durationMs: amount * unitToMs(match[2] ?? ''),
    });
  }
  for (const match of text.matchAll(CHINESE_DURATION)) {
    const amount = parseChineseNumber(match[1] ?? '');
    if (amount === null) continue;
    candidates.push({
      matched: match[0],
      durationMs: amount * unitToMs(match[2] ?? ''),
    });
  }

  for (const candidate of candidates) {
    if (candidate.durationMs < MENTIONED_DURATION_LIMIT_MS) continue;
    const index = text.indexOf(candidate.matched);
    const matchedLength = candidate.matched.length;
    const bounds =
      index >= 0
        ? segmentBounds(text, index)
        : { start: 0, end: text.length };
    const from = index >= 0 ? index : 0;
    const before = text.slice(Math.max(bounds.start, from - 10), from);
    const after = text.slice(
      from + matchedLength,
      Math.min(bounds.end, from + matchedLength + 6),
    );
    if (!WORK_CUE.test(before) && !WORK_CUE_SUFFIX.test(after)) continue;
    return {
      accepted: false,
      reason: 'mentioned-duration',
      matched: candidate.matched,
      durationMs: candidate.durationMs,
    };
  }

  return { accepted: true };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  return Number.isInteger(hours)
    ? `${hours} 小时`
    : `${hours.toFixed(1)} 小时`;
}

function budgetLabel(policy: DynamicLoopPolicy): string {
  return `${Math.max(1, Math.round(policy.maxWallTimeMs / MINUTE_MS))} 分钟 / ${policy.maxTotalTokens.toLocaleString('en-US')} tokens`;
}

export function formatAdmissionRefusal(
  decision: AdmissionDecision,
  policy: DynamicLoopPolicy,
): string {
  const evidence = decision.matched ? `「${decision.matched}」` : '长时间任务';
  const detail =
    decision.durationMs !== undefined
      ? `需求里提到 ${evidence}，约 ${formatDuration(decision.durationMs)}，超过 ${formatDuration(MENTIONED_DURATION_LIMIT_MS)} 的评估上限。`
      : `需求里出现了 ${evidence} 这类长时间任务描述。`;
  return [
    '机器人不认可这个需求，已关闭执行。',
    `原因：${detail}`,
    `我单次最多执行 ${budgetLabel(policy)}，超出的需求不会开工，也不会用半成品拼凑答案。`,
    '建议把需求拆成多个几分钟内能完成的小任务，逐条发给我。',
  ].join('\n');
}

export type RuntimeRefusalReason = 'wall-time' | 'tokens';

export function formatRuntimeRefusal(input: {
  reason: RuntimeRefusalReason;
  elapsedMs: number;
  tokens: number;
  policy: DynamicLoopPolicy;
}): string {
  const cause =
    input.reason === 'wall-time'
      ? `本次已执行 ${formatDuration(input.elapsedMs)}，达到 ${budgetLabel(input.policy)} 的时间上限`
      : `本次已消耗 ${input.tokens.toLocaleString('en-US')} tokens，达到 ${budgetLabel(input.policy)} 的 Token 上限`;
  return [
    '机器人不认可这个需求，已停止执行。',
    `原因：${cause}。`,
    '继续执行会超出可接受范围，因此不再调用工具，也不会用未完成的过程内容拼凑答案。',
    '请把需求拆小或缩小查询范围后重新提问。',
  ].join('\n');
}
