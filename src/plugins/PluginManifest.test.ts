import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPluginManifest,
  PluginManifestError,
  satisfiesSemverRange,
  type PluginManifestContext,
} from './PluginManifest.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-manifest-'));
  roots.push(dir);
  return dir;
}

const SKILL_MD = `---
name: repo-review
description: 按清单评审仓库
version: 0.1.0
when_to_use: 需要评审 PR 或检查仓库质量时
tags:
  - review
risk: read
---
# 评审步骤

1. 阅读变更
2. 输出结论
`;

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'com.example.demo',
    name: '示例插件',
    version: '1.0.0',
    description: '用于测试的声明式插件',
    engines: { agent: '>=0.1.0' },
    trust: 'declarative',
    ...overrides,
  };
}

async function writePlugin(
  manifest: Record<string, unknown>,
  skill = SKILL_MD,
): Promise<string> {
  const dir = await tempDir();
  await mkdir(path.join(dir, 'skills', 'repo-review'), { recursive: true });
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
  );
  if (skill) {
    await writeFile(path.join(dir, 'skills', 'repo-review', 'SKILL.md'), skill);
  }
  return dir;
}

function context(
  overrides: Partial<PluginManifestContext> = {},
): PluginManifestContext {
  return {
    agentVersion: '0.1.0',
    allowedCommands: ['npx', 'node'],
    env: {},
    ...overrides,
  };
}

