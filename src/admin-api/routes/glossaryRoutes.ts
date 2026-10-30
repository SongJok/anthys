import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import {
  GlossaryConflictError,
  GlossaryNotFoundError,
  GlossaryValidationError,
  isGlossarySensitivity,
  isGlossaryTimeliness,
  type GlossaryAdminPort,
  type GlossaryListFilter,
  type GlossarySensitivity,
  type GlossaryTerm,
  type GlossaryTermInput,
  type GlossaryTermPatch,
  type GlossaryTimeliness,
} from '../../types/glossary.js';
import {
  readBoolean,
  readJsonBody,
  readNumber,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface GlossaryRouteDeps {
  glossary: GlossaryAdminPort;
  configCenter?: DynamicConfigCenter;
}

/** 审计只保留元数据，避免敏感级别术语正文被复制进审计表 */
function auditSnapshot(term: GlossaryTerm): Record<string, unknown> {
  return {
    id: term.id,
    standardName: term.standardName,
    timeliness: term.timeliness,
    sensitivity: term.sensitivity,
    injectToPrompt: term.injectToPrompt,
  };
}

function mapServiceError(error: unknown): never {
  if (error instanceof GlossaryConflictError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof GlossaryValidationError) {
    throw new HTTPException(400, { message: error.message });
  }
  if (error instanceof GlossaryNotFoundError) {
    throw new HTTPException(404, { message: error.message });
  }
  throw error;
}

function readGlossaryPatch(body: Record<string, unknown>): GlossaryTermPatch {
  const timelinessRaw = readString(body, 'timeliness');
  let timeliness: GlossaryTimeliness | undefined;
  if (timelinessRaw !== undefined) {
    if (!isGlossaryTimeliness(timelinessRaw)) {
      throw new HTTPException(400, {
        message: 'timeliness 必须是 long_term / project / retired',
      });
    }
    timeliness = timelinessRaw;
  }
  const sensitivityRaw = readString(body, 'sensitivity');
  let sensitivity: GlossarySensitivity | undefined;
  if (sensitivityRaw !== undefined) {
    if (!isGlossarySensitivity(sensitivityRaw)) {
      throw new HTTPException(400, {
        message: 'sensitivity 必须是 public / team / sensitive',
      });
    }
    sensitivity = sensitivityRaw;
  }
  const aliases = readStringArray(body, 'aliases');
  const examples = readStringArray(body, 'examples');
  const docLinks = readStringArray(body, 'docLinks');
  const standardName = readString(body, 'standardName');
  const definition = readString(body, 'definition');
  const usageScenarios = readString(body, 'usageScenarios');
  const misconceptions = readString(body, 'misconceptions');
  const department = readString(body, 'department');
  const injectToPrompt = readBoolean(body, 'injectToPrompt');
  const promptPriority = readNumber(body, 'promptPriority');
  return {
    ...(standardName !== undefined ? { standardName } : {}),
    ...(definition !== undefined ? { definition } : {}),
    ...(usageScenarios !== undefined ? { usageScenarios } : {}),
    ...(misconceptions !== undefined ? { misconceptions } : {}),
    ...(department !== undefined ? { department } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(examples !== undefined ? { examples } : {}),
    ...(docLinks !== undefined ? { docLinks } : {}),
    ...(timeliness !== undefined ? { timeliness } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
    ...(injectToPrompt !== undefined ? { injectToPrompt } : {}),
    ...(promptPriority !== undefined ? { promptPriority } : {}),
  };
}

/** 术语知识库：检索、创建、更新、删除、质量校验与系统提示预览 */
export function createGlossaryRoutes(deps: GlossaryRouteDeps): Hono {
  const app = new Hono();

  app.get('/glossary', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 200);
    const offsetRaw = Number(c.req.query('offset') ?? 0);
    const timelinessRaw = c.req.query('timeliness');
    const sensitivityRaw = c.req.query('sensitivity');
    const sort = c.req.query('sort');
    let timeliness: GlossaryTimeliness | undefined;
    if (timelinessRaw) {
      if (!isGlossaryTimeliness(timelinessRaw)) {
        throw new HTTPException(400, {
          message: 'timeliness 必须是 long_term / project / retired',
        });
      }
      timeliness = timelinessRaw;
    }
    let sensitivity: GlossarySensitivity | undefined;
    if (sensitivityRaw) {
      if (!isGlossarySensitivity(sensitivityRaw)) {
        throw new HTTPException(400, {
          message: 'sensitivity 必须是 public / team / sensitive',
        });
      }
      sensitivity = sensitivityRaw;
    }
    const filter: GlossaryListFilter = {
      ...(c.req.query('query')?.trim()
        ? { query: c.req.query('query')!.trim() }
        : {}),
      ...(c.req.query('department')?.trim()
        ? { department: c.req.query('department')!.trim() }
        : {}),
      ...(timeliness ? { timeliness } : {}),
      ...(sensitivity ? { sensitivity } : {}),
      ...(c.req.query('onlyInjected') === 'true' ? { onlyInjected: true } : {}),
      ...(sort === 'hits' || sort === 'priority' || sort === 'updated'
        ? { sort }
        : {}),
      limit: Number.isFinite(limitRaw) ? limitRaw : 200,
      offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
    };
    const result = await deps.glossary.list(filter);
    return c.json({ ok: true, ...result });
  });

  app.get('/glossary/stats', async (c) => {
    return c.json({ ok: true, stats: await deps.glossary.stats() });
  });

  app.get('/glossary/validate', async (c) => {
    return c.json({ ok: true, report: await deps.glossary.validate() });
  });

  app.get('/glossary/prompt-preview', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? NaN);
    const preview = await deps.glossary.previewPrompt(
      Number.isFinite(limitRaw) ? limitRaw : undefined,
    );
    return c.json({ ok: true, ...preview });
  });

  app.get('/glossary/:id', async (c) => {
    const term = await deps.glossary.get(c.req.param('id'));
    if (!term) {
      throw new HTTPException(404, { message: '未找到术语' });
    }
    return c.json({ ok: true, term });
  });

  app.post('/glossary', async (c) => {
    const body = await readJsonBody(c);
    const standardName = readString(body, 'standardName', { required: true })!;
    const definition = readString(body, 'definition', { required: true })!;
    const patch = readGlossaryPatch(body);
    let term: GlossaryTerm;
    try {
      term = await deps.glossary.create(
        { ...patch, standardName, definition } satisfies GlossaryTermInput,
        webActor(c),
      );
    } catch (error) {
      mapServiceError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_GLOSSARY',
        {},
        { action: 'create', term: auditSnapshot(term) },
      );
    }
    return c.json({ ok: true, term });
  });

  app.put('/glossary/:id', async (c) => {
    const id = c.req.param('id');
    const before = await deps.glossary.get(id);
    if (!before) {
      throw new HTTPException(404, { message: '未找到术语' });
    }
    const body = await readJsonBody(c);
    const patch = readGlossaryPatch(body);
    let term: GlossaryTerm;
    try {
      term = await deps.glossary.update(id, patch, webActor(c));
    } catch (error) {
      mapServiceError(error);
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_GLOSSARY',
        { action: 'update', term: auditSnapshot(before) },
        { action: 'update', term: auditSnapshot(term) },
      );
    }
    return c.json({ ok: true, term });
  });

  app.delete('/glossary/:id', async (c) => {
    const id = c.req.param('id');
    const before = await deps.glossary.get(id);
    const removed = await deps.glossary.remove(id);
    if (!removed) {
      throw new HTTPException(404, { message: '未找到术语' });
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_GLOSSARY',
        { action: 'delete', term: before ? auditSnapshot(before) : { id } },
        {},
      );
    }
    return c.json({ ok: true, removed });
  });

  return app;
}
