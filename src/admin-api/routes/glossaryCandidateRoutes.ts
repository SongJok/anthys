import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import {
  GlossaryConflictError,
  GlossaryValidationError,
} from '../../types/glossary.js';
import {
  GlossaryCandidateNotFoundError,
  GlossaryCandidateStateError,
  isGlossaryCandidateStatus,
  type GlossaryCandidate,
  type GlossaryCandidateListFilter,
  type GlossaryCandidateStatus,
} from '../../types/glossary-candidates.js';
import type { GlossaryTerm } from '../../types/glossary.js';
import { readJsonBody, readString, recordWebAudit, webActor } from './configRoutes.js';

/** 候选审批最小端口（GlossaryCandidateService 满足） */
export interface GlossaryCandidateAdminPort {
  list(filter: GlossaryCandidateListFilter): Promise<GlossaryCandidate[]>;
  get(id: string): Promise<GlossaryCandidate | null>;
  stats(): Promise<Record<GlossaryCandidateStatus, number>>;
  approve(
    id: string,
    reviewedBy: string,
    reviewNote?: string,
  ): Promise<{ candidate: GlossaryCandidate; term: GlossaryTerm }>;
  reject(
    id: string,
    reviewedBy: string,
    reviewNote?: string,
  ): Promise<GlossaryCandidate>;
}

export interface GlossaryCandidateRouteDeps {
  candidates: GlossaryCandidateAdminPort;
  configCenter?: DynamicConfigCenter;
}

/** 审计只保留元数据，避免候选正文与群内原话被复制进审计表 */
function auditSnapshot(candidate: GlossaryCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    standardName: candidate.standardName,
    status: candidate.status,
    sourceConversationId: candidate.sourceConversationId,
    glossaryTermId: candidate.glossaryTermId,
  };
}

function mapCandidateError(error: unknown): never {
  if (error instanceof GlossaryCandidateNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof GlossaryCandidateStateError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof GlossaryConflictError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof GlossaryValidationError) {
    throw new HTTPException(400, { message: error.message });
  }
  throw error;
}

/** 黑话候选审批：只有管理员「通过」才会写入术语知识库 */
export function createGlossaryCandidateRoutes(
  deps: GlossaryCandidateRouteDeps,
): Hono {
  const app = new Hono();

  app.get('/glossary-candidates', async (c) => {
    const statusRaw = c.req.query('status');
    let status: GlossaryCandidateStatus | undefined;
    if (statusRaw) {
      if (!isGlossaryCandidateStatus(statusRaw)) {
        throw new HTTPException(400, {
          message: 'status 必须是 pending / approved / rejected',
        });
      }
      status = statusRaw;
    }
    const limitRaw = Number(c.req.query('limit') ?? 200);
    const filter: GlossaryCandidateListFilter = {
      ...(status ? { status } : {}),
      limit: Number.isFinite(limitRaw) ? limitRaw : 200,
    };
    const candidates = await deps.candidates.list(filter);
    return c.json({ ok: true, candidates });
  });

  app.get('/glossary-candidates/stats', async (c) => {
    return c.json({ ok: true, stats: await deps.candidates.stats() });
  });

  app.get('/glossary-candidates/:id', async (c) => {
    const candidate = await deps.candidates.get(c.req.param('id'));
    if (!candidate) {
      throw new HTTPException(404, { message: '未找到黑话候选' });
    }
    return c.json({ ok: true, candidate });
  });

  app.post('/glossary-candidates/:id/approve', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const reviewNote = readString(body, 'reviewNote');
    const actor = webActor(c);
    let result: { candidate: GlossaryCandidate; term: GlossaryTerm };
    try {
      result = await deps.candidates.approve(
        id,
        actor,
        ...(reviewNote !== undefined ? [reviewNote] : []),
      );
    } catch (error) {
      mapCandidateError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        actor,
        'REVIEW_GLOSSARY_CANDIDATE',
        { action: 'approve', candidate: auditSnapshot(result.candidate) },
        {
          action: 'approve',
          candidate: auditSnapshot(result.candidate),
          termId: result.term.id,
        },
      );
    }
    return c.json({ ok: true, ...result });
  });

  app.post('/glossary-candidates/:id/reject', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const reviewNote = readString(body, 'reviewNote');
    const actor = webActor(c);
    let candidate: GlossaryCandidate;
    try {
      candidate = await deps.candidates.reject(
        id,
        actor,
        ...(reviewNote !== undefined ? [reviewNote] : []),
      );
    } catch (error) {
      mapCandidateError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        actor,
        'REVIEW_GLOSSARY_CANDIDATE',
        { action: 'reject', candidate: auditSnapshot(candidate) },
        { action: 'reject', candidate: auditSnapshot(candidate) },
      );
    }
    return c.json({ ok: true, candidate });
  });

  return app;
}