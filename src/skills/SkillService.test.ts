import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillService } from './SkillService.js';
import type {
  SkillStore,
  SkillUsageInput,
  SkillState,
} from './SkillStore.js';
import type {
  SkillDefinition,
  SkillUsageSummary,
} from '../types/skills-plugins-projects.js';

class MemorySkillStore implements SkillStore {
  public readonly states = new Map<string, SkillState>();
  public readonly usageRecords: SkillUsageInput[] = [];
  public readonly usage = new Map<string, SkillUsageSummary>();

  public async listStates(): Promise<SkillState[]> {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  public async sync(definitions: SkillDefinition[]): Promise<void> {
    for (const definition of definitions) {
      const current = this.states.get(definition.id);
      this.states.set(definition.id, {
        id: definition.id,
        name: definition.name,
        source: definition.source,
        ...(definition.pluginId ? { pluginId: definition.pluginId } : {}),
        path: definition.dir,
        bodyHash: definition.bodyHash,
        enabled: current?.enabled ?? definition.enabled,
        visibility: definition.visibility,
        loadError: definition.loadError ?? '',
      });
    }
  }

  public async setEnabled(id: string, enabled: boolean): Promise<void> {
    const state = this.states.get(id);
    if (state) state.enabled = enabled;
  }

  public async recordUsage(input: SkillUsageInput): Promise<void> {
    this.usageRecords.push(input);
    const current = this.usage.get(input.skillId);
    this.usage.set(input.skillId, {
      skillId: input.skillId,
      uses: (current?.uses ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
  }

  public async usageSince(): Promise<Map<string, SkillUsageSummary>> {
    return new Map(this.usage);
  }

  public async purgeUsageBefore(): Promise<number> {
    return 0;
  }
}

const tempDirs: string[] = [];

async function makeSkillRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-service-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  root: string,
  name: string,
  options: {
    visibility?: 'public' | 'admin';
    body?: string;
    resources?: Record<string, string>;
  } = {},
): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: 测试技能描述',
      'version: 1.0.0',
      'when_to_use: 当用户要求测试技能时',
      'tags:',
      '  - test',
      `visibility: ${options.visibility ?? 'public'}`,
      '---',
      '',
      options.body ?? '# 测试技能\n\n## 步骤\n1. 执行测试',
    ].join('\n'),
    'utf8',
  );
  for (const [resourcePath, content] of Object.entries(
    options.resources ?? {},
  )) {
    const fullPath = path.join(dir, resourcePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
}

function builtinRoots() {
  return [{ source: 'builtin' as const, dir: path.resolve('skills/builtin') }];
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('SkillService', () => {
  it('按任务关键词排序目录，并对普通用户隐藏 admin 技能', async () => {
    const service = new SkillService({ roots: builtinRoots() });
    await service.init();

    const catalog = service.buildCatalog({
      conversationType: '2',
      isAdmin: false,
      query: '帮我评审这个仓库',
    });
    expect(catalog.entries[0]?.name).toBe('repo-review');
    expect(catalog.entries.some((entry) => entry.name === 'handbook-maintainer')).toBe(
      false,
    );
    expect(catalog.prompt).toContain('## 可用技能');
    expect(catalog.prompt).toContain('use_skill');

    const adminCatalog = service.buildCatalog({
      conversationType: '1',
      isAdmin: true,
      query: '更新项目手册',
    });
    expect(adminCatalog.entries[0]?.name).toBe('handbook-maintainer');
  });

  it('加载技能返回正文，并记录使用次数', async () => {
    const store = new MemorySkillStore();
    const service = new SkillService({ roots: builtinRoots(), store });
    await service.init();
    const result = await service.load({
      name: 'code-reading',
      conversationId: 'conv-1',
      senderStaffId: 'staff-1',
      isAdmin: false,
    });
    expect(result.instructions).toContain('# 代码阅读');
    expect(result.truncated).toBe(false);
    expect(
      store.usageRecords.some(
        (record) =>
          record.skillId === 'builtin:code-reading' && record.action === 'load',
      ),
    ).toBe(true);
  });

  it('禁用技能后目录与加载都不可用', async () => {
    const store = new MemorySkillStore();
    const service = new SkillService({ roots: builtinRoots(), store });
    await service.init();
    await service.setEnabled('builtin:repo-review', false);
    const catalog = service.buildCatalog({
      conversationType: '1',
      isAdmin: true,
      query: '评审仓库',
    });
    expect(catalog.entries.some((entry) => entry.name === 'repo-review')).toBe(
      false,
    );
    await expect(
      service.load({
        name: 'repo-review',
        conversationId: 'c',
        senderStaffId: 'u',
        isAdmin: true,
      }),
    ).rejects.toThrow('已停用');
  });

  it('admin 技能对普通用户不可加载', async () => {
    const service = new SkillService({ roots: builtinRoots() });
    await service.init();
    await expect(
      service.load({
        name: 'handbook-maintainer',
        conversationId: 'c',
        senderStaffId: 'u',
        isAdmin: false,
      }),
    ).rejects.toThrow('仅管理员');
  });

  it('超长技能正文不注入，返回分段读取指引', async () => {
    const root = await makeSkillRoot();
    await writeSkill(root, 'long-skill', {
      body: `# 长技能\n\n${'步骤内容\n'.repeat(1_200)}`,
    });
    const service = new SkillService({
      roots: [{ source: 'local', dir: root }],
    });
    await service.init();
    const result = await service.load({
      name: 'long-skill',
      conversationId: 'c',
      senderStaffId: 'u',
      isAdmin: false,
    });
    expect(result.truncated).toBe(true);
    expect(result.instructions).toBeUndefined();
    expect(result.outline).toContain('skill_read');
    expect(result.outline).toContain('SKILL.md');
  });

  it('资源读取支持分页并阻止路径逃逸', async () => {
    const root = await makeSkillRoot();
    const lines = Array.from({ length: 600 }, (_, index) => `x${index + 1}`);
    await writeSkill(root, 'demo', {
      resources: { 'references/long.md': lines.join('\n') },
    });
    const service = new SkillService({
      roots: [{ source: 'local', dir: root }],
    });
    await service.init();

    const page = await service.readResource({
      name: 'demo',
      path: 'references/long.md',
      startLine: 1,
      isAdmin: false,
    });
    expect(page.endLine).toBe(500);
    expect(page.nextStartLine).toBe(501);
    expect(page.content).toContain('x1');
    expect(page.content).not.toContain('x501');

    await expect(
      service.readResource({
        name: 'demo',
        path: '../outside.md',
        isAdmin: false,
      }),
    ).rejects.toThrow('相对路径');
  });
});
