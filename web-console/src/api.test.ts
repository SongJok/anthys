import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, chatStreamUrl, getToken, setToken } from './api';

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return store;
}

describe('web-console api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses same-origin credentials on session and admin requests', async () => {
    const store = installMemoryStorage();
    store.set('dingtalk-agent-admin-token', 'legacy-secret');

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        authRequired: true,
        authenticated: true,
        role: 'admin',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const loginResult = await api.loginSession('new-token');
    expect(loginResult).toMatchObject({
      authenticated: true,
      role: 'admin',
    });
    expect(getToken()).toBe('');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      }),
    );

    await api.session();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/auth/session',
      expect.objectContaining({
        credentials: 'same-origin',
      }),
    );

    await api.logoutSession();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/auth/session',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'same-origin',
      }),
    );
  });

  it('surfaces backend error messages on failed requests and builds ticket URLs', async () => {
    installMemoryStorage();
    setToken('');
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        ok: false,
        error: '只读凭证禁止写入',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.dashboard()).rejects.toThrow('只读凭证禁止写入');
    expect(chatStreamUrl('ticket-1', '查日志', 'system rule')).toBe(
      '/api/v1/chat/stream?ticket=ticket-1&question=%E6%9F%A5%E6%97%A5%E5%BF%97&systemPrompt=system+rule',
    );
  });
});
