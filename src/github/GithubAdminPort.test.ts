import { describe, expect, it, vi } from 'vitest';
import { GithubClientError } from './GithubClient.js';
import { createGithubAdminPort, type GithubAdminProbe } from './GithubAdminPort.js';
import type { GithubRepoInfo } from '../types/skills-plugins-projects.js';

function info(fullName = 'SongJok/anthys'): GithubRepoInfo {
  const [owner = 'SongJok', name = 'anthys'] = fullName.split('/');
  return {
    owner,
    name,
    fullName,
    description: '钉钉智能体',
    defaultBranch: 'main',
    private: true,
    htmlUrl: `https://github.com/${fullName}`,
    stars: 12,
    updatedAt: '2026-11-01T00:00:00Z',
    topics: ['dingtalk'],
    language: 'TypeScript',
    license: 'MIT',
  };
}

function probe(hasToken = true): GithubAdminProbe & {
  repo: ReturnType<typeof vi.fn>;
} {
  return {
    hasToken,
    repo: vi.fn(async () => info()),
  };
}

describe('GithubAdminPort', () => {
  it('未开启时明确说明工具未装配，且不发起请求', async () => {
    const client = probe();
    const port = createGithubAdminPort({ enabled: false, client });
    const status = await port.status();
    expect(status).toMatchObject({
      enabled: false,
      ready: true,
      toolsActive: true,
    });
    expect(status.hint).toContain('GITHUB_ENABLED=false');

    const result = await port.test('SongJok/anthys');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('重启');
    expect(client.repo).not.toHaveBeenCalled();
  });

  it('就绪时输出 Token、默认仓库与动态项目开关状态', async () => {
    const client = probe(true);
    const port = createGithubAdminPort({
      enabled: true,
      client,
      defaultRepo: () => 'SongJok/anthys',
      apiBase: 'https://api.github.com',
      allowedHosts: ['ghe.example.com'],
      cacheTtlSeconds: 120,
      toolsEnabled: () => true,
    });
    const status = await port.status();
    expect(status).toMatchObject({
      enabled: true,
      ready: true,
      tokenConfigured: true,
      providerRegistered: true,
      toolsActive: true,
      apiBase: 'https://api.github.com',
      allowedHosts: ['ghe.example.com'],
      cacheTtlSeconds: 120,
      defaultRepo: 'SongJok/anthys',
    });
    expect(status.hint).toContain('已就绪');
    expect(status.initError).toBeUndefined();
  });

  it('项目开关关闭或缺少 Token 时如实给出降级原因', async () => {
    const noToken = createGithubAdminPort({
      enabled: true,
      client: probe(false),
      defaultRepo: () => 'SongJok/anthys',
      toolsEnabled: () => true,
    });
    expect((await noToken.status()).hint).toContain('GITHUB_TOKEN');

    const toolsOff = createGithubAdminPort({
      enabled: true,
      client: probe(true),
      defaultRepo: () => 'SongJok/anthys',
      toolsEnabled: () => false,
    });
    const status = await toolsOff.status();
    expect(status.toolsActive).toBe(false);
    expect(status.hint).toContain('EXTENSIONS_PROJECTS_ENABLED=false');
  });

  it('客户端未创建时返回初始化错误而不是伪装为已就绪', async () => {
    const port = createGithubAdminPort({
      enabled: true,
      initError: 'GITHUB_API_BASE 主机不在白名单内：ghe.example.com',
    });
    const status = await port.status();
    expect(status).toMatchObject({
      enabled: true,
      ready: false,
      providerRegistered: false,
      toolsActive: false,
    });
    expect(status.initError).toContain('白名单');
    expect(status.hint).toContain('初始化失败');

    const result = await port.test();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('白名单');
  });

  it('默认仓库读取失败或缺失时给出可执行提示', async () => {
    const readError = createGithubAdminPort({
      enabled: true,
      client: probe(),
      defaultRepo: () => {
        throw new Error('数据库不可用');
      },
    });
    const failedStatus = await readError.status();
    expect(failedStatus.defaultRepoError).toContain('数据库不可用');
    expect(failedStatus.hint).toContain('数据库不可用');
    const failedTest = await readError.test();
    expect(failedTest.ok).toBe(false);
    expect(failedTest.error).toContain('默认项目仓库读取失败');

    const noDefault = createGithubAdminPort({
      enabled: true,
      client: probe(),
      defaultRepo: () => '',
    });
    expect((await noDefault.status()).hint).toContain('需显式传 repo');
    expect((await noDefault.test()).error).toContain('没有可用的默认');
  });

  it('连通性测试强制绕过缓存并返回仓库信息与延迟', async () => {
    let clock = 1_000;
    const client = probe();
    client.repo.mockImplementation(async () => {
      clock += 42;
      return info();
    });
    const port = createGithubAdminPort({
      enabled: true,
      client,
      now: () => clock,
    });
    const result = await port.test('SongJok/anthys');
    expect(result).toMatchObject({
      ok: true,
      repo: 'SongJok/anthys',
      fullName: 'SongJok/anthys',
      defaultBranch: 'main',
      private: true,
      tokenConfigured: true,
      latencyMs: 42,
      checkedAt: 1_000,
    });
    expect(client.repo).toHaveBeenCalledWith('SongJok/anthys', { fresh: true });
  });

  it('测试失败时保留状态码与限流标记', async () => {
    const client = probe();
    client.repo.mockRejectedValue(
      new GithubClientError(
        'GitHub API 触发限流，恢复时间：2026-11-01T00:00:00Z',
        403,
        true,
      ),
    );
    const port = createGithubAdminPort({ enabled: true, client });
    const failed = await port.test('SongJok/anthys');
    expect(failed).toMatchObject({
      ok: false,
      repo: 'SongJok/anthys',
      status: 403,
      rateLimited: true,
    });
    expect(failed.error).toContain('限流');
  });
});
