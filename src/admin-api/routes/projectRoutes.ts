import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import {
  ProjectNotFoundError,
  ProjectNotIndexedError,
  ProjectValidationError,
} from '../../projects/ProjectService.js';
import { ProjectSourceError } from '../../projects/RepoSource.js';
import type {
  HandbookSectionKey,
  ProjectAdminEntry,
  ProjectAdminPort,
  ProjectCreateInput,
  ProjectManualEntryInput,
  ProjectManualEntryPatch,
  ProjectRecord,
  ProjectSource,
  ProjectUpdateInput,
} from '../../types/skills-plugins-projects.js';
import type { ProjectHandbookRecord } from '../../types/skills-plugins-projects.js';
import {
  isProjectSensitivity,
  isProjectVisibility,
} from '../../types/skills-plugins-projects.js';
import {
  readBoolean,
  readJsonBody,
  readNumber,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface ProjectRouteDeps {
  projects: ProjectAdminPort;
  configCenter?: DynamicConfigCenter;
}

function mapProjectError(error: unknown): never {
  if (error instanceof ProjectNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof ProjectNotIndexedError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (
    error instanceof ProjectValidationError ||
    error instanceof ProjectSourceError
  ) {
    throw new HTTPException(400, { message: error.message });
  }
  throw error;
}

function auditProject(project: ProjectRecord): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    sourceType: project.source.type,
    visibility: project.visibility,
    sensitivity: project.sensitivity,
    enabled: project.enabled,
    isDefault: project.isDefault,
    autoSyncMinutes: project.autoSyncMinutes,
  };
}

function readManualEntry(
  body: Record<string, unknown>,
  partial: boolean,
): ProjectManualEntryInput | ProjectManualEntryPatch {
  const input: ProjectManualEntryInput = {
    section: (readString(body, 'section', { required: !partial }) ??
      'overview') as ProjectManualEntryInput['section'],
    title: readString(body, 'title', { required: !partial }) ?? '',
    markdown: readString(body, 'markdown', { required: !partial }) ?? '',
  };
  if (partial) {
    const patch: ProjectManualEntryPatch = {};
    const section = readString(body, 'section');
    if (section !== undefined) {
      patch.section = section as ProjectManualEntryPatch['section'];
    }
    const title = readString(body, 'title');
    if (title !== undefined) patch.title = title;
    const markdown = readString(body, 'markdown');
    if (markdown !== undefined) patch.markdown = markdown;
    const visibility = readString(body, 'visibility');
    if (visibility !== undefined) {
      patch.visibility = visibility as ProjectManualEntryPatch['visibility'];
    }
    const sensitivity = readString(body, 'sensitivity');
    if (sensitivity !== undefined) {
      patch.sensitivity =
        sensitivity as ProjectManualEntryPatch['sensitivity'];
    }
    const injectToBrief = readBoolean(body, 'injectToBrief');
    if (injectToBrief !== undefined) patch.injectToBrief = injectToBrief;
    const priority = readNumber(body, 'priority');
    if (priority !== undefined) patch.priority = priority;
    return patch;
  }
  const visibility = readString(body, 'visibility');
  if (visibility !== undefined) {
    input.visibility = visibility as ProjectManualEntryInput['visibility'];
  }
  const sensitivity = readString(body, 'sensitivity');
  if (sensitivity !== undefined) {
    input.sensitivity = sensitivity as ProjectManualEntryInput['sensitivity'];
  }
  const injectToBrief = readBoolean(body, 'injectToBrief');
  if (injectToBrief !== undefined) input.injectToBrief = injectToBrief;
  const priority = readNumber(body, 'priority');
  if (priority !== undefined) input.priority = priority;
  return input;
}

function auditHandbook(record: ProjectHandbookRecord): Record<string, unknown> {
  return {
    projectId: record.projectId,
    version: record.version,
    status: record.status,
    commit: record.commitSha,
    generatedBy: record.generatedBy,
    sections: record.content.sections.map((section) => section.key),
  };
}

