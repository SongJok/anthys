import { describe, expect, it } from 'vitest';
import { DingTalkContactDirectorySource } from './DirectorySources.js';

function json(payload: unknown): Response {
  return { json: async () => payload } as unknown as Response;
}

function fetcherFor(
  handler: (path: string, body: Record<string, unknown>) => unknown,
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes('/gettoken')) {
      return json({ errcode: 0, errmsg: 'ok', access_token: 'token' });
    }
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return json({ errcode: 0, errmsg: 'ok', result: handler(path, body) });
  }) as unknown as typeof fetch;
}

describe('DingTalkContactDirectorySource', () => {
  it('解析 v2 listsub 返回的部门数组并遍历子部门', async () => {
    const source = new DingTalkContactDirectorySource(
      () => ({ clientId: 'id', clientSecret: 'secret' }),
      undefined,
      fetcherFor((path, body) => {
        if (path.endsWith('/listsub')) {
          return body.id === 1 ? [{ dept_id: 10, name: '技术部' }] : [];
        }
        if (path.endsWith('/user/list')) {
          return body.dept_id === 10
            ? {
                has_more: false,
                list: [{ userid: 'u1', name: '张三', active: true }],
              }
            : { has_more: false, list: [] };
        }
        return {};
      }),
    );

    await expect(source.fetchUsers()).resolves.toEqual([
      { staffId: 'u1', name: '张三', deptPath: '技术部' },
    ]);
  });

  it('跳过 active=false 的离职员工', async () => {
    const source = new DingTalkContactDirectorySource(
      () => ({ clientId: 'id', clientSecret: 'secret' }),
      undefined,
      fetcherFor((path, body) => {
        if (path.endsWith('/listsub')) return [];
        if (path.endsWith('/user/list')) {
          return {
            has_more: false,
            list: [
              { userid: 'u1', name: '在职员工', active: true },
              { userid: 'u2', name: '离职员工', active: false },
            ],
          };
        }
        return {};
      }),
    );

    const users = await source.fetchUsers();
    expect(users.map((user) => user.staffId)).toEqual(['u1']);
  });
});
