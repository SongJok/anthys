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
        module: definition.module,
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
      `name: ${path.basename(name)}`,
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

async function writeModules(
  root: string,
  layout: Record<string, string[]>,
): Promise<void> {
  for (const [module, names] of Object.entries(layout)) {
    for (const name of names) await writeSkill(root, `${module}/${name}`);
  }
}

function builtinRoots() {
  return [
    {
      source: 'builtin' as const,
      dir: path.resolve('skills/builtin'),
      modules: true,
    },
  ];
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

  describe('目录两级渲染', () => {
    function moduleLines(prompt: string): string[] {
      return prompt.split('\n').filter((line) => /^- [a-z0-9-]+（\d+）/u.test(line));
    }

    it('模块摘要点名全部技能，明细只展开 top-K', async () => {
      const root = await makeSkillRoot();
      await writeModules(root, {
        code: ['audit-code', 'analyze-code', 'fix-bug'],
        testing: ['debug-helper', 'auto-testing'],
      });
      const service = new SkillService({
        roots: [{ source: 'market', dir: root, modules: true }],
        catalogLimit: 30,
        catalogMaxChars: 1_600,
      });
      await service.init();
      const catalog = service.buildCatalog({
        conversationType: '1',
        isAdmin: true,
      });
      expect(catalog.prompt).toContain('- code（3）：');
      expect(catalog.prompt).toContain('- testing（2）：');
      expect(catalog.prompt).toContain('### 本次可能相关');
      expect(catalog.entries.map((entry) => entry.name).sort()).toEqual([
        'analyze-code',
        'audit-code',
        'auto-testing',
        'debug-helper',
        'fix-bug',
      ]);
      expect(catalog.total).toBe(5);
      expect(catalog.truncated).toBe(false);
      expect(catalog.prompt.length).toBeLessThanOrEqual(1_600);
      // 5 个技能但明细只展开 4 条（DEFAULT_DETAIL_LIMIT）
      expect(
        catalog.prompt.split('\n').filter((line) => line.includes('适用：')),
      ).toHaveLength(4);
    });

    it('预算收紧时只按整名截断，剩余数量用 …+N 交代', async () => {
      const root = await makeSkillRoot();
      const names = Array.from(
        { length: 10 },
        (_, index) => `engineering-very-long-skill-${index + 1}`,
      );
      await writeModules(root, { engineering: names });
      const service = new SkillService({
        roots: [{ source: 'builtin', dir: root, modules: true }],
        catalogLimit: 30,
        catalogMaxChars: 300,
      });
      await service.init();
      const catalog = service.buildCatalog({
        conversationType: '1',
        isAdmin: true,
      });
      const allNames = new Set(names);
      const line = moduleLines(catalog.prompt)[0] ?? '';
      expect(line).toMatch(/^- engineering（10）：/u);
      const tail = line.slice(line.indexOf('：') + 1);
      const [namesPart, overflow] = tail.split(' …+');
      const listed = (namesPart ?? '').split(', ');
      // 关键断言：列出来的每个名字都是完整技能名，没有半个
      for (const name of listed) expect(allNames.has(name)).toBe(true);
      expect(listed.length).toBeLessThan(10);
      expect(Number(overflow)).toBe(10 - listed.length);
      expect(catalog.prompt.length).toBeLessThanOrEqual(300);
    });

    it('技能数超过 catalogLimit 时每个模块仍然露面，并标记 truncated', async () => {
      const root = await makeSkillRoot();
      const layout: Record<string, string[]> = {};
      for (const module of ['code', 'testing', 'finance', 'database']) {
        layout[module] = Array.from({ length: 8 }, (_, index) => `${module}-skill-${index + 1}`);
      }
      await writeModules(root, layout);
      const service = new SkillService({
        roots: [{ source: 'market', dir: root, modules: true }],
        catalogLimit: 30,
        catalogMaxChars: 1_600,
      });
      await service.init();
      const catalog = service.buildCatalog({
        conversationType: '1',
        isAdmin: true,
      });
      expect(catalog.total).toBe(32);
      expect(moduleLines(catalog.prompt)).toHaveLength(4);
      expect(catalog.entries.length).toBeLessThan(32);
      expect(catalog.truncated).toBe(true);
      expect(catalog.prompt).toContain('skill_search');
      expect(catalog.prompt.length).toBeLessThanOrEqual(1_600);
    });

    it('模块数量按真实规模算，不受 catalogLimit 影响', async () => {
      const root = await makeSkillRoot();
      await writeModules(root, {
        code: ['a-code', 'b-code', 'c-code'],
        office: ['a-office', 'b-office'],
      });
      const service = new SkillService({
        roots: [{ source: 'market', dir: root, modules: true }],
        catalogLimit: 3,
        catalogMaxChars: 1_600,
      });
      await service.init();
      const catalog = service.buildCatalog({
        conversationType: '1',
        isAdmin: true,
      });
      expect(catalog.total).toBe(5);
      expect(catalog.prompt).toContain('- code（3）：');
      expect(catalog.prompt).toContain('- office（2）：');
      expect(catalog.entries).toHaveLength(3);
      expect(catalog.truncated).toBe(true);
    });
  });

  describe('模块别名加分', () => {
    it('别名命中时同组技能整体上浮，未命中的模块不加分', async () => {
      const root = await makeSkillRoot();
      // 两个模块的 description/when_to_use/tags 完全一样，唯一差别是模块名
      await writeModules(root, {
        engineering: ['alpha-skill', 'beta-skill'],
        general: ['gamma-skill', 'delta-skill'],
      });
      const service = new SkillService({
        roots: [{ source: 'market', dir: root, modules: true }],
      });
      await service.init();
      const result = service.search({
        query: '帮我看看这段代码',
        isAdmin: true,
        limit: 10,
      });
      expect(result.matches.map((match) => match.name)).toEqual([
        'alpha-skill',
        'beta-skill',
      ]);
      expect(result.matches.every((match) => match.module === 'engineering')).toBe(
        true,
      );
      expect(result.total).toBe(4);
    });

    it('没有登记别名的模块不参与加分', async () => {
      const root = await makeSkillRoot();
      await writeModules(root, { finance: ['quant-research'] });
      const service = new SkillService({
        roots: [{ source: 'market', dir: root, modules: true }],
      });
      await service.init();
      const result = service.search({
        query: '帮我看看这段代码',
        isAdmin: true,
        limit: 10,
      });
      expect(result.matches).toHaveLength(0);
    });
  });

  describe('模块汇总', () => {
    it('total 按扫描规模算，停用只减 enabled', async () => {
      const store = new MemorySkillStore();
      const service = new SkillService({ roots: builtinRoots(), store });
      await service.init();

      const admin = await service.listAdmin();
      const modules = await service.listModules();
      expect(modules.reduce((sum, item) => sum + item.total, 0)).toBe(admin.length);
      expect(modules.map((item) => item.module)).toEqual(
        [...modules.map((item) => item.module)].sort((a, b) => a.localeCompare(b)),
      );

      const engineering = modules.find((item) => item.module === 'engineering')!;
      expect(engineering.total).toBe(
        admin.filter((item) => item.module === 'engineering').length,
      );
      expect(engineering.enabled).toBe(engineering.total);
      expect(engineering.sources).toEqual(['builtin']);

      await service.setEnabled('builtin:repo-review', false);
      const after = (await service.listModules()).find(
        (item) => item.module === 'engineering',
      )!;
      expect(after.total).toBe(engineering.total);
      expect(after.enabled).toBe(engineering.total - 1);
    });

    it('重载后仍按数据库里的停用状态计数，不回落到默认全开', async () => {
      const store = new MemorySkillStore();
      const first = new SkillService({ roots: builtinRoots(), store });
      await first.init();
      await first.setEnabled('builtin:repo-review', false);
      const expected = (await first.listModules()).find(
        (item) => item.module === 'engineering',
      )!;

      const second = new SkillService({ roots: builtinRoots(), store });
      await second.init();
      const actual = (await second.listModules()).find(
        (item) => item.module === 'engineering',
      )!;
      expect(actual).toEqual(expected);
      expect(actual.enabled).toBe(actual.total - 1);
    });

    it('同名模块跨来源合并，sources 去重', async () => {
      const root = await makeSkillRoot();
      await writeModules(root, { data: ['quant-research', 'stock-screener'] });
      const service = new SkillService({
        roots: [...builtinRoots(), { source: 'market' as const, dir: root, modules: true }],
      });
      await service.init();
      const data = (await service.listModules()).find((item) => item.module === 'data')!;
      const admin = await service.listAdmin();
      expect(data.total).toBe(admin.filter((item) => item.module === 'data').length);
      expect(data.sources).toEqual(['builtin', 'market']);
    });
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
