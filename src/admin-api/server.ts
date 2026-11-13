import { existsSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type {
  GroupDirectory,
  LlmSandboxTestResult,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  SystemLoopStatus,
  UsageSummary,
  McpServerStatusView,
  McpServerTestResult,
  ReActTraceStore,
} from '../types/admin-and-console.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import type { GlossaryAdminPort } from '../types/glossary.js';
import type {
  GithubAdminPort,
  PluginAdminPort,
  ProjectAdminPort,
  SkillAdminPort,
  SkillFileAdminPort,
} from '../types/skills-plugins-projects.js';
import {
  bindAdminRequestSecurityContext,
  createConfigRoutes,
  readJsonBody,
} from './routes/configRoutes.js';
import { createMcpRoutes } from './routes/mcpRoutes.js';
import { createGlossaryRoutes } from './routes/glossaryRoutes.js';
import {
  createGlossaryCandidateRoutes,
  type GlossaryCandidateAdminPort,
} from './routes/glossaryCandidateRoutes.js';
import { createSkillRoutes } from './routes/skillRoutes.js';
import { createPluginRoutes } from './routes/pluginRoutes.js';
import { createProjectRoutes } from './routes/projectRoutes.js';
import {
  createGithubRoutes,
  createGithubWebhookRoutes,
  type GithubWebhookDeps,
} from './routes/githubRoutes.js';
import { createPersonaRoutes } from './routes/personaRoutes.js';
import { createMemoryRoutes } from './routes/memoryRoutes.js';
import { createGroupRoutes } from './routes/groupRoutes.js';
import { createPersonSettingsRoutes } from './routes/personSettingsRoutes.js';
import { createWhitelistRoutes } from './routes/whitelistRoutes.js';
import type { GroupWorkspaceAdminPort } from '../types/group-workspace.js';
import type { GroupModelRouteService } from '../groups/GroupModelRouteService.js';
import type { PersonSettingsAdminPort } from '../types/personal-settings.js';
import { createGovernanceRoutes } from '../governance/governanceRoutes.js';
import type { DataGovernancePort } from '../governance/DataRetention.js';
import type {
  PersonIdentityAdminPort,
  PersonaAdminPort,
} from '../types/persona-and-identity.js';
import type { SemanticMemoryAdminPort } from '../types/bystander-and-memory.js';
import type { UserWhitelistAdminPort } from '../types/whitelist.js';
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
  /** 当前已订阅旁听长连接的群 */
  listeningGroups?: () => Iterable<string>;
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
  /** 只读控制台访问 Token（ADMIN_VIEWER_TOKEN）：仅放行 GET/HEAD/OPTIONS，写操作返回 403 */
  viewerToken?: string;
  /** 是否采信客户端传入的 X-Admin-Staff-Id（仅受信反向代理场景可设为 true，默认 false） */
  trustActorHeader?: boolean;
  /** HttpOnly 登录 Cookie 会话有效期（毫秒），默认 24 小时 */
  sessionTtlMs?: number;
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
  usage?: {
    summary(days?: number): Promise<UsageSummary>;
  };
  scheduledTasks?: {
    list(): Promise<ScheduledTask[]>;
    create(input: ScheduledTaskInput): Promise<ScheduledTask>;
    update(id: string, input: ScheduledTaskUpdate): Promise<ScheduledTask>;
    remove(id: string): Promise<boolean>;
    runNow?(id: string): Promise<void>;
    /** 系统级周期循环只读状态（非用户定时任务） */
    systemLoops?(): SystemLoopStatus[] | Promise<SystemLoopStatus[]>;
  };
  /** 数据治理：保留期、清理与级联删除 */
  governance?: DataGovernancePort;
  /** 术语知识库管理 */
  glossary?: GlossaryAdminPort;
  /** 黑话候选审批：通过后才写入术语知识库 */
  glossaryCandidates?: GlossaryCandidateAdminPort;
  /** 技能管理：列表、启停、预览与资源读取 */
  skills?: SkillAdminPort;
  /** 本地技能文件编辑（创建 / 更新 / 删除 / 资源写入） */
  skillFiles?: SkillFileAdminPort;
  /** 声明式插件管理 */
  plugins?: PluginAdminPort;
  /** 项目登记、同步与检索管理 */
  projects?: ProjectAdminPort;
  /** GitHub 只读工具的真实运行状态与连通性测试 */
  github?: GithubAdminPort;
  /** 群 / 个人人设覆盖 */
  personas?: PersonaAdminPort;
  /** 员工身份别名与绑定 */
  identities?: PersonIdentityAdminPort;
  /** 语义记忆治理：查看、修订、退役与删除 */
  memories?: SemanticMemoryAdminPort;
  /** 群工作区：定位、职责、群目标与群任务 */
  groupWorkspace?: GroupWorkspaceAdminPort;
  /** 按群模型路由 */
  groupModelRoutes?: GroupModelRouteService;
  /** 个人表达偏好与跨群记忆授权 */
  personSettings?: PersonSettingsAdminPort;
  /** 员工白名单：目录同步与授权审批 */
  whitelist?: UserWhitelistAdminPort;
  /** GitHub Webhook 签名校验与任务路由回调 */
  githubWebhook?: Pick<GithubWebhookDeps, 'secret' | 'onEvent'>;
}

