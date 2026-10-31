import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IToolProvider } from '../types/core.js';
import type {
  EnterpriseMcpServerConfig,
  WorkspacePaths,
} from '../types/mcp-and-sandbox.js';
import { BuiltinToolProvider } from '../react/BuiltinTools.js';
import { expandEnvPlaceholder } from '../config/envPlaceholder.js';
import { DwsCliRunner } from '../tools/dws/DwsCliRunner.js';
import { DwsCliToolProvider } from '../tools/dws/DwsCliToolProvider.js';
import type { DwsIdentityService } from '../tools/dws/DwsIdentityService.js';
import type { DwsPermissionNotifier } from '../tools/dws/DwsPermissionNotice.js';
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
import type { ExecutionContext, ToolDefinition } from '../types/core.js';
import type { McpToolAccessPolicy } from '../types/admin-and-console.js';

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
  /** 每员工独立 DWS 身份（同意 + 设备码登录 + 独立 home）；缺省时不校验身份 */
  dwsIdentity?: DwsIdentityService;
  /** DWS 应用权限缺失时主动通知管理员 */
  dwsPermissionNotifier?: DwsPermissionNotifier;
  /** 群聊里把 DWS 授权链接私聊推给提问人 */
  dwsPersonalNotifier?: (
    staffId: string,
    text: string,
  ) => Promise<boolean> | boolean;
  /** dws 可执行文件路径，默认读取 DWS_BINARY 或 PATH 中的 dws */
  dwsBinary?: string;
  sandbox?: IsolatedSandbox;
  sandboxOptions?: IsolatedSandboxOptions;
  /** 管理员单聊工具（内部自带上下文隔离），仅在管理员单聊时返回工具 */
  adminProvider?: IToolProvider;
  /** 术语知识库查询工具 */
  glossaryProvider?: IToolProvider;
  /** 个人提醒与定时报告工具（内部只对单聊挂载） */
  personalAssistantProvider?: IToolProvider;
  /** 公网搜索工具；由外部注入，并在 getTools 内实时判断开关 */
  webSearchProvider?: IToolProvider;
  /** 产物投递等额外工具提供方，按工作区路径构造 */
  artifactProvider?: (workspace: WorkspacePaths) => IToolProvider;
  /** MCP 工具按群/角色授权（实时读取，支持热更新） */
  toolAccess?: {
    policies: () => McpToolAccessPolicy[];
    isAdmin: (staffId: string) => boolean;
  };
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
  const endpointOrCommand = expandEnvPlaceholder(
    asString(record.endpointOrCommand, 'endpointOrCommand', index),
    env,
  );
  const args = Array.isArray(record.args)
    ? record.args.map((item) => {
        if (typeof item !== 'string') {
          throw new Error(`MCP Server ${id} 的 args 必须是字符串数组`);
        }
        return expandEnvPlaceholder(item, env);
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
      envOrHeaders[key] = expandEnvPlaceholder(value, env);
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
  private dwsProvider: IToolProvider | null;

  private constructor(
    providers: IToolProvider[],
    workspace: WorkspacePaths,
    pool: McpClientPool | null,
    dwsProvider: IToolProvider | null,
    private readonly createDwsProvider: () => IToolProvider,
  ) {
    this.providers = providers;
    this.workspace = workspace;
    this.pool = pool;
    this.dwsProvider = dwsProvider;
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
    // 显式传入 mcpServers（即使为空）时也建立连接池，
    // 保证 Web/ChatOps 运行期新增的 MCP 节点可被热应用。
    if (servers.length > 0 || options.mcpServers !== undefined) {
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
    if (options.webSearchProvider) {
      providers.push(options.webSearchProvider);
    }
    if (pool) {
      providers.push(
        new McpToolProvider({
          pool,
          workspace,
          logger: options.logger,
          ...(options.toolAccess ? { toolAccess: options.toolAccess } : {}),
        }),
      );
    }
    let dwsProvider: IToolProvider | null = null;
    const createDwsProvider = (): IToolProvider =>
      new DwsCliToolProvider({
        runner:
          options.dwsRunner ??
          new DwsCliRunner({
            binary: options.dwsBinary ?? env.DWS_BINARY ?? 'dws',
            env,
          }),
        ...(options.dwsIdentity ? { identity: options.dwsIdentity } : {}),
        ...(options.dwsPersonalNotifier
          ? { personalNotifier: options.dwsPersonalNotifier }
          : {}),
        ...(options.dwsPermissionNotifier
          ? { permissionNotifier: options.dwsPermissionNotifier }
          : {}),
      });
    if (options.enableDws ?? envFlag(env, 'DWS_CLI_ENABLED', true)) {
      dwsProvider = createDwsProvider();
      providers.push(dwsProvider);
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

    if (options.adminProvider) {
      providers.push(options.adminProvider);
    }
    if (options.glossaryProvider) {
      providers.push(options.glossaryProvider);
    }
    if (options.personalAssistantProvider) {
      providers.push(options.personalAssistantProvider);
    }
    if (options.artifactProvider) {
      providers.push(options.artifactProvider(workspace));
    }

    return new ToolRegistry(
      providers,
      workspace,
      pool,
      dwsProvider,
      createDwsProvider,
    );
  }

  /**
   * 汇总当前上下文可见的工具。管理员工具由 AdminChatOpsToolProvider
   * 在 getTools 内做 conversationType === '1' + 白名单双重校验。
   */
  public async assembleTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const loaded = await Promise.all(
      this.providers.map((provider) => provider.getTools(ctx)),
    );
    const tools: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const tool of loaded.flat()) {
      if (seen.has(tool.name)) {
        throw new Error(`工具名称重复: ${tool.name}`);
      }
      seen.add(tool.name);
      tools.push(tool);
    }
    return tools;
  }

  /** DWS CLI 权限开关热切换：无需重建 MCP 连接或重启进程 */
  public setDwsEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.dwsProvider) return;
      this.dwsProvider = this.createDwsProvider();
      this.providers.push(this.dwsProvider);
      return;
    }
    if (!this.dwsProvider) return;
    const index = this.providers.indexOf(this.dwsProvider);
    if (index >= 0) this.providers.splice(index, 1);
    this.dwsProvider = null;
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
