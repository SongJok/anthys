import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IToolProvider } from '../types/core.js';
import type {
  EnterpriseMcpServerConfig,
  WorkspacePaths,
} from '../types/mcp-and-sandbox.js';
import { BuiltinToolProvider } from '../react/BuiltinTools.js';
import { DwsCliRunner } from '../tools/dws/DwsCliRunner.js';
import { DwsCliToolProvider } from '../tools/dws/DwsCliToolProvider.js';
import {
  IsolatedSandbox,
  type IsolatedSandboxOptions,
} from '../tools/sandbox/IsolatedSandbox.js';
import { SandboxToolProvider } from '../tools/sandbox/SandboxToolProvider.js';
import {
  McpClientPool,
  type McpClientPoolOptions,
  type McpPoolLogger,
  type McpTransportFactory,
} from '../tools/mcp/McpClientPool.js';
import { McpToolProvider } from '../tools/mcp/McpToolProvider.js';

const MCP_DOMAINS = [
  'code',
  'data',
  'log',
  'apidoc',
  'business',
  'general',
] as const;
const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable-http'] as const;
const SANDBOX_DIR = '/workspace';
const DEFAULT_CONFIG_FILE = join('config', 'mcp-servers.json');

export interface ToolRegistryOptions {
  configPath?: string;
  mcpServers?: EnterpriseMcpServerConfig[];
  transportFactory?: McpTransportFactory;
  mcpOptions?: Omit<
    McpClientPoolOptions,
    'servers' | 'logger' | 'transportFactory'
  >;
  workspaceRoot?: string;
  workspace?: WorkspacePaths;
  logger?: McpPoolLogger;
  env?: NodeJS.ProcessEnv;
  enableBuiltin?: boolean;
  enableDws?: boolean;
  enableSandbox?: boolean;
  dwsRunner?: DwsCliRunner;
  sandbox?: IsolatedSandbox;
  sandboxOptions?: IsolatedSandboxOptions;
}

function envFlag(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function expandEnvString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    const replacement = env[name as string];
    return replacement === undefined ? match : replacement;
  });
}

function asString(
  value: unknown,
  field: string,
  index: number,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`MCP 配置第 ${index + 1} 项缺少有效字段 ${field}`);
  }
  return value.trim();
}

function normalizeServer(
  raw: unknown,
  index: number,
  env: NodeJS.ProcessEnv,
): EnterpriseMcpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`MCP 配置第 ${index + 1} 项必须是对象`);
  }
  const record = raw as Record<string, unknown>;
  const id = asString(record.id, 'id', index);
  const domain = asString(record.domain, 'domain', index);
  if (!(MCP_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error(
      `MCP Server ${id} 的 domain 非法: ${domain}（允许: ${MCP_DOMAINS.join(', ')}）`,
    );
  }
  const transport = asString(record.transport, 'transport', index);
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new Error(
      `MCP Server ${id} 的 transport 非法: ${transport}（允许: ${MCP_TRANSPORTS.join(', ')}）`,
    );
  }
  const endpointOrCommand = expandEnvString(
    asString(record.endpointOrCommand, 'endpointOrCommand', index),
    env,
  );
  const args = Array.isArray(record.args)
    ? record.args.map((item) => {
        if (typeof item !== 'string') {
          throw new Error(`MCP Server ${id} 的 args 必须是字符串数组`);
        }
        return expandEnvString(item, env);
      })
    : undefined;
  let envOrHeaders: Record<string, string> | undefined;
  if (record.envOrHeaders !== undefined) {
    if (
      !record.envOrHeaders ||
      typeof record.envOrHeaders !== 'object' ||
      Array.isArray(record.envOrHeaders)
    ) {
      throw new Error(`MCP Server ${id} 的 envOrHeaders 必须是对象`);
    }
    envOrHeaders = {};
    for (const [key, value] of Object.entries(
      record.envOrHeaders as Record<string, unknown>,
    )) {
      if (typeof value !== 'string') {
        throw new Error(`MCP Server ${id} 的 envOrHeaders.${key} 必须是字符串`);
      }
      envOrHeaders[key] = expandEnvString(value, env);
    }
  }
  const timeoutMs = Number(record.timeoutMs ?? 15_000);
  const maxResultChars = Number(record.maxResultChars ?? 8_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`MCP Server ${id} 的 timeoutMs 必须是正数`);
  }
  if (!Number.isFinite(maxResultChars) || maxResultChars < 200) {
    throw new Error(`MCP Server ${id} 的 maxResultChars 必须 >= 200`);
  }
  return {
    id,
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : id,
    domain: domain as EnterpriseMcpServerConfig['domain'],
    transport: transport as EnterpriseMcpServerConfig['transport'],
    endpointOrCommand,
    ...(args ? { args } : {}),
    ...(envOrHeaders ? { envOrHeaders } : {}),
    timeoutMs,
    maxResultChars,
    enabled: record.enabled !== false,
  };
}

