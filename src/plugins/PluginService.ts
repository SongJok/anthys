import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SkillScanRoot } from '../skills/SkillRegistry.js';
import { parseSkillMarkdown } from '../skills/SkillRegistry.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import type {
  PluginAdminView,
  PluginInstallInput,
  PluginInstallResult,
  PluginManifest,
  PluginMcpServerDecl,
  PluginRecord,
  PluginValidationIssue,
  PluginVersionRecord,
} from '../types/skills-plugins-projects.js';
import {
  comparePluginVersions,
  DEFAULT_PLUGIN_ALLOWED_COMMANDS,
  loadPluginManifest,
  PluginManifestError,
  type ParsedPluginManifest,
  type PluginManifestContext,
} from './PluginManifest.js';
import {
  checksumPluginDir,
  extractPluginZip,
  inspectPluginDir,
  locatePluginRoot,
  PluginPackageError,
} from './PluginPackage.js';
import type { PluginStore, PluginUpdate } from './PluginStore.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULT_CHARS = 12_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_VERSIONS = 2;
const PLACEHOLDER_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/gu;

export type PluginOperationStage =
  | 'package'
  | 'manifest'
  | 'skills'
  | 'mcp'
  | 'secrets'
  | 'conflict'
  | 'storage'
  | 'runtime';

export class PluginError extends Error {
  public readonly issues: PluginValidationIssue[];

  constructor(
    public readonly stage: PluginOperationStage,
    message: string,
    issues: PluginValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'PluginError';
    this.issues = issues;
  }
}

export class PluginNotFoundError extends PluginError {
  constructor(id: string) {
    super('storage', `插件 ${id} 未安装`);
    this.name = 'PluginNotFoundError';
  }
}

export type PluginChangeType =
  | 'install'
  | 'upgrade'
  | 'enable'
  | 'disable'
  | 'rollback'
  | 'uninstall'
  | 'refresh';

export interface PluginChangeEvent {
  type: PluginChangeType;
  pluginId: string;
  version?: string;
}

export interface PluginServiceLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn?(obj: Record<string, unknown>, msg: string): void;
  error?(obj: Record<string, unknown>, msg: string): void;
}

export interface PluginServiceOptions {
  store: PluginStore;
  pluginsRoot: string;
  agentVersion: string;
  env?: Record<string, string | undefined>;
  allowedCommands?: readonly string[];
  reservedSkillNames?: () => Iterable<string> | Promise<Iterable<string>>;
  manualMcpServerIds?: () => Iterable<string> | Promise<Iterable<string>>;
  onChanged?: (event: PluginChangeEvent) => Promise<void> | void;
  logger?: PluginServiceLogger;
  now?: () => number;
  trashRetentionMs?: number;
  /** 仅作为 install 的默认值；显式 input.allowMissingSecrets 优先 */
  allowMissingSecrets?: boolean;
}

export interface PluginInstallOptions {
  mode?: 'install' | 'upgrade';
}

