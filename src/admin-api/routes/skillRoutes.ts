import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import {
  SkillResourceError,
  SkillDisabledError,
  SkillForbiddenError,
  SkillNotFoundError,
} from '../../skills/SkillService.js';
import { validateSkillDraft } from '../../skills/LocalSkillManager.js';
import { SkillValidationError } from '../../skills/SkillRegistry.js';
import type {
  SkillAdminPort,
  SkillDefinition,
  SkillDraftInput,
  SkillFileAdminPort,
  SkillResourceWriteInput,
  SkillRisk,
  SkillVisibility,
} from '../../types/skills-plugins-projects.js';
import {
  isSkillRisk,
  isSkillVisibility,
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

export interface SkillRouteDeps {
  skills: SkillAdminPort;
  skillFiles?: SkillFileAdminPort;
  configCenter?: DynamicConfigCenter;
}

function mapSkillError(error: unknown): never {
  if (error instanceof SkillNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof SkillForbiddenError) {
    throw new HTTPException(403, { message: error.message });
  }
  if (error instanceof SkillDisabledError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (
    error instanceof SkillValidationError ||
    error instanceof SkillResourceError
  ) {
    throw new HTTPException(400, { message: error.message });
  }
  throw error;
}

function auditSkill(skill: SkillDefinition | { id: string; name: string }): Record<string, unknown> {
  if ('source' in skill) {
    return {
      id: skill.id,
      name: skill.name,
      source: skill.source,
      version: skill.version,
      enabled: skill.enabled,
      visibility: skill.visibility,
      risk: skill.risk,
    };
  }
  return { id: skill.id, name: skill.name };
}

/** 请求体里的技能草稿；控制台编辑器总是提交完整内容 */
function readDraft(body: Record<string, unknown>): SkillDraftInput {
  const name = readString(body, 'name', { required: true })!.trim();
  const description = readString(body, 'description', { required: true })!.trim();
  const whenToUse = readString(body, 'whenToUse', { required: true })!.trim();
  const bodyText = readString(body, 'body', { required: true })!;
  const version = readString(body, 'version')?.trim();
  const riskRaw = readString(body, 'risk');
  if (riskRaw !== undefined && !isSkillRisk(riskRaw)) {
    throw new HTTPException(400, {
      message: 'risk 必须是 read / write / destructive',
    });
  }
  const visibilityRaw = readString(body, 'visibility');
  if (visibilityRaw !== undefined && !isSkillVisibility(visibilityRaw)) {
    throw new HTTPException(400, { message: 'visibility 必须是 public / admin' });
  }
  return {
    name,
    description,
    whenToUse,
    body: bodyText,
    ...(version !== undefined ? { version } : {}),
    ...(riskRaw !== undefined ? { risk: riskRaw as SkillRisk } : {}),
    ...(visibilityRaw !== undefined
      ? { visibility: visibilityRaw as SkillVisibility }
      : {}),
    ...(readStringArray(body, 'tags')
      ? { tags: readStringArray(body, 'tags')! }
      : {}),
    ...(readStringArray(body, 'allowedTools')
      ? { allowedTools: readStringArray(body, 'allowedTools')! }
      : {}),
    ...(readNumber(body, 'maxInstructionChars') !== undefined
      ? { maxInstructionChars: readNumber(body, 'maxInstructionChars')! }
      : {}),
  };
}

function readResourceInput(body: Record<string, unknown>): SkillResourceWriteInput {
  return {
    path: readString(body, 'path', { required: true })!,
    content: readString(body, 'content', { required: true })!,
  };
}

/** 技能管理：列表、本地技能编辑、启停、目录预览与资源文件 */
export function createSkillRoutes(deps: SkillRouteDeps): Hono {
  const app = new Hono();
  const requireFiles = (): SkillFileAdminPort => {
    if (!deps.skillFiles) {
      throw new HTTPException(503, { message: '本地技能编辑未启用' });
    }
    return deps.skillFiles;
  };

  app.get('/skills', async (c) => {
    const query = (c.req.query('query') ?? '').trim().toLowerCase();
    const source = c.req.query('source');
    const enabledRaw = c.req.query('enabled');
    const items = (await deps.skills.list()).filter((skill) => {
      if (source && skill.source !== source) return false;
      if (enabledRaw === 'true' && !skill.enabled) return false;
      if (enabledRaw === 'false' && skill.enabled) return false;
      if (!query) return true;
      return [skill.id, skill.name, skill.description, skill.whenToUse]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return c.json({ ok: true, skills: items, total: items.length });
  });

  app.post('/skills/validate', async (c) => {
    const body = await readJsonBody(c);
    const result = (deps.skillFiles?.validate ?? validateSkillDraft)(
      readDraft(body),
    );
    return c.json({ ok: true, result });
  });

  app.post('/skills/reload', async (c) => {
    const result = await deps.skills.reload();
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'RELOAD_SKILLS',
        {},
        result,
      );
    }
    return c.json({ ok: true, ...result });
  });

  app.get('/skills/usage', async (c) => {
    if (!deps.skills.usage) {
      return c.json({ ok: true, usage: {} });
    }
    const daysRaw = Number(c.req.query('days') ?? 7);
    const days = Number.isFinite(daysRaw)
      ? Math.min(90, Math.max(1, daysRaw))
      : 7;
    const usage = await deps.skills.usage(days);
    return c.json({ ok: true, days, usage });
  });

  app.post('/skills/preview', async (c) => {
    const body = await readJsonBody(c);
    const query = readString(body, 'query') ?? '';
    const conversationType =
      readString(body, 'conversationType') === '2' ? '2' : '1';
    const projectId = readString(body, 'projectId')?.trim();
    const limit = readNumber(body, 'limit');
    const isAdmin = readBoolean(body, 'isAdmin') ?? true;
    const result = await deps.skills.preview({
      query,
      conversationType,
      isAdmin,
      ...(projectId ? { projectId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ ok: true, ...result });
  });

  app.post('/skills', async (c) => {
    const files = requireFiles();
    const body = await readJsonBody(c);
    let skill: SkillDefinition;
    try {
      skill = await files.create(readDraft(body));
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        { action: 'create', skill: auditSkill(skill) },
      );
    }
    return c.json({ ok: true, skill });
  });

  app.post('/skills/:id/enable', async (c) => {
    const id = c.req.param('id');
    let skill: SkillDefinition;
    try {
      skill = await deps.skills.setEnabled(id, true);
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        { action: 'enable', skill: auditSkill(skill) },
      );
    }
    return c.json({ ok: true, skill });
  });

  app.post('/skills/:id/disable', async (c) => {
    const id = c.req.param('id');
    let skill: SkillDefinition;
    try {
      skill = await deps.skills.setEnabled(id, false);
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        { action: 'disable', skill: auditSkill(skill) },
      );
    }
    return c.json({ ok: true, skill });
  });

  app.get('/skills/:id/resource', async (c) => {
    const resourcePath = c.req.query('path')?.trim();
    if (!resourcePath) {
      throw new HTTPException(400, { message: '缺少 path 参数' });
    }
    const startLine = Number(c.req.query('startLine') ?? NaN);
    const endLine = Number(c.req.query('endLine') ?? NaN);
    try {
      const result = await deps.skills.readResource({
        name: c.req.param('id'),
        path: resourcePath,
        ...(Number.isFinite(startLine) ? { startLine } : {}),
        ...(Number.isFinite(endLine) ? { endLine } : {}),
      });
      return c.json({ ok: true, resource: result });
    } catch (error) {
      mapSkillError(error);
    }
  });

  app.put('/skills/:id/resource', async (c) => {
    const files = requireFiles();
    const body = await readJsonBody(c);
    let resource;
    try {
      resource = await files.writeResource(
        c.req.param('id'),
        readResourceInput(body),
      );
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        { action: 'write-resource', skillId: c.req.param('id'), resource },
      );
    }
    return c.json({ ok: true, resource });
  });

  app.delete('/skills/:id/resource', async (c) => {
    const files = requireFiles();
    const resourcePath = c.req.query('path')?.trim();
    if (!resourcePath) {
      throw new HTTPException(400, { message: '缺少 path 参数' });
    }
    try {
      await files.removeResource(c.req.param('id'), resourcePath);
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        {
          action: 'delete-resource',
          skillId: c.req.param('id'),
          path: resourcePath,
        },
      );
    }
    return c.json({ ok: true });
  });

  app.get('/skills/:id', async (c) => {
    const id = c.req.param('id');
    const skillsList = await deps.skills.list();
    const skill =
      skillsList.find((item) => item.id === id) ??
      skillsList.find((item) => item.name === id);
    if (!skill) throw new HTTPException(404, { message: `技能不存在：${id}` });
    return c.json({ ok: true, skill });
  });

  app.put('/skills/:id', async (c) => {
    const files = requireFiles();
    const body = await readJsonBody(c);
    let skill: SkillDefinition;
    try {
      skill = await files.update(c.req.param('id'), readDraft(body));
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        { action: 'update', skill: auditSkill(skill) },
      );
    }
    return c.json({ ok: true, skill });
  });

  app.delete('/skills/:id', async (c) => {
    const files = requireFiles();
    try {
      await files.remove(c.req.param('id'));
    } catch (error) {
      mapSkillError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_SKILL',
        {},
        { action: 'delete', skillId: c.req.param('id') },
      );
    }
    return c.json({ ok: true });
  });

  app.get('/skills/:id/usage', async (c) => {
    const id = c.req.param('id');
    if (!deps.skills.usage) return c.json({ ok: true, usage: null });
    const usage = await deps.skills.usage(7);
    return c.json({ ok: true, usage: usage[id] ?? null });
  });

  return app;
}
