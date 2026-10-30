import { describe, expect, it } from 'vitest';
import { GlossaryService } from './GlossaryService.js';
import {
  GlossaryConflictError,
  GlossaryValidationError,
  type GlossaryStore,
  type GlossaryTerm,
  type GlossaryTermWrite,
} from '../types/glossary.js';

const NOW = Date.UTC(2026, 9, 30, 2, 0, 0);
const DAY = 24 * 60 * 60 * 1_000;

function term(
  overrides: Partial<GlossaryTerm> & { id: string; standardName: string },
): GlossaryTerm {
  return {
    aliases: [],
    definition: `${overrides.standardName} 的标准定义`,
    usageScenarios: '',
    examples: [],
    misconceptions: '',
    department: '',
    timeliness: 'long_term',
    sensitivity: 'team',
    docLinks: [],
    injectToPrompt: true,
    promptPriority: 0,
    hitCount: 0,
    lastUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: 'tester',
    ...overrides,
  };
}

function clone(item: GlossaryTerm): GlossaryTerm {
  return structuredClone(item);
}

class MemoryGlossaryStore implements GlossaryStore {
  public readonly terms: GlossaryTerm[] = [];

  async listAll(): Promise<GlossaryTerm[]> {
    return this.terms.map(clone);
  }

  async getById(id: string): Promise<GlossaryTerm | null> {
    const found = this.terms.find((item) => item.id === id);
    return found ? clone(found) : null;
  }

