import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  PersonIdentityAdminPort,
  PersonIdentityAliasSource,
  PersonaAdminPort,
  PersonaScope,
} from '../../types/persona-and-identity.js';
import { normalizeIdentityAlias } from '../../identity/PersonIdentityService.js';
import {
  readBoolean,
  readJsonBody,
  readString,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface PersonaRouteDeps {
  configCenter: DynamicConfigCenter;
  personas: PersonaAdminPort;
  identities: PersonIdentityAdminPort;
}

function parseScope(value: string): PersonaScope {
  if (value !== 'group' && value !== 'user') {
    throw new HTTPException(400, { message: 'scope 必须是 group 或 user' });
  }
  return value;
}

function normalizeSubject(scope: PersonaScope, raw: string): string {
  const subjectKey = raw.trim();
  if (!subjectKey) throw new HTTPException(400, { message: 'subjectKey 不能为空' });
  if (scope === 'user') {
    const normalized = normalizeIdentityAlias(subjectKey);
    return normalized?.alias ?? subjectKey;
  }
  return subjectKey;
}

const ALIAS_SOURCES: PersonIdentityAliasSource[] = [
  'staff',
  'open',
  'external',
  'manual',
];

export function createPersonaRoutes(deps: PersonaRouteDeps): Hono {
  const app = new Hono();

  app.get('/personas', async (c) => {
    const scopeRaw = c.req.query('scope');
    const scope = scopeRaw ? parseScope(scopeRaw) : undefined;
    const profiles = await deps.personas.list(scope);
    return c.json({ ok: true, profiles });
  });

  app.get('/personas/:scope/:subjectKey', async (c) => {
    const scope = parseScope(c.req.param('scope'));
    const subjectKey = normalizeSubject(scope, c.req.param('subjectKey'));
    const profile = await deps.personas.get(scope, subjectKey);
    if (!profile) {
      return c.json({ ok: false, error: '未找到人设配置' }, 404);
    }
    return c.json({ ok: true, profile });
  });

  app.put('/personas/:scope/:subjectKey', async (c) => {
    const scope = parseScope(c.req.param('scope'));
    const subjectKey = normalizeSubject(scope, c.req.param('subjectKey'));
    const body = await readJsonBody(c);
    const before = await deps.personas.get(scope, subjectKey);
    const name = readString(body, 'name');
    const rolePrompt = readString(body, 'rolePrompt');
    const speakingStyle = readString(body, 'speakingStyle');
    const enabled = readBoolean(body, 'enabled');
    if (
      !before &&
      !name?.trim() &&
      !rolePrompt?.trim() &&
      !speakingStyle?.trim()
    ) {
      throw new HTTPException(400, {
        message: '新建人设至少需要 name、rolePrompt 或 speakingStyle 之一',
      });
    }
    const profile = await deps.personas.upsert(
      scope,
      subjectKey,
      {
        ...(name !== undefined ? { name } : {}),
        ...(rolePrompt !== undefined ? { rolePrompt } : {}),
        ...(speakingStyle !== undefined ? { speakingStyle } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
      webActor(c),
    );
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_PERSONA',
      before ? { ...before } : {},
      { ...profile },
    );
    return c.json({ ok: true, profile });
  });

  app.delete('/personas/:scope/:subjectKey', async (c) => {
    const scope = parseScope(c.req.param('scope'));
    const subjectKey = normalizeSubject(scope, c.req.param('subjectKey'));
    const before = await deps.personas.get(scope, subjectKey);
    const removed = await deps.personas.remove(scope, subjectKey);
    if (removed) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'DELETE_PERSONA',
        before ? { ...before } : { scope, subjectKey },
        {},
      );
    }
    return c.json({ ok: true, removed });
  });

  app.get('/identities', async (c) => {
    const query = c.req.query('query')?.trim();
    const people = await deps.identities.list(query);
    return c.json({ ok: true, people });
  });

  app.post('/identities/bind', async (c) => {
    const body = await readJsonBody(c);
    const alias = readString(body, 'alias', { required: true })!;
    const staffId = readString(body, 'staffId');
    const personKey = readString(body, 'personKey');
    const displayName = readString(body, 'displayName');
    const source = readString(body, 'source');
    if (source && !ALIAS_SOURCES.includes(source as PersonIdentityAliasSource)) {
      throw new HTTPException(400, {
        message: `source 必须是 ${ALIAS_SOURCES.join(' / ')}`,
      });
    }
    if (!staffId?.trim() && !personKey?.trim()) {
      throw new HTTPException(400, {
        message: '需要提供 staffId 或 personKey',
      });
    }
    const mergeMemories = readBoolean(body, 'mergeMemories');
    const outcome = await deps.identities.bind({
      alias,
      ...(source ? { source: source as PersonIdentityAliasSource } : {}),
      ...(staffId?.trim() ? { staffId } : {}),
      ...(personKey?.trim() ? { personKey } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(mergeMemories !== undefined ? { mergeMemories } : {}),
    });
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'BIND_PERSON_IDENTITY',
      { alias },
      { ...outcome },
    );
    return c.json({ ok: true, ...outcome });
  });

  return app;
}
