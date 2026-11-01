import { Hono } from 'hono';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type { GithubAdminPort } from '../../types/skills-plugins-projects.js';
import {
  readJsonBody,
  readString,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface GithubRouteDeps {
  github: GithubAdminPort;
  configCenter?: DynamicConfigCenter;
}

export function createGithubRoutes(deps: GithubRouteDeps): Hono {
  const app = new Hono();

  app.get('/github/status', async (c) =>
    c.json({ ok: true, status: await deps.github.status() }),
  );

  app.post('/github/test', async (c) => {
    const body = await readJsonBody(c);
    const repo = readString(body, 'repo')?.trim() || undefined;
    const result = await deps.github.test(repo);
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'TEST_GITHUB',
        { repo: repo ?? '' },
        {
          action: 'test-connection',
          repo: result.repo,
          ok: result.ok,
          latencyMs: result.latencyMs,
          ...(result.fullName ? { fullName: result.fullName } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
      );
    }
    return c.json({ ok: result.ok, result });
  });

  return app;
}