function readSource(value: unknown): ProjectSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPException(400, { message: 'source 必须是对象' });
  }
  const source = value as Record<string, unknown>;
  const type = readString(source, 'type', { required: true })!;
  if (type === 'manual') return { type: 'manual' };
  if (type === 'local') {
    const localPath = readString(source, 'path', { required: true })!.trim();
    if (!localPath) {
      throw new HTTPException(400, { message: '本地项目必须填写路径' });
    }
    return {
      type: 'local',
      path: localPath,
      ...(readString(source, 'branch')?.trim()
        ? { branch: readString(source, 'branch')!.trim() }
        : {}),
    };
  }
  if (type === 'github') {
    const repo = readString(source, 'repo', { required: true })!.trim();
    return {
      type: 'github',
      repo,
      ...(readString(source, 'ref')?.trim()
        ? { ref: readString(source, 'ref')!.trim() }
        : {}),
      ...(readNumber(source, 'depth') !== undefined
        ? { depth: readNumber(source, 'depth')! }
        : {}),
    };
  }
  throw new HTTPException(400, {
    message: 'source.type 必须是 local / github / manual',
  });
}

function readCreate(body: Record<string, unknown>): ProjectCreateInput {
  const sourceRaw = body['source'];
  if (sourceRaw === undefined) {
    throw new HTTPException(400, { message: '缺少字段 source' });
  }
  return {
    id: readString(body, 'id', { required: true })!,
    name: readString(body, 'name', { required: true })!,
    source: readSource(sourceRaw),
    ...(readStringArray(body, 'aliases')
      ? { aliases: readStringArray(body, 'aliases')! }
      : {}),
    ...(readString(body, 'description') !== undefined
      ? { description: readString(body, 'description')! }
      : {}),
    ...(readString(body, 'defaultBranch') !== undefined
      ? { defaultBranch: readString(body, 'defaultBranch')! }
      : {}),
    ...(readStringArray(body, 'ownerStaffIds')
      ? { ownerStaffIds: readStringArray(body, 'ownerStaffIds')! }
      : {}),
    ...(readString(body, 'visibility') !== undefined
      ? { visibility: readString(body, 'visibility') as ProjectRecord['visibility'] }
      : {}),
    ...(readString(body, 'sensitivity') !== undefined
      ? {
          sensitivity: readString(
            body,
            'sensitivity',
          ) as ProjectRecord['sensitivity'],
        }
      : {}),
    ...(readBoolean(body, 'isDefault') !== undefined
      ? { isDefault: readBoolean(body, 'isDefault')! }
      : {}),
    ...(readBoolean(body, 'enabled') !== undefined
      ? { enabled: readBoolean(body, 'enabled')! }
      : {}),
    ...(readNumber(body, 'autoSyncMinutes') !== undefined
      ? { autoSyncMinutes: readNumber(body, 'autoSyncMinutes')! }
      : {}),
  };
}

function readPatch(body: Record<string, unknown>): ProjectUpdateInput {
  const visibility = readString(body, 'visibility');
  if (visibility !== undefined && !isProjectVisibility(visibility)) {
    throw new HTTPException(400, {
      message: 'visibility 必须是 team / private / admin',
    });
  }
  const sensitivity = readString(body, 'sensitivity');
  if (sensitivity !== undefined && !isProjectSensitivity(sensitivity)) {
    throw new HTTPException(400, { message: 'sensitivity 必须是 team / private' });
  }
  return {
    ...(readString(body, 'name') !== undefined
      ? { name: readString(body, 'name')! }
      : {}),
    ...(readStringArray(body, 'aliases')
      ? { aliases: readStringArray(body, 'aliases')! }
      : {}),
    ...(readString(body, 'description') !== undefined
      ? { description: readString(body, 'description')! }
      : {}),
    ...(body['source'] !== undefined ? { source: readSource(body['source']) } : {}),
    ...(readString(body, 'defaultBranch') !== undefined
      ? { defaultBranch: readString(body, 'defaultBranch')! }
      : {}),
    ...(readStringArray(body, 'ownerStaffIds')
      ? { ownerStaffIds: readStringArray(body, 'ownerStaffIds')! }
      : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
    ...(readBoolean(body, 'isDefault') !== undefined
      ? { isDefault: readBoolean(body, 'isDefault')! }
      : {}),
    ...(readBoolean(body, 'enabled') !== undefined
      ? { enabled: readBoolean(body, 'enabled')! }
      : {}),
    ...(readNumber(body, 'autoSyncMinutes') !== undefined
      ? { autoSyncMinutes: readNumber(body, 'autoSyncMinutes')! }
      : {}),
  };
}

function readHandbookDraft(
  body: Record<string, unknown>,
): { version?: number; sections: Array<{ key: HandbookSectionKey; title?: string; markdown: string }> } {
  const raw = body['sections'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HTTPException(400, { message: 'sections 必须是非空数组' });
  }
  const sections = raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HTTPException(400, {
        message: `sections[${index}] 必须是对象`,
      });
    }
    const section = item as Record<string, unknown>;
    const key = readString(section, 'key', { required: true })!;
    const markdown = readString(section, 'markdown', { required: true })!;
    const title = readString(section, 'title');
    return {
      key: key as HandbookSectionKey,
      markdown,
      ...(title !== undefined ? { title } : {}),
    };
  });
  const version = readNumber(body, 'version');
  return {
    ...(version !== undefined ? { version } : {}),
    sections,
  };
}

