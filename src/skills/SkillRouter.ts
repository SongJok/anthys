import type {
  SkillCatalogEntry,
  SkillDefinition,
  SkillSearchMatch,
  SkillUsageSummary,
} from '../types/skills-plugins-projects.js';

export interface SkillRouteInput {
  query?: string;
  isAdmin: boolean;
  projectId?: string;
  usage?: Map<string, SkillUsageSummary>;
  now?: number;
}

const ASCII_WORD = /[a-z0-9][a-z0-9_+.-]{1,}/gu;
const CJK_SEGMENT = /[\u4e00-\u9fff]{2,}/gu;

function keywords(text: string): string[] {
  const lower = text.toLowerCase();
  const result = new Set<string>();
  for (const match of lower.match(ASCII_WORD) ?? []) result.add(match);
  for (const segment of lower.match(CJK_SEGMENT) ?? []) {
    result.add(segment);
    // 中文没有空格，补二元组让“评审仓库”能命中“评审这个仓库”
    if (segment.length >= 3) {
      for (let index = 0; index <= segment.length - 2; index += 1) {
        result.add(segment.slice(index, index + 2));
      }
    }
  }
  return [...result];
}

function countHits(text: string, query: string, limit: number): number {
  let hits = 0;
  for (const keyword of keywords(text)) {
    if (keyword.length < 2) continue;
    if (query.includes(keyword)) hits += 1;
    if (hits >= limit) break;
  }
  return hits;
}

/**
 * 本地关键词路由，不调用模型。
 * 分数只用于排序与目录裁剪；没有任何命中时仍保留全部技能，保证可发现性。
 */
export class SkillRouter {
  public rank(
    definitions: SkillDefinition[],
    input: SkillRouteInput,
  ): SkillSearchMatch[] {
    const query = (input.query ?? '').toLowerCase().trim();
    const now = input.now ?? Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const matched = definitions.map((definition) => {
      let score = 0;
      if (query) {
        score += countHits(definition.whenToUse, query, 5) * 3;
        score += countHits(definition.tags.join(' '), query, 3) * 3;
        if (query.includes(definition.name.toLowerCase())) score += 2;
      }
      const usage = input.usage?.get(definition.id);
      if (usage && (usage.lastUsedAt ?? 0) >= sevenDaysAgo) {
        score += Math.min(1, usage.uses / 5);
      }
      if (input.projectId && definition.tags.includes(input.projectId)) {
        score += 1;
      }
      return {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        whenToUse: definition.whenToUse,
        source: definition.source,
        tags: definition.tags,
        allowedTools: definition.allowedTools,
        score,
      } satisfies SkillSearchMatch;
    });
    return matched.sort(
      (a, b) =>
        b.score - a.score ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  }
}

export function toCatalogEntry(match: SkillSearchMatch): SkillCatalogEntry {
  return {
    id: match.id,
    name: match.name,
    description: match.description,
    whenToUse: match.whenToUse,
    source: match.source,
    score: match.score,
  };
}