  async insert(input: GlossaryTermWrite): Promise<GlossaryTerm> {
    const record = term({
      id: `g-${this.terms.length + 1}`,
      ...input,
      hitCount: 0,
      lastUpdatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    record.updatedBy = input.updatedBy;
    this.terms.push(record);
    return clone(record);
  }

  async update(
    id: string,
    input: GlossaryTermWrite,
  ): Promise<GlossaryTerm | null> {
    const index = this.terms.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const next = term({
      ...this.terms[index]!,
      ...input,
      id,
      lastUpdatedAt: NOW,
      updatedAt: NOW,
    });
    this.terms[index] = next;
    return clone(next);
  }

  async remove(id: string): Promise<boolean> {
    const index = this.terms.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.terms.splice(index, 1);
    return true;
  }

  async incrementHits(ids: string[]): Promise<void> {
    for (const id of ids) {
      const found = this.terms.find((item) => item.id === id);
      if (found) found.hitCount += 1;
    }
  }

  async searchSimilar(): Promise<never[]> {
    return [];
  }

  async listMissingEmbeddings(): Promise<GlossaryTerm[]> {
    return [];
  }

  async setEmbedding(): Promise<void> {
    return undefined;
  }
}

function createService(terms: GlossaryTerm[] = []): {
  service: GlossaryService;
  store: MemoryGlossaryStore;
} {
  const store = new MemoryGlossaryStore();
  store.terms.push(...terms.map(clone));
  const service = new GlossaryService({
    store,
    now: () => NOW,
    promptLimit: 10,
    retrievalLimit: 4,
  });
  return { service, store };
}

describe('GlossaryService 系统提示注入', () => {
  it('只注入允许的高频术语，排除敏感、已废弃与关闭注入的条目', async () => {
    const { service } = createService([
      term({
        id: 'g-1',
        standardName: 'CQ',
        aliases: ['cheque'],
        definition: '变更请求单',
        promptPriority: 90,
      }),
      term({
        id: 'g-2',
        standardName: '薪酬包',
        definition: '敏感信息',
        sensitivity: 'sensitive',
        promptPriority: 99,
      }),
      term({
        id: 'g-3',
        standardName: '老 K8s 平台',
        definition: '历史集群',
        timeliness: 'retired',
        promptPriority: 98,
      }),
      term({
        id: 'g-4',
        standardName: '临时代号',
        definition: '不常驻',
        injectToPrompt: false,
        promptPriority: 97,
      }),
      term({
        id: 'g-5',
        standardName: '双十一大促',
        definition: '年度大促',
        promptPriority: 10,
      }),
    ]);

    const result = await service.buildContext({
      conversationType: '1',
      query: '',
    });

    expect(result.prompt).toContain('CQ');
    expect(result.prompt).toContain('变更请求单');
    expect(result.prompt).toContain('cheque');
    expect(result.prompt).toContain('双十一大促');
    expect(result.prompt).not.toContain('薪酬包');
    expect(result.prompt).not.toContain('老 K8s 平台');
    expect(result.prompt).not.toContain('临时代号');
    expect(result.injected.map((item) => item.id)).toEqual(['g-1', 'g-5']);
    expect(result.retrieved).toEqual([]);
  });

  it('按权重与命中次数截断，最多保持设定条数', async () => {
    const { service } = createService([
      term({ id: 'g-1', standardName: 'A', promptPriority: 10 }),
      term({ id: 'g-2', standardName: 'B', promptPriority: 80 }),
      term({ id: 'g-3', standardName: 'C', promptPriority: 80, hitCount: 5 }),
      term({ id: 'g-4', standardName: 'D', promptPriority: 80, hitCount: 1 }),
    ]);

    const result = await service.buildContext({
      conversationType: '1',
      promptLimit: 2,
    });
    expect(result.injected.map((item) => item.standardName)).toEqual(['C', 'D']);
  });

  it('关闭注入时仍可按提问检索术语卡', async () => {
    const store = new MemoryGlossaryStore();
    store.terms.push(
      term({
        id: 'g-1',
        standardName: 'CQ',
        definition: '变更请求单',
      }),
    );
    const service = new GlossaryService({
      store,
      now: () => NOW,
      promptEnabled: false,
    });

    const result = await service.buildContext({
      conversationType: '1',
      query: 'CQ 怎么提',
    });
    expect(result.injected).toEqual([]);
    expect(result.retrieved.map((item) => item.standardName)).toEqual(['CQ']);
    expect(result.prompt).toContain('【标准名称】CQ');
    expect(result.prompt).toContain('【不要误解为】');
  });
});

describe('GlossaryService 按问检索与术语查询', () => {
  it('群聊检索排除敏感术语，单聊可以命中', async () => {
    const { service } = createService([
      term({
        id: 'g-1',
        standardName: 'CQ',
        aliases: ['变更请求'],
        definition: '变更请求单',
        injectToPrompt: false,
      }),
      term({
        id: 'g-2',
        standardName: 'CQ 预算',
        definition: '变更预算额度',
        sensitivity: 'sensitive',
        injectToPrompt: false,
      }),
    ]);

    const group = await service.buildContext({
      conversationType: '2',
      query: 'CQ 预算怎么申请',
    });
    expect(group.retrieved.map((item) => item.id)).toEqual(['g-1']);
    expect(group.prompt).not.toContain('变更预算额度');

    const single = await service.buildContext({
      conversationType: '1',
      query: 'CQ 预算怎么申请',
    });
    expect(single.retrieved.map((item) => item.id)).toContain('g-2');
    expect(single.prompt).toContain('变更预算额度');
  });

  it('查询工具精确匹配标准名与别名，并累计命中次数', async () => {
    const { service, store } = createService([
      term({
        id: 'g-1',
        standardName: 'CQ',
        aliases: ['变更请求'],
        definition: '变更请求单',
      }),
      term({
        id: 'g-2',
        standardName: 'PB 系统',
        aliases: ['定价后台'],
        definition: '价格配置后台',
      }),
    ]);

    const result = await service.lookup('pb 系统', { conversationType: '1' });
    expect(result.exact.map((item) => item.id)).toEqual(['g-2']);

    const aliasResult = await service.lookup('变更请求', {
      conversationType: '1',
    });
    expect(aliasResult.exact.map((item) => item.id)).toEqual(['g-1']);

    await Promise.resolve();
    expect(store.terms.find((item) => item.id === 'g-1')?.hitCount).toBe(1);
    expect(store.terms.find((item) => item.id === 'g-2')?.hitCount).toBe(1);
  });

  it('群聊查询不到敏感术语，单聊可以查到完整模板', async () => {
    const { service } = createService([
      term({
        id: 'g-1',
        standardName: '薪酬包',
        definition: '年度现金与期权组合',
        sensitivity: 'sensitive',
      }),
    ]);

    const group = await service.lookup('薪酬包', { conversationType: '2' });
    expect(group.exact).toEqual([]);

    const single = await service.lookup('薪酬包', { conversationType: '1' });
    expect(single.exact).toHaveLength(1);
    const card = service.formatCard(single.exact[0]!);
    for (const label of [
      '【标准名称】',
      '【常见别名/缩写】',
      '【定义】',
      '【使用场景】',
      '【示例句子】',
      '【不要误解为】',
      '【所属部门/项目】',
      '【时效性】',
      '【敏感级别】',
      '【关联文档链接】',
      '【最后更新时间】',
    ]) {
      expect(card).toContain(label);
    }
    expect(card).toContain('【敏感级别】敏感');
  });
});

describe('GlossaryService 管理与校验', () => {
  it('创建与更新会使缓存失效，并拒绝名称冲突', async () => {
    const { service } = createService([
      term({ id: 'g-1', standardName: 'CQ', aliases: ['变更请求'] }),
    ]);

    await service.list();
    const created = await service.create(
      {
        standardName: 'PB 系统',
        definition: '价格配置后台',
        aliases: ['定价后台'],
      },
      'admin-1',
    );
    expect((await service.list()).total).toBe(2);
    expect(created.updatedBy).toBe('admin-1');

    await expect(
      service.create({ standardName: 'CQ', definition: '重复' }, 'admin-1'),
    ).rejects.toBeInstanceOf(GlossaryConflictError);
    await expect(
      service.create(
        { standardName: '变更请求', definition: '与别名冲突' },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(GlossaryConflictError);
    await expect(
      service.create({ standardName: '无定义', definition: '' }, 'admin-1'),
    ).rejects.toBeInstanceOf(GlossaryValidationError);

    const updated = await service.update(
      'g-1',
      { definition: '变更请求单（新版流程）' },
      'admin-1',
    );
    expect(updated.definition).toContain('新版流程');
    const listed = await service.list();
    expect(
      listed.terms.find((item) => item.id === 'g-1')?.definition,
    ).toContain('新版流程');
  });

  it('校验时报出缺定义、非法链接、废弃注入与项目期过期', async () => {
    const { service } = createService([
      term({
        id: 'g-1',
        standardName: '无定义术语',
        definition: ' ',
      }),
      term({
        id: 'g-2',
        standardName: '文档错误',
        docLinks: ['not-a-url'],
      }),
      term({
        id: 'g-3',
        standardName: '废弃术语',
        timeliness: 'retired',
        injectToPrompt: true,
      }),
      term({
        id: 'g-4',
        standardName: '旧项目代号',
        timeliness: 'project',
        lastUpdatedAt: NOW - 200 * DAY,
      }),
      term({
        id: 'g-5',
        standardName: '共享别名',
        aliases: ['共享'],
      }),
      term({
        id: 'g-6',
        standardName: '另一个术语',
        aliases: ['共享'],
      }),
    ]);

    const report = await service.validate();
    expect(report.checked).toBe(6);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(
      report.issues.some(
        (issue) => issue.termId === 'g-1' && issue.field === 'definition',
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) => issue.termId === 'g-2' && issue.field === 'docLinks',
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) => issue.termId === 'g-3' && issue.field === 'injectToPrompt',
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) => issue.termId === 'g-4' && issue.field === 'lastUpdatedAt',
      ),
    ).toBe(true);
    const aliasWarnings = report.issues.filter(
      (issue) => issue.field === 'aliases' && issue.severity === 'warning',
    );
    expect(aliasWarnings.map((issue) => issue.termId).sort()).toEqual([
      'g-5',
      'g-6',
    ]);
  });

  it('统计与管理列表按条件过滤', async () => {
    const { service } = createService([
      term({ id: 'g-1', standardName: 'CQ', aliases: ['变更请求'] }),
      term({
        id: 'g-2',
        standardName: '薪酬包',
        sensitivity: 'sensitive',
      }),
      term({
        id: 'g-3',
        standardName: '旧平台',
        timeliness: 'retired',
      }),
    ]);

    const stats = await service.stats();
    expect(stats.total).toBe(3);
    expect(stats.injected).toBe(1);
    expect(stats.sensitive).toBe(1);
    expect(stats.retired).toBe(1);

    const filtered = await service.list({ query: '变更', onlyInjected: true });
    expect(filtered.terms.map((item) => item.id)).toEqual(['g-1']);

    const preview = await service.previewPrompt();
    expect(preview.terms.map((item) => item.id)).toEqual(['g-1']);
    expect(preview.prompt).toContain('企业术语知识库');
  });
});
