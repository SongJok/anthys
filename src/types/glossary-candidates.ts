import type {
  GlossarySensitivity,
  GlossaryTimeliness,
} from './glossary.js';

/**
 * 黑话候选：技能从群发言归档归纳出的术语草稿。
 * 候选必须经管理员在后台「通过」才会写入术语知识库（glossary_terms），
 * 提交工具本身绝不直接入库。
 */
export type GlossaryCandidateStatus = 'pending' | 'approved' | 'rejected';

export const GLOSSARY_CANDIDATE_STATUS_LABELS: Record<
  GlossaryCandidateStatus,
  string
> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
};

export function isGlossaryCandidateStatus(
  value: unknown,
): value is GlossaryCandidateStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

/** 候选术语卡片：模板字段与术语一致，另带来源与审批信息 */
export interface GlossaryCandidate {
  id: string;
  status: GlossaryCandidateStatus;
  standardName: string;
  aliases: string[];
  definition: string;
  usageScenarios: string;
  examples: string[];
  misconceptions: string;
  department: string;
  timeliness: GlossaryTimeliness;
  sensitivity: GlossarySensitivity;
  docLinks: string[];
  injectToPrompt: boolean;
  promptPriority: number;
  /** 归纳来源群（conversationId），可空表示跨群综合 */
  sourceConversationId: string;
  /** 支撑证据：群内原话摘录与归纳理由 */
  evidence: string;
  /** 提交者（技能/工具名或 staffId） */
  submittedBy: string;
  reviewedBy: string;
  reviewedAt: number | null;
  reviewNote: string;
  /** 通过后生成的术语 id */
  glossaryTermId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 提交候选的输入（技能调用），模板字段大多可选 */
export interface GlossaryCandidateInput {
  standardName: string;
  definition: string;
  aliases?: string[];
  usageScenarios?: string;
  examples?: string[];
  misconceptions?: string;
  department?: string;
  timeliness?: GlossaryTimeliness;
  sensitivity?: GlossarySensitivity;
  docLinks?: string[];
  injectToPrompt?: boolean;
  promptPriority?: number;
  sourceConversationId?: string;
  evidence?: string;
  submittedBy?: string;
}

export interface GlossaryCandidateListFilter {
  status?: GlossaryCandidateStatus;
  limit?: number;
}

/** 候选持久化端口（纯存储，不含入库编排） */
export interface GlossaryCandidateStore {
  submit(input: GlossaryCandidateInput): Promise<GlossaryCandidate>;
  list(filter: GlossaryCandidateListFilter): Promise<GlossaryCandidate[]>;
  getById(id: string): Promise<GlossaryCandidate | null>;
  /** 仅当候选仍为 pending 时更新审批结果，返回更新后的候选；否则 null */
  markReviewed(
    id: string,
    review: {
      status: 'approved' | 'rejected';
      reviewedBy: string;
      reviewNote?: string;
      glossaryTermId?: string | null;
    },
  ): Promise<GlossaryCandidate | null>;
  countByStatus(): Promise<Record<GlossaryCandidateStatus, number>>;
}

export class GlossaryCandidateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryCandidateNotFoundError';
  }
}

export class GlossaryCandidateStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlossaryCandidateStateError';
  }
}