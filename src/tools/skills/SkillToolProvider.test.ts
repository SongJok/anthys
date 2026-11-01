import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillService } from '../../skills/SkillService.js';
import { SkillToolProvider } from './SkillToolProvider.js';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';

const tempDirs: string[] = [];

function context(): ExecutionContext {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '测试',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: () => Date.now(),
  };
}

async function pluginSkillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-skills-'));
  tempDirs.push(root);
  const dir = path.join(root, 'review');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'name: plugin-review',
      'description: 插件提供的评审技能',
      'version: 1.2.0',
      'when_to_use: 当用户要求插件评审时',
      '---',
      '',
      '# 插件评审',
      '',
      '1. 按插件流程执行',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('SkillToolProvider', () => {
  it('use_skill 通过 instructions 返回受信任正文', async () => {
    const service = new SkillService({
      roots: [{ source: 'builtin', dir: path.resolve('skills/builtin') }],
    });
    await service.init();
    const provider = new SkillToolProvider({
      service,
      isAdmin: () => false,
    });
    const tools = await provider.getTools(context());
    const output = await toolByName(tools, 'use_skill').executeStructured?.(
      { name: 'repo-review' },
      context(),
    );
    expect(output?.instructions).toEqual([
      expect.objectContaining({
        id: 'builtin:repo-review',
        source: 'skill',
        trust: 'admin',
      }),
    ]);
    expect(output?.instructions?.[0]?.text).toContain('# 仓库与 PR 工程评审');
  });

  it('插件技能使用 plugin-skill / plugin 信任标记', async () => {
    const root = await pluginSkillRoot();
    const service = new SkillService({
      roots: [{ source: 'plugin', pluginId: 'github-assistant', dir: root }],
    });
    await service.init();
    const provider = new SkillToolProvider({ service, isAdmin: () => false });
    const tools = await provider.getTools(context());
    const output = await toolByName(tools, 'use_skill').executeStructured?.(
      { name: 'plugin-review' },
      context(),
    );
    expect(output?.instructions?.[0]).toMatchObject({
      id: 'plugin:github-assistant:plugin-review',
      source: 'plugin-skill',
      trust: 'plugin',
    });
  });

  it('skill_search 返回匹配技能但不泄露正文', async () => {
    const service = new SkillService({
      roots: [{ source: 'builtin', dir: path.resolve('skills/builtin') }],
    });
    await service.init();
    const provider = new SkillToolProvider({ service, isAdmin: () => false });
    const tools = await provider.getTools(context());
    const text = await toolByName(tools, 'skill_search').execute(
      { query: '评审仓库', limit: 3 },
      context(),
    );
    expect(text).toContain('repo-review');
    expect(text).toContain('适用：');
    expect(text).not.toContain('# 仓库与 PR 工程评审');
  });

  it('skill_read 返回分段内容且不产生 instructions', async () => {
    const service = new SkillService({
      roots: [{ source: 'builtin', dir: path.resolve('skills/builtin') }],
    });
    await service.init();
    const provider = new SkillToolProvider({ service, isAdmin: () => false });
    const tools = await provider.getTools(context());
    const tool = toolByName(tools, 'skill_read');
    const text = await tool.execute(
      {
        name: 'code-reading',
        path: 'SKILL.md',
        startLine: 1,
        endLine: 3,
      },
      context(),
    );
    expect(text).toContain('[skill:builtin:code-reading SKILL.md L1-L3');
    expect(text).toContain('name: code-reading');
  });

  it('普通用户加载 admin 技能会被拒绝', async () => {
    const service = new SkillService({
      roots: [{ source: 'builtin', dir: path.resolve('skills/builtin') }],
    });
    await service.init();
    const provider = new SkillToolProvider({ service, isAdmin: () => false });
    const tools = await provider.getTools(context());
    await expect(
      toolByName(tools, 'use_skill').executeStructured?.(
        { name: 'handbook-maintainer' },
        context(),
      ),
    ).rejects.toThrow('仅管理员');
  });
});
