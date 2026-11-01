import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '../types/skills-plugins-projects.js';
import {
  canReadProjectContent,
  hasCodeHint,
  isProjectVisible,
  matchProjectsByText,
  ProjectResolutionError,
  resolveProject,
} from './ProjectRegistry.js';

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'anthys',
    name: '钉钉智能体',
    aliases: ['dingtalk-agent', 'anthys-bot'],
    description: '',
    source: { type: 'manual' },
    defaultBranch: 'main',
    ownerStaffIds: ['owner-1'],
    visibility: 'team',
    sensitivity: 'team',
    isDefault: false,
    enabled: true,
    autoSyncMinutes: 0,
    lastCommit: '',
    handbookVersion: 0,
    ...overrides,
  };
}

const employee = {
  senderStaffId: 'user-1',
  isAdmin: false,
  conversationType: '2',
} as const;
const adminSingle = {
  senderStaffId: 'admin-1',
  isAdmin: true,
  conversationType: '1',
} as const;

describe('项目解析与可见性', () => {
  it('按 ID、名称、别名解析项目', () => {
    const projects = [project()];
    expect(resolveProject(projects, 'anthys', employee).id).toBe('anthys');
    expect(resolveProject(projects, '钉钉智能体', employee).id).toBe('anthys');
    expect(resolveProject(projects, 'dingtalk-agent', employee).id).toBe('anthys');
  });

  it('引用不唯一时报错，无法判断时不猜测', () => {
    const projects = [
      project(),
      project({ id: 'other', name: '其他项目', aliases: ['dingtalk-agent'] }),
    ];
    expect(() => resolveProject(projects, 'dingtalk-agent', employee)).toThrow(
      ProjectResolutionError,
    );
  });

  it('默认项目只在可见时使用，否则要求明确指定', () => {
    const projects = [project(), project({ id: 'other', name: '其他' })];
    expect(resolveProject(projects, undefined, employee, 'anthys').id).toBe(
      'anthys',
    );
    expect(() =>
      resolveProject(projects, undefined, employee, 'missing'),
    ).toThrow(/默认项目/u);
    expect(() => resolveProject(projects, undefined, employee)).toThrow(
      /请指定项目/u,
    );
  });

  it('private 项目只在单聊对管理员或负责人可见', () => {
    const privateProject = project({ visibility: 'private' });
    expect(isProjectVisible(privateProject, employee)).toBe(false);
    expect(
      isProjectVisible(privateProject, {
        senderStaffId: 'owner-1',
        isAdmin: false,
        conversationType: '1',
      }),
    ).toBe(true);
    expect(
      isProjectVisible(privateProject, {
        senderStaffId: 'user-1',
        isAdmin: false,
        conversationType: '2',
      }),
    ).toBe(false);
  });

  it('admin 项目只对管理员单聊可见，禁用项目不可见', () => {
    const adminProject = project({ visibility: 'admin' });
    expect(isProjectVisible(adminProject, employee)).toBe(false);
    expect(isProjectVisible(adminProject, adminSingle)).toBe(true);
    expect(isProjectVisible(project({ enabled: false }), adminSingle)).toBe(false);
  });

  it('private 敏感度在群聊中不允许读取代码内容', () => {
    const sensitive = project({ sensitivity: 'private' });
    expect(canReadProjectContent(sensitive, employee)).toBe(false);
    expect(
      canReadProjectContent(sensitive, {
        senderStaffId: 'user-1',
        isAdmin: false,
        conversationType: '1',
      }),
    ).toBe(true);
  });

  it('按文本命中项目别名，同分视为无法判断', () => {
    const projects = [project()];
    expect(matchProjectsByText(projects, '帮我看下 anthys 的部署', employee)).toHaveLength(1);
    const tied = [
      project(),
      project({ id: 'other', name: '钉钉智能体2', aliases: ['dingtalk-agent'] }),
    ];
    expect(matchProjectsByText(tied, 'dingtalk-agent', employee)).toEqual([]);
  });

  it('识别代码类问题关键词', () => {
    expect(hasCodeHint('这个仓库怎么部署')).toBe(true);
    expect(hasCodeHint('今天天气怎么样')).toBe(false);
  });
});
