import type {
  GlossaryAdminPort,
  GlossaryTerm,
  GlossaryTermInput,
} from '../types/glossary.js';
import {
  GlossaryCandidateNotFoundError,
  GlossaryCandidateStateError,
  type GlossaryCandidate,
  type GlossaryCandidateInput,
  type GlossaryCandidateListFilter,
  type GlossaryCandidateStatus,
  type GlossaryCandidateStore,
} from '../types/glossary-candidates.js';

export interface GlossaryCandidateServiceOptions {
  store: GlossaryCandidateStore;
  /** 通过候选时复用术语服务的校验/去重/注入约定入库 */
  glossary: GlossaryAdminPort;
}

function toTermInput(candidate: GlossaryCandidate): GlossaryTermInput {
  return {
    standardName: candidate.standardName,
    aliases: candidate.aliases,
    definition: candidate.definition,
    usageScenarios: candidate.usageScenarios,
    examples: candidate.examples,
    misconceptions: candidate.misconceptions,
    department: candidate.department,
    timeliness: candidate.timeliness,
    sensitivity: candidate.sensitivity,
    docLinks: candidate.docLinks,
    injectToPrompt: candidate.injectToPrompt,
    promptPriority: candidate.promptPriority,
  };
}

/**
 * 黑话候选编排：技能只能提交 pending 候选；
 * 只有管理员「通过」才会调用术语服务写入知识库，驳回则不入库。
 */
export class GlossaryCandidateService {
  private readonly store: GlossaryCandidateStore;
  private readonly glossary: GlossaryAdminPort;

  constructor(options: GlossaryCandidateServiceOptions) {
    this.store = options.store;
    this.glossary = options.glossary;
  }

  public async submit(input: GlossaryCandidateInput): Promise<GlossaryCandidate> {
    if (!input.standardName?.trim()) {
      throw new GlossaryCandidateStateError('候选标准名称不能为空');
    }
    if (!input.definition?.trim()) {
      throw new GlossaryCandidateStateError('候选定义不能为空');
    }
    return this.store.submit(input);
  }

  public list(filter: GlossaryCandidateListFilter): Promise<GlossaryCandidate[]> {
    return this.store.list(filter);
  }

  public get(id: string): Promise<GlossaryCandidate | null> {
    return this.store.getById(id);
  }

  public stats(): Promise<Record<GlossaryCandidateStatus, number>> {
    return this.store.countByStatus();
  }

  /** 管理员通过：先入库术语，再把候选标记为 approved 并回写术语 id */
  public async approve(
    id: string,
    reviewedBy: string,
    reviewNote?: string,
  ): Promise<{ candidate: GlossaryCandidate; term: GlossaryTerm }> {
    const candidate = await this.requirePending(id);
    const term = await this.glossary.create(toTermInput(candidate), reviewedBy);
    const updated = await this.store.markReviewed(id, {
      status: 'approved',
      reviewedBy,
      ...(reviewNote !== undefined ? { reviewNote } : {}),
      glossaryTermId: term.id,
    });
    if (!updated) {
      throw new GlossaryCandidateStateError('候选已被其他管理员处理');
    }
    return { candidate: updated, term };
  }

  /** 管理员驳回：不写入术语库 */
  public async reject(
    id: string,
    reviewedBy: string,
    reviewNote?: string,
  ): Promise<GlossaryCandidate> {
    await this.requirePending(id);
    const updated = await this.store.markReviewed(id, {
      status: 'rejected',
      reviewedBy,
      ...(reviewNote !== undefined ? { reviewNote } : {}),
    });
    if (!updated) {
      throw new GlossaryCandidateStateError('候选已被其他管理员处理');
    }
    return updated;
  }

  private async requirePending(id: string): Promise<GlossaryCandidate> {
    const candidate = await this.store.getById(id);
    if (!candidate) {
      throw new GlossaryCandidateNotFoundError(`未找到候选：${id}`);
    }
    if (candidate.status !== 'pending') {
      throw new GlossaryCandidateStateError(
        `候选已处理（${candidate.status}），不能重复审批`,
      );
    }
    return candidate;
  }
}