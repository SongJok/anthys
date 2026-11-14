import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  GithubAdminStatus,
  GithubConnectionTestResult,
} from '../../types/skills-plugins-projects.js';
import {
  createGithubRoutes,
  createGithubWebhookRoutes,
} from './githubRoutes.js';
import { bindAdminRequestSecurityContext } from './configRoutes.js';

const NOW = new Date('2026-11-01T10:00:00Z').getTime();

function fakeStatus(): GithubAdminStatus {
  return {
    enabled: true,
    ready: true,
    tokenConfigured: true,
    providerRegistered: true,
    toolsActive: true,
    apiBase: 'https://api.github.com',
    allowedHosts: [],
    cacheTtlSeconds: 300,
    defaultRepo: 'SongJok/anthys',
    hint: 'GitHub 工具已就绪，默认仓库：SongJok/anthys。',
  };
}

function fakeResult(ok: boolean): GithubConnectionTestResult {
  return {
    ok,
    repo: 'SongJok/anthys',
    checkedAt: NOW,
    latencyMs: 32,
    tokenConfigured: true,
    ...(ok
      ? { fullName: 'SongJok/anthys', defaultBranch: 'main', private: true }
      : { error: 'Bad credentials', status: 401 }),
  };
}

function setup(result = fakeResult(true)) {
  const recordAudit = vi.fn(async () => ({}));
  const github = {
    status: vi.fn(async () => fakeStatus()),
    test: vi.fn(async () => result),
  };
  const configCenter = { recordAudit } as unknown as DynamicConfigCenter;
  const app = new Hono();
  // 模拟生产 Admin 中间件绑定安全上下文，webActor 才会采信受信任的操作人头
  app.use('*', async (c, next) => {
    bindAdminRequestSecurityContext(c.req.raw, {
      trustActorHeader: true,
      role: 'admin',
    });
    await next();
  });
  app.route(
    '/api/v1/admin',
    createGithubRoutes({ github, configCenter }),
  );
  return { app, github, recordAudit };
}

describe('GitHub 管理接口', () => {
  it('GET /github/status 返回进程内真实状态', async () => {
    const { app, github } = setup();
    const response = await app.request('/api/v1/admin/github/status');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      status: GithubAdminStatus;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toMatchObject({
      ready: true,
      toolsActive: true,
      defaultRepo: 'SongJok/anthys',
    });
    expect(github.status).toHaveBeenCalledTimes(1);
  });

  it('POST /github/test 透传仓库并写入审计', async () => {
    const { app, github, recordAudit } = setup();
    const response = await app.request('/api/v1/admin/github/test', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-staff-id': 'admin-1',
      },
      body: JSON.stringify({ repo: 'SongJok/anthys' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      result: GithubConnectionTestResult;
    };
    expect(body.ok).toBe(true);
    expect(body.result.latencyMs).toBe(32);
    expect(github.test).toHaveBeenCalledWith('SongJok/anthys');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminStaffId: 'admin-1',
        actionType: 'TEST_GITHUB',
        afterSnapshot: expect.objectContaining({
          repo: 'SongJok/anthys',
          ok: true,
          latencyMs: 32,
        }),
      }),
    );
  });

  it('测试失败仍返回 200 与结构化原因，便于控制台展示', async () => {
    const { app, github } = setup(fakeResult(false));
    const response = await app.request('/api/v1/admin/github/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      result: GithubConnectionTestResult;
    };
    expect(body.ok).toBe(false);
    expect(body.result.error).toBe('Bad credentials');
    expect(github.test).toHaveBeenCalledWith(undefined);
  });

  it('请求体不是 JSON 对象时返回 400', async () => {
    const { app, github } = setup();
    const response = await app.request('/api/v1/admin/github/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(response.status).toBe(400);
    expect(github.test).not.toHaveBeenCalled();
  });
});

describe('GitHub Webhook 验签与事件路由', () => {
  const SECRET = 'whsec_test_secret_123';

  function sign(body: string, secret = SECRET): string {
    return (
      'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    );
  }

  it('未配置 secret 时 fail-closed 返回 503', async () => {
    const prev = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    try {
      const app = new Hono().route(
        '/api/v1/webhooks',
        createGithubWebhookRoutes({ secret: '' }),
      );
      const res = await app.request('/api/v1/webhooks/github', {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(503);
    } finally {
      if (prev !== undefined) process.env.GITHUB_WEBHOOK_SECRET = prev;
    }
  });

  it('签名缺失或篡改时返回 401', async () => {
    const onEvent = vi.fn();
    const app = new Hono().route(
      '/api/v1/webhooks',
      createGithubWebhookRoutes({ secret: SECRET, onEvent }),
    );
    const body = JSON.stringify({ action: 'opened' });
    const badRes = await app.request('/api/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(body, 'wrong-secret'),
      },
      body,
    });
    expect(badRes.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('验签通过后提取 PR 引用并路由至 onEvent', async () => {
    const onEvent = vi.fn(async () => ({
      matchedTasks: [{ task: { id: 'task-1' } as never, subscribers: [] }],
      notificationsSent: 1,
    }));
    const app = new Hono().route(
      '/api/v1/webhooks',
      createGithubWebhookRoutes({ secret: SECRET, onEvent }),
    );
    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'SongJok/anthys', html_url: 'https://github.com/SongJok/anthys' },
      pull_request: {
        number: 88,
        title: 'Optimize DingTalk runtime',
        html_url: 'https://github.com/SongJok/anthys/pull/88',
      },
      sender: { login: 'octocat' },
    });

    const res = await app.request('/api/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'deliv-88',
        'x-hub-signature-256': sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      event: string;
      matchedTaskIds: string[];
      notificationsSent: number;
    };
    expect(json).toMatchObject({
      ok: true,
      event: 'pull_request.opened',
      matchedTaskIds: ['task-1'],
      notificationsSent: 1,
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'github',
        eventType: 'pull_request.opened',
        deliveryId: 'deliv-88',
        refs: [
          { kind: 'url', ref: 'https://github.com/SongJok/anthys/pull/88' },
          { kind: 'issue', ref: 'SongJok/anthys#88' },
        ],
      }),
    );
  });
});
