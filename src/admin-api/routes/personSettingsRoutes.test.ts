import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  PersonMemoryConsent,
  PersonPreferences,
  PersonSettingsAdminPort,
} from '../../types/personal-settings.js';
import { createPersonSettingsRoutes } from './personSettingsRoutes.js';
import { bindAdminRequestSecurityContext } from './configRoutes.js';

const NOW = new Date('2026-11-01T10:00:00Z').getTime();

function preferences(personKey: string): PersonPreferences {
  return {
    personKey,
    replyLength: 'balanced',
    language: 'auto',
    addressAs: '',
    extraInstructions: '',
    enabled: true,
    updatedBy: '',
    updatedAt: NOW,
  };
}

function consent(personKey: string): PersonMemoryConsent {
  return {
    personKey,
    groupSharing: 'shareable',
    allowedConversationIds: [],
    updatedBy: '',
    updatedAt: NOW,
  };
}

function setup() {
  const recordAudit = vi.fn(async () => ({}));
  const configCenter = { recordAudit } as unknown as DynamicConfigCenter;
  const settings = {
    listPreferences: vi.fn(async () => []),
    getPreferences: vi.fn(async (personKey: string) => preferences(personKey)),
    updatePreferences: vi.fn(
      async (personKey: string, input, actor: string) => ({
        ...preferences(personKey),
        ...input,
        updatedBy: actor,
        updatedAt: NOW,
      }),
    ),
    listConsents: vi.fn(async () => []),
    getConsent: vi.fn(async (personKey: string) => consent(personKey)),
    updateConsent: vi.fn(
      async (personKey: string, input, actor: string) => ({
        ...consent(personKey),
        ...input,
        updatedBy: actor,
        updatedAt: NOW,
      }),
    ),
  };
  const app = new Hono();
  // 模拟生产 Admin 中间件绑定安全上下文，webActor 才会采信受信任的操作人头
  app.use('*', async (c, next) => {
    bindAdminRequestSecurityContext(c.req.raw, {
      trustActorHeader: true,
      role: 'admin',
    });
    await next();
  });
  app.route(
    '/api/v1/admin',
    createPersonSettingsRoutes({
      configCenter,
      settings: settings as unknown as PersonSettingsAdminPort,
    }),
  );
  return { app, settings, recordAudit };
}

describe('个人偏好与跨群授权接口', () => {
  it('GET preferences 支持列出与按 personKey 查询并归一别名', async () => {
    const { app, settings } = setup();
    const list = await app.request('/api/v1/admin/person-settings/preferences');
    expect(list.status).toBe(200);
    expect(settings.listPreferences).toHaveBeenCalledTimes(1);

    const single = await app.request(
      '/api/v1/admin/person-settings/preferences?personKey=staff%3A1',
    );
    expect(single.status).toBe(200);
    expect(settings.getPreferences).toHaveBeenCalledWith('staff:1');

    await app.request(
      '/api/v1/admin/person-settings/preferences?personKey=staff-2',
    );
    expect(settings.getPreferences).toHaveBeenLastCalledWith('staff:staff-2');
  });

  it('PUT preferences 校验枚举、归一 personKey 并写审计', async () => {
    const { app, settings, recordAudit } = setup();
    const missing = await app.request(
      '/api/v1/admin/person-settings/preferences',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replyLength: 'concise' }),
      },
    );
    expect(missing.status).toBe(400);

    const badLength = await app.request(
      '/api/v1/admin/person-settings/preferences',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personKey: 'staff-1', replyLength: 'huge' }),
      },
    );
    expect(badLength.status).toBe(400);
    expect(settings.updatePreferences).not.toHaveBeenCalled();

    const response = await app.request(
      '/api/v1/admin/person-settings/preferences',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-admin-staff-id': 'admin-1',
        },
        body: JSON.stringify({
          personKey: 'staff-1',
          replyLength: 'concise',
          language: 'en',
          addressAs: '小明',
          extraInstructions: '先给结论',
          enabled: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(settings.updatePreferences).toHaveBeenCalledWith(
      'staff:staff-1',
      {
        replyLength: 'concise',
        language: 'en',
        addressAs: '小明',
        extraInstructions: '先给结论',
        enabled: false,
      },
      'admin-1',
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminStaffId: 'admin-1',
        actionType: 'UPDATE_PERSON_SETTINGS',
      }),
    );
  });

  it('GET consents 支持列出与单查', async () => {
    const { app, settings } = setup();
    const list = await app.request('/api/v1/admin/person-settings/consents');
    expect(list.status).toBe(200);
    expect(settings.listConsents).toHaveBeenCalledTimes(1);

    const single = await app.request(
      '/api/v1/admin/person-settings/consents?personKey=staff%3A1',
    );
    expect(single.status).toBe(200);
    expect(settings.getConsent).toHaveBeenCalledWith('staff:1');
  });

  it('PUT consents 校验档位并透传白名单', async () => {
    const { app, settings } = setup();
    const bad = await app.request('/api/v1/admin/person-settings/consents', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personKey: 'staff-1', groupSharing: 'wide' }),
    });
    expect(bad.status).toBe(400);
    expect(settings.updateConsent).not.toHaveBeenCalled();

    const response = await app.request(
      '/api/v1/admin/person-settings/consents',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personKey: 'staff-1',
          groupSharing: 'all',
          allowedConversationIds: ['cid-group-1', ' cid-group-1 '],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(settings.updateConsent).toHaveBeenCalledWith(
      'staff:staff-1',
      {
        groupSharing: 'all',
        allowedConversationIds: ['cid-group-1', ' cid-group-1 '],
      },
      expect.any(String),
    );
  });
});
