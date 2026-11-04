import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  UserWhitelistAdminPort,
  WhitelistStatus,
} from '../../types/whitelist.js';
import {
  readJsonBody,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface WhitelistRouteDeps {
  whitelist: UserWhitelistAdminPort;
  configCenter: DynamicConfigCenter;
}

function isWhitelistStatus(value: string): value is WhitelistStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

function readStatus(value: string | undefined): WhitelistStatus {
  if (!value || !isWhitelistStatus(value)) {
    throw new HTTPException(400, {
      message: 'status 必须是 pending、approved 或 rejected',
    });
  }
  return value;
}

export function createWhitelistRoutes(deps: WhitelistRouteDeps): Hono {
  const app = new Hono();
  const actorOf = (c: Parameters<typeof webActor>[0]): string => webActor(c);

  app.get('/whitelist', async (c) => {
    const status = c.req.query('status');
    const page = Number(c.req.query('page') ?? 1);
    const pageSize = Number(c.req.query('pageSize') ?? 20);
    const result = await deps.whitelist.list({
      ...(status && isWhitelistStatus(status) ? { status } : {}),
      ...(c.req.query('query')?.trim()
        ? { query: c.req.query('query')!.trim() }
        : {}),
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    });
    return c.json({ ok: true, ...result });
  });

  app.get('/whitelist/stats', async (c) =>
    c.json({ ok: true, stats: await deps.whitelist.stats() }),
  );

  app.post('/whitelist/sync', async (c) => {
    let result;
    try {
      result = await deps.whitelist.sync();
    } catch (error) {
      throw new HTTPException(502, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'SYNC_WHITELIST',
      {},
      {
        source: result.source,
        scanned: result.scanned,
        created: result.created,
        updated: result.updated,
      },
    );
    return c.json({ ok: true, result });
  });

  app.put('/whitelist/:staffId', async (c) => {
    const staffId = c.req.param('staffId').trim();
    if (!staffId) {
      throw new HTTPException(400, { message: 'staffId 不能为空' });
    }
    const body = await readJsonBody(c);
    const status = readStatus(readString(body, 'status'));
    const note = readString(body, 'note');
    const actor = actorOf(c);
    const before = (await deps.whitelist.list({ query: staffId, pageSize: 1 }))
      .items.find((item) => item.staffId === staffId);
    const entry = await deps.whitelist.setStatus(
      staffId,
      status,
      actor,
      note,
    );
    if (!entry) {
      throw new HTTPException(404, { message: `白名单中不存在员工 ${staffId}` });
    }
    await recordWebAudit(
      deps.configCenter,
      actor,
      'UPDATE_WHITELIST',
      before ? { ...before } : {},
      { ...entry },
    );
    return c.json({ ok: true, entry });
  });

  app.post('/whitelist/batch', async (c) => {
    const body = await readJsonBody(c);
    const staffIds = readStringArray(body, 'staffIds') ?? [];
    const ids = staffIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new HTTPException(400, { message: 'staffIds 不能为空' });
    }
    const status = readStatus(readString(body, 'status'));
    const actor = actorOf(c);
    const updated = await deps.whitelist.setStatusBatch(ids, status, actor);
    await recordWebAudit(
      deps.configCenter,
      actor,
      'UPDATE_WHITELIST',
      { staffIds: ids },
      { status, updated },
    );
    return c.json({ ok: true, updated });
  });

  return app;
}
