import { existsSync } from 'node:fs';
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
}

export interface AdminServerOptions extends AdminApiOptions {
  port?: number;
  hostname?: string;
}

/** 组装管理后台 Hono 应用（REST API + SPA 静态托管） */
export function createAdminApp(options: AdminApiOptions): Hono {
  const logger = options.logger;
  const app = new Hono();
  const token = (options.authToken ?? process.env.ADMIN_API_TOKEN ?? '').trim();

  const admin = new Hono();
  if (token) {
    admin.use('*', async (c, next) => {
      const header = c.req.header('authorization') ?? '';
      const queryToken = c.req.query('token');
      if (header !== `Bearer ${token}` && queryToken !== token) {
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

  app.get('/health', (c) => c.json({ ok: true, service: 'admin-console' }));
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