/** 从 JSON 配置加载 MCP Server 列表；文件不存在时返回空列表。 */
export async function loadMcpServerConfigs(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnterpriseMcpServerConfig[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MCP 配置文件不是合法 JSON: ${configPath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(
          (parsed as { servers?: unknown }).servers,
        )
      ? (parsed as { servers: unknown[] }).servers
      : null;
  if (!list) {
    throw new Error(
      `MCP 配置文件格式错误: ${configPath}，应为数组或 { "servers": [...] }`,
    );
  }
  return list.map((item, index) => normalizeServer(item, index, env));
}

/**
 * 阶段二工具注册中心：把内置工具、企业 MCP、钉钉 DWS、隔离沙盒
 * 组装成 ReActRunner 可直接使用的 Provider 列表，不改动 ReAct 核心。
 */
export class ToolRegistry {
  public readonly providers: IToolProvider[];
  public readonly workspace: WorkspacePaths;
  public readonly pool: McpClientPool | null;

  private constructor(
    providers: IToolProvider[],
    workspace: WorkspacePaths,
    pool: McpClientPool | null,
  ) {
    this.providers = providers;
    this.workspace = workspace;
    this.pool = pool;
  }

  public static async create(
    options: ToolRegistryOptions = {},
  ): Promise<ToolRegistry> {
    const env = options.env ?? process.env;
    const workspace = await ToolRegistry.ensureWorkspace(options, env);
    const servers =
      options.mcpServers ??
      (await loadMcpServerConfigs(
        options.configPath ??
          env.MCP_SERVERS_CONFIG ??
          resolve(process.cwd(), DEFAULT_CONFIG_FILE),
        env,
      ));

    let pool: McpClientPool | null = null;
    if (servers.length > 0) {
      pool = new McpClientPool({
        ...options.mcpOptions,
        servers,
        logger: options.logger,
        ...(options.transportFactory
          ? { transportFactory: options.transportFactory }
          : {}),
      });
      await pool.init();
    }

    const providers: IToolProvider[] = [];
    if (options.enableBuiltin !== false) {
      providers.push(new BuiltinToolProvider());
    }
    if (pool) {
      providers.push(
        new McpToolProvider({
          pool,
          workspace,
          logger: options.logger,
        }),
      );
    }
    if (options.enableDws ?? envFlag(env, 'DWS_CLI_ENABLED', true)) {
      providers.push(
        new DwsCliToolProvider({
          ...(options.dwsRunner ? { runner: options.dwsRunner } : {}),
        }),
      );
    }
    if (options.enableSandbox ?? envFlag(env, 'SANDBOX_ENABLED', true)) {
      providers.push(
        new SandboxToolProvider({
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.sandboxOptions
            ? { sandboxOptions: options.sandboxOptions }
            : {}),
          workspace,
        }),
      );
    }

    return new ToolRegistry(providers, workspace, pool);
  }

  private static async ensureWorkspace(
    options: ToolRegistryOptions,
    env: NodeJS.ProcessEnv,
  ): Promise<WorkspacePaths> {
    if (options.workspace) {
      await mkdir(options.workspace.hostDir, { recursive: true });
      return options.workspace;
    }
    const root =
      options.workspaceRoot ??
      env.AGENT_WORKSPACE_DIR ??
      resolve(process.cwd(), '.workspace');
    await mkdir(root, { recursive: true });
    return { hostDir: root, sandboxDir: SANDBOX_DIR };
  }

  public async close(): Promise<void> {
    await this.pool?.close();
  }
}
