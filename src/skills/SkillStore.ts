import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { skillUsage, skills } from '../db/skillSchema.js';
import type {
  SkillDefinition,
  SkillFrontmatter,
  SkillSource,
  SkillUsageAction,
  SkillUsageSummary,
  SkillVisibility,
} from '../types/skills-plugins-projects.js';

export interface SkillState {
  id: string;
  name: string;
  source: SkillSource;
  pluginId?: string;
  path: string;
  bodyHash: string;
  module: string;
  enabled: boolean;
  visibility: SkillVisibility;
  loadError: string;
}

export interface SkillUsageInput {
  skillId: string;
  conversationId: string;
  senderStaffId: string;
  action: SkillUsageAction;
}

export interface SkillStore {
  listStates(): Promise<SkillState[]>;
  sync(definitions: SkillDefinition[]): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  recordUsage(input: SkillUsageInput): Promise<void>;
  usageSince(sinceMs: number): Promise<Map<string, SkillUsageSummary>>;
  purgeUsageBefore(ms: number): Promise<number>;
}

function toFrontmatter(definition: SkillDefinition): SkillFrontmatter {
  return {
    name: definition.name,
    description: definition.description,
    version: definition.version,
    when_to_use: definition.whenToUse,
    tags: definition.tags,
    allowed_tools: definition.allowedTools,
    risk: definition.risk,
    visibility: definition.visibility,
    max_instruction_chars: definition.maxInstructionChars,
    module: definition.module,
  };
}

export class DrizzleSkillStore implements SkillStore {
  constructor(private readonly db: Database) {}

  public async listStates(): Promise<SkillState[]> {
    const rows = await this.db.select().from(skills);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source as SkillSource,
      ...(row.pluginId ? { pluginId: row.pluginId } : {}),
      path: row.path,
      bodyHash: row.bodyHash,
      module: row.module,
      enabled: row.enabled,
      visibility: row.visibility as SkillVisibility,
      loadError: row.loadError,
    }));
  }

  /** 只同步元数据；enabled 由管理员决定，不能被重新扫描覆盖 */
  public async sync(definitions: SkillDefinition[]): Promise<void> {
    for (const definition of definitions) {
      await this.db
        .insert(skills)
        .values({
          id: definition.id,
          name: definition.name,
          description: definition.description,
          version: definition.version,
          source: definition.source,
          pluginId: definition.pluginId ?? null,
          path: definition.dir,
          frontmatter: toFrontmatter(definition),
          bodyHash: definition.bodyHash,
          module: definition.module,
          enabled: definition.enabled,
          visibility: definition.visibility,
          loadError: definition.loadError ?? '',
        })
        .onConflictDoUpdate({
          target: skills.id,
          set: {
            name: definition.name,
            description: definition.description,
            version: definition.version,
            source: definition.source,
            pluginId: definition.pluginId ?? null,
            path: definition.dir,
            frontmatter: toFrontmatter(definition),
            bodyHash: definition.bodyHash,
            // 重新划分模块时必须覆盖，否则技能会停在旧分组里
            module: definition.module,
            visibility: definition.visibility,
            loadError: definition.loadError ?? '',
            updatedAt: new Date(),
          },
        });
    }
  }

  public async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db
      .update(skills)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(skills.id, id));
  }

  public async recordUsage(input: SkillUsageInput): Promise<void> {
    await this.db.insert(skillUsage).values({
      skillId: input.skillId,
      conversationId: input.conversationId,
      senderStaffId: input.senderStaffId,
      action: input.action,
    });
  }

  public async usageSince(
    sinceMs: number,
  ): Promise<Map<string, SkillUsageSummary>> {
    const rows = await this.db
      .select({
        skillId: skillUsage.skillId,
        uses: sql<number>`count(*)::int`,
        lastUsedAt: sql<Date | null>`max(${skillUsage.createdAt})`,
      })
      .from(skillUsage)
      .where(gte(skillUsage.createdAt, new Date(sinceMs)))
      .groupBy(skillUsage.skillId);
    return new Map(
      rows.map((row) => [
        row.skillId,
        {
          skillId: row.skillId,
          uses: Number(row.uses),
          lastUsedAt: row.lastUsedAt
            ? new Date(row.lastUsedAt).getTime()
            : null,
        },
      ]),
    );
  }

  public async purgeUsageBefore(ms: number): Promise<number> {
    const rows = await this.db
      .delete(skillUsage)
      .where(lt(skillUsage.createdAt, new Date(ms)))
      .returning({ id: skillUsage.id });
    return rows.length;
  }

  /** 控制台按最近使用时间排序时需要逐技能统计 */
  public async listUsage(
    limit = 500,
  ): Promise<Array<{ skillId: string; uses: number; lastUsedAt: number | null }>> {
    const rows = await this.db
      .select({
        skillId: skillUsage.skillId,
        uses: sql<number>`count(*)::int`,
        lastUsedAt: sql<Date | null>`max(${skillUsage.createdAt})`,
      })
      .from(skillUsage)
      .groupBy(skillUsage.skillId)
      .orderBy(desc(sql`max(${skillUsage.createdAt})`))
      .limit(Math.max(1, limit));
    return rows.map((row) => ({
      skillId: row.skillId,
      uses: Number(row.uses),
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : null,
    }));
  }
}
