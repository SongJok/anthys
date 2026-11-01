import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord } from '../types/skills-plugins-projects.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 180_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export class ProjectSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectSourceError';
  }
}

export interface PreparedRepo {
  root: string;
  commit: string;
  branch: string;
  kind: 'local' | 'github';
}

export interface RepoSourceLogger {
  warn(obj: Record<string, unknown>, message: string): void;
}

export interface RepoSourceOptions {
  /** 本地项目允许的根目录；为空时默认只允许进程工作目录 */
  allowedRoots: string[];
  /** GitHub 镜像根目录，通常是 <workspace>/.state/projects */
  stateDir: string;
  now?: () => number;
  logger?: RepoSourceLogger;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function sanitizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/^\/+/u, '');
  if (
    normalized.length === 0 ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new ProjectSourceError(`非法路径：${value}`);
  }
  return normalized;
}

async function runGit(
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    });
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof error === 'object' && error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    const message =
      error instanceof Error ? error.message : String(error);
    throw new GitCommandError(`git ${args[0] ?? ''} 失败：${message}`, stderr);
  }
}

export class RepoSource {
  private readonly allowedRoots: string[];
  private readonly stateDir: string;
  private readonly now: () => number;
  private readonly logger?: RepoSourceLogger;

  constructor(options: RepoSourceOptions) {
    this.allowedRoots =
      options.allowedRoots.length > 0
        ? options.allowedRoots
        : [process.cwd()];
    this.stateDir = options.stateDir;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  public async prepare(project: ProjectRecord): Promise<PreparedRepo> {
    if (project.source.type === 'manual') {
      throw new ProjectSourceError('manual 项目没有代码仓库，无需同步');
    }
    if (project.source.type === 'github') {
      return this.prepareGithub(project);
    }
    return this.prepareLocal(project);
  }

  /** 创建项目时只校验本地路径边界，不读取 Git */
  public async assertLocalPathAllowed(sourcePath: string): Promise<string> {
    const candidate = await realpath(sourcePath).catch(() => {
      throw new ProjectSourceError(`本地路径不存在：${sourcePath}`);
    });
    const info = await stat(candidate);
    if (!info.isDirectory()) {
      throw new ProjectSourceError(`本地路径不是目录：${candidate}`);
    }
    const roots = await Promise.all(
      this.allowedRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return null;
        }
      }),
    );
    const allowed = roots.some(
      (root) => root !== null && isInside(root, candidate),
    );
    if (!allowed) {
      throw new ProjectSourceError(
        `本地路径不在 PROJECT_ALLOWED_ROOTS 内：${candidate}`,
      );
    }
    return candidate;
  }

  /** 不 fetch 的 HEAD 读取，用于 stale 检测 */
  public async peekHead(project: ProjectRecord): Promise<string | null> {
    if (project.source.type === 'manual') return null;
    let root: string;
    try {
      root = await this.rootFor(project);
    } catch {
      return null;
    }
    try {
      return await runGit(root, ['rev-parse', 'HEAD'], 10_000);
    } catch {
      return null;
    }
  }

  /** 只解析已有仓库根目录，不 clone/fetch */
  public async rootFor(project: ProjectRecord): Promise<string> {
    if (project.source.type === 'local') {
      return this.assertLocalPathAllowed(project.source.path);
    }
    if (project.source.type === 'github') {
      const mirror = path.join(this.stateDir, project.id, 'mirror');
      const info = await stat(path.join(mirror, '.git')).catch(() => null);
      if (!info) {
        throw new ProjectSourceError(
          `GitHub 镜像尚未克隆，请先同步项目：${project.id}`,
        );
      }
      return mirror;
    }
    throw new ProjectSourceError('manual 项目没有代码仓库');
  }

  private async prepareLocal(project: ProjectRecord): Promise<PreparedRepo> {
    if (project.source.type !== 'local') {
      throw new ProjectSourceError('项目来源不是 local');
    }
    const candidate = await this.assertLocalPathAllowed(project.source.path);
    let commit: string;
    let branch: string;
    try {
      commit = await runGit(candidate, ['rev-parse', 'HEAD'], 10_000);
      branch = await runGit(
        candidate,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        10_000,
      );
    } catch {
      commit = `local-${this.now()}`;
      branch = 'local';
      this.logger?.warn(
        { projectId: project.id },
        'local project is not a git repository, using synthetic commit',
      );
    }
    return { root: candidate, commit, branch, kind: 'local' };
  }

  private async prepareGithub(project: ProjectRecord): Promise<PreparedRepo> {
    if (project.source.type !== 'github') {
      throw new ProjectSourceError('项目来源不是 github');
    }
    const repo = project.source.repo.trim();
    if (!GITHUB_REPO_PATTERN.test(repo)) {
      throw new ProjectSourceError(`GitHub 仓库格式应为 owner/name：${repo}`);
    }
    const depth = Math.min(Math.max(project.source.depth ?? 1, 1), 50);
    const branch = project.source.ref ?? project.defaultBranch ?? 'main';
    const mirror = path.join(this.stateDir, project.id, 'mirror');
    const url = `https://github.com/${repo}.git`;
    await mkdir(path.dirname(mirror), { recursive: true });
    const exists = await stat(mirror).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!exists) {
      await runGit(path.dirname(mirror), [
        'clone',
        '--depth',
        String(depth),
        '--single-branch',
        '--branch',
        branch,
        url,
        mirror,
      ]);
    } else {
      const hasGit = await stat(path.join(mirror, '.git')).then(
        () => true,
        () => false,
      );
      if (!hasGit) {
        throw new ProjectSourceError(
          `GitHub 镜像目录已存在但不是 Git 仓库：${mirror}`,
        );
      }
      await runGit(mirror, ['remote', 'set-url', 'origin', url]);
      await runGit(mirror, [
        'fetch',
        '--depth',
        String(depth),
        'origin',
        branch,
      ]);
      await runGit(mirror, ['checkout', '--force', 'FETCH_HEAD']);
    }
    const commit = await runGit(mirror, ['rev-parse', 'HEAD']);
    return { root: mirror, commit, branch, kind: 'github' };
  }

  public async log(
    root: string,
    options: { path?: string; limit?: number } = {},
  ): Promise<Array<{ sha: string; author: string; date: string; subject: string }>> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 30);
    const args = [
      'log',
      '--no-decorate',
      '--date=short',
      '--pretty=format:%h%x09%an%x09%ad%x09%s',
      '-n',
      String(limit),
    ];
    if (options.path) {
      args.push('--', sanitizeRelativePath(options.path));
    }
    try {
      const output = await runGit(root, args, 20_000);
      if (!output) return [];
      return output.split('\n').map((line) => {
        const [sha = '', author = '', date = '', ...subject] =
          line.split('\t');
        return { sha, author, date, subject: subject.join('\t') };
      });
    } catch (error) {
      if (error instanceof GitCommandError && /does not have any commits/iu.test(error.stderr)) {
        return [];
      }
      throw error;
    }
  }

  public async hasFullHistory(root: string): Promise<boolean> {
    try {
      const shallow = await runGit(root, ['rev-parse', '--is-shallow-repository'], 10_000);
      return shallow === 'false';
    } catch {
      return false;
    }
  }
}
