import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type {
  GroupDirectory,
  LlmSandboxTestResult,
  McpServerStatusView,
  McpServerTestResult,
  ReActTraceStore,
} from '../types/admin-and-console.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import { createConfigRoutes } from './routes/configRoutes.js';
import { createMcpRoutes } from './routes/mcpRoutes.js';
import {
  handleChatStream,
  OneTimeTicketStore,
  type ChatStreamDeps,
  type ConsoleChatHandler,
} from './chatStream.js';
import type { MetricsRegistry } from './metrics.js';

export interface AdminApiLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AdminApiOptions {
  configCenter: DynamicConfigCenter;
  traces: ReActTraceStore;
  groups: GroupDirectory;
  mcp: {
    status(): McpServerStatusView[];
    applyServers(servers: EnterpriseMcpServerConfig[]): Promise<unknown>;
    testServer?(serverId: string): Promise<McpServerTestResult>;
  };
  llmTester?: (input: {
    question: string;
    systemPrompt?: string;
  }) => Promise<LlmSandboxTestResult>;
  dingtalkTester?: {
    streamStatus(): { connected: boolean; detail?: string };
    sendTestCard(staffId?: string): Promise<{ ok: boolean; error?: string }>;
  };
  /** Bearer Token；留空则开放访问（仅限本地开发） */
  authToken?: string;
  /** web-console 生产构建目录，存在时由后端静态托管 */
  staticDir?: string;
  logger?: AdminApiLogger;
  now?: () => number;
  /** 控制台 SSE 在线对话 */
  chatStream?: ConsoleChatHandler;
  /** 就绪探针：数据库 / Stream 连接状态 */
  readiness?: () =>
    | { ready: boolean; detail?: string }
    | Promise<{ ready: boolean; detail?: string }>;
  metrics?: MetricsRegistry;
  ticketTtlMs?: number;
  feedback?: {
    list(limit?: number): Promise<unknown[]>;
  };
}

export interface AdminServerOptions extends AdminApiOptions {
  port?: number;
  hostname?: string;
}

/** 组装管理后台 Hono 应用（REST API + SPA 静态托管） */
function safeEqual(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(
  authorization: string | undefined,
  queryToken: string | undefined,
  token: string,
): boolean {
  if (!token) return true;
  const bearer = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  if (bearer && safeEqual(bearer, token)) return true;
  return Boolean(queryToken) && safeEqual(queryToken ?? '', token);
}

export function createAdminApp(options: AdminApiOptions): Hono {
  const logger = options.logger;
  const app = new Hono();
  const token = (options.authToken ?? process.env.ADMIN_API_TOKEN ?? '').trim();
  const tickets = new OneTimeTicketStore(
    options.ticketTtlMs ?? 60_000,
    options.now ?? Date.now,
  );
  const chatDeps: ChatStreamDeps = {
    tickets,
    ...(options.chatStream ? { chatStream: options.chatStream } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(logger ? { logger } : {}),
  };

  const admin = new Hono();
  if (token) {
    admin.use('*', async (c, next) => {
      const header = c.req.header('authorization');
      const queryToken = c.req.query('token');
      if (!isAuthorized(header, queryToken, token)) {
        throw new HTTPException(401, {
          message: '未授权：ADMIN_API_TOKEN 校验失败',
        });
      }
      await next();
    });
  } else {
    logger?.warn(
      {},
      'ADMIN_API_TOKEN 未配置，管理 API 处于开放状态，请仅在受控网络中使用',
    );
  }

  admin.route(
    '/',
    createConfigRoutes({
      configCenter: options.configCenter,
      traces: options.traces,
      groups: options.groups,
      mcpStatus: () => options.mcp.status(),
      ...(options.llmTester ? { llmTester: options.llmTester } : {}),
      ...(options.dingtalkTester
        ? { dingtalkTester: options.dingtalkTester }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  );
  admin.route(
    '/',
    createMcpRoutes({
      configCenter: options.configCenter,
      status: () => options.mcp.status(),
      applyServers: (servers) => options.mcp.applyServers(servers),
      ...(options.mcp.testServer
        ? { testServer: (id) => options.mcp.testServer!(id) }
        : {}),
    }),
  );

  admin.get('/feedback', async (c) => {
    if (!options.feedback) return c.json({ ok: true, items: [] });
    const limit = Number(c.req.query('limit') ?? 50);
    const items = await options.feedback.list(
      Number.isFinite(limit) ? limit : 50,
    );
    return c.json({ ok: true, items });
  });

  admin.post('/chat/tickets', (c) => {
    if (!options.chatStream) {
      return c.json({ ok: false, error: '在线对话未启用' }, 503);
    }
    const ticket = tickets.issue();
    options.metrics?.inc('console_ticket_total');
    return c.json({ ok: true, ...ticket });
  });

  app.get('/health', (c) => c.json({ ok: true, service: 'admin-console' }));
  app.get('/healthz', (c) => c.json({ ok: true, service: 'admin-console' }));

  app.get('/readyz', async (c) => {
    if (!options.readiness) {
      return c.json({ ok: true, ready: true });
    }
    try {
      const result = await options.readiness();
      return c.json(
        { ok: result.ready, ready: result.ready, ...(result.detail ? { detail: result.detail } : {}) },
        result.ready ? 200 : 503,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, ready: false, detail }, 503);
    }
  });

  app.get('/metrics', (c) => {
    if (
      !isAuthorized(
        c.req.header('authorization'),
        c.req.query('token'),
        token,
      )
    ) {
      return c.json({ ok: false, error: '未授权' }, 401);
    }
    if (!options.metrics) {
      return c.text('# metrics disabled\n', 200, {
        'content-type': 'text/plain; version=0.0.4',
      });
    }
    return c.text(options.metrics.render(), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  app.get('/api/v1/chat/stream', (c) => handleChatStream(c, chatDeps));

  app.route('/api/v1/admin', admin);
  app.all('/api/*', (c) =>
    c.json({ ok: false, error: `未找到接口: ${c.req.path}` }, 404),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ ok: false, error: error.message }, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn({ error: message, path: c.req.path }, 'admin api request failed');
    return c.json({ ok: false, error: message }, 500);
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.use('*', serveStatic({ root: options.staticDir }));
    app.get(
      '*',
      serveStatic({
        root: options.staticDir,
        rewriteRequestPath: () => '/index.html',
      }),
    );
  }

  return app;
}

/** 启动管理后台 HTTP 服务（与 Stream 机器人在同一进程内） */
export function startAdminServer(options: AdminServerOptions): {
  app: Hono;
  port: number;
  close: () => Promise<void>;
} {
  const app = createAdminApp(options);
  const port = options.port ?? Number(process.env.ADMIN_PORT ?? 8787);
  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: options.hostname ?? '0.0.0.0',
    },
    (info) => {
      options.logger?.info(
        { port: info.port, staticDir: options.staticDir ?? null },
        'admin console listening',
      );
    },
  );
  return {
    app,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
