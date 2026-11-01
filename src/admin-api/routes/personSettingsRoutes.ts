import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type { PersonSettingsAdminPort } from '../../types/personal-settings.js';
import {
  isGroupMemorySharing,
  isPreferenceLanguage,
  isReplyLength,
} from '../../types/personal-settings.js';
import { normalizeIdentityAlias } from '../../identity/PersonIdentityService.js';
import {
  readBoolean,
  readJsonBody,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface PersonSettingsRouteDeps {
  configCenter: DynamicConfigCenter;
  settings: PersonSettingsAdminPort;
}

function normalizePersonKey(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value) throw new HTTPException(400, { message: 'personKey 不能为空' });
  return normalizeIdentityAlias(value)?.alias ?? value;
}

export function createPersonSettingsRoutes(
  deps: PersonSettingsRouteDeps,
): Hono {
  const app = new Hono();

  app.get('/person-settings/preferences', async (c) => {
    const raw = c.req.query('personKey');
    if (raw?.trim()) {
      const personKey = normalizePersonKey(raw);
      return c.json({
        ok: true,
        preferences: await deps.settings.getPreferences(personKey),
      });
    }
    return c.json({
      ok: true,
      preferences: await deps.settings.listPreferences(),
    });
  });

  app.put('/person-settings/preferences', async (c) => {
    const body = await readJsonBody(c);
    const personKey = normalizePersonKey(readString(body, 'personKey'));
    const replyLength = readString(body, 'replyLength')?.trim();
    if (replyLength && !isReplyLength(replyLength)) {
      throw new HTTPException(400, {
        message: 'replyLength 必须是 concise / balanced / detailed',
      });
    }
    const language = readString(body, 'language')?.trim();
    if (language && !isPreferenceLanguage(language)) {
      throw new HTTPException(400, {
        message: 'language 必须是 auto / zh / en',
      });
    }
    const enabled = readBoolean(body, 'enabled');
    const before = await deps.settings.getPreferences(personKey);
    const preferences = await deps.settings.updatePreferences(
      personKey,
      {
        ...(replyLength && isReplyLength(replyLength) ? { replyLength } : {}),
        ...(language && isPreferenceLanguage(language) ? { language } : {}),
        ...(readString(body, 'addressAs') !== undefined
          ? { addressAs: readString(body, 'addressAs')! }
          : {}),
        ...(readString(body, 'extraInstructions') !== undefined
          ? { extraInstructions: readString(body, 'extraInstructions')! }
          : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
      webActor(c),
    );
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_PERSON_SETTINGS',
      { ...before },
      { ...preferences },
    );
    return c.json({ ok: true, preferences });
  });

  app.get('/person-settings/consents', async (c) => {
    const raw = c.req.query('personKey');
    if (raw?.trim()) {
      const personKey = normalizePersonKey(raw);
      return c.json({
        ok: true,
        consent: await deps.settings.getConsent(personKey),
      });
    }
    return c.json({ ok: true, consents: await deps.settings.listConsents() });
  });

  app.put('/person-settings/consents', async (c) => {
    const body = await readJsonBody(c);
    const personKey = normalizePersonKey(readString(body, 'personKey'));
    const groupSharing = readString(body, 'groupSharing')?.trim();
    if (groupSharing && !isGroupMemorySharing(groupSharing)) {
      throw new HTTPException(400, {
        message: 'groupSharing 必须是 off / shareable / all',
      });
    }
    const allowedConversationIds = readStringArray(
      body,
      'allowedConversationIds',
    );
    const before = await deps.settings.getConsent(personKey);
    const consent = await deps.settings.updateConsent(
      personKey,
      {
        ...(groupSharing && isGroupMemorySharing(groupSharing)
          ? { groupSharing }
          : {}),
        ...(allowedConversationIds !== undefined
          ? { allowedConversationIds }
          : {}),
      },
      webActor(c),
    );
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_PERSON_SETTINGS',
      { ...before },
      { ...consent },
    );
    return c.json({ ok: true, consent });
  });

  return app;
}
