import type { StreamCitation } from '../types/core.js';

// 全角标点（U+3000-303F、U+FF00-FFEF）不会出现在 URL 路径中，遇到即截断
const URL_PATTERN = /https?:\/\/[^\s<>"'`）)】\]\u3000-\u303f\uff00-\uffef]+/gu;
const TRAILING_PUNCTUATION = /[.,;:!?。，；：！？）》】]+$/u;

function titleFor(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    if (last) {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}

/**
 * 从工具输出中提取可追溯的来源链接，供卡片「参考来源」与轨迹引用使用。
 * 只保留前若干个不重复 URL，避免日志噪声淹没答案。
 */
export function extractCitations(
  text: string,
  source: string,
  limit = 5,
): StreamCitation[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: StreamCitation[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({
      index: result.length + 1,
      title: titleFor(url),
      url,
      source,
    });
    if (result.length >= limit) break;
  }
  return result;
}