/** 项目登记、同步任务、快照与检索管理 */
export function createProjectRoutes(deps: ProjectRouteDeps): Hono {
  const app = new Hono();

  app.get('/projects', async (c) => {
    const query = (c.req.query('query') ?? '').trim().toLowerCase();
    const entries: ProjectAdminEntry[] = await deps.projects.list(true);
    const items = entries.filter((entry) => {
      if (!query) return true;
      const project = entry.project;
      return [
        project.id,
        project.name,
        project.description,
        ...project.aliases,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return c.json({ ok: true, projects: items, total: items.length });
  });

  app.post('/projects', async (c) => {
    const body = await readJsonBody(c);
    let project: ProjectRecord;
    try {
      project = await deps.projects.create(readCreate(body));
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'CREATE_PROJECT',
        {},
        { action: 'create', project: auditProject(project) },
      );
    }
    return c.json({ ok: true, project });
  });

  app.post('/projects/:id/sync', async (c) => {
    const id = c.req.param('id');
    let job;
    try {
      job = await deps.projects.queueSync(id, 'manual');
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'SYNC_PROJECT',
        { id },
        { action: 'queue-sync', id, jobId: job.id, status: job.status },
      );
    }
    return c.json({ ok: true, job }, 202);
  });

  app.get('/projects/:id/sync-jobs', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 20);
    try {
      const jobs = await deps.projects.listSyncJobs(
        c.req.param('id'),
        Number.isFinite(limitRaw) ? limitRaw : 20,
      );
      return c.json({ ok: true, jobs });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.get('/projects/:id/status', async (c) => {
    if (!deps.projects.status) {
      throw new HTTPException(503, { message: '项目状态接口未启用' });
    }
    try {
      return c.json({
        ok: true,
        status: await deps.projects.status(c.req.param('id')),
      });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.get('/projects/:id/snapshots', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 10);
    try {
      const snapshots = await deps.projects.listSnapshots(
        c.req.param('id'),
        Number.isFinite(limitRaw) ? limitRaw : 10,
      );
      return c.json({ ok: true, snapshots });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.get('/projects/:id/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim();
    if (!query) throw new HTTPException(400, { message: '缺少 q 参数' });
    const limitRaw = Number(c.req.query('limit') ?? 10);
    try {
      const result = await deps.projects.search(
        c.req.param('id'),
        query,
        Number.isFinite(limitRaw) ? limitRaw : 10,
      );
      return c.json({ ok: true, result });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.get('/projects/:id/handbook', async (c) => {
    if (!deps.projects.handbook) {
      throw new HTTPException(503, { message: '项目手册接口未启用' });
    }
    try {
      const id = c.req.param('id');
      const [handbook, draft] = await Promise.all([
        deps.projects.handbook(id),
        deps.projects.handbookDraft?.(id).catch(() => null) ?? null,
      ]);
      return c.json({ ok: true, handbook, draft });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.put('/projects/:id/handbook', async (c) => {
    if (!deps.projects.saveHandbookDraft) {
      throw new HTTPException(503, { message: '项目手册草稿接口未启用' });
    }
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    let handbook;
    try {
      handbook = await deps.projects.saveHandbookDraft(id, readHandbookDraft(body));
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_PROJECT_HANDBOOK',
        { id },
        {
          action: 'save-handbook-draft',
          sections: handbook.content.sections.map((section) => section.key),
          handbook: auditHandbook(handbook),
        },
      );
    }
    return c.json({ ok: true, handbook });
  });

  app.get('/projects/:id/manual-entries', async (c) => {
    if (!deps.projects.manualEntries) {
      return c.json({ ok: true, entries: [] });
    }
    try {
      return c.json({
        ok: true,
        entries: await deps.projects.manualEntries(c.req.param('id')),
      });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.post('/projects/:id/manual-entries', async (c) => {
    if (!deps.projects.createManualEntry) {
      throw new HTTPException(503, { message: '人工条目接口未启用' });
    }
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    let entry;
    try {
      entry = await deps.projects.createManualEntry(
        id,
        readManualEntry(body, false) as ProjectManualEntryInput,
      );
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_PROJECT_MANUAL',
        { id },
        {
          action: 'create-manual',
          id,
          entryId: entry.id,
          section: entry.section,
          title: entry.title,
        },
      );
    }
    return c.json({ ok: true, entry });
  });

  app.put('/projects/:id/manual-entries/:entryId', async (c) => {
    if (!deps.projects.updateManualEntry) {
      throw new HTTPException(503, { message: '人工条目接口未启用' });
    }
    const id = c.req.param('id');
    const entryId = c.req.param('entryId');
    const body = await readJsonBody(c);
    let entry;
    try {
      entry = await deps.projects.updateManualEntry(
        id,
        entryId,
        readManualEntry(body, true) as ProjectManualEntryPatch,
      );
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_PROJECT_MANUAL',
        { id, entryId },
        {
          action: 'update-manual',
          id,
          entryId,
          section: entry.section,
          title: entry.title,
        },
      );
    }
    return c.json({ ok: true, entry });
  });

  app.delete('/projects/:id/manual-entries/:entryId', async (c) => {
    if (!deps.projects.deleteManualEntry) {
      throw new HTTPException(503, { message: '人工条目接口未启用' });
    }
    const id = c.req.param('id');
    const entryId = c.req.param('entryId');
    try {
      await deps.projects.deleteManualEntry(id, entryId);
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_PROJECT_MANUAL',
        { id, entryId },
        { action: 'delete-manual', id, entryId },
      );
    }
    return c.json({ ok: true });
  });

  app.get('/projects/:id/handbooks', async (c) => {
    if (!deps.projects.handbookVersions) {
      return c.json({ ok: true, versions: [] });
    }
    const limitRaw = Number(c.req.query('limit') ?? 10);
    try {
      const versions = await deps.projects.handbookVersions(
        c.req.param('id'),
        Number.isFinite(limitRaw) ? limitRaw : 10,
      );
      return c.json({ ok: true, versions });
    } catch (error) {
      mapProjectError(error);
    }
  });

  app.post('/projects/:id/handbook/generate', async (c) => {
    if (!deps.projects.generateHandbook) {
      throw new HTTPException(503, { message: '项目手册接口未启用' });
    }
    const id = c.req.param('id');
    let handbook;
    try {
      handbook = await deps.projects.generateHandbook(id);
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'GENERATE_PROJECT_HANDBOOK',
        { id },
        { action: 'generate-handbook', handbook: auditHandbook(handbook) },
      );
    }
    return c.json({ ok: true, handbook });
  });

  app.post('/projects/:id/handbook/publish', async (c) => {
    if (!deps.projects.publishHandbook) {
      throw new HTTPException(503, { message: '项目手册接口未启用' });
    }
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const version = readNumber(body, 'version');
    let handbook;
    try {
      handbook = await deps.projects.publishHandbook(id, version);
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'PUBLISH_PROJECT_HANDBOOK',
        { id },
        { action: 'publish-handbook', handbook: auditHandbook(handbook) },
      );
    }
    return c.json({ ok: true, handbook });
  });

  app.get('/projects/:id', async (c) => {
    const project = await deps.projects.get(c.req.param('id'));
    if (!project) {
      throw new HTTPException(404, {
        message: `未找到项目：${c.req.param('id')}`,
      });
    }
    return c.json({ ok: true, project });
  });

  app.put('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    let project: ProjectRecord;
    try {
      project = await deps.projects.update(id, readPatch(body));
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_PROJECT',
        { id },
        { action: 'update', project: auditProject(project) },
      );
    }
    return c.json({ ok: true, project });
  });

  app.delete('/projects/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await deps.projects.remove(id);
    } catch (error) {
      mapProjectError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'DELETE_PROJECT',
        { id },
        { action: 'delete', id },
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
