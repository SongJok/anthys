import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { DataGovernancePort, RetentionPolicy } from '../governance/DataRetention.js';
import { readJsonBody, readBoolean, readNumber, readString, recordWebAudit, webActor } from '../admin-api/routes/configRoutes.js';

export interface GovernanceRouteDeps {
  governance: DataGovernancePort;
  configCenter?: DynamicConfigCenter;
}

function readPolicy(body: Record<string, unknown>): Partial<RetentionPolicy> {
  return {
    ...(readNumber(body, 'messagesDays') !== undefined
      ? { messagesDays: readNumber(body, 'messagesDays')! }
      : {}),
    ...(readNumber(body, 'tracesDays') !== undefined
      ? { tracesDays: readNumber(body, 'tracesDays')! }
      : {}),
    ...(readNumber(body, 'attachmentsHours') !== undefined
      ? { attachmentsHours: readNumber(body, 'attachmentsHours')! }
      : {}),
    ...(readNumber(body, 'auditDays') !== undefined
      ? { auditDays: readNumber(body, 'auditDays')! }
      : {}),
    ...(readNumber(body, 'usageDays') !== undefined
      ? { usageDays: readNumber(body, 'usageDays')! }
      : {}),
  };
}

/** 数据治理：保留期、带 dry-run 的清理、按用户/会话级联删除 */
export function createGovernanceRoutes(deps: GovernanceRouteDeps): Hono {
  const app = new Hono();

  app.get('/governance', async (c) => {
    const stats = await deps.governance.stats();
    return c.json({ ok: true, ...stats });
  });

  app.put('/governance/retention', async (c) => {
    const body = await readJsonBody(c);
    const before = deps.governance.getPolicy();
    let policy: RetentionPolicy;
    try {
      policy = await deps.governance.updatePolicy(readPolicy(body));
    } catch (error) {
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_RETENTION',
        before as unknown as Record<string, unknown>,
        policy as unknown as Record<string, unknown>,
      );
    }
    return c.json({ ok: true, policy });
  });

  app.post('/governance/cleanup', async (c) => {
    const body = await readJsonBody(c);
    const dryRun = readBoolean(body, 'dryRun') ?? true;
    const result = await deps.governance.cleanup({ dryRun });
    if (!dryRun && deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'PURGE_DATA',
        { dryRun },
        { deleted: result.deleted },
      );
    }
    return c.json({ ok: true, result });
  });

  app.post('/governance/delete-conversation', async (c) => {
    const body = await readJsonBody(c);
    const conversationId = readString(body, 'conversationId', { required: true })!;
    if (readBoolean(body, 'confirm') !== true) {
      throw new HTTPException(400, {
        message: '级联删除不可撤销，请传 confirm: true',
      });
    }
    const result = await deps.governance.deleteConversation(conversationId);
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'DELETE_USER_DATA',
        { conversationId },
        { deleted: result.deleted, attachmentsRemoved: result.attachmentsRemoved },
      );
    }
    return c.json({ ok: true, result });
  });

  app.post('/governance/delete-user', async (c) => {
    const body = await readJsonBody(c);
    const staffId = readString(body, 'staffId', { required: true })!;
    if (readBoolean(body, 'confirm') !== true) {
      throw new HTTPException(400, {
        message: '级联删除不可撤销，请传 confirm: true',
      });
    }
    const result = await deps.governance.deleteUser(staffId);
    if (deps.configCenter) {
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'DELETE_USER_DATA',
        { staffId },
        { deleted: result.deleted, attachmentsRemoved: result.attachmentsRemoved },
      );
    }
    return c.json({ ok: true, result });
  });

  return app;
}
