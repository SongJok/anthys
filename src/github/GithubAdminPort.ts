import type {
  GithubAdminPort,
  GithubAdminStatus,
  GithubConnectionTestResult,
  GithubRepoInfo,
} from '../types/skills-plugins-projects.js';
import { GithubClientError } from './GithubClient.js';

export interface GithubAdminProbe {
  readonly hasToken: boolean;
  repo(
    repoRef: string,
    options?: { fresh?: boolean },
  ): Promise<GithubRepoInfo>;
}

export interface GithubAdminPortOptions {
  /** 进程启动时读到的 GITHUB_ENABLED，不随 .env 文件修改而变化 */
  enabled: boolean;
  client?: GithubAdminProbe;
  /** 扩展项目的动态开关；关闭时 github_* 不会进入工具列表 */
  toolsEnabled?: () => boolean;
  defaultRepo?: () => string | Promise<string>;
  apiBase?: string;
  allowedHosts?: string[];
  cacheTtlSeconds?: number;
  initError?: string;
  now?: () => number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildHint(input: {
  enabled: boolean;
  ready: boolean;
  toolsActive: boolean;
  tokenConfigured: boolean;
  defaultRepo: string;
  defaultRepoError?: string;
  initError?: string;
}): string {
  if (input.initError) {
    return `GitHub 客户端初始化失败：${input.initError}。修正 GITHUB_API_BASE / GITHUB_ALLOWED_HOSTS 后重启进程。`;
  }
  if (!input.enabled) {
    return 'GITHUB_ENABLED=false：GitHub 工具未装配，github_* 不会出现在工具列表；修改 .env 后需重启进程。';
  }
  if (!input.ready) {
    return 'GITHUB_ENABLED=true 但 GitHub 客户端未创建，请查看启动日志中的 github client init failed。';
  }
  if (!input.toolsActive) {
    return 'GitHub 客户端已就绪，但 EXTENSIONS_PROJECTS_ENABLED=false，github_* 工具不会进入工具列表。';
  }
  if (!input.tokenConfigured) {
    return '客户端已就绪，但未配置 GITHUB_TOKEN：可匿名读取公开仓库，代码搜索与更高配额不可用。';
  }
  if (input.defaultRepoError) {
    return `客户端已就绪，但默认项目仓库读取失败：${input.defaultRepoError}`;
  }
  if (!input.defaultRepo) {
    return '客户端已就绪；未设置默认 GitHub 项目，调用 github_* 时需显式传 repo。';
  }
  return `GitHub 工具已就绪，默认仓库：${input.defaultRepo}。`;
}

export function createGithubAdminPort(
  options: GithubAdminPortOptions,
): GithubAdminPort {
  const now = options.now ?? Date.now;
  const apiBase = (options.apiBase ?? 'https://api.github.com').replace(
    /\/+$/u,
    '',
  );
  const allowedHosts = options.allowedHosts ?? [];
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 300;

  const defaultRepoFor = async (): Promise<{
    repo: string;
    error?: string;
  }> => {
    if (!options.client || !options.defaultRepo) return { repo: '' };
    try {
      return { repo: (await options.defaultRepo()).trim() };
    } catch (error) {
      return { repo: '', error: errorText(error) };
    }
  };

  const status = async (): Promise<GithubAdminStatus> => {
    const ready = Boolean(options.client);
    const tokenConfigured = options.client?.hasToken ?? false;
    const toolsActive = ready && (options.toolsEnabled?.() ?? true);
    const resolved = ready ? await defaultRepoFor() : { repo: '' };
    const initError = options.initError?.trim() || undefined;
    const defaultRepoError = resolved.error;
    return {
      enabled: options.enabled,
      ready,
      tokenConfigured,
      providerRegistered: ready,
      toolsActive,
      apiBase,
      allowedHosts,
      cacheTtlSeconds,
      defaultRepo: resolved.repo,
      ...(initError ? { initError } : {}),
      ...(defaultRepoError ? { defaultRepoError } : {}),
      hint: buildHint({
        enabled: options.enabled,
        ready,
        toolsActive,
        tokenConfigured,
        defaultRepo: resolved.repo,
        ...(defaultRepoError ? { defaultRepoError } : {}),
        ...(initError ? { initError } : {}),
      }),
    };
  };

  const test = async (
    repoInput?: string,
  ): Promise<GithubConnectionTestResult> => {
    const checkedAt = now();
    const client = options.client;
    const tokenConfigured = client?.hasToken ?? false;
    const fail = (repo: string, error: string): GithubConnectionTestResult => ({
      ok: false,
      repo,
      checkedAt,
      latencyMs: Math.max(0, now() - checkedAt),
      tokenConfigured,
      error,
    });

    if (!options.enabled) {
      return fail(
        (repoInput ?? '').trim(),
        'GITHUB_ENABLED=false：GitHub 工具未装配；修改 .env 后需重启进程。',
      );
    }
    if (!client) {
      return fail(
        (repoInput ?? '').trim(),
        `GitHub 客户端未就绪：${options.initError?.trim() || '请查看启动日志'}`,
      );
    }

    let repo = (repoInput ?? '').trim();
    if (!repo) {
      const resolved = await defaultRepoFor();
      if (resolved.error) return fail('', `默认项目仓库读取失败：${resolved.error}`);
      repo = resolved.repo;
    }
    if (!repo) {
      return fail('', '未提供 repo，且没有可用的默认 GitHub 项目仓库。');
    }

    try {
      const info = await client.repo(repo, { fresh: true });
      return {
        ok: true,
        repo,
        checkedAt,
        latencyMs: Math.max(0, now() - checkedAt),
        tokenConfigured,
        fullName: info.fullName,
        defaultBranch: info.defaultBranch,
        private: info.private,
      };
    } catch (error) {
      const clientError =
        error instanceof GithubClientError ? error : undefined;
      return {
        ok: false,
        repo,
        checkedAt,
        latencyMs: Math.max(0, now() - checkedAt),
        tokenConfigured,
        ...(clientError?.status !== undefined
          ? { status: clientError.status }
          : {}),
        ...(clientError?.rateLimited ? { rateLimited: true } : {}),
        error: errorText(error),
      };
    }
  };

  return { status, test };
}
