import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginRecord, PluginVersionRecord } from '../types/skills-plugins-projects.js';
import type {
  PluginStore,
  PluginUpdate,
  PluginVersionUpdate,
} from './PluginStore.js';
import { PluginError, PluginService } from './PluginService.js';

const roots: string[] = [];
let clock = 1_700_000_000_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix = 'plugin-service-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

class MemoryPluginStore implements PluginStore {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly versions = new Map<string, PluginVersionRecord>();

  private key(pluginId: string, version: string): string {
    return `${pluginId}@${version}`;
  }

  async listPlugins(): Promise<PluginRecord[]> {
    return [...this.plugins.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async getPlugin(id: string): Promise<PluginRecord | null> {
    return this.plugins.get(id) ?? null;
  }

  async insertPlugin(record: PluginRecord): Promise<void> {
    this.plugins.set(record.id, { ...record });
  }

  async updatePlugin(id: string, patch: PluginUpdate): Promise<void> {
    const current = this.plugins.get(id);
    if (!current) return;
    this.plugins.set(id, {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.activeVersion !== undefined
        ? { activeVersion: patch.activeVersion }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.manifest !== undefined ? { manifest: patch.manifest } : {}),
      ...(patch.installedBy !== undefined
        ? { installedBy: patch.installedBy }
        : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      updatedAt: Date.now(),
    });
  }

  async deletePlugin(id: string): Promise<void> {
    this.plugins.delete(id);
    for (const key of [...this.versions.keys()]) {
      if (key.startsWith(`${id}@`)) this.versions.delete(key);
    }
  }

  async listVersions(pluginId: string): Promise<PluginVersionRecord[]> {
    return [...this.versions.values()]
      .filter((item) => item.pluginId === pluginId)
      .sort((a, b) => b.installedAt - a.installedAt);
  }

  async getVersion(
    pluginId: string,
    version: string,
  ): Promise<PluginVersionRecord | null> {
    return this.versions.get(this.key(pluginId, version)) ?? null;
  }

  async insertVersion(record: PluginVersionRecord): Promise<void> {
    this.versions.set(this.key(record.pluginId, record.version), {
      ...record,
    });
  }

  async updateVersion(
    pluginId: string,
    version: string,
    patch: PluginVersionUpdate,
  ): Promise<void> {
    const key = this.key(pluginId, version);
    const current = this.versions.get(key);
    if (!current) return;
    this.versions.set(key, {
      ...current,
      ...(patch.manifest !== undefined ? { manifest: patch.manifest } : {}),
      ...(patch.dir !== undefined ? { dir: patch.dir } : {}),
      ...(patch.checksum !== undefined ? { checksum: patch.checksum } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
  }

  async deleteVersion(pluginId: string, version: string): Promise<void> {
    this.versions.delete(this.key(pluginId, version));
  }
}

const SKILL_MD = (name: string): string => `---
name: ${name}
description: 用于测试的插件技能
version: 0.1.0
when_to_use: 测试插件技能注入时
tags:
  - test
risk: read
---
# 执行步骤

1. 读取上下文
2. 输出结论
`;

async function makePlugin(options: {
  id?: string;
  version?: string;
  name?: string;
  skillName?: string;
  secretRequired?: boolean;
  command?: string;
  serverId?: string;
  withMcp?: boolean;
} = {}): Promise<string> {
  const id = options.id ?? 'com.example.demo';
  const version = options.version ?? '1.0.0';
  const skillName = options.skillName ?? 'demo-skill';
  const dir = await tempDir('plugin-fixture-');
  await mkdir(path.join(dir, 'skills', 'demo'), { recursive: true });
  await writeFile(
    path.join(dir, 'skills', 'demo', 'SKILL.md'),
    SKILL_MD(skillName),
  );
  const withMcp = options.withMcp ?? true;
  const manifest = {
    schemaVersion: 1,
    id,
    name: options.name ?? '示例插件',
    version,
    description: '用于测试的声明式插件',
    engines: { agent: '>=0.1.0' },
    trust: 'declarative',
    skills: ['skills/demo'],
    ...(withMcp
      ? {
          mcpServers: [
            {
              id: options.serverId ?? 'github',
              name: 'GitHub',
              domain: 'code',
              transport: 'stdio',
              endpointOrCommand: options.command ?? 'npx',
              args: ['-y', '@modelcontextprotocol/server-github@0.6.2'],
              envOrHeaders: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
              timeoutMs: 30_000,
              maxResultChars: 8_000,
            },
          ],
          secrets: [
            {
              key: 'GITHUB_TOKEN',
              required: options.secretRequired ?? false,
            },
          ],
        }
      : {}),
    permissions: { network: ['api.github.com'], filesystem: 'none' },
  };
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
  );
  return dir;
}

interface Harness {
  service: PluginService;
  store: MemoryPluginStore;
  pluginsRoot: string;
  env: Record<string, string | undefined>;
  applied: string[][];
  reserve: string[];
  manualServers: string[];
}

async function makeHarness(
  options: {
    env?: Record<string, string | undefined>;
    reserved?: string[];
    manualServers?: string[];
  } = {},
): Promise<Harness> {
  const pluginsRoot = await tempDir('plugin-root-');
  const store = new MemoryPluginStore();
  const env = options.env ?? { GITHUB_TOKEN: 'secret-token' };
  const reserve = options.reserved ?? [];
  const manualServers = options.manualServers ?? [];
  const applied: string[][] = [];
  const service = new PluginService({
    store,
    pluginsRoot,
    agentVersion: '0.1.0',
    env,
    allowedCommands: ['npx', 'node'],
    now: () => {
      clock += 1;
      return clock;
    },
    reservedSkillNames: () => reserve,
    manualMcpServerIds: () => manualServers,
    async onChanged() {
      applied.push(
        (await service.getEnabledMcpServers()).map((server) => server.id),
      );
    },
  });
  return { service, store, pluginsRoot, env, applied, reserve, manualServers };
}

describe('PluginService install', () => {
  it('安装声明式插件并合并技能与 MCP', async () => {
    const h = await makeHarness();
    const fixture = await makePlugin();
    const result = await h.service.install({
      dir: fixture,
      installedBy: 'admin',
    });
    expect(result.plugin.status).toBe('enabled');
    expect(result.plugin.runtimeApplied).toBe(true);
    expect(result.skills).toEqual(['plugin:com.example.demo:demo-skill']);
    expect(result.mcpServers).toEqual([
      'plugin-com-example-demo-github',
    ]);

    const views = await h.service.list();
    expect(views).toHaveLength(1);
    expect(views[0]?.skills[0]).toMatchObject({
      id: 'plugin:com.example.demo:demo-skill',
      enabled: true,
    });
    expect(views[0]?.missingSecrets).toEqual([]);

    const roots = await h.service.getSkillRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      source: 'plugin',
      pluginId: 'com.example.demo',
      pluginVersion: '1.0.0',
    });

    const servers = await h.service.getEnabledMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      id: 'plugin-com-example-demo-github',
      name: '示例插件 / GitHub',
      source: 'plugin',
      pluginId: 'com.example.demo',
      transport: 'stdio',
      timeoutMs: 30_000,
    });
    expect(servers[0]?.envOrHeaders?.GITHUB_TOKEN).toBe('secret-token');
    expect(h.applied.at(-1)).toEqual(['plugin-com-example-demo-github']);
    expect(await readdir(path.join(h.pluginsRoot, 'com.example.demo'))).toContain(
      '1.0.0',
    );
  });

  it('缺少必需密钥时拒绝安装；allowMissingSecrets 时保持禁用', async () => {
    const h = await makeHarness({ env: {} });
    const fixture = await makePlugin({ secretRequired: true });

    const error = await h.service
      .install({ dir: fixture, installedBy: 'admin' })
      .catch((item: unknown) => item);
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).stage).toBe('secrets');
    expect(await h.service.list()).toEqual([]);

    const result = await h.service.install({
      dir: fixture,
      installedBy: 'admin',
      allowMissingSecrets: true,
    });
    expect(result.plugin.status).toBe('disabled');
    expect(result.plugin.missingSecrets).toEqual(['GITHUB_TOKEN']);
    expect(await h.service.getSkillRoots()).toEqual([]);

    await expect(h.service.enable('com.example.demo')).rejects.toMatchObject({
      stage: 'secrets',
    });
    h.env.GITHUB_TOKEN = 'later-token';
    const enabled = await h.service.enable('com.example.demo');
    expect(enabled.status).toBe('enabled');
    expect(enabled.runtimeApplied).toBe(true);
    expect(await h.service.getEnabledMcpServers()).toHaveLength(1);
  });

  it('拒绝手工 MCP、技能名与插件命名空间冲突', async () => {
    const manual = await makeHarness({
      manualServers: ['plugin-com-example-demo-github'],
    });
    await expect(
      manual.service.install({
        dir: await makePlugin(),
        installedBy: 'admin',
      }),
    ).rejects.toMatchObject({ stage: 'conflict' });

    const reserved = await makeHarness({ reserved: ['demo-skill'] });
    await expect(
      reserved.service.install({
        dir: await makePlugin(),
        installedBy: 'admin',
      }),
    ).rejects.toMatchObject({ stage: 'skills' });

    const namespace = await makeHarness();
    await namespace.service.install({
      dir: await makePlugin({ id: 'com.example.demo' }),
      installedBy: 'admin',
    });
    await expect(
      namespace.service.install({
        dir: await makePlugin({
          id: 'com-example-demo',
          version: '1.0.0',
          skillName: 'other-skill',
        }),
        installedBy: 'admin',
      }),
    ).rejects.toMatchObject({ stage: 'conflict' });
  });

  it('同版本覆盖需要 force', async () => {
    const h = await makeHarness();
    const fixture = await makePlugin();
    await h.service.install({ dir: fixture, installedBy: 'admin' });
    await expect(
      h.service.install({ dir: fixture, installedBy: 'admin' }),
    ).rejects.toMatchObject({ stage: 'conflict' });
    const again = await h.service.install({
      dir: fixture,
      installedBy: 'admin',
      force: true,
    });
    expect(again.plugin.activeVersion).toBe('1.0.0');
    expect(await h.service.list()).toHaveLength(1);
  });
});