export interface PluginUninstallOptions {
  /** 默认保留目录 7 天，true 时立即删除 */
  deleteFiles?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizePluginNamespace(pluginId: string): string {
  const normalized = pluginId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'plugin';
}

export function pluginMcpServerId(
  pluginId: string,
  serverId: string,
): string {
  return `plugin-${sanitizePluginNamespace(pluginId)}-${serverId}`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function requiredSecretKeys(manifest: PluginManifest): string[] {
  return (manifest.secrets ?? [])
    .filter((secret) => secret.required)
    .map((secret) => secret.key);
}

export class PluginService {
  private readonly store: PluginStore;
  private readonly pluginsRoot: string;
  private readonly env: Record<string, string | undefined>;
  private readonly allowedCommands: readonly string[];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly applied = new Set<string>();

  constructor(private readonly options: PluginServiceOptions) {
    this.store = options.store;
    this.pluginsRoot = path.resolve(options.pluginsRoot);
    this.env = options.env ?? process.env;
    this.allowedCommands =
      options.allowedCommands ?? DEFAULT_PLUGIN_ALLOWED_COMMANDS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  public async list(): Promise<PluginAdminView[]> {
    const records = await this.store.listPlugins();
    return Promise.all(records.map((record) => this.toAdminView(record)));
  }

  public async get(id: string): Promise<PluginAdminView> {
    const record = await this.store.getPlugin(id);
    if (!record) throw new PluginNotFoundError(id);
    return this.toAdminView(record);
  }

  public async versions(id: string): Promise<PluginVersionRecord[]> {
    return this.store.listVersions(id);
  }

  public async install(input: PluginInstallInput): Promise<PluginInstallResult> {
    return this.installInternal(input, { mode: 'install' });
  }

  public async upgrade(input: PluginInstallInput): Promise<PluginInstallResult> {
    return this.installInternal(input, { mode: 'upgrade' });
  }

  public async installFromZip(input: {
    zipPath: string;
    installedBy: string;
    force?: boolean;
    allowMissingSecrets?: boolean;
    mode?: 'install' | 'upgrade';
  }): Promise<PluginInstallResult> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'plugin-zip-'));
    try {
      await extractPluginZip(input.zipPath, tempDir);
      const root = await locatePluginRoot(tempDir);
      return await this.installInternal(
        {
          dir: root,
          installedBy: input.installedBy,
          force: input.force,
          allowMissingSecrets: input.allowMissingSecrets,
        },
        { mode: input.mode ?? 'install' },
      );
    } catch (error) {
      throw this.normalizeError(error, 'package');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  public async enable(id: string): Promise<PluginAdminView> {
    return this.withLock(id, async () => {
      const plugin = await this.requirePlugin(id);
      const version = await this.requireVersion(plugin);
      const missing = this.missingSecrets(version.manifest);
      if (missing.length > 0) {
        throw new PluginError(
          'secrets',
          `缺少必需的环境变量：${missing.join(', ')}`,
        );
      }
      const conflicts = await this.namespaceConflicts(version.manifest, id);
      if (conflicts.length > 0) {
        throw new PluginError(
          'conflict',
          conflicts.map((issue) => issue.message).join('；'),
          conflicts,
        );
      }
      await this.ensureVersionDir(version);
      await this.store.updateVersion(id, version.version, { status: 'enabled' });
      await this.store.updatePlugin(id, {
        status: 'enabled',
        lastError: '',
        manifest: version.manifest,
      });
      await this.refreshRuntime({
        type: 'enable',
        pluginId: id,
        version: version.version,
      });
      return this.toAdminView((await this.requirePlugin(id)));
    });
  }

  public async disable(id: string): Promise<PluginAdminView> {
    return this.withLock(id, async () => {
      const plugin = await this.requirePlugin(id);
      await this.store.updatePlugin(id, {
        status: 'disabled',
        lastError: '',
      });
      await this.store.updateVersion(id, plugin.activeVersion, {
        status: 'disabled',
      });
      await this.refreshRuntime({
        type: 'disable',
        pluginId: id,
        version: plugin.activeVersion,
      });
      return this.toAdminView(await this.requirePlugin(id));
    });
  }

  public async rollback(id: string, version: string): Promise<PluginAdminView> {
    return this.withLock(id, async () => {
      const plugin = await this.requirePlugin(id);
      if (plugin.activeVersion === version) {
        return this.toAdminView(plugin);
      }
      const target = await this.store.getVersion(id, version);
      if (!target) {
        throw new PluginError('storage', `版本 ${id}@${version} 不存在`);
      }
      await this.ensureVersionDir(target);
      const missing = this.missingSecrets(target.manifest);
      if (missing.length > 0) {
        throw new PluginError(
          'secrets',
          `回滚目标缺少必需的环境变量：${missing.join(', ')}`,
        );
      }
      const conflicts = await this.namespaceConflicts(target.manifest, id);
      if (conflicts.length > 0) {
        throw new PluginError(
          'conflict',
          conflicts.map((issue) => issue.message).join('；'),
          conflicts,
        );
      }
      await this.store.updateVersion(id, plugin.activeVersion, {
        status: 'superseded',
      });
      await this.store.updateVersion(id, version, { status: 'enabled' });
      await this.store.updatePlugin(id, {
        activeVersion: version,
        status: 'enabled',
        manifest: target.manifest,
        lastError: '',
      });
      await this.refreshRuntime({
        type: 'rollback',
        pluginId: id,
        version,
      });
      return this.toAdminView(await this.requirePlugin(id));
    });
  }

  public async uninstall(
    id: string,
    options: PluginUninstallOptions = {},
  ): Promise<void> {
    await this.withLock(id, async () => {
      const plugin = await this.requirePlugin(id);
      await this.store.updatePlugin(id, {
        status: 'disabled',
        lastError: '',
      });
      await this.store.updateVersion(id, plugin.activeVersion, {
        status: 'disabled',
      });
      await this.refreshRuntime({
        type: 'uninstall',
        pluginId: id,
        version: plugin.activeVersion,
      });
      await this.store.deletePlugin(id);
      const pluginDir = path.join(this.pluginsRoot, id);
      if (options.deleteFiles) {
        await rm(pluginDir, { recursive: true, force: true });
      } else {
        await this.moveToTrash(pluginDir, id);
      }
      await this.purgeTrash();
    });
  }

  /** 插件技能根目录；仅启用的插件，且只包含清单声明的技能 */
  public async getSkillRoots(): Promise<SkillScanRoot[]> {
    const records = await this.store.listPlugins();
    const roots: SkillScanRoot[] = [];
    for (const record of records) {
      if (record.status !== 'enabled') continue;
      const version = await this.store.getVersion(record.id, record.activeVersion);
      if (!version || !version.manifest.skills) continue;
      for (const relativeDir of version.manifest.skills) {
        const dir = path.resolve(version.dir, relativeDir);
        if (!isInside(path.resolve(version.dir), dir)) {
          this.options.logger?.warn?.(
            { pluginId: record.id, relativeDir },
            'skip plugin skill outside version dir',
          );
          continue;
        }
        try {
          const info = await stat(path.join(dir, 'SKILL.md'));
          if (!info.isFile()) continue;
        } catch {
          this.options.logger?.warn?.(
            { pluginId: record.id, dir },
            'skip missing plugin skill directory',
          );
          continue;
        }
        roots.push({
          source: 'plugin',
          dir,
          pluginId: record.id,
          pluginVersion: version.version,
        });
      }
    }
    return roots.sort(
      (a, b) =>
        (a.pluginId ?? '').localeCompare(b.pluginId ?? '') ||
        a.dir.localeCompare(b.dir),
    );
  }

  /** 运行时合并的 MCP 配置；密钥从进程环境展开 */
  public async getEnabledMcpServers(): Promise<EnterpriseMcpServerConfig[]> {
    const records = await this.store.listPlugins();
    const servers: EnterpriseMcpServerConfig[] = [];
    for (const record of records) {
      if (record.status !== 'enabled') continue;
      const version = await this.store.getVersion(record.id, record.activeVersion);
      if (!version) continue;
      const manifest = version.manifest;
      const missing = this.missingSecrets(manifest);
      if (missing.length > 0) {
        this.options.logger?.warn?.(
          { pluginId: record.id, missing },
          'skip plugin MCP servers because required secrets are missing',
        );
        continue;
      }
      for (const server of manifest.mcpServers ?? []) {
        if (server.enabled === false) continue;
        const config = this.toMcpConfig(record, server);
        if (!config) {
          this.options.logger?.warn?.(
            { pluginId: record.id, serverId: server.id },
            'skip plugin MCP server because a secret placeholder is unresolved',
          );
          continue;
        }
        servers.push(config);
      }
    }
    return servers;
  }

  /** 调用宿主应用运行时（连接池 / 技能注册）并记录是否已生效 */
  public async refreshRuntime(event: PluginChangeEvent): Promise<boolean> {
    const enabledKeys = new Set<string>();
    for (const record of await this.store.listPlugins()) {
      if (record.status === 'enabled') {
        enabledKeys.add(`${record.id}@${record.activeVersion}`);
      }
    }
    if (!this.options.onChanged) {
      this.applied.clear();
      return false;
    }
    try {
      await this.options.onChanged(event);
      this.applied.clear();
      for (const key of enabledKeys) this.applied.add(key);
      this.options.logger?.info?.(
        { ...event, enabled: enabledKeys.size },
        'plugin runtime applied',
      );
      return true;
    } catch (error) {
      this.applied.clear();
      this.options.logger?.error?.(
        { ...event, error: errorMessage(error) },
        'plugin runtime apply failed',
      );
      return false;
    }
  }

  private async installInternal(
    input: PluginInstallInput,
    options: PluginInstallOptions,
  ): Promise<PluginInstallResult> {
    let sourceRoot: string;
    try {
      sourceRoot = await locatePluginRoot(input.dir);
      await inspectPluginDir(sourceRoot);
    } catch (error) {
      throw this.normalizeError(error, 'package');
    }

    let parsed: ParsedPluginManifest;
    try {
      parsed = await loadPluginManifest(sourceRoot, await this.manifestContext(input));
    } catch (error) {
      throw this.normalizeError(error, 'manifest');
    }
    const manifest = parsed.manifest;

    return this.withLock(manifest.id, async () => {
      await this.purgeTrash();
      const existing = await this.store.getPlugin(manifest.id);
      const previousVersion = existing
        ? await this.store.getVersion(existing.id, existing.activeVersion)
        : null;
      const mode = options.mode ?? 'install';
      if (mode === 'install') {
        if (existing && !input.force) {
          throw new PluginError(
            'conflict',
            `插件 ${manifest.id} 已安装（当前版本 ${existing.activeVersion}），请使用升级`,
          );
        }
        if (
          existing &&
          input.force &&
          existing.activeVersion !== manifest.version
        ) {
          throw new PluginError(
            'conflict',
            `插件 ${manifest.id} 已安装版本 ${existing.activeVersion}，不能以安装方式覆盖其他版本`,
          );
        }
      } else {
        if (!existing) {
          throw new PluginError(
            'storage',
            `插件 ${manifest.id} 未安装，无法升级`,
          );
        }
        if (
          !input.force &&
          comparePluginVersions(manifest.version, existing.activeVersion) <= 0
        ) {
          throw new PluginError(
            'conflict',
            `新版本 ${manifest.version} 必须高于当前版本 ${existing.activeVersion}`,
          );
        }
      }

      const conflicts = await this.namespaceConflicts(manifest, manifest.id);
      if (conflicts.length > 0) {
        throw new PluginError(
          'conflict',
          conflicts.map((issue) => issue.message).join('；'),
          conflicts,
        );
      }

      const missingSecrets = this.missingSecrets(manifest);
      await mkdir(this.pluginsRoot, { recursive: true, mode: 0o755 });
      const stagedDir = await mkdtemp(
        path.join(this.pluginsRoot, '.staging-'),
      );
      const pluginDir = path.join(this.pluginsRoot, manifest.id);
      const targetDir = path.join(pluginDir, manifest.version);
      const backupDir = path.join(
        pluginDir,
        `.backup-${manifest.version}-${randomUUID().slice(0, 8)}`,
      );
      let targetSwapped = false;
      let backupMoved = false;
      let versionInserted = false;
      try {
        await cp(sourceRoot, stagedDir, {
          recursive: true,
          force: true,
          dereference: false,
        });
        const checksum = await checksumPluginDir(stagedDir);
        await mkdir(pluginDir, { recursive: true, mode: 0o755 });
        try {
          await stat(targetDir);
          await rename(targetDir, backupDir);
          backupMoved = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(stagedDir, targetDir);
        targetSwapped = true;

        const now = this.now();
        const initialStatus = missingSecrets.length > 0 ? 'disabled' : 'enabled';
        const versionRecord: PluginVersionRecord = {
          pluginId: manifest.id,
          version: manifest.version,
          manifest,
          dir: targetDir,
          checksum,
          status: initialStatus,
          installedAt: now,
        };
        if (existing) {
          const prior = await this.store.getVersion(manifest.id, manifest.version);
          if (prior) {
            await this.store.updateVersion(manifest.id, manifest.version, {
              manifest,
              dir: targetDir,
              checksum,
              status: initialStatus,
            });
          } else {
            await this.store.insertVersion(versionRecord);
            versionInserted = true;
          }
          const patch: PluginUpdate = {
            name: manifest.name,
            activeVersion: manifest.version,
            status: initialStatus,
            manifest,
            installedBy: input.installedBy,
            lastError: missingSecrets.length
              ? `缺少必需的环境变量：${missingSecrets.join(', ')}`
              : '',
          };
          await this.store.updatePlugin(manifest.id, patch);
          if (existing.activeVersion !== manifest.version) {
            await this.store.updateVersion(existing.id, existing.activeVersion, {
              status: 'superseded',
            });
          }
        } else {
          await this.store.insertVersion(versionRecord);
          versionInserted = true;
          const record: PluginRecord = {
            id: manifest.id,
            name: manifest.name,
            activeVersion: manifest.version,
            status: initialStatus,
            manifest,
            installedBy: input.installedBy,
            lastError: missingSecrets.length
              ? `缺少必需的环境变量：${missingSecrets.join(', ')}`
              : '',
            createdAt: now,
            updatedAt: now,
          };
          await this.store.insertPlugin(record);
        }

        if (backupMoved) {
          await rm(backupDir, { recursive: true, force: true });
          backupMoved = false;
        }
        await this.pruneVersions(manifest.id);
        await this.refreshRuntime({
          type: options.mode === 'upgrade' ? 'upgrade' : 'install',
          pluginId: manifest.id,
          version: manifest.version,
        });

        const plugin = await this.toAdminView(
          await this.requirePlugin(manifest.id),
        );
        const version = await this.store.getVersion(
          manifest.id,
          manifest.version,
        );
        if (!version) {
          throw new PluginError('storage', '安装后版本记录缺失');
        }
        return {
          plugin,
          version,
          skills: parsed.skills.map((skill) => skill.id),
          mcpServers: (manifest.mcpServers ?? []).map((server) =>
            pluginMcpServerId(manifest.id, server.id),
          ),
          warnings: parsed.warnings,
        };
      } catch (error) {
        if (versionInserted) {
          await this.store
            .deleteVersion(manifest.id, manifest.version)
            .catch(() => undefined);
        }
        if (existing) {
          await this.store
            .updatePlugin(manifest.id, {
              name: existing.name,
              activeVersion: existing.activeVersion,
              status: existing.status,
              manifest: existing.manifest,
              installedBy: existing.installedBy,
              lastError: existing.lastError,
            })
            .catch(() => undefined);
          if (previousVersion) {
            await this.store
              .updateVersion(manifest.id, previousVersion.version, {
                status: previousVersion.status,
              })
              .catch(() => undefined);
          }
        }
        if (targetSwapped) {
          await rm(targetDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
        if (backupMoved) {
          await rename(backupDir, targetDir).catch(() => undefined);
        }
        throw this.normalizeError(error, 'storage');
      } finally {
        await rm(stagedDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    });
  }

  private async manifestContext(
    input: PluginInstallInput,
  ): Promise<PluginManifestContext> {
    const reserved = this.options.reservedSkillNames
      ? await this.options.reservedSkillNames()
      : [];
    return {
      agentVersion: this.options.agentVersion,
      allowedCommands: this.allowedCommands,
      env: this.env,
      allowMissingSecrets:
        input.allowMissingSecrets ?? this.options.allowMissingSecrets ?? false,
      reservedSkillNames: reserved,
    };
  }

  private normalizeError(
    error: unknown,
    fallbackStage: PluginOperationStage,
  ): PluginError {
    if (error instanceof PluginError) return error;
    if (error instanceof PluginManifestError) {
      return new PluginError(error.stage, error.message, error.issues);
    }
    if (error instanceof PluginPackageError) {
      return new PluginError('package', error.message);
    }
    return new PluginError(fallbackStage, errorMessage(error));
  }

  private async requirePlugin(id: string): Promise<PluginRecord> {
    const plugin = await this.store.getPlugin(id);
    if (!plugin) throw new PluginNotFoundError(id);
    return plugin;
  }

  private async requireVersion(
    plugin: PluginRecord,
  ): Promise<PluginVersionRecord> {
    const version = await this.store.getVersion(
      plugin.id,
      plugin.activeVersion,
    );
    if (!version) {
      throw new PluginError(
        'storage',
        `插件 ${plugin.id} 的当前版本 ${plugin.activeVersion} 记录缺失`,
      );
    }
    return version;
  }

  private async ensureVersionDir(version: PluginVersionRecord): Promise<void> {
    try {
      const info = await stat(path.join(version.dir, 'plugin.json'));
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      throw new PluginError(
        'storage',
        `插件版本目录不可用：${version.dir}`,
      );
    }
  }

  private missingSecrets(manifest: PluginManifest): string[] {
    return requiredSecretKeys(manifest).filter((key) => !this.env[key]);
  }

  private async namespaceConflicts(
    manifest: PluginManifest,
    pluginId: string,
  ): Promise<PluginValidationIssue[]> {
    const owners = new Map<string, string>();
    const manual = this.options.manualMcpServerIds
      ? await this.options.manualMcpServerIds()
      : [];
    for (const id of manual) owners.set(id, '手工 MCP 配置');
    for (const record of await this.store.listPlugins()) {
      if (record.id === pluginId) continue;
      for (const server of record.manifest.mcpServers ?? []) {
        owners.set(
          pluginMcpServerId(record.id, server.id),
          `插件 ${record.id}`,
        );
      }
    }
    const issues: PluginValidationIssue[] = [];
    for (const server of manifest.mcpServers ?? []) {
      const namespaced = pluginMcpServerId(pluginId, server.id);
      const owner = owners.get(namespaced);
      if (owner) {
        issues.push({
          severity: 'error',
          path: `mcpServers.${server.id}`,
          message: `MCP 服务 ID ${namespaced} 与 ${owner} 冲突`,
        });
      }
    }
    return issues;
  }

  private expandSecretValue(value: string): string | null {
    let missing = false;
    const expanded = value.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
      const secret = this.env[key];
      if (!secret) {
        missing = true;
        return '';
      }
      return secret;
    });
    return missing ? null : expanded;
  }

  private toMcpConfig(
    record: PluginRecord,
    server: PluginMcpServerDecl,
  ): EnterpriseMcpServerConfig | null {
    const endpoint = this.expandSecretValue(server.endpointOrCommand);
    if (!endpoint) return null;
    const args: string[] = [];
    for (const arg of server.args ?? []) {
      const expanded = this.expandSecretValue(arg);
      if (expanded === null) return null;
      args.push(expanded);
    }
    const envOrHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.envOrHeaders ?? {})) {
      const expanded = this.expandSecretValue(value);
      if (expanded === null) return null;
      envOrHeaders[key] = expanded;
    }
    return {
      id: pluginMcpServerId(record.id, server.id),
      name: `${record.name} / ${server.name}`,
      domain: server.domain,
      transport: server.transport,
      endpointOrCommand: endpoint,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(envOrHeaders).length > 0 ? { envOrHeaders } : {}),
      timeoutMs: server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      enabled: server.enabled !== false,
      maxResultChars: server.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
      source: 'plugin',
      pluginId: record.id,
    };
  }

  private async toAdminView(record: PluginRecord): Promise<PluginAdminView> {
    const version = await this.store.getVersion(
      record.id,
      record.activeVersion,
    );
    const skills = version
      ? await this.describeSkills(record, version)
      : [];
    const mcpServerIds = (record.manifest.mcpServers ?? []).map((server) =>
      pluginMcpServerId(record.id, server.id),
    );
    return {
      ...record,
      skills,
      mcpServerIds,
      missingSecrets: this.missingSecrets(record.manifest),
      runtimeApplied:
        record.status === 'enabled' &&
        this.applied.has(`${record.id}@${record.activeVersion}`),
    };
  }

  private async describeSkills(
    record: PluginRecord,
    version: PluginVersionRecord,
  ): Promise<
    Array<{ id: string; name: string; enabled: boolean; loadError?: string }>
  > {
    const result: Array<{
      id: string;
      name: string;
      enabled: boolean;
      loadError?: string;
    }> = [];
    for (const relativeDir of version.manifest.skills ?? []) {
      const dir = path.resolve(version.dir, relativeDir);
      const fallbackName = path.basename(dir);
      try {
        const raw = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
        const parsed = parseSkillMarkdown(raw, fallbackName);
        result.push({
          id: `plugin:${record.id}:${parsed.frontmatter.name}`,
          name: parsed.frontmatter.name,
          enabled: record.status === 'enabled',
        });
      } catch (error) {
        result.push({
          id: `plugin:${record.id}:${fallbackName}`,
          name: fallbackName,
          enabled: false,
          loadError: errorMessage(error),
        });
      }
    }
    return result;
  }

  private async pruneVersions(pluginId: string): Promise<void> {
    const versions = await this.store.listVersions(pluginId);
    if (versions.length <= KEEP_VERSIONS) return;
    const plugin = await this.store.getPlugin(pluginId);
    const sorted = [...versions].sort(
      (a, b) =>
        b.installedAt - a.installedAt ||
        comparePluginVersions(b.version, a.version),
    );
    const keep = new Set<string>();
    if (plugin) keep.add(plugin.activeVersion);
    for (const version of sorted) {
      if (keep.size >= KEEP_VERSIONS) break;
      keep.add(version.version);
    }
    for (const version of versions) {
      if (keep.has(version.version)) continue;
      await this.store.deleteVersion(pluginId, version.version);
      const pluginDir = path.join(this.pluginsRoot, pluginId);
      if (isInside(pluginDir, version.dir)) {
        await rm(version.dir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private async moveToTrash(dir: string, id: string): Promise<void> {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) return;
    } catch {
      return;
    }
    const trashRoot = path.join(this.pluginsRoot, '.trash');
    await mkdir(trashRoot, { recursive: true, mode: 0o755 });
    const target = path.join(
      trashRoot,
      `${sanitizePluginNamespace(id)}-${this.now()}-${randomUUID().slice(0, 6)}`,
    );
    await rename(dir, target).catch(async () => {
      await rm(dir, { recursive: true, force: true });
    });
  }

  private async purgeTrash(): Promise<void> {
    const trashRoot = path.join(this.pluginsRoot, '.trash');
    let entries;
    try {
      entries = await readdir(trashRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const retention = this.options.trashRetentionMs ?? DEFAULT_RETENTION_MS;
    const cutoff = this.now() - retention;
    for (const entry of entries) {
      const full = path.join(trashRoot, entry.name);
      try {
        const info = await stat(full);
        if (info.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
        }
      } catch {
        // 清理失败不影响主流程
      }
    }
  }

  private async withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.locks.set(id, queued);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }
}