describe('satisfiesSemverRange', () => {
  it('支持常见范围', () => {
    expect(satisfiesSemverRange('0.1.0', '>=0.1.0')).toBe(true);
    expect(satisfiesSemverRange('0.1.0', '>=0.2.0')).toBe(false);
    expect(satisfiesSemverRange('1.5.0', '^1.2.3')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfiesSemverRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesSemverRange('1.2.7', '1.2.x')).toBe(true);
    expect(satisfiesSemverRange('0.0.9', '^0.0.1')).toBe(false);
    expect(satisfiesSemverRange('1.9.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemverRange('2.1.0', '^1.0.0 || ^2.0.0')).toBe(true);
  });
});

describe('loadPluginManifest', () => {
  it('解析声明式清单与技能', async () => {
    const dir = await writePlugin(
      baseManifest({
        skills: ['skills/repo-review'],
        mcpServers: [
          {
            id: 'github',
            name: 'GitHub',
            domain: 'code',
            transport: 'stdio',
            endpointOrCommand: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github@0.6.2'],
            envOrHeaders: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
          },
        ],
        secrets: [
          { key: 'GITHUB_TOKEN', required: true, description: '只读令牌' },
        ],
        permissions: { network: ['api.github.com'], filesystem: 'none' },
      }),
    );
    const parsed = await loadPluginManifest(
      dir,
      context({ env: { GITHUB_TOKEN: 'token' } }),
    );
    expect(parsed.manifest.id).toBe('com.example.demo');
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]?.id).toBe('plugin:com.example.demo:repo-review');
    expect(parsed.missingSecrets).toEqual([]);
  });

  it('拒绝非法 JSON 并尽量给出位置', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'plugin.json'), '{ "schemaVersion": 1, }');
    await expect(loadPluginManifest(dir, context())).rejects.toMatchObject({
      stage: 'manifest',
      issues: [
        expect.objectContaining({
          path: 'plugin.json',
          message: expect.stringContaining('JSON 解析失败'),
        }),
      ],
    });
  });

  it('拒绝不满足的 agent 版本范围', async () => {
    const dir = await writePlugin(
      baseManifest({ engines: { agent: '>=0.2.0' } }),
    );
    await expect(
      loadPluginManifest(dir, context({ agentVersion: '0.1.0' })),
    ).rejects.toThrow(/engines\.agent/);
  });

  it('拒绝未声明的技能目录', async () => {
    const dir = await writePlugin(baseManifest());
    await expect(
      loadPluginManifest(dir, context()),
    ).rejects.toMatchObject({ stage: 'skills' });
  });

  it('拒绝与内置技能重名', async () => {
    const dir = await writePlugin(
      baseManifest({ skills: ['skills/repo-review'] }),
    );
    await expect(
      loadPluginManifest(
        dir,
        context({ reservedSkillNames: ['repo-review'] }),
      ),
    ).rejects.toMatchObject({ stage: 'skills' });
  });

  it('拒绝不在白名单的 stdio 命令', async () => {
    const dir = await writePlugin(
      baseManifest({
        mcpServers: [
          {
            id: 'demo',
            name: 'Demo',
            domain: 'general',
            transport: 'stdio',
            endpointOrCommand: 'bash',
          },
        ],
      }),
    );
    await expect(loadPluginManifest(dir, context())).rejects.toMatchObject({
      stage: 'mcp',
    });
  });

  it('拒绝 shell 拼接参数与未声明占位符', async () => {
    const dir = await writePlugin(
      baseManifest({
        mcpServers: [
          {
            id: 'demo',
            name: 'Demo',
            domain: 'general',
            transport: 'stdio',
            endpointOrCommand: 'npx',
            args: ['-y', 'tool;rm -rf /'],
            envOrHeaders: { TOKEN: '${UNDECLARED}' },
          },
        ],
      }),
    );
    const error = await loadPluginManifest(dir, context()).catch(
      (item: unknown) => item,
    );
    expect(error).toBeInstanceOf(PluginManifestError);
    const issues = (error as PluginManifestError).issues;
    expect(issues.some((item) => item.message.includes('shell 元字符'))).toBe(
      true,
    );
    expect(issues.some((item) => item.message.includes('UNDECLARED'))).toBe(
      true,
    );
  });

  it('缺少必需密钥时默认拒绝，allowMissingSecrets 时返回缺失项', async () => {
    const manifest = baseManifest({
      skills: ['skills/repo-review'],
      secrets: [{ key: 'GITHUB_TOKEN', required: true }],
    });
    const dir = await writePlugin(manifest);
    await expect(loadPluginManifest(dir, context())).rejects.toMatchObject({
      stage: 'secrets',
    });
    const parsed = await loadPluginManifest(
      dir,
      context({ allowMissingSecrets: true }),
    );
    expect(parsed.missingSecrets).toEqual(['GITHUB_TOKEN']);
    expect(parsed.warnings.some((item) => item.message.includes('GITHUB_TOKEN'))).toBe(
      true,
    );
  });

  it('拒绝非 none 的文件系统权限和未声明域名', async () => {
    const dir = await writePlugin(
      baseManifest({
        permissions: { network: ['api.example.com'], filesystem: 'read' },
        mcpServers: [
          {
            id: 'remote',
            name: 'Remote',
            domain: 'general',
            transport: 'sse',
            endpointOrCommand: 'https://other.example.com/sse',
          },
        ],
      }),
    );
    const error = await loadPluginManifest(dir, context()).catch(
      (item: unknown) => item,
    );
    expect(error).toBeInstanceOf(PluginManifestError);
    const issues = (error as PluginManifestError).issues;
    expect(
      issues.some((item) => item.path === 'permissions.filesystem'),
    ).toBe(true);
    expect(
      issues.some((item) => item.message.includes('permissions.network')),
    ).toBe(true);
  });

  it('拒绝技能目录逃逸与非法 front matter', async () => {
    const dir = await writePlugin(
      baseManifest({ skills: ['../outside'] }),
    );
    await expect(loadPluginManifest(dir, context())).rejects.toMatchObject({
      stage: 'skills',
    });

    const broken = await writePlugin(
      baseManifest({ skills: ['skills/repo-review'] }),
      '---\nname: BadName\n---\nbody\n',
    );
    await expect(loadPluginManifest(broken, context())).rejects.toMatchObject({
      stage: 'skills',
    });
  });
});
