import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import { MAX_PLUGIN_ARCHIVE_BYTES } from '../../plugins/PluginPackage.js';
import {
  PluginError,
  PluginNotFoundError,
} from '../../plugins/PluginService.js';
import type {
  PluginAdminPort,
  PluginAdminView,
  PluginInstallResult,
} from '../../types/skills-plugins-projects.js';
import {
  readBoolean,
  readJsonBody,
  readString,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface PluginRouteDeps {
  plugins: PluginAdminPort;
  configCenter?: DynamicConfigCenter;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

interface UploadLike {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  name?: string;
}

interface PackageRequest {
  dir?: string;
  zipPath?: string;
  force: boolean;
  allowMissingSecrets?: boolean;
  cleanup?: () => Promise<void>;
}

function isUpload(value: unknown): value is UploadLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UploadLike).arrayBuffer === 'function' &&
    typeof (value as UploadLike).size === 'number'
  );
}

function pluginStatusForError(error: PluginError): 400 | 409 | 422 | 500 {
  switch (error.stage) {
    case 'conflict':
      return 409;
    case 'secrets':
      return 422;
    case 'package':
    case 'manifest':
    case 'skills':
    case 'mcp':
      return 400;
    default:
      return 500;
  }
}

function pluginErrorResponse(c: Context, error: unknown): Response | null {
  if (error instanceof PluginNotFoundError) {
    return c.json({ ok: false, error: error.message }, 404);
  }
  if (error instanceof PluginError) {
    return c.json(
      {
        ok: false,
        error: error.message,
        stage: error.stage,
        issues: error.issues,
      },
      pluginStatusForError(error),
    );
  }
  return null;
}

function auditPlugin(
  plugin: PluginAdminView,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.activeVersion,
    status: plugin.status,
    enabled: plugin.status === 'enabled',
    skills: plugin.skills.map((skill) => skill.id),
    mcpServers: plugin.mcpServerIds,
    ...extra,
  };
}

function auditInstall(result: PluginInstallResult): Record<string, unknown> {
  return {
    ...auditPlugin(result.plugin),
    installedVersion: result.version.version,
    checksum: result.version.checksum,
    skills: result.skills,
    mcpServers: result.mcpServers,
    warnings: result.warnings.length,
  };
}

function parseFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === 'on' || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

async function storeUpload(file: UploadLike): Promise<{
  zipPath: string;
  cleanup: () => Promise<void>;
}> {
  if (file.size > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new HTTPException(413, {
      message: `插件包超过 ${MAX_PLUGIN_ARCHIVE_BYTES} 字节上限`,
    });
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'plugin-upload-'));
  const zipPath = path.join(tempDir, 'plugin.zip');
  try {
    await writeFile(zipPath, Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    zipPath,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

function sourceFromBody(
  body: Record<string, unknown>,
): Pick<PackageRequest, 'dir' | 'zipPath'> {
  const dir = readString(body, 'dir')?.trim();
  const rawPath = readString(body, 'path')?.trim();
  if (dir) return { dir };
  if (!rawPath) {
    throw new HTTPException(400, { message: '缺少 path / dir 或上传文件' });
  }
  return rawPath.toLowerCase().endsWith('.zip')
    ? { zipPath: rawPath }
    : { dir: rawPath };
}

/** 一次读取请求，避免 multipart body 被重复消费 */
async function readPackageRequest(c: Context): Promise<PackageRequest> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    const uploaded =
      body['file'] ?? body['zip'] ?? body['package'] ?? body['plugin'];
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!isUpload(file)) {
      throw new HTTPException(400, { message: '请上传 zip 插件包' });
    }
    const stored = await storeUpload(file);
    const allowMissingSecrets = parseFlag(body['allowMissingSecrets']);
    return {
      zipPath: stored.zipPath,
      force: parseFlag(body['force']) ?? false,
      ...(allowMissingSecrets !== undefined ? { allowMissingSecrets } : {}),
      cleanup: stored.cleanup,
    };
  }
  const body = await readJsonBody(c);
  const source = sourceFromBody(body);
  const allowMissingSecrets = readBoolean(body, 'allowMissingSecrets');
  return {
    ...source,
    force: readBoolean(body, 'force') ?? false,
    ...(allowMissingSecrets !== undefined ? { allowMissingSecrets } : {}),
  };
}

