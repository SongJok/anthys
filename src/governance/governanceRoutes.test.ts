import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { createGovernanceRoutes } from './governanceRoutes.js';
import {
  DEFAULT_RETENTION_POLICY,
  type DataGovernancePort,
  type DeletionResult,
  type RetentionPolicy,
  type RetentionStats,
} from './DataRetention.js';

class FakeGovernance implements DataGovernancePort {
  public policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY };
  public cleanups: boolean[] = [];
  public deletedConversations: string[] = [];
  public deletedUsers: string[] = [];

  getPolicy(): RetentionPolicy {
    return { ...this.policy };
  }

  async updatePolicy(input: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
    if (input.tracesDays !== undefined && input.tracesDays < 1) {
      throw new Error('tracesDays 必须大于 0');
    }
    this.policy = { ...this.policy, ...input };
    return { ...this.policy };
  }

  async stats(): Promise<RetentionStats> {
    return {
      policy: this.getPolicy(),
      now: 1,
      totals: {
        messages: 1,
        summaries: 0,
        traces: 2,
        audit: 3,
        usage: 4,
        attachments: 0,
      },
      expired: {
        messages: 1,
        summaries: 0,
        traces: 0,
        audit: 0,
        usage: 0,
        attachments: 0,
      },
      attachmentBytes: 0,
    };
  }

  async cleanup(input: { dryRun?: boolean } = {}) {
    const dryRun = input.dryRun ?? false;
    this.cleanups.push(dryRun);
    return {
      dryRun,
      startedAt: 1,
      finishedAt: 2,
      deleted: {
        messages: 1,
        summaries: 0,
        traces: 0,
        audit: 0,
        usage: 0,
        attachments: 0,
      },
    };
  }

  async deleteConversation(conversationId: string): Promise<DeletionResult> {
    this.deletedConversations.push(conversationId);
    return {
      target: conversationId,
      deleted: { messages: 3 },
      attachmentsRemoved: 1,
    };
  }

  async deleteUser(staffId: string): Promise<DeletionResult> {
    this.deletedUsers.push(staffId);
    return {
      target: staffId,
      deleted: { messages: 1 },
      attachmentsRemoved: 0,
    };
  }
}

function app(governance: FakeGovernance): Hono {
  const root = new Hono();
  root.route('/', createGovernanceRoutes({ governance }));
  root.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ ok: false, error: error.message }, error.status);
    }
    return c.json({ ok: false, error: error.message }, 500);
  });
  return root;
}

async function post(
  target: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await target.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe('governance routes', () => {
  it('返回保留期与统计', async () => {
    const governance = new FakeGovernance();
    const response = await app(governance).request('/governance');
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.policy).toMatchObject({ tracesDays: 90 });
    expect(body.totals).toMatchObject({ traces: 2 });
  });

  it('更新保留期并拒绝非法值', async () => {
    const governance = new FakeGovernance();
    const ok = await app(governance).request('/governance/retention', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracesDays: 30 }),
    });
    expect(ok.status).toBe(200);
    expect(governance.policy.tracesDays).toBe(30);

    const bad = await app(governance).request('/governance/retention', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracesDays: 0 }),
    });
    expect(bad.status).toBe(400);
  });

  it('清理默认 dry-run，显式传 false 才真正删除', async () => {
    const governance = new FakeGovernance();
    const dry = await post(app(governance), '/governance/cleanup', {});
    expect(dry.status).toBe(200);
    expect(governance.cleanups).toEqual([true]);

    const real = await post(app(governance), '/governance/cleanup', {
      dryRun: false,
    });
    expect(real.status).toBe(200);
    expect(governance.cleanups).toEqual([true, false]);
  });

  it('级联删除必须显式确认', async () => {
    const governance = new FakeGovernance();
    const missing = await post(
      app(governance),
      '/governance/delete-conversation',
      { conversationId: 'cid-1' },
    );
    expect(missing.status).toBe(400);
    expect(governance.deletedConversations).toEqual([]);

    const ok = await post(app(governance), '/governance/delete-conversation', {
      conversationId: 'cid-1',
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(governance.deletedConversations).toEqual(['cid-1']);

    const user = await post(app(governance), '/governance/delete-user', {
      staffId: 'staff-1',
      confirm: true,
    });
    expect(user.status).toBe(200);
    expect(governance.deletedUsers).toEqual(['staff-1']);
  });
});