describe('PluginService lifecycle', () => {
  it('升级、回滚并保留最近两个版本', async () => {
    const h = await makeHarness();
    await h.service.install({
      dir: await makePlugin({ version: '1.0.0' }),
      installedBy: 'admin',
    });
    const upgraded = await h.service.upgrade({
      dir: await makePlugin({ version: '1.1.0' }),
      installedBy: 'admin',
    });
    expect(upgraded.plugin.activeVersion).toBe('1.1.0');
    let versions = await h.service.versions('com.example.demo');
    expect(versions.map((item) => [item.version, item.status])).toEqual([
      ['1.1.0', 'enabled'],
      ['1.0.0', 'superseded'],
    ]);

    await expect(
      h.service.upgrade({
        dir: await makePlugin({ version: '1.1.0' }),
        installedBy: 'admin',
      }),
    ).rejects.toMatchObject({ stage: 'conflict' });

    const rolled = await h.service.rollback('com.example.demo', '1.0.0');
    expect(rolled.activeVersion).toBe('1.0.0');
    expect(rolled.status).toBe('enabled');
    versions = await h.service.versions('com.example.demo');
    expect(versions.map((item) => [item.version, item.status])).toEqual([
      ['1.1.0', 'superseded'],
      ['1.0.0', 'enabled'],
    ]);

    await h.service.upgrade({
      dir: await makePlugin({ version: '1.2.0' }),
      installedBy: 'admin',
    });
    await h.service.upgrade({
      dir: await makePlugin({ version: '1.3.0' }),
      installedBy: 'admin',
    });
    versions = await h.service.versions('com.example.demo');
    expect(versions.map((item) => item.version).sort()).toEqual([
      '1.2.0',
      '1.3.0',
    ]);
    const dirs = await readdir(path.join(h.pluginsRoot, 'com.example.demo'));
    expect(dirs.sort()).toEqual(['1.2.0', '1.3.0']);
  });

  it('禁用后移除技能与 MCP，卸载后进入回收站', async () => {
    const h = await makeHarness();
    await h.service.install({
      dir: await makePlugin(),
      installedBy: 'admin',
    });
    const disabled = await h.service.disable('com.example.demo');
    expect(disabled.status).toBe('disabled');
    expect(await h.service.getSkillRoots()).toEqual([]);
    expect(await h.service.getEnabledMcpServers()).toEqual([]);

    const enabled = await h.service.enable('com.example.demo');
    expect(enabled.status).toBe('enabled');
    expect(await h.service.getSkillRoots()).toHaveLength(1);

    await h.service.uninstall('com.example.demo');
    expect(await h.service.list()).toEqual([]);
    expect(await h.service.getSkillRoots()).toEqual([]);
    await expect(
      readdir(path.join(h.pluginsRoot, 'com.example.demo')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const trash = await readdir(path.join(h.pluginsRoot, '.trash'));
    expect(trash.length).toBe(1);
  });

  it('重启后需要重新应用到运行时', async () => {
    const h = await makeHarness();
    await h.service.install({
      dir: await makePlugin(),
      installedBy: 'admin',
    });
    const restarted = new PluginService({
      store: h.store,
      pluginsRoot: h.pluginsRoot,
      agentVersion: '0.1.0',
      env: h.env,
      allowedCommands: ['npx', 'node'],
      async onChanged() {
        // 模拟连接池应用
      },
    });
    const before = await restarted.list();
    expect(before[0]?.runtimeApplied).toBe(false);
    const applied = await restarted.refreshRuntime({
      type: 'refresh',
      pluginId: '*',
    });
    expect(applied).toBe(true);
    const after = await restarted.list();
    expect(after[0]?.runtimeApplied).toBe(true);
  });
});
