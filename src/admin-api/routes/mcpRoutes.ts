import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type { EnterpriseMcpServerConfig } from '../../types/mcp-and-sandbox.js';
import type {
  McpServerStatusView,
  McpServerTestResult,
  McpToolAccessPolicy,
} from '../../types/admin-and-console.js';
import {
  readBoolean,
  readJsonBody,
  readNumber,
  readString,
  readStringArray,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

const MCP_DOMAINS = [
  'code',
  'data',
  'log',
  'apidoc',
  'business',
  'general',
] as const;
const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;

export interface McpRouteDeps {
  configCenter: DynamicConfigCenter;
  status: () => McpServerStatusView[];
  /** 把最新 MCP 列表热应用到连接池，无需重启进程 */
  applyServers: (servers: EnterpriseMcpServerConfig[]) => Promise<unknown>;
  /** 一键连通性测试：连接并拉取该节点暴露的全部工具 Schema */
  testServer?: (serverId: string) => Promise<McpServerTestResult>;
}

function readServerBody(
  body: Record<string, unknown>,
  idOverride?: string,
): EnterpriseMcpServerConfig {
  const id = idOverride ?? readString(body, 'id', { required: true })!;
  const domain = readString(body, 'domain', { required: true })!;
  if (!(MCP_DOMAINS as readonly string[]).includes(domain)) {
    throw new HTTPException(400, {
      message: `domain 非法，允许值: ${MCP_DOMAINS.join(', ')}`,
    });
  }
  const transport = readString(body, 'transport', { required: true })!;
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new HTTPException(400, {
      message: `transport 非法，允许值: ${MCP_TRANSPORTS.join(', ')}`,
    });
  }
  const endpointOrCommand = readString(body, 'endpointOrCommand', {
    required: true,
  })!;
  if (!endpointOrCommand.trim()) {
    throw new HTTPException(400, { message: 'endpointOrCommand 不能为空' });
  }
  const args = readStringArray(body, 'args');
  let envOrHeaders: Record<string, string> | undefined;
  const rawEnv = body.envOrHeaders;
  if (rawEnv !== undefined && rawEnv !== null) {
    if (typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
      throw new HTTPException(400, {
        message: 'envOrHeaders 必须是字符串键值对象',
      });
    }
    envOrHeaders = {};
    for (const [key, value] of Object.entries(
      rawEnv as Record<string, unknown>,
    )) {
      if (typeof value !== 'string') {
        throw new HTTPException(400, {
          message: `envOrHeaders.${key} 必须是字符串`,
        });
      }
      envOrHeaders[key] = value;
    }
  }
  const timeoutMs = readNumber(body, 'timeoutMs') ?? 15_000;
  const maxResultChars = readNumber(body, 'maxResultChars') ?? 8_000;
  if (timeoutMs <= 0) {
    throw new HTTPException(400, { message: 'timeoutMs 必须为正数' });
  }
  if (maxResultChars < 200) {
    throw new HTTPException(400, { message: 'maxResultChars 必须 >= 200' });
  }
  return {
    id,
    name: readString(body, 'name')?.trim() || id,
    domain: domain as EnterpriseMcpServerConfig['domain'],
    transport: transport as EnterpriseMcpServerConfig['transport'],
    endpointOrCommand: endpointOrCommand.trim(),
    ...(args ? { args } : {}),
    ...(envOrHeaders ? { envOrHeaders } : {}),
    timeoutMs,
    maxResultChars,
    enabled: readBoolean(body, 'enabled') ?? true,
  };
}

function readAccessPoliciesBody(body: Record<string, unknown>): McpToolAccessPolicy[] {
  const raw = body.policies;
  if (!Array.isArray(raw)) {
    throw new HTTPException(400, { message: 'policies 必须是数组' });
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HTTPException(400, {
        message: `policies[${index}] 必须是对象`,
      });
    }
    const policy = item as Record<string, unknown>;
    const role = readString(policy, 'role');
    if (role !== undefined && role !== 'admin' && role !== 'employee') {
      throw new HTTPException(400, {
        message: `policies[${index}].role 必须是 admin 或 employee`,
      });
    }
    return {
      id: readString(policy, 'id', { required: true })!,
      ...(readString(policy, 'conversationId') !== undefined
        ? { conversationId: readString(policy, 'conversationId')! }
        : {}),
      ...(role ? { role: role as 'admin' | 'employee' } : {}),
      allowedServerIds: readStringArray(policy, 'allowedServerIds') ?? [],
      allowedTools: readStringArray(policy, 'allowedTools') ?? [],
      enabled: readBoolean(policy, 'enabled') ?? true,
    };
  });
}

