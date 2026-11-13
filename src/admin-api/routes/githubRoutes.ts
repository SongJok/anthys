import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  ExternalTaskEvent,
  RouteExternalEventResult,
} from '../../tasks/TaskService.js';
import type { GithubAdminPort } from '../../types/skills-plugins-projects.js';
import type { ExternalTaskLinkRef } from '../../types/tasks.js';
import type { MetricsRegistry } from '../metrics.js';
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

export interface GithubWebhookDeps {
  /** Webhook 签名密钥；未配置时 fail-closed 返回 503 */
  secret?: string;
  onEvent?: (event: ExternalTaskEvent) => Promise<RouteExternalEventResult | void>;
  metrics?: MetricsRegistry;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const left = Buffer.from(signatureHeader, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(obj: Record<string, unknown> | undefined, key: string): string {
  const val = obj?.[key];
  return typeof val === 'string' ? val.trim() : '';
}

function asNum(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const val = obj?.[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

export function extractGithubTaskEvent(
  eventName: string,
  deliveryId: string | undefined,
  payload: Record<string, unknown>,
): ExternalTaskEvent {
  const repo = asRecord(payload.repository);
  const repoFullName = asText(repo, 'full_name');
  const repoUrl = asText(repo, 'html_url');
  const action = asText(payload, 'action');
  const pr = asRecord(payload.pull_request);
  const issue = asRecord(payload.issue);
  const workflowRun = asRecord(payload.workflow_run);
  const checkRun = asRecord(payload.check_run);
  const sender = asText(asRecord(payload.sender), 'login');

  const refs: ExternalTaskLinkRef[] = [];
  const addRef = (kind: ExternalTaskLinkRef['kind'], ref: string): void => {
    const trimmed = ref.trim();
    if (!trimmed) return;
    if (!refs.some((item) => item.kind === kind && item.ref === trimmed)) {
      refs.push({ kind, ref: trimmed });
    }
  };

  let subject = '';
  const target = pr ?? issue;
  if (target) {
    const number = asNum(target, 'number');
    const htmlUrl = asText(target, 'html_url');
    const title = asText(target, 'title');
    if (htmlUrl) addRef('url', htmlUrl);
    if (repoFullName && number !== undefined) {
      addRef('issue', `${repoFullName}#${number}`);
    }
    subject = `#${number ?? '?'} ${title}`.trim();
  } else if (workflowRun) {
    const htmlUrl = asText(workflowRun, 'html_url');
    const name = asText(workflowRun, 'name') || 'workflow';
    const conclusion = asText(workflowRun, 'conclusion') || asText(workflowRun, 'status');
    if (htmlUrl) addRef('url', htmlUrl);
    const pullRequests = Array.isArray(workflowRun.pull_requests)
      ? workflowRun.pull_requests
      : [];
    for (const item of pullRequests) {
      const prNum = asNum(asRecord(item), 'number');
      if (repoFullName && prNum !== undefined) {
        addRef('issue', `${repoFullName}#${prNum}`);
      }
    }
    if (repoFullName) addRef('other', repoFullName);
    if (repoUrl) addRef('url', repoUrl);
    subject = `${name}${conclusion ? ` (${conclusion})` : ''}`;
  } else if (checkRun) {
    const htmlUrl = asText(checkRun, 'html_url');
    const name = asText(checkRun, 'name') || 'check';
    const conclusion = asText(checkRun, 'conclusion') || asText(checkRun, 'status');
    if (htmlUrl) addRef('url', htmlUrl);
    if (repoFullName) addRef('other', repoFullName);
    subject = `${name}${conclusion ? ` (${conclusion})` : ''}`;
  } else {
    const compareUrl = asText(payload, 'compare');
    if (compareUrl) addRef('url', compareUrl);
    if (repoUrl) addRef('url', repoUrl);
    if (repoFullName) addRef('other', repoFullName);
    subject = asText(payload, 'ref') || repoFullName || eventName;
  }

  const eventType = action ? `${eventName}.${action}` : eventName;
  const summaryParts = [
    repoFullName || undefined,
    subject || undefined,
    sender ? `by @${sender}` : undefined,
  ].filter(Boolean);

  return {
    source: 'github',
    eventType,
    ...(deliveryId ? { deliveryId } : {}),
    summary: summaryParts.join(' · ') || eventType,
    refs,
    payload: {
      ...(repoFullName ? { repo: repoFullName } : {}),
      ...(action ? { action } : {}),
      ...(sender ? { sender } : {}),
    },
  };
}

/** POST /github （挂载于 /api/v1/webhooks/github）：验签并按关联引用路由至任务线程 */
export function createGithubWebhookRoutes(deps: GithubWebhookDeps): Hono {
  const app = new Hono();

  app.post('/github', async (c) => {
    const secret = (
      deps.secret ??
      process.env.GITHUB_WEBHOOK_SECRET ??
      ''
    ).trim();
    if (!secret) {
      return c.json(
        {
          ok: false,
          error: 'GITHUB_WEBHOOK_SECRET 未配置，GitHub Webhook 已关闭',
        },
        503,
      );
    }

    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256');
    if (!verifyGithubSignature(rawBody, signature, secret)) {
      deps.metrics?.inc('github_webhook_rejected_total');
      return c.json({ ok: false, error: 'GitHub Webhook 签名校验失败' }, 401);
    }

    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return c.json({ ok: false, error: 'Webhook 请求体不是合法 JSON' }, 400);
    }
    const payload = asRecord(parsed);
    if (!payload) {
      return c.json({ ok: false, error: 'Webhook 请求体必须是 JSON 对象' }, 400);
    }

    const eventName = (c.req.header('x-github-event') ?? 'unknown').trim() || 'unknown';
    const deliveryId = (c.req.header('x-github-delivery') ?? '').trim() || undefined;
    deps.metrics?.inc('github_webhook_total');

    if (eventName === 'ping') {
      return c.json({
        ok: true,
        event: 'ping',
        ...(deliveryId ? { deliveryId } : {}),
        matchedTaskIds: [],
      });
    }

    const event = extractGithubTaskEvent(eventName, deliveryId, payload);
    const result = deps.onEvent ? await deps.onEvent(event) : undefined;
    const matchedTaskIds =
      result?.matchedTasks.map((item) => item.task.id) ?? [];

    deps.logger?.info(
      {
        event: event.eventType,
        deliveryId: deliveryId ?? null,
        refsCount: event.refs.length,
        matchedTasks: matchedTaskIds.length,
      },
      'processed verified GitHub webhook event',
    );

    return c.json({
      ok: true,
      event: event.eventType,
      ...(deliveryId ? { deliveryId } : {}),
      matchedTaskIds,
      notificationsSent: result?.notificationsSent ?? 0,
    });
  });

  return app;
}
