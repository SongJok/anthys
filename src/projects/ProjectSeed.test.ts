import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../types/skills-plugins-projects.js';
import type { ProjectService } from './ProjectService.js';
import { seedProjectsFromRoot } from './ProjectSeed.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anthys-seed-'));
  roots.push(root);
  return root;
}

function fakeService(existing: ProjectRecord | null = null) {
  const imported: Array<{ projectId: string; count: number; tag: string }> = [];
  const service = {
    getProject: vi.fn(async () => existing),
    createProject: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      aliases: input['aliases'] ?? [],
      lastCommit: '',
      handbookVersion: 0,
      lastError: '',
    })),
    importManualEntries: vi.fn(
      async (
        projectId: string,
        entries: unknown[],
        tag: string,
      ) => {
        imported.push({ projectId, count: entries.length, tag });
        return { created: entries.length, updated: 0, skipped: 0 };
      },
    ),
  };
  return { service: service as unknown as ProjectService, serviceMock: service, imported };
}

async function writeProject(
  root: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, 'anthys');
  await mkdir(join(dir, 'manual'), { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, 'manual', name), content);
  }
  return dir;
}

describe('ProjectSeed', () => {
  it('按清单创建项目并导入 manual 目录的 Markdown', async () => {
    const root = await makeRoot();
    await writeProject(
      root,
      {
        id: 'anthys',
        name: '钉钉智能体',
        aliases: ['anthys'],
        description: '企业知识助手',
        source: { type: 'local', path: '.', branch: 'main' },
        default: true,
        visibility: 'team',
        autoSyncMinutes: 30,
      },
      {
        'overview.md': '# 项目概览\n\n定位说明。\n',
        'faq.md': '# 常见问题\n\n怎么换模型？\n',
        'owners.md': '# 负责人\n\n待填写。\n',
        'unknown.md': '忽略未知章节',
      },
    );
    const { service, serviceMock, imported } = fakeService();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const results = await seedProjectsFromRoot({ service, root, logger });

    expect(results).toHaveLength(1);
    expect(serviceMock.createProject).toHaveBeenCalledTimes(1);
    expect(serviceMock.createProject.mock.calls[0]?.[0]).toMatchObject({
      id: 'anthys',
      name: '钉钉智能体',
      source: { type: 'local', path: '.', branch: 'main' },
      isDefault: true,
      autoSyncMinutes: 30,
    });
    expect(imported).toEqual([
      { projectId: 'anthys', count: 3, tag: 'seed:projects/manual' },
    ]);
    const entries = serviceMock.importManualEntries.mock.calls[0]?.[1] as Array<
      Record<string, unknown>
    >;
    expect(entries.map((entry) => entry['section'])).toEqual([
      'faq',
      'overview',
      'operations',
    ]);
    expect(entries[1]).toMatchObject({
      title: '项目概览',
      injectToBrief: true,
      priority: 10,
    });
    expect(results[0]).toMatchObject({
      projectId: 'anthys',
      projectCreated: true,
    });
    expect(logger.info).toHaveBeenCalled();
  });

  it('已存在的项目不覆盖登记配置，但继续同步种子条目', async () => {
    const root = await makeRoot();
    await writeProject(
      root,
      { id: 'anthys', name: '新名字', source: { type: 'local', path: '.' } },
      { 'overview.md': '# 概览\n\n内容\n' },
    );
    const existing = {
      id: 'anthys',
      name: '控制台改过的名字',
    } as ProjectRecord;
    const { service, serviceMock, imported } = fakeService(existing);
    const results = await seedProjectsFromRoot({ service, root });
    expect(serviceMock.createProject).not.toHaveBeenCalled();
    expect(imported).toHaveLength(1);
    expect(results[0]?.projectCreated).toBe(false);
  });

  it('清单缺失、非法 JSON 或缺字段时跳过并记录告警', async () => {
    const root = await makeRoot();
    await writeProject(root, { name: '没有 id' }, {});
    const invalidDir = join(root, 'invalid');
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(invalidDir, 'project.json'), '{not-json');
    const logs = { info: vi.fn(), warn: vi.fn() };
    const { service, serviceMock } = fakeService();
    const results = await seedProjectsFromRoot({
      service,
      root,
      logger: logs,
    });
    expect(results).toEqual([]);
    expect(serviceMock.createProject).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledTimes(2);
  });

  it('seed 根目录不存在时静默返回空列表', async () => {
    const { service } = fakeService();
    await expect(
      seedProjectsFromRoot({
        service,
        root: join(tmpdir(), 'anthys-seed-missing-directory'),
      }),
    ).resolves.toEqual([]);
  });
});