function serverSnapshot(servers: readonly EnterpriseMcpServerConfig[]) {
  return servers.map((item) => ({
    id: item.id,
    name: item.name,
    domain: item.domain,
    transport: item.transport,
    endpointOrCommand: item.endpointOrCommand,
    enabled: item.enabled,
  }));
}

/** 企业 MCP 管理路由：增删改查、连通性测试与工具级访问策略 */
export function createMcpRoutes(deps: McpRouteDeps): Hono {
  const app = new Hono();
  const actor = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('x-admin-staff-id');

  app.get('/mcp-servers', (c) =>
    c.json({
      ok: true,
      servers: deps.configCenter.getMcpServers(),
      status: deps.status(),
    }),
  );

  app.post('/mcp-servers', async (c) => {
    const body = await readJsonBody(c);
    const server = readServerBody(body);
    if (
      deps.configCenter.getMcpServers().some((item) => item.id === server.id)
    ) {
      throw new HTTPException(409, {
        message: `MCP Server 已存在: ${server.id}`,
      });
    }
    await deps.configCenter.upsertMcpServer(server, actor(c));
    const servers = deps.configCenter.getMcpServers();
    await deps.applyServers(servers);
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'RELOAD_MCP',
      { action: 'create', servers: serverSnapshot(servers.filter((item) => item.id !== server.id)) },
      { action: 'create', servers: serverSnapshot(servers) },
    );
    return c.json({ ok: true, server, servers: deps.configCenter.getMcpServers() });
  });

  app.put('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const existing = deps.configCenter
      .getMcpServers()
      .find((item) => item.id === id);
    if (!existing) {
      throw new HTTPException(404, { message: `未知 MCP Server: ${id}` });
    }
    const body = await readJsonBody(c);
    const server = readServerBody(
      {
        ...existing,
        ...body,
      },
      id,
    );
    await deps.configCenter.upsertMcpServer(server, actor(c));
    await deps.applyServers(deps.configCenter.getMcpServers());
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'RELOAD_MCP',
      { action: 'update', servers: serverSnapshot([existing]) },
      { action: 'update', servers: serverSnapshot([server]) },
    );
    return c.json({ ok: true, server, servers: deps.configCenter.getMcpServers() });
  });

  app.delete('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const existing = deps.configCenter
      .getMcpServers()
      .find((item) => item.id === id);
    if (!existing) {
      throw new HTTPException(404, { message: `未知 MCP Server: ${id}` });
    }
    await deps.configCenter.deleteMcpServer(id, actor(c));
    await deps.applyServers(deps.configCenter.getMcpServers());
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'RELOAD_MCP',
      { action: 'delete', servers: serverSnapshot([existing]) },
      { action: 'delete', servers: serverSnapshot(deps.configCenter.getMcpServers()) },
    );
    return c.json({ ok: true, servers: deps.configCenter.getMcpServers() });
  });

  app.post('/mcp-servers/:id/test', async (c) => {
    if (!deps.testServer) {
      throw new HTTPException(501, { message: '未配置 MCP 连通性探测能力' });
    }
    const id = c.req.param('id');
    const exists = deps.configCenter
      .getMcpServers()
      .some((item) => item.id === id);
    if (!exists) {
      throw new HTTPException(404, { message: `未知 MCP Server: ${id}` });
    }
    return c.json({ ok: true, result: await deps.testServer(id) });
  });

  app.get('/mcp-access-policies', (c) =>
    c.json({
      ok: true,
      policies: deps.configCenter.getMcpAccessPolicies(),
    }),
  );

  app.put('/mcp-access-policies', async (c) => {
    const body = await readJsonBody(c);
    await deps.configCenter.updateMcpAccessPolicies(
      readAccessPoliciesBody(body),
      actor(c),
    );
    return c.json({
      ok: true,
      policies: deps.configCenter.getMcpAccessPolicies(),
    });
  });

  return app;
}
