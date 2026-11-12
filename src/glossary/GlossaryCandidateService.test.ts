import { describe, expect, it } from 'vitest';
import { GlossaryCandidateService } from './GlossaryCandidateService.js';
import {
  GlossaryCandidateNotFoundError,
  GlossaryCandidateStateError,
  type GlossaryCandidate,
  type GlossaryCandidateInput,
  type GlossaryCandidateListFilter,
  type GlossaryCandidateStatus,
  type GlossaryCandidateStore,
} from '../types/glossary-candidates.js';
import {
  glossaryNameKey,
  type GlossaryAdminPort,
  type GlossaryTerm,
  type GlossaryTermInput,
} from '../types/glossary.js';

class FakeStore implements GlossaryCandidateStore {
  public readonly rows = new Map<string, GlossaryCandidate>();
  private seq = 0;

  async submit(input: GlossaryCandidateInput): Promise<GlossaryCandidate> {
    const nameKey = glossaryNameKey(input.standardName);
    for (const row of this.rows.values()) {
      if (row.status === 'pending' && glossaryNameKey(row.standardName) === nameKey) {
        return row;
      }
    }
    this.seq += 1;
    const now = Date.now();
    const candidate: GlossaryCandidate = {
      id: `cand-${this.seq}`,
      status: 'pending',
      standardName: input.standardName.trim(),
      aliases: input.aliases ?? [],
      definition: input.definition.trim(),
      usageScenarios: input.usageScenarios ?? '',
      examples: input.examples ?? [],
      misconceptions: input.misconceptions ?? '',
      department: input.department ?? '',
      timeliness: input.timeliness ?? 'long_term',
      sensitivity: input.sensitivity ?? 'team',
      docLinks: input.docLinks ?? [],
      injectToPrompt: input.injectToPrompt ?? true,
      promptPriority: input.promptPriority ?? 0,
      sourceConversationId: input.sourceConversationId ?? '',
      evidence: input.evidence ?? '',
      submittedBy: input.submittedBy ?? '',
      reviewedBy: '',
      reviewedAt: null,
      reviewNote: '',
      glossaryTermId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(candidate.id, candidate);
    return candidate;
  }

  async list(filter: GlossaryCandidateListFilter): Promise<GlossaryCandidate[]> {
    return [...this.rows.values()].filter(
      (row) => !filter.status || row.status === filter.status,
    );
  }

  async getById(id: string): Promise<GlossaryCandidate | null> {
    return this.rows.get(id) ?? null;
  }

  async markReviewed(
    id: string,
    review: {
      status: 'approved' | 'rejected';
      reviewedBy: string;
      reviewNote?: string;
      glossaryTermId?: string | null;
    },
  ): Promise<GlossaryCandidate | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return null;
    const updated: GlossaryCandidate = {
      ...row,
      status: review.status,
      reviewedBy: review.reviewedBy,
      reviewNote: review.reviewNote ?? '',
      glossaryTermId: review.glossaryTermId ?? null,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async countByStatus(): Promise<Record<GlossaryCandidateStatus, number>> {
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const row of this.rows.values()) counts[row.status] += 1;
    return counts;
  }
}

function fakeGlossary(): { port: GlossaryAdminPort; created: GlossaryTermInput[] } {
  const created: GlossaryTermInput[] = [];
  const port = {
    async create(input: GlossaryTermInput, updatedBy: string): Promise<GlossaryTerm> {
      created.push(input);
      return {
        id: `term-${created.length}`,
        standardName: input.standardName,
        aliases: input.aliases ?? [],
        definition: input.definition,
        usageScenarios: input.usageScenarios ?? '',
        examples: input.examples ?? [],
        misconceptions: input.misconceptions ?? '',
        department: input.department ?? '',
        timeliness: input.timeliness ?? 'long_term',
        sensitivity: input.sensitivity ?? 'team',
        docLinks: input.docLinks ?? [],
        injectToPrompt: input.injectToPrompt ?? true,
        promptPriority: input.promptPriority ?? 0,
        hitCount: 0,
        lastUpdatedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updatedBy,
      };
    },
  } as unknown as GlossaryAdminPort;
  return { port, created };
}

function setup() {
  const store = new FakeStore();
  const glossary = fakeGlossary();
  const service = new GlossaryCandidateService({ store, glossary: glossary.port });
  return { store, glossary, service };
}

describe('GlossaryCandidateService', () => {
  it('提交候选只落 pending，不写入术语库', async () => {
    const { glossary, service } = setup();
    const candidate = await service.submit({
      standardName: '拉齐',
      definition: '把信息同步到一致认知',
      submittedBy: 'company-jargon',
    });
    expect(candidate.status).toBe('pending');
    expect(glossary.created).toHaveLength(0);
  });

  it('提交缺少名称或定义时拒绝', async () => {
    const { service } = setup();
    await expect(
      service.submit({ standardName: '  ', definition: 'x' }),
    ).rejects.toBeInstanceOf(GlossaryCandidateStateError);
    await expect(
      service.submit({ standardName: 'x', definition: '  ' }),
    ).rejects.toBeInstanceOf(GlossaryCandidateStateError);
  });

  it('管理员通过后才写入术语库并回写术语 id', async () => {
    const { glossary, service } = setup();
    const candidate = await service.submit({
      standardName: '拉齐',
      definition: '把信息同步到一致认知',
    });
    const { candidate: reviewed, term } = await service.approve(
      candidate.id,
      'admin',
      '确认收录',
    );
    expect(glossary.created).toHaveLength(1);
    expect(glossary.created[0]?.standardName).toBe('拉齐');
    expect(reviewed.status).toBe('approved');
    expect(reviewed.glossaryTermId).toBe(term.id);
    expect(reviewed.reviewedBy).toBe('admin');
    expect(reviewed.reviewNote).toBe('确认收录');
  });

  it('驳回不写入术语库', async () => {
    const { glossary, service } = setup();
    const candidate = await service.submit({
      standardName: '拉齐',
      definition: '把信息同步到一致认知',
    });
    const reviewed = await service.reject(candidate.id, 'admin', '证据不足');
    expect(reviewed.status).toBe('rejected');
    expect(glossary.created).toHaveLength(0);
  });

  it('已处理的候选不能重复审批', async () => {
    const { service } = setup();
    const candidate = await service.submit({
      standardName: '拉齐',
      definition: '把信息同步到一致认知',
    });
    await service.approve(candidate.id, 'admin');
    await expect(service.approve(candidate.id, 'admin')).rejects.toBeInstanceOf(
      GlossaryCandidateStateError,
    );
    await expect(service.reject(candidate.id, 'admin')).rejects.toBeInstanceOf(
      GlossaryCandidateStateError,
    );
  });

  it('审批不存在的候选报未找到', async () => {
    const { service } = setup();
    await expect(service.approve('missing', 'admin')).rejects.toBeInstanceOf(
      GlossaryCandidateNotFoundError,
    );
  });

  it('同名待审批候选幂等返回', async () => {
    const { store, service } = setup();
    const first = await service.submit({ standardName: '拉齐', definition: 'a' });
    const second = await service.submit({ standardName: '拉齐', definition: 'b' });
    expect(second.id).toBe(first.id);
    expect(store.rows.size).toBe(1);
  });
});