import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SkillAdminPort,
  SkillAdminView,
  SkillModuleSummary,
} from '../../types/skills-plugins-projects.js';
import { createSkillRoutes } from './skillRoutes.js';

function skill(
  name: string,
  module: string,
  enabled = true,
): SkillAdminView {
  return {
    id: `builtin:${name}`,
    name,
    description: `${name} 说明`,
    version: '1.0.0',
    whenToUse: `当用户要 ${name} 时`,
    tags: [],
    allowedTools: [],
    risk: 'read',
    visibility: 'public',
    source: 'builtin',
    module,
    dir: `/skills/builtin/${module}/${name}`,
    body: '# body',
    bodyHash: 'hash',
    maxInstructionChars: 4_000,
    enabled,
    resources: [],
    lastUsedAt: null,
    uses: 0,
  };
}

function setup(items: SkillAdminView[], modules: SkillModuleSummary[]) {
  const port = {
    list: vi.fn(async () => items),
    listModules: vi.fn(async () => modules),
    reload: vi.fn(async () => ({ loaded: items.length, errors: [] })),
    setEnabled: vi.fn(async () => items[0]!),
    preview: vi.fn(async () => ({ prompt: '', entries: [], truncated: false })),
    readResource: vi.fn(async () => ({
      skillId: items[0]!.id,
      path: 'SKILL.md',
      content: '',
      totalLines: 0,
      truncated: false,
    })),
  };
  const app = createSkillRoutes({ skills: port as unknown as SkillAdminPort });
  return { app, port };
}

const ITEMS = [
  skill('data-analysis', 'data'),
  skill('data-insight', 'data', false),
  skill('repo-review', 'engineering'),
];
const MODULES = [
  { module: 'data', total: 2, enabled: 1, sources: ['builtin'] },
  { module: 'engineering', total: 1, enabled: 1, sources: ['builtin'] },
] satisfies SkillModuleSummary[];

afterEach(() => {
  vi.clearAllMocks();
});

describe('技能模块接口', () => {
  it('GET /skills 支持 module 过滤，可与 source/enabled 叠加', async () => {
    const { app } = setup(ITEMS, MODULES);
    const response = await app.request('/skills?module=data');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      skills: SkillAdminView[];
    };
    expect(body.total).toBe(2);
    expect(body.skills.every((item) => item.module === 'data')).toBe(true);

    const enabledOnly = await app.request('/skills?module=data&enabled=true');
    const enabledBody = (await enabledOnly.json()) as {
      skills: SkillAdminView[];
    };
    expect(enabledBody.skills.map((item) => item.name)).toEqual(['data-analysis']);
  });

  it('GET /skills/modules 返回分组汇总，不会被 /skills/:id 吃掉', async () => {
    const { app, port } = setup(ITEMS, MODULES);
    const response = await app.request('/skills/modules');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      total: number;
      modules: SkillModuleSummary[];
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.modules).toEqual(MODULES);
    expect(port.listModules).toHaveBeenCalledTimes(1);
    // 计数来自服务端汇总：停用的技能算在 total 里，不算在 enabled 里
    expect(body.modules[0]).toMatchObject({ total: 2, enabled: 1 });
  });

  it('GET /skills/:id 仍能取到技能详情', async () => {
    const { app } = setup(ITEMS, MODULES);
    const response = await app.request('/skills/builtin%3Arepo-review');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skill: SkillAdminView };
    expect(body.skill.name).toBe('repo-review');
  });
});
