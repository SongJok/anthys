import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  EnterpriseMcpServerConfig,
  McpToolCallOptions,
  McpToolCallResult,
  McpToolDescriptor,
} from '../../types/mcp-and-sandbox.js';

export interface McpPoolLogger {
  info?(obj: Record<string, unknown>, msg: string): void;
  warn?(obj: Record<string, unknown>, msg: string): void;
  error?(obj: Record<string, unknown>, msg: string): void;
}

export type McpTransportFactory = (
  config: EnterpriseMcpServerConfig,
) => Transport | Promise<Transport>;

export interface McpClientPoolOptions {
  servers: EnterpriseMcpServerConfig[];
  logger?: McpPoolLogger;
  transportFactory?: McpTransportFactory;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  schemaCacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  toolsFetchedAt: number | null;
  lastError: string | null;
}

export interface McpHealthResult {
  serverId: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

interface ServerState {
  config: EnterpriseMcpServerConfig;
  client: Client | null;
  transport: Transport | null;
  connected: boolean;
  connecting: Promise<void> | null;
  tools: McpToolDescriptor[];
  toolByNamespacedName: Map<string, McpToolDescriptor>;
  toolsFetchedAt: number | null;
  lastError: string | null;
}

const NAMESPACE_PREFIX = 'mcp__';
const MAX_TOOL_NAME_LENGTH = 64;
const DEFAULT_RECONNECT_ATTEMPTS = 2;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_SCHEMA_CACHE_TTL_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function namespacedToolName(serverId: string, toolName: string): string {
  const raw = `${NAMESPACE_PREFIX}${sanitizeName(serverId)}__${sanitizeName(toolName)}`;
  if (raw.length <= MAX_TOOL_NAME_LENGTH) return raw;
  const digest = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${raw.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${digest}`;
}

function assertConfig(config: EnterpriseMcpServerConfig): void {
  if (!config.id.trim()) {
    throw new Error('MCP Server 配置缺少 id');
  }
  if (!config.endpointOrCommand.trim()) {
    throw new Error(`MCP Server "${config.id}" 缺少 endpointOrCommand`);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error(`MCP Server "${config.id}" 的 timeoutMs 必须为正数`);
  }
  if (!Number.isFinite(config.maxResultChars) || config.maxResultChars <= 0) {
    throw new Error(`MCP Server "${config.id}" 的 maxResultChars 必须为正数`);
  }
}

function headersOf(config: EnterpriseMcpServerConfig): Record<string, string> {
  return config.envOrHeaders ?? {};
}

/** 默认传输工厂：stdio / sse / streamable-http 三种协议 */
export function createDefaultMcpTransport(
  config: EnterpriseMcpServerConfig,
): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.endpointOrCommand,
        args: config.args ?? [],
        env: {
          ...getDefaultEnvironment(),
          ...headersOf(config),
        },
        stderr: 'inherit',
      });
    case 'sse':
      return new SSEClientTransport(new URL(config.endpointOrCommand), {
        requestInit: { headers: headersOf(config) },
      });
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.endpointOrCommand),
        { requestInit: { headers: headersOf(config) } },
      );
    default: {
      const exhaustive: never = config.transport;
      throw new Error(`不支持的 MCP 传输协议: ${String(exhaustive)}`);
    }
  }
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      parts.push(String(item));
      continue;
    }
    const entry = item as Record<string, unknown>;
    switch (entry.type) {
      case 'text':
        parts.push(typeof entry.text === 'string' ? entry.text : '');
        break;
      case 'image':
      case 'audio':
        parts.push(
          `[${entry.type} ${String(entry.mimeType ?? 'unknown')} ${String(entry.data ?? '').length} chars]`,
        );
        break;
      case 'resource': {
        const resource = (entry.resource ?? {}) as Record<string, unknown>;
        if (typeof resource.text === 'string') parts.push(resource.text);
        else if (typeof resource.blob === 'string') {
          parts.push(
            `[binary resource ${String(resource.uri ?? '')} ${resource.blob.length} base64 chars]`,
          );
        } else parts.push(JSON.stringify(resource));
        break;
      }
      case 'resource_link':
        parts.push(`[resource ${String(entry.uri ?? '')}]`);
        break;
      default:
        parts.push(JSON.stringify(entry));
    }
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

export class McpClientPool {
  private readonly states = new Map<string, ServerState>();
  private readonly logger?: McpPoolLogger;
  private readonly transportFactory: McpTransportFactory;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly schemaCacheTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private closed = false;

  constructor(options: McpClientPoolOptions) {
    this.logger = options.logger;
    this.transportFactory =
      options.transportFactory ?? createDefaultMcpTransport;
    this.reconnectAttempts = Math.max(
      0,
      options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS,
    );
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.schemaCacheTtlMs =
      options.schemaCacheTtlMs ?? DEFAULT_SCHEMA_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    for (const config of options.servers) {
      assertConfig(config);
      if (this.states.has(config.id)) {
        throw new Error(`MCP Server id 重复: ${config.id}`);
      }
      this.states.set(config.id, {
        config,
        client: null,
        transport: null,
        connected: false,
        connecting: null,
        tools: [],
        toolByNamespacedName: new Map(),
        toolsFetchedAt: null,
        lastError: null,
      });
    }
  }

  /** 连接所有启用的 Server；单个失败不会阻断其它 Server。 */
  public async init(): Promise<void> {
    const enabled = [...this.states.values()].filter(
      (state) => state.config.enabled,
    );
    await Promise.all(
      enabled.map(async (state) => {
        try {
          await this.ensureConnected(state.config.id);
        } catch (error) {
          state.lastError = errorMessage(error);
          this.logger?.warn?.(
            { serverId: state.config.id, error: state.lastError },
            'mcp server unavailable at startup',
          );
        }
      }),
    );
  }

  public listEnabledServers(): EnterpriseMcpServerConfig[] {
    return [...this.states.values()]
      .filter((state) => state.config.enabled)
      .map((state) => state.config);
  }

  public getServerConfig(serverId: string): EnterpriseMcpServerConfig | null {
    return this.states.get(serverId)?.config ?? null;
  }

  public status(): McpServerStatus[] {
    return [...this.states.values()].map((state) => ({
      id: state.config.id,
      name: state.config.name,
      enabled: state.config.enabled,
      connected: state.connected,
      toolCount: state.tools.length,
      toolsFetchedAt: state.toolsFetchedAt,
      lastError: state.lastError,
    }));
  }

  /** 发现所有工具（带 Schema 缓存）；默认只返回启用且可连接的 Server 工具。 */
  public async listTools(options: { refresh?: boolean } = {}): Promise<
    McpToolDescriptor[]
  > {
    const enabled = [...this.states.values()].filter(
      (state) => state.config.enabled,
    );
    const collected: McpToolDescriptor[] = [];
    for (const state of enabled) {
      try {
        const tools = await this.loadTools(state, options.refresh === true);
        collected.push(...tools);
      } catch (error) {
        state.lastError = errorMessage(error);
        this.logger?.warn?.(
          { serverId: state.config.id, error: state.lastError },
          'mcp tool discovery failed',
        );
      }
    }
    return collected;
  }

  public async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    options: McpToolCallOptions = {},
  ): Promise<McpToolCallResult> {
    const located = this.locateTool(namespacedName);
    if (!located) {
      // Schema 缓存可能过期，强制刷新一次再找
      await this.listTools({ refresh: true });
      const retried = this.locateTool(namespacedName);
      if (!retried) {
        throw new Error(`未知 MCP 工具: ${namespacedName}`);
      }
      return this.invoke(retried.state, retried.tool, args, options);
    }
    return this.invoke(located.state, located.tool, args, options);
  }

  /** 对每个启用的 Server 做协议层 ping，并顺带恢复断线连接。 */
  public async healthCheck(): Promise<McpHealthResult[]> {
    const enabled = [...this.states.values()].filter(
      (state) => state.config.enabled,
    );
    return Promise.all(
      enabled.map(async (state) => {
        const startedAt = this.now();
        try {
          if (!state.client || !state.connected) {
            await this.ensureConnected(state.config.id);
          }
          await state.client?.ping({ timeout: state.config.timeoutMs });
          state.lastError = null;
          return {
            serverId: state.config.id,
            healthy: true,
            latencyMs: this.now() - startedAt,
          };
        } catch (error) {
          state.lastError = errorMessage(error);
          state.connected = false;
          return {
            serverId: state.config.id,
            healthy: false,
            latencyMs: this.now() - startedAt,
            error: state.lastError,
          };
        }
      }),
    );
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        await this.disconnect(state);
      }),
    );
  }

  private locateTool(
    namespacedName: string,
  ): { state: ServerState; tool: McpToolDescriptor } | null {
    for (const state of this.states.values()) {
      const tool = state.toolByNamespacedName.get(namespacedName);
      if (tool) return { state, tool };
    }
    return null;
  }

  private async loadTools(
    state: ServerState,
    refresh: boolean,
  ): Promise<McpToolDescriptor[]> {
    if (!refresh && this.schemaCacheFresh(state)) return state.tools;
    await this.ensureConnected(state.config.id);
    const client = state.client;
    if (!client) throw new Error(`MCP Server "${state.config.id}" 未连接`);

    const result = await client.listTools(
      undefined,
      { timeout: state.config.timeoutMs },
    );
    const tools: McpToolDescriptor[] = [];
    const byName = new Map<string, McpToolDescriptor>();
    for (const tool of result.tools) {
      const descriptor: McpToolDescriptor = {
        serverId: state.config.id,
        serverName: state.config.name,
        domain: state.config.domain,
        originalName: tool.name,
        namespacedName: namespacedToolName(state.config.id, tool.name),
        description: tool.description ?? '',
        inputSchema:
          tool.inputSchema &&
          typeof tool.inputSchema === 'object' &&
          !Array.isArray(tool.inputSchema)
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
        maxResultChars: state.config.maxResultChars,
      };
      if (byName.has(descriptor.namespacedName)) {
        throw new Error(
          `MCP Server "${state.config.id}" 的工具名冲突: ${descriptor.namespacedName}`,
        );
      }
      byName.set(descriptor.namespacedName, descriptor);
      tools.push(descriptor);
    }
    state.tools = tools;
    state.toolByNamespacedName = byName;
    state.toolsFetchedAt = this.now();
    state.lastError = null;
    return tools;
  }

  private schemaCacheFresh(state: ServerState): boolean {
    return (
      state.connected &&
      state.toolsFetchedAt !== null &&
      this.now() - state.toolsFetchedAt < this.schemaCacheTtlMs
    );
  }

  private async invoke(
    state: ServerState,
    tool: McpToolDescriptor,
    args: Record<string, unknown>,
    options: McpToolCallOptions,
  ): Promise<McpToolCallResult> {
    const attempt = async (): Promise<McpToolCallResult> => {
      await this.ensureConnected(state.config.id);
      const client = state.client;
      if (!client) throw new Error(`MCP Server "${state.config.id}" 未连接`);
      const result = await client.callTool(
        { name: tool.originalName, arguments: args },
        undefined,
        {
          timeout: state.config.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const record = result as unknown as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: boolean;
      };
      let text = textOfContent(record.content);
      if (record.structuredContent !== undefined) {
        const structured = JSON.stringify(record.structuredContent);
        text = text ? `${text}\n${structured}` : structured;
      }
      return {
        text,
        isError: record.isError === true,
        raw: result,
      };
    };

    try {
      return await attempt();
    } catch (error) {
      if (this.closed) throw error;
      state.lastError = errorMessage(error);
      state.connected = false;
      this.logger?.warn?.(
        { serverId: state.config.id, tool: tool.originalName, error: state.lastError },
        'mcp tool call failed, reconnecting',
      );
      await this.disconnect(state);
      return attempt();
    }
  }

  private async ensureConnected(serverId: string): Promise<void> {
    const state = this.states.get(serverId);
    if (!state) throw new Error(`未知 MCP Server: ${serverId}`);
    if (!state.config.enabled) {
      throw new Error(`MCP Server "${serverId}" 已被禁用`);
    }
    if (this.closed) throw new Error('MCP 连接池已关闭');
    if (state.connected && state.client) return;
    if (state.connecting) {
      await state.connecting;
      return;
    }
    if (state.client || state.transport) {
      await this.disconnect(state);
    }
    state.connecting = this.connectWithRetry(state).finally(() => {
      state.connecting = null;
    });
    await state.connecting;
  }

  private async connectWithRetry(state: ServerState): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.reconnectAttempts; attempt += 1) {
      try {
        await this.connectOnce(state);
        return;
      } catch (error) {
        lastError = error;
        state.lastError = errorMessage(error);
        await this.disconnect(state);
        if (attempt < this.reconnectAttempts) {
          this.logger?.warn?.(
            {
              serverId: state.config.id,
              attempt: attempt + 1,
              error: state.lastError,
            },
            'mcp reconnect attempt failed',
          );
          await this.sleep(this.reconnectDelayMs * (attempt + 1));
        }
      }
    }
    throw new Error(
      `连接 MCP Server "${state.config.id}" 失败: ${errorMessage(lastError)}`,
    );
  }

  private async connectOnce(state: ServerState): Promise<void> {
    const transport = await this.transportFactory(state.config);
    const client = new Client(
      { name: `dingtalk-agent-${state.config.id}`, version: '0.1.0' },
      { capabilities: {} },
    );
    transport.onclose = () => {
      state.connected = false;
    };
    transport.onerror = (error: Error) => {
      state.lastError = error.message;
      this.logger?.warn?.(
        { serverId: state.config.id, error: error.message },
        'mcp transport error',
      );
    };
    await client.connect(transport, { timeout: state.config.timeoutMs });
    state.transport = transport;
    state.client = client;
    state.connected = true;
    state.lastError = null;
    this.logger?.info?.(
      { serverId: state.config.id, transport: state.config.transport },
      'mcp server connected',
    );
  }

  private async disconnect(state: ServerState): Promise<void> {
    const client = state.client;
    const transport = state.transport;
    state.client = null;
    state.transport = null;
    state.connected = false;
    state.toolsFetchedAt = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // 关闭失败不影响重连
      }
    } else if (transport) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
  }
}