/** 插件管理：校验、安装、升级、启停、回滚与卸载 */
export function createPluginRoutes(deps: PluginRouteDeps): Hono {
  const app = new Hono();

  app.get('/plugins', async (c) => {
    const plugins = await deps.plugins.list();
    const query = (c.req.query('query') ?? '').trim().toLowerCase();
    const status = c.req.query('status');
    const items = plugins.filter((plugin) => {
      if (status && plugin.status !== status) return false;
      if (!query) return true;
      return [
        plugin.id,
        plugin.name,
        plugin.manifest.description,
        plugin.manifest.publisher ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return c.json({ ok: true, plugins: items, total: items.length });
  });

  app.post('/plugins/validate', async (c) => {
    if (!deps.plugins.validatePackage) {
      throw new HTTPException(503, { message: '插件校验未启用' });
    }
    const request = await readPackageRequest(c);
    try {
      const preview = await deps.plugins.validatePackage({
        ...(request.dir ? { dir: request.dir } : {}),
        ...(request.zipPath ? { zipPath: request.zipPath } : {}),
        ...(request.allowMissingSecrets !== undefined
          ? { allowMissingSecrets: request.allowMissingSecrets }
          : {}),
      });
      return c.json({ ok: true, preview });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    } finally {
      await request.cleanup?.();
    }
  });

  app.post('/plugins/install', async (c) => {
    const request = await readPackageRequest(c);
    try {
      let result: PluginInstallResult;
      try {
        if (request.zipPath) {
          if (!deps.plugins.installFromZip) {
            throw new HTTPException(503, { message: 'zip 安装未启用' });
          }
          result = await deps.plugins.installFromZip({
            zipPath: request.zipPath,
            installedBy: webActor(c),
            force: request.force,
            ...(request.allowMissingSecrets !== undefined
              ? { allowMissingSecrets: request.allowMissingSecrets }
              : {}),
            mode: 'install',
          });
        } else if (request.dir) {
          result = await deps.plugins.install({
            dir: request.dir,
            installedBy: webActor(c),
            force: request.force,
            ...(request.allowMissingSecrets !== undefined
              ? { allowMissingSecrets: request.allowMissingSecrets }
              : {}),
          });
        } else {
          throw new HTTPException(400, { message: '缺少插件包' });
        }
      } catch (error) {
        const response = pluginErrorResponse(c, error);
        if (response) return response;
        throw error;
      }
      if (deps.configCenter) {
        await recordWebAudit(
          deps.configCenter,
          webActor(c),
          'INSTALL_PLUGIN',
          {},
          auditInstall(result),
        );
      }
      return c.json({ ok: true, ...result });
    } finally {
      await request.cleanup?.();
    }
  });

  app.post('/plugins/:id/upgrade', async (c) => {
    const expectedId = c.req.param('id');
    const request = await readPackageRequest(c);
    try {
      if (deps.plugins.validatePackage) {
        const preview = await deps.plugins.validatePackage({
          ...(request.dir ? { dir: request.dir } : {}),
          ...(request.zipPath ? { zipPath: request.zipPath } : {}),
        });
        if (preview.manifest.id !== expectedId) {
          throw new HTTPException(400, {
            message: `插件包 id 为 ${preview.manifest.id}，与路径中的 ${expectedId} 不一致`,
          });
        }
      }
      let result: PluginInstallResult;
      try {
        if (request.zipPath) {
          if (!deps.plugins.installFromZip) {
            throw new HTTPException(503, { message: 'zip 安装未启用' });
          }
          result = await deps.plugins.installFromZip({
            zipPath: request.zipPath,
            installedBy: webActor(c),
            force: request.force,
            ...(request.allowMissingSecrets !== undefined
              ? { allowMissingSecrets: request.allowMissingSecrets }
              : {}),
            mode: 'upgrade',
          });
        } else if (request.dir) {
          result = await deps.plugins.upgrade({
            dir: request.dir,
            installedBy: webActor(c),
            force: request.force,
            ...(request.allowMissingSecrets !== undefined
              ? { allowMissingSecrets: request.allowMissingSecrets }
              : {}),
          });
        } else {
          throw new HTTPException(400, { message: '缺少插件包' });
        }
      } catch (error) {
        const response = pluginErrorResponse(c, error);
        if (response) return response;
        throw error;
      }
      if (deps.configCenter) {
        await recordWebAudit(
          deps.configCenter,
          webActor(c),
          'UPGRADE_PLUGIN',
          { id: expectedId },
          auditInstall(result),
        );
      }
      return c.json({ ok: true, ...result });
    } finally {
      await request.cleanup?.();
    }
  });

  app.post('/plugins/:id/enable', async (c) => {
    const id = c.req.param('id');
    try {
      const plugin = await deps.plugins.enable(id);
      if (deps.configCenter) {
        await recordWebAudit(
          deps.configCenter,
          webActor(c),
          'ENABLE_PLUGIN',
          {},
          auditPlugin(plugin, { action: 'enable' }),
        );
      }
      return c.json({ ok: true, plugin });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.post('/plugins/:id/disable', async (c) => {
    const id = c.req.param('id');
    try {
      const plugin = await deps.plugins.disable(id);
      if (deps.configCenter) {
        await recordWebAudit(
          deps.configCenter,
          webActor(c),
          'DISABLE_PLUGIN',
          {},
          auditPlugin(plugin, { action: 'disable' }),
        );
      }
      return c.json({ ok: true, plugin });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.post('/plugins/:id/rollback', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const version = readString(body, 'version', { required: true })!.trim();
    try {
      const plugin = await deps.plugins.rollback(id, version);
      if (deps.configCenter) {
        await recordWebAudit(
          deps.configCenter,
          webActor(c),
          'ROLLBACK_PLUGIN',
          { id },
          auditPlugin(plugin, { action: 'rollback', targetVersion: version }),
        );
      }
      return c.json({ ok: true, plugin });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.get('/plugins/:id/versions', async (c) => {
    if (!deps.plugins.versions) {
      return c.json({ ok: true, versions: [] });
    }
    try {
      const versions = await deps.plugins.versions(c.req.param('id'));
      return c.json({ ok: true, versions });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.get('/plugins/:id', async (c) => {
    const id = c.req.param('id');
    try {
      if (deps.plugins.get) {
        return c.json({ ok: true, plugin: await deps.plugins.get(id) });
      }
      const plugin = (await deps.plugins.list()).find((item) => item.id === id);
      if (!plugin) throw new PluginNotFoundError(id);
      return c.json({ ok: true, plugin });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.delete('/plugins/:id', async (c) => {
    const id = c.req.param('id');
    const deleteFiles = c.req.query('deleteFiles') === 'true';
    try {
      await deps.plugins.uninstall(id, { deleteFiles });
      if (deps.configCenter) {
        await recordWebAudit(
          deps.configCenter,
          webActor(c),
          'UNINSTALL_PLUGIN',
          { id },
          { id, deleteFiles },
        );
      }
      return c.json({ ok: true });
    } catch (error) {
      const response = pluginErrorResponse(c, error);
      if (response) return response;
      throw error;
    }
  });

  return app;
}
