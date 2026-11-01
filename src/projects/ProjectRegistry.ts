import type {
  ProjectMemberContextInput,
  ProjectRecord,
} from '../types/skills-plugins-projects.js';

export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

export function isProjectVisible(
  project: ProjectRecord,
  member: ProjectMemberContextInput,
): boolean {
  if (!project.enabled) return false;
  if (project.visibility === 'team') return true;
  if (member.conversationType !== '1') return false;
  if (project.visibility === 'admin') return member.isAdmin;
  return member.isAdmin || project.ownerStaffIds.includes(member.senderStaffId);
}

/** 群聊中不得返回 private 敏感度项目的代码内容 */
export function canReadProjectContent(
  project: ProjectRecord,
  member: ProjectMemberContextInput,
): boolean {
  return project.sensitivity === 'team' || member.conversationType === '1';
}

export function visibleProjects(
  projects: ProjectRecord[],
  member: ProjectMemberContextInput,
): ProjectRecord[] {
  return projects.filter((project) => isProjectVisible(project, member));
}

export function resolveProject(
  projects: ProjectRecord[],
  ref: string | undefined,
  member: ProjectMemberContextInput,
  defaultProjectId = '',
): ProjectRecord {
  const visible = visibleProjects(projects, member);
  const normalized = (ref ?? '').trim().toLowerCase();
  if (!normalized) {
    const fallbackId = defaultProjectId.trim().toLowerCase();
    if (fallbackId) {
      const fallback = visible.find(
        (project) => project.id.toLowerCase() === fallbackId,
      );
      if (fallback) return fallback;
      throw new ProjectResolutionError(
        `默认项目 ${defaultProjectId} 不存在或当前用户不可见，请明确指定项目`,
      );
    }
    if (visible.length === 1 && visible[0]) return visible[0];
    if (visible.length === 0) {
      throw new ProjectResolutionError('当前没有可见的项目');
    }
    throw new ProjectResolutionError('请指定项目 ID 或别名');
  }
  const matches = visible.filter(
    (project) =>
      project.id.toLowerCase() === normalized ||
      project.name.toLowerCase() === normalized ||
      project.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    throw new ProjectResolutionError(
      `项目引用「${ref}」不唯一：${matches.map((project) => project.id).join('、')}`,
    );
  }
  const partial = visible.filter(
    (project) =>
      project.id.toLowerCase().startsWith(normalized) ||
      project.name.toLowerCase().includes(normalized) ||
      project.aliases.some((alias) =>
        alias.toLowerCase().includes(normalized),
      ),
  );
  if (partial.length === 1 && partial[0]) return partial[0];
  if (partial.length > 1) {
    throw new ProjectResolutionError(
      `项目引用「${ref}」匹配多个项目：${partial
        .map((project) => project.id)
        .join('、')}`,
    );
  }
  throw new ProjectResolutionError(`未找到项目：${ref}`);
}

const CODE_HINT_PATTERN =
  /(?:仓库|项目|代码|源码|实现|模块|架构|部署|接口|函数|类|配置|测试|日志|报错|PR|Issue|commit|分支|依赖)/iu;

export function hasCodeHint(text: string): boolean {
  return CODE_HINT_PATTERN.test(text);
}

/**
 * 按名称/别名命中文本，返回按得分降序的项目；同分视为无法判断并返回空。
 */
export function matchProjectsByText(
  projects: ProjectRecord[],
  text: string,
  member: ProjectMemberContextInput,
): ProjectRecord[] {
  const lower = text.toLowerCase();
  const scored = visibleProjects(projects, member)
    .map((project) => {
      const names = [project.id, project.name, ...project.aliases]
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0);
      let score = 0;
      for (const name of names) {
        if (!lower.includes(name)) continue;
        score += name.length >= 2 ? name.length : 1;
      }
      return { project, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) return [];
  const best = scored[0];
  if (!best) return [];
  const tied = scored.filter((entry) => entry.score === best.score);
  if (tied.length > 1) return [];
  return scored.map((entry) => entry.project);
}
