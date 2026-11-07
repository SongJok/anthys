import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  SemanticMemoryAdminPort,
  SemanticMemoryKind,
  SemanticMemoryPatch,
  SemanticMemoryScope,
  SemanticMemorySensitivity,
  SemanticMemoryStatus,
} from '../../types/bystander-and-memory.js';
import {
  readBoolean,
  readJsonBody,
  readNumber,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface MemoryRouteDeps {
  configCenter: DynamicConfigCenter;
  memories: SemanticMemoryAdminPort;
}

const SCOPES: SemanticMemoryScope[] = [
  'global',
  'group',
  'group_member',
  'user',
];
const KINDS: SemanticMemoryKind[] = ['terminology', 'profile'];
const STATUSES: SemanticMemoryStatus[] = ['active', 'retired'];
const SENSITIVITIES: SemanticMemorySensitivity[] = [
  'normal',
  'private',
  'sensitive',
];

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: T[],
  field: string,
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) {
    throw new HTTPException(400, {
      message: `${field} 必须是 ${allowed.join(' / ')}`,
    });
  }
  return value as T;
}

export function createMemoryRoutes(deps: MemoryRouteDeps): Hono {
  const app = new Hono();

  app.get('/memories', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 50);
    const offsetRaw = Number(c.req.query('offset') ?? 0);
    const scope = parseEnum(c.req.query('scope'), SCOPES, 'scope');
    const kind = parseEnum(c.req.query('kind'), KINDS, 'kind');
    const status = parseEnum(c.req.query('status'), STATUSES, 'status');
    const result = await deps.memories.list({
      ...(scope ? { scope } : {}),
      ...(c.req.query('subjectKey')?.trim()
        ? { subjectKey: c.req.query('subjectKey')!.trim() }
        : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(c.req.query('query')?.trim()
        ? { query: c.req.query('query')!.trim() }
        : {}),
      limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
    });
    return c.json({ ok: true, ...result });
  });

  app.patch('/memories/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const before = await deps.memories.get(id);
    if (!before) {
      return c.json({ ok: false, error: '未找到语义记忆' }, 404);
    }
    const content = readString(body, 'content');
    if (content !== undefined && !content.trim()) {
      throw new HTTPException(400, { message: 'content 不能为空' });
    }
    const sensitivity = parseEnum(
      readString(body, 'sensitivity'),
      SENSITIVITIES,
      'sensitivity',
    );
    const status = parseEnum(
      readString(body, 'status'),
      STATUSES,
      'status',
    );
    const confidence = readNumber(body, 'confidence');
    if (
      confidence !== undefined &&
      (confidence < 0 || confidence > 1)
    ) {
      throw new HTTPException(400, {
        message: 'confidence 必须在 0–1 之间',
      });
    }
    const patch: SemanticMemoryPatch = {
      ...(content !== undefined ? { content: content.trim() } : {}),
      ...(readStringArray(body, 'keywords') !== undefined
        ? { keywords: readStringArray(body, 'keywords')! }
        : {}),
      ...(readBoolean(body, 'shareableInGroup') !== undefined
        ? { shareableInGroup: readBoolean(body, 'shareableInGroup')! }
        : {}),
      ...(sensitivity ? { sensitivity } : {}),
      ...(status ? { status } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    };
    if (Object.prototype.hasOwnProperty.call(body, 'expiresAt')) {
      const raw = body.expiresAt;
      if (raw === null) {
        patch.expiresAt = null;
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        patch.expiresAt = raw;
      } else {
        throw new HTTPException(400, {
          message: 'expiresAt 必须是 epoch 毫秒数或 null',
        });
      }
    }
    const memory = await deps.memories.update(id, patch);
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_SEMANTIC_MEMORY',
      { ...before },
      { ...memory },
    );
    return c.json({ ok: true, memory });
  });

  app.delete('/memories/:id', async (c) => {
    const id = c.req.param('id');
    const before = await deps.memories.get(id);
    const removed = await deps.memories.remove(id);
    if (removed) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'DELETE_SEMANTIC_MEMORY',
        before ? { ...before } : { id },
        {},
      );
    }
    return c.json({ ok: true, removed });
  });

  return app;
}
