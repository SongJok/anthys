import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSimpleYaml,
  parseSkillMarkdown,
  SkillRegistry,
  splitFrontmatter,
} from './SkillRegistry.js';

const tempDirs: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  root: string,
  name: string,
  options: {
    version?: string;
    body?: string;
    description?: string;
    nameField?: string;
  } = {},
): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${options.nameField ?? name}`,
      `description: ${options.description ?? '测试技能描述'}`,
      `version: ${options.version ?? '1.0.0'}`,
      'when_to_use: 当用户测试技能时',
      'tags:',
      '  - test',
      '  - demo',
      'allowed_tools: [tool_a, tool_b]',
      'risk: read',
      'visibility: public',
      'max_instruction_chars: 4000',
      '---',
      '',
      options.body ?? '# 测试技能\n\n## 步骤\n1. 执行测试',
      '',
    ].join('\n'),
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('skill front matter', () => {
  it('解析行内数组、缩进数组与块标量', () => {
    const parsed = parseSimpleYaml(
      [
        'name: demo',
        'tags:',
        '  - a',
        '  - "b"',
        'allowed_tools: [x, y]',
        'when_to_use: |',
        '  第一行',
        '  第二行',
      ].join('\n'),
    );
    expect(parsed).toMatchObject({
      name: 'demo',
      tags: ['a', 'b'],
      allowed_tools: ['x', 'y'],
      when_to_use: '第一行\n第二行',
    });
  });

  it('去除 BOM 并拒绝缺少 front matter 的文件', () => {
    const raw = `\uFEFF---\nname: demo\ndescription: 描述\nversion: 1.0.0\nwhen_to_use: 测试\n---\n正文`;
    expect(splitFrontmatter(raw)?.body).toBe('正文');
    expect(() => parseSkillMarkdown('没有 front matter', 'demo')).toThrow(
      'front matter',
    );
  });

  it('校验必填字段与语义化版本', () => {
    expect(() =>
      parseSkillMarkdown(
        '---\nname: demo\ndescription: 描述\nversion: 1.0\nwhen_to_use: 测试\n---\n正文',
        'demo',
      ),
    ).toThrow('语义化版本');
    expect(() =>
      parseSkillMarkdown(
        '---\nname: Demo\ndescription: 描述\nversion: 1.0.0\nwhen_to_use: 测试\n---\n正文',
        'Demo',
      ),
    ).toThrow('技能 name');
  });
});

describe('SkillRegistry', () => {
  it('扫描内置技能，全部通过校验', async () => {
    const registry = new SkillRegistry({
      roots: [{ source: 'builtin', dir: path.resolve('skills/builtin') }],
    });
    const definitions = await registry.scan();
    expect(definitions.map((item) => item.name).sort()).toEqual([
      'code-reading',
      'data-analysis',
      'data-insight',
      'dingtalk-office',
      'enterprise-lens',
      'everyday-chat',
      'github-project-scan',
      'handbook-maintainer',
      'incident-triage',
      'link-reader',
      'meeting-notes',
      'office-docs',
      'plugin-author',
      'presentation-brief',
      'project-docs',
      'project-onboarding',
      'repo-review',
      'research-brief',
      'skill-author',
      'work-report',
    ]);
    expect(definitions.every((item) => !item.loadError)).toBe(true);
    expect(definitions.every((item) => item.body.length > 0)).toBe(true);
  });

  it('同名技能跨来源时标记冲突而不是静默覆盖', async () => {
    const builtinRoot = await makeRoot();
    const localRoot = await makeRoot();
    await writeSkill(builtinRoot, 'demo');
    await writeSkill(localRoot, 'demo');
    const registry = new SkillRegistry({
      roots: [
        { source: 'builtin', dir: builtinRoot },
        { source: 'local', dir: localRoot },
      ],
    });
    const definitions = await registry.scan();
    expect(definitions).toHaveLength(2);
    expect(definitions.every((item) => item.loadError?.includes('名称冲突'))).toBe(
      true,
    );
  });

  it('损坏的技能记录 loadError，不影响其他技能', async () => {
    const root = await makeRoot();
    await writeSkill(root, 'good');
    const badDir = path.join(root, 'bad');
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, 'SKILL.md'), 'no front matter', 'utf8');
    const registry = new SkillRegistry({
      roots: [{ source: 'local', dir: root }],
    });
    const definitions = await registry.scan();
    const bad = definitions.find((item) => item.name === 'bad');
    expect(bad?.loadError).toContain('front matter');
    expect(definitions.find((item) => item.name === 'good')?.loadError).toBeUndefined();
  });
});
