import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import {
  GlossaryConflictError,
  type GlossaryTerm,
} from '../../types/glossary.js';
import {
  GlossaryCandidateNotFoundError,
  GlossaryCandidateStateError,
  type GlossaryCandidate,
} from '../../types/glossary-candidates.js';
import {
  createGlossaryCandidateRoutes,
  type GlossaryCandidateAdminPort,
} from './glossaryCandidateRoutes.js';

const NOW = new Date('2026-11-01T10:00:00Z').getTime();

function fakeCandidate(
  overrides: Partial<GlossaryCandidate> = {},
): GlossaryCandidate {
  return {
    id: 'cand-1',
    status: 'pending',
    standardName: '拉齐',
    aliases: ['对齐'],
    definition: '把相关人的认知同步到同一水平',
    usageScenarios: '开会前后',
    examples: ['这个方案先拉齐一下'],
    misconceptions: '',
    department: '',
    timeliness: 'long_term',
    sensitivity: 'team',
    docLinks: [],
    injectToPrompt: true,
    promptPriority: 0,
    sourceConversationId: 'cid-1',
    evidence: '群内多次出现',
    submittedBy: 'staff-9',
    reviewedBy: '',
    reviewedAt: null,
    reviewNote: '',
    glossaryTermId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fakeTerm(): GlossaryTerm {
  return {
    id: 'term-1',
    standardName: '拉齐',
    aliases: ['对齐'],
    definition: '把相关人的认知同步到同一水平',
    usageScenarios: '开会前后',
    examples: ['这个方案先拉齐一下'],
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
    updatedBy: 'admin-1',
  };
}

function setup(port: Partial<GlossaryCandidateAdminPort> = {}) {
  const recordAudit = vi.fn(async () => ({}));
  const candidates: GlossaryCandidateAdminPort = {
    list: vi.fn(async () => [fakeCandidate()]),
    get: vi.fn(async () => fakeCandidate()),
    stats: vi.fn(async () => ({ pending: 1, approved: 0, rejected: 0 })),
    approve: vi.fn(async () => ({
      candidate: fakeCandidate({
        status: 'approved',
        reviewedBy: 'admin-1',
        glossaryTermId: 'term-1',
      }),
      term: fakeTerm(),
    })),
    reject: vi.fn(async () =>
      fakeCandidate({ status: 'rejected', reviewedBy: 'admin-1' }),
    ),
    ...port,
  };
  const configCenter = { recordAudit } as unknown as DynamicConfigCenter;
  const app = new Hono().route(
    '/api/v1/admin',
    createGlossaryCandidateRoutes({ candidates, configCenter }),
  );
  return { app, candidates, recordAudit };
}

describe('黑话候选审批接口', () => {
  it('GET /glossary-candidates 透传 status 过滤', async () => {
    const { app, candidates } = setup();
    const response = await app.request(
      '/api/v1/admin/glossary-candidates?status=pending&limit=50',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      candidates: GlossaryCandidate[];
    };
    expect(body.ok).toBe(true);
    expect(body.candidates).toHaveLength(1);
    expect(candidates.list).toHaveBeenCalledWith({ status: 'pending', limit: 50 });
  });

  it('非法 status 返回 400', async () => {
    const { app, candidates } = setup();
    const response = await app.request(
      '/api/v1/admin/glossary-candidates?status=done',
    );
    expect(response.status).toBe(400);
    expect(candidates.list).not.toHaveBeenCalled();
  });

  it('GET /glossary-candidates/stats 返回各状态计数', async () => {
    const { app } = setup();
    const response = await app.request('/api/v1/admin/glossary-candidates/stats');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stats: Record<string, number>;
    };
    expect(body.stats).toEqual({ pending: 1, approved: 0, rejected: 0 });
  });

  it('GET /glossary-candidates/:id 不存在返回 404', async () => {
    const { app } = setup({ get: vi.fn(async () => null) });
    const response = await app.request('/api/v1/admin/glossary-candidates/nope');
    expect(response.status).toBe(404);
  });

  it('POST approve 入库术语、回写候选并写审计', async () => {
    const { app, candidates, recordAudit } = setup();
    const response = await app.request(
      '/api/v1/admin/glossary-candidates/cand-1/approve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-staff-id': 'admin-1',
        },
        body: JSON.stringify({ reviewNote: '定义准确' }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      candidate: GlossaryCandidate;
      term: GlossaryTerm;
    };
    expect(body.ok).toBe(true);
    expect(body.term.id).toBe('term-1');
    expect(body.candidate.glossaryTermId).toBe('term-1');
    expect(candidates.approve).toHaveBeenCalledWith('cand-1', 'admin-1', '定义准确');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminStaffId: 'admin-1',
        actionType: 'REVIEW_GLOSSARY_CANDIDATE',
        afterSnapshot: expect.objectContaining({
          action: 'approve',
          termId: 'term-1',
        }),
      }),
    );
  });

  it('已处理候选再次审批返回 409', async () => {
    const { app } = setup({
      approve: vi.fn(async () => {
        throw new GlossaryCandidateStateError('候选已处理（approved），不能重复审批');
      }),
    });
    const response = await app.request(
      '/api/v1/admin/glossary-candidates/cand-1/approve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(409);
  });

  it('术语重名冲突返回 409，候选不入库', async () => {
    const { app, recordAudit } = setup({
      approve: vi.fn(async () => {
        throw new GlossaryConflictError('术语已存在：拉齐');
      }),
    });
    const response = await app.request(
      '/api/v1/admin/glossary-candidates/cand-1/approve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(409);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('候选不存在审批返回 404', async () => {
    const { app } = setup({
      approve: vi.fn(async () => {
        throw new GlossaryCandidateNotFoundError('未找到候选：nope');
      }),
    });
    const response = await app.request(
      '/api/v1/admin/glossary-candidates/nope/approve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(404);
  });

  it('POST reject 不产生术语并写审计', async () => {
    const { app, candidates, recordAudit } = setup();
    const response = await app.request(
      '/api/v1/admin/glossary-candidates/cand-1/reject',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-staff-id': 'admin-1',
        },
        body: JSON.stringify({ reviewNote: '一次性梗' }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      candidate: GlossaryCandidate;
      term?: GlossaryTerm;
    };
    expect(body.ok).toBe(true);
    expect(body.candidate.status).toBe('rejected');
    expect(body.term).toBeUndefined();
    expect(candidates.reject).toHaveBeenCalledWith('cand-1', 'admin-1', '一次性梗');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'REVIEW_GLOSSARY_CANDIDATE',
        afterSnapshot: expect.objectContaining({ action: 'reject' }),
      }),
    );
  });
});