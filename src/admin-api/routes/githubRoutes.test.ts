import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  GithubAdminStatus,
  GithubConnectionTestResult,
} from '../../types/skills-plugins-projects.js';
import { createGithubRoutes } from './githubRoutes.js';

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
  const app = new Hono().route(
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