export interface AdminServerOptions extends AdminApiOptions {
  port?: number;
  hostname?: string;
}

const ADMIN_SESSION_COOKIE = 'anthys_admin_session';
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type AdminRole = 'admin' | 'viewer';

function safeEqual(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isReadOnlyMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
}

function extractCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eqIndex + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function signSessionCookie(
  role: AdminRole,
  expiresAtMs: number,
  key: Buffer,
): string {
  const payload = `${role}.${expiresAtMs}`;
  const sig = createHmac('sha256', key).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionCookie(
  value: string | undefined,
  key: Buffer,
  nowMs: number,
): AdminRole | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [role, expiresRaw, sig] = parts;
  if (role !== 'admin' && role !== 'viewer') return null;
  if (!expiresRaw || !sig) return null;
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) return null;
  const expectedSig = createHmac('sha256', key)
    .update(`${role}.${expiresRaw}`)
    .digest('hex');
  return safeEqual(sig, expectedSig) ? role : null;
}

function buildSessionCookieHeader(
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isHttpsRequest(
  forwardedProto: string | undefined,
  url: string,
): boolean {
  return (
    forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https' ||
    url.startsWith('https://')
  );
}

/** 组装管理后台 Hono 应用（REST API + SPA 静态托管） */
export function createAdminApp(options: AdminApiOptions): Hono {
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const app = new Hono();
  const token = (options.authToken ?? process.env.ADMIN_API_TOKEN ?? '').trim();
  const viewerToken = (
    options.viewerToken ??
    process.env.ADMIN_VIEWER_TOKEN ??
    ''
  ).trim();
  const authEnabled = Boolean(token || viewerToken);
  const trustActorHeader =
    options.trustActorHeader ?? process.env.ADMIN_TRUST_ACTOR_HEADER === 'true';
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessionKey = createHash('sha256')
    .update(`anthys-admin-session-v1:${token}:${viewerToken}`)
    .digest();

  const resolveTokenRole = (candidate: string): AdminRole | null => {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    if (token && safeEqual(trimmed, token)) return 'admin';
    if (viewerToken && safeEqual(trimmed, viewerToken)) return 'viewer';
    return null;
  };

  const authenticateRequest = (c: {
    req: { header: (name: string) => string | undefined };
  }): AdminRole | null => {
    if (!authEnabled) return 'admin';
    const authorization = c.req.header('authorization');
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    const bearerRole = resolveTokenRole(bearer);
    if (bearerRole) return bearerRole;
    const cookieVal = extractCookieValue(
      c.req.header('cookie'),
      ADMIN_SESSION_COOKIE,
    );
    return verifySessionCookie(cookieVal, sessionKey, now());
  };

  const tickets = new OneTimeTicketStore(options.ticketTtlMs ?? 60_000, now);
  const chatDeps: ChatStreamDeps = {
    tickets,
    ...(options.chatStream ? { chatStream: options.chatStream } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(logger ? { logger } : {}),
  };

  const admin = new Hono();
  if (!authEnabled) {
    logger?.warn(
      {},
      'ADMIN_API_TOKEN 与 ADMIN_VIEWER_TOKEN 均未配置，管理 API 处于开放状态，请仅在受控网络中使用',
    );
  }
  admin.use('*', async (c, next) => {
    const role = authenticateRequest(c);
    if (!role) {
      throw new HTTPException(401, {
        message: '未授权：ADMIN_API_TOKEN 校验失败',
      });
    }
    bindAdminRequestSecurityContext(c.req.raw, {
      trustActorHeader,
      role,
    });
    if (role === 'viewer' && !isReadOnlyMethod(c.req.method)) {
      throw new HTTPException(403, {
        message: '只读凭证（ADMIN_VIEWER_TOKEN）禁止执行修改操作',
      });
    }
    await next();
  });

  admin.route(
    '/',
    createConfigRoutes({
      configCenter: options.configCenter,
      traces: options.traces,
      groups: options.groups,
      ...(options.listeningGroups
        ? { listeningGroups: options.listeningGroups }
        : {}),
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
  if (options.governance) {
    admin.route(
      '/',
      createGovernanceRoutes({
        governance: options.governance,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.glossary) {
    admin.route(
      '/',
      createGlossaryRoutes({
        glossary: options.glossary,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.glossaryCandidates) {
    admin.route(
      '/',
      createGlossaryCandidateRoutes({
        candidates: options.glossaryCandidates,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.skills) {
    admin.route(
      '/',
      createSkillRoutes({
        skills: options.skills,
        ...(options.skillFiles ? { skillFiles: options.skillFiles } : {}),
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.plugins) {
    admin.route(
      '/',
      createPluginRoutes({
        plugins: options.plugins,
        configCenter: options.configCenter,
        ...(logger ? { logger } : {}),
      }),
    );
  }
  if (options.projects) {
    admin.route(
      '/',
      createProjectRoutes({
        projects: options.projects,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.github) {
    admin.route(
      '/',
      createGithubRoutes({
        github: options.github,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.personas && options.identities) {
    admin.route(
      '/',
      createPersonaRoutes({
        personas: options.personas,
        identities: options.identities,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.memories) {
    admin.route(
      '/',
      createMemoryRoutes({
        memories: options.memories,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.groupWorkspace && options.groupModelRoutes) {
    admin.route(
      '/',
      createGroupRoutes({
        workspace: options.groupWorkspace,
        modelRoutes: options.groupModelRoutes,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.personSettings) {
    admin.route(
      '/',
      createPersonSettingsRoutes({
        settings: options.personSettings,
        configCenter: options.configCenter,
      }),
    );
  }
  if (options.whitelist) {
    admin.route(
      '/',
      createWhitelistRoutes({
        whitelist: options.whitelist,
        configCenter: options.configCenter,
      }),
    );
  }

  admin.get('/feedback', async (c) => {
    if (!options.feedback) return c.json({ ok: true, items: [] });
    const limit = Number(c.req.query('limit') ?? 50);
    const items = await options.feedback.list(
      Number.isFinite(limit) ? limit : 50,
    );
    return c.json({ ok: true, items });
  });

  admin.get('/usage', async (c) => {
    if (!options.usage) {
      return c.json({
        ok: true,
        summary: {
          sinceMs: 0,
          totalTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTurns: 0,
          totalCostMicros: 0,
          pricedTurns: 0,
          byUser: [],
          byConversation: [],
          byModel: [],
          byWorker: [],
          byJobKind: [],
        } satisfies UsageSummary,
      });
    }
    const days = Number(c.req.query('days') ?? 1);
    const summary = await options.usage.summary(
      Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : 1,
    );
    return c.json({ ok: true, summary });
  });

  admin.get('/scheduled-tasks', async (c) => {
    if (!options.scheduledTasks) return c.json({ ok: true, tasks: [] });
    return c.json({ ok: true, tasks: await options.scheduledTasks.list() });
  });

  admin.get('/scheduled-tasks/system-loops', async (c) => {
    if (!options.scheduledTasks?.systemLoops) {
      return c.json({ ok: true, loops: [] });
    }
    return c.json({ ok: true, loops: await options.scheduledTasks.systemLoops() });
  });

  admin.post('/scheduled-tasks', async (c) => {
    if (!options.scheduledTasks) {
      return c.json({ ok: false, error: '定时任务未启用' }, 503);
    }
    const input = (await c.req.json().catch(() => ({}))) as ScheduledTaskInput;
    const kind = input.kind ?? 'prompt';
    const needsPrompt = kind === 'prompt' || kind === 'reminder';
    if (!input.conversationId?.trim() || (needsPrompt && !input.prompt?.trim())) {
      return c.json({ ok: false, error: '缺少 conversationId 或 prompt' }, 400);
    }
    try {
      const task = await options.scheduledTasks.create(input);
      return c.json({ ok: true, task });
    } catch (error) {
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  admin.put('/scheduled-tasks/:id', async (c) => {
    if (!options.scheduledTasks) {
      return c.json({ ok: false, error: '定时任务未启用' }, 503);
    }
    const input = (await c.req.json().catch(() => ({}))) as ScheduledTaskUpdate;
    try {
      const task = await options.scheduledTasks.update(c.req.param('id'), input);
      return c.json({ ok: true, task });
    } catch (error) {
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  admin.delete('/scheduled-tasks/:id', async (c) => {
    if (!options.scheduledTasks) {
      return c.json({ ok: false, error: '定时任务未启用' }, 503);
    }
    const removed = await options.scheduledTasks.remove(c.req.param('id'));
    return c.json({ ok: true, removed });
  });

  admin.post('/scheduled-tasks/:id/run', async (c) => {
    if (!options.scheduledTasks?.runNow) {
      return c.json({ ok: false, error: '立即执行未启用' }, 503);
    }
    try {
      await options.scheduledTasks.runNow(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
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

  app.get('/api/v1/auth/session', (c) => {
    const role = authenticateRequest(c);
    return c.json({
      ok: true,
      authRequired: authEnabled,
      authenticated: Boolean(role),
      role,
    });
  });

  app.post('/api/v1/auth/session', async (c) => {
    if (!authEnabled) {
      return c.json({
        ok: true,
        authRequired: false,
        authenticated: true,
        role: 'admin' satisfies AdminRole,
      });
    }
    const body: Record<string, unknown> = await readJsonBody(c).catch(() => ({}));
    const bodyToken = typeof body.token === 'string' ? body.token : '';
    const authHeader = c.req.header('authorization');
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';
    const role = resolveTokenRole(bodyToken || bearer);
    if (!role) {
      return c.json({ ok: false, error: '未授权：Token 无效' }, 401);
    }
    const expiresAtMs = now() + sessionTtlMs;
    const cookieVal = signSessionCookie(role, expiresAtMs, sessionKey);
    const secure = isHttpsRequest(
      c.req.header('x-forwarded-proto'),
      c.req.url,
    );
    c.header(
      'set-cookie',
      buildSessionCookieHeader(cookieVal, sessionTtlMs / 1000, secure),
    );
    return c.json({
      ok: true,
      authRequired: true,
      authenticated: true,
      role,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  });

  app.delete('/api/v1/auth/session', (c) => {
    const secure = isHttpsRequest(
      c.req.header('x-forwarded-proto'),
      c.req.url,
    );
    c.header('set-cookie', buildSessionCookieHeader('', 0, secure));
    return c.json({ ok: true, authenticated: false, role: null });
  });

  app.get('/metrics', (c) => {
    if (!authenticateRequest(c)) {
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

  app.route(
    '/api/v1/webhooks',
    createGithubWebhookRoutes({
      ...(options.githubWebhook?.secret !== undefined
        ? { secret: options.githubWebhook.secret }
        : {}),
      ...(options.githubWebhook?.onEvent
        ? { onEvent: options.githubWebhook.onEvent }
        : {}),
      ...(options.metrics ? { metrics: options.metrics } : {}),
      ...(logger ? { logger } : {}),
    }),
  );

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
