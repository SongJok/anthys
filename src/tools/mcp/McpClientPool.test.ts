import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EnterpriseMcpServerConfig } from '../../types/mcp-and-sandbox.js';
import type { ExecutionContext } from '../../types/core.js';
import {
  McpClientPool,
  createDefaultMcpTransport,
  namespacedToolName,
  type McpTransportFactory,
} from './McpClientPool.js';
import { McpToolProvider } from './McpToolProvider.js';

const LONG_ORDERS = Array.from({ length: 120 }, (_, index) => ({
  orderId: `ORDER-${index}`,
  status: index % 3 === 0 ? 'FAILED' : 'PAID',
  amount: 100 + index,
  errorCode: index % 3 === 0 ? 'PAY_TIMEOUT' : null,
  stack: `at com.shop.order.OrderService.pay(OrderService.java:${index})`,
}));

interface FakePartner {
  clientTransport: Transport;
  server: Server;
  callTool: () => number;
  listTools: () => number;
}

async function fakePartner(serverId: string): Promise<FakePartner> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: `fake-${serverId}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  let listCount = 0;
  let callCount = 0;
  const tools =
    serverId === 'prod_log'
      ? [
          {
            name: 'query_errors',
            description: '查询订单服务 ERROR 日志',
            inputSchema: {
              type: 'object' as const,
              properties: { service: { type: 'string' } },
              required: ['service'],
            },
          },
          {
            name: 'dump_orders',
            description: '导出订单样本',
            inputSchema: { type: 'object' as const, properties: {} },
          },
        ]
      : [
          {
            name: 'blame_file',
            description: '查看代码行提交人',
            inputSchema: {
              type: 'object' as const,
              properties: { file: { type: 'string' }, line: { type: 'number' } },
              required: ['file'],
            },
          },
        ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    listCount += 1;
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    callCount += 1;
    const name = request.params.name;
    if (name === 'query_errors') {
      const service = String(request.params.arguments?.service ?? 'unknown');
      if (service === 'fail') {
        return {
          content: [{ type: 'text' as const, text: '订单服务查询失败' }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify([
              { level: 'ERROR', service, message: 'PAY_TIMEOUT' },
              { level: 'ERROR', service, message: 'DB_DEADLOCK' },
            ]),
          },
        ],
      };
    }
    if (name === 'dump_orders') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(LONG_ORDERS) }],
      };
    }
    if (name === 'blame_file') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              file: request.params.arguments?.file,
              author: 'alice',
              commit: 'abc123',
            }),
          },
        ],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'unknown tool' }],
      isError: true,
    };
  });

  await server.connect(serverTransport);

  return {
    clientTransport,
    server,
    callTool: () => callCount,
    listTools: () => listCount,
  };
}

function config(
  id: string,
  overrides: Partial<EnterpriseMcpServerConfig> = {},
): EnterpriseMcpServerConfig {
  return {
    id,
    name: id,
    domain: id === 'prod_log' ? 'log' : 'code',
    transport: 'streamable-http',
    endpointOrCommand: `http://127.0.0.1/${id}`,
    timeoutMs: 3_000,
    enabled: true,
    maxResultChars: 8_000,
    ...overrides,
  };
}

const ctx: ExecutionContext = {
  conversationId: 'c1',
  messageId: 'msg+id/with=special',
  senderStaffId: 'staff-1',
  senderNick: 'n',
  conversationType: '1',
  deadlineAt: Date.now() + 30_000,
  now: () => Date.now(),
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn) await fn();
  }
});

function inMemoryFactory(): {
  factory: McpTransportFactory;
  partners: FakePartner[];
  factoryCalls: string[];
} {
  const partners: FakePartner[] = [];
  const factoryCalls: string[] = [];
  const factory: McpTransportFactory = async (serverConfig) => {
    factoryCalls.push(serverConfig.id);
    const partner = await fakePartner(serverConfig.id);
    partners.push(partner);
    cleanup.push(async () => {
      await partner.server.close();
    });
    return partner.clientTransport;
  };
  return { factory, partners, factoryCalls };
}

describe('namespacedToolName', () => {
  it('按 mcp__{serverId}__{toolName} 映射并清理非法字符', () => {
    expect(namespacedToolName('prod_log', 'query_errors')).toBe(
      'mcp__prod_log__query_errors',
    );
    expect(namespacedToolName('git code', 'blame.file')).toBe(
      'mcp__git_code__blame_file',
    );
  });

  it('超长名称在 64 字符内保持唯一', () => {
    const a = namespacedToolName('s'.repeat(40), 'a'.repeat(40));
    const b = namespacedToolName('s'.repeat(40), 'b'.repeat(40));
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});

describe('McpClientPool', () => {
  it('发现多个 Server 的工具并隔离命名空间，命中 Schema 缓存', async () => {
    const { factory, partners, factoryCalls } = inMemoryFactory();
    const pool = new McpClientPool({
      servers: [config('prod_log'), config('git_code')],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();

    const tools = await pool.listTools();
    expect(tools.map((tool) => tool.namespacedName).sort()).toEqual([
      'mcp__git_code__blame_file',
      'mcp__prod_log__dump_orders',
      'mcp__prod_log__query_errors',
    ]);
    expect(factoryCalls).toEqual(['prod_log', 'git_code']);

    const listCallsBefore = partners.map((partner) => partner.listTools());
    const cached = await pool.listTools();
    expect(cached).toHaveLength(3);
    expect(partners.map((partner) => partner.listTools())).toEqual(
      listCallsBefore,
    );

    await pool.listTools({ refresh: true });
    expect(partners.map((partner) => partner.listTools())).toEqual([2, 2]);
  });

  it('按命名空间调用不同 Server 的工具并拼接文本结果', async () => {
    const { factory } = inMemoryFactory();
    const pool = new McpClientPool({
      servers: [config('prod_log'), config('git_code')],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();
    await pool.listTools();

    const logs = await pool.callTool('mcp__prod_log__query_errors', {
      service: 'order',
    });
    expect(logs.isError).toBe(false);
    expect(logs.text).toContain('PAY_TIMEOUT');
    expect(logs.text).toContain('DB_DEADLOCK');

    const blame = await pool.callTool('mcp__git_code__blame_file', {
      file: 'OrderService.java',
    });
    expect(blame.text).toContain('alice');
  });

  it('工具级错误以 isError 返回而不是断开连接', async () => {
    const { factory } = inMemoryFactory();
    const pool = new McpClientPool({
      servers: [config('prod_log')],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();
    await pool.listTools();

    const result = await pool.callTool('mcp__prod_log__query_errors', {
      service: 'fail',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('查询失败');
    expect(pool.status()[0]?.connected).toBe(true);
  });

  it('初始化失败后按退避重连，并在恢复后完成工具发现', async () => {
    const partners: FakePartner[] = [];
    let attempts = 0;
    const factory: McpTransportFactory = async (serverConfig) => {
      attempts += 1;
      if (attempts <= 2) throw new Error('connection refused');
      const partner = await fakePartner(serverConfig.id);
      partners.push(partner);
      cleanup.push(async () => partner.server.close());
      return partner.clientTransport;
    };
    const pool = new McpClientPool({
      servers: [config('prod_log')],
      transportFactory: factory,
      reconnectAttempts: 1,
      reconnectDelayMs: 0,
    });
    cleanup.push(() => pool.close());

    await pool.init();
    expect(pool.status()[0]?.connected).toBe(false);
    expect(attempts).toBe(2);

    const tools = await pool.listTools();
    expect(tools.map((tool) => tool.namespacedName)).toContain(
      'mcp__prod_log__query_errors',
    );
    expect(attempts).toBe(3);
    expect(pool.status()[0]?.connected).toBe(true);
  });

  it('健康检查返回每个 Server 的 ping 结果', async () => {
    const { factory } = inMemoryFactory();
    const pool = new McpClientPool({
      servers: [config('prod_log'), config('git_code')],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();

    const health = await pool.healthCheck();
    expect(health).toHaveLength(2);
    expect(health.every((item) => item.healthy)).toBe(true);
  });

  it('禁用 Server 不参与发现与调用', async () => {
    const { factory, factoryCalls } = inMemoryFactory();
    const pool = new McpClientPool({
      servers: [config('prod_log'), config('git_code', { enabled: false })],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();
    const tools = await pool.listTools();
    expect(tools.every((tool) => tool.serverId !== 'git_code')).toBe(true);
    expect(factoryCalls).toEqual(['prod_log']);
  });
});

describe('createDefaultMcpTransport', () => {
  it('覆盖 stdio / sse / streamable-http 三种协议', () => {
    expect(
      createDefaultMcpTransport(
        config('stdio', {
          transport: 'stdio',
          endpointOrCommand: 'node',
          args: ['server.js'],
        }),
      ),
    ).toBeInstanceOf(StdioClientTransport);
    expect(
      createDefaultMcpTransport(
        config('sse', {
          transport: 'sse',
          endpointOrCommand: 'http://127.0.0.1:9000/sse',
        }),
      ),
    ).toBeInstanceOf(SSEClientTransport);
    expect(
      createDefaultMcpTransport(
        config('http', {
          transport: 'streamable-http',
          endpointOrCommand: 'http://127.0.0.1:9000/mcp',
        }),
      ),
    ).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('建立连接前按进程环境展开 endpointOrCommand', () => {
    const previous = process.env.ENTERPRISE_MCP_ENDPOINT;
    process.env.ENTERPRISE_MCP_ENDPOINT = 'http://127.0.0.1:9000/mcp';
    try {
      expect(
        createDefaultMcpTransport(
          config('http', {
            transport: 'streamable-http',
            endpointOrCommand: '${ENTERPRISE_MCP_ENDPOINT}',
          }),
        ),
      ).toBeInstanceOf(StreamableHTTPClientTransport);
    } finally {
      if (previous === undefined) delete process.env.ENTERPRISE_MCP_ENDPOINT;
      else process.env.ENTERPRISE_MCP_ENDPOINT = previous;
    }
  });

  it('环境变量缺失时给出明确错误', () => {
    delete process.env.MISSING_MCP_ENDPOINT;
    expect(() =>
      createDefaultMcpTransport(
        config('http', {
          transport: 'streamable-http',
          endpointOrCommand: '${MISSING_MCP_ENDPOINT}',
        }),
      ),
    ).toThrow(/未配置的环境变量/);
  });
});

describe('McpToolProvider', () => {
  it('正常结果直接返回，超长结果转存沙盒并返回前 20 条样本与 Schema', async () => {
    const { factory } = inMemoryFactory();
    const workspaceHost = await mkdtemp(join(tmpdir(), 'mcp-offload-'));
    cleanup.push(() => rm(workspaceHost, { recursive: true, force: true }));
    const pool = new McpClientPool({
      servers: [
        config('prod_log', { maxResultChars: 500 }),
      ],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();

    const provider = new McpToolProvider({
      pool,
      workspace: { hostDir: workspaceHost, sandboxDir: '/workspace' },
    });
    const tools = await provider.getTools(ctx);
    const shortTool = tools.find(
      (tool) => tool.name === 'mcp__prod_log__query_errors',
    );
    const dumpTool = tools.find(
      (tool) => tool.name === 'mcp__prod_log__dump_orders',
    );
    expect(shortTool).toBeDefined();
    expect(dumpTool).toBeDefined();

    const short = await shortTool!.execute({ service: 'order' }, ctx);
    expect(short).toContain('PAY_TIMEOUT');
    expect(JSON.parse(short).offloaded).toBeUndefined();

    const output = JSON.parse(
      await dumpTool!.execute({}, ctx),
    ) as Record<string, unknown>;
    expect(output.offloaded).toBe(true);
    const datasetKey = String(output.datasetKey);
    expect(datasetKey).toMatch(/^data_msgidwithspecial_\d+\.json$/);
    expect(output.datasetPath).toBe(`/workspace/${datasetKey}`);
    expect(output.previewCount).toBe(20);
    expect(Array.isArray(output.sample)).toBe(true);
    expect((output.sample as unknown[]).length).toBe(20);
    expect(String(output.schema)).toContain('"type":"array"');
    expect(String(output.hint)).toContain('sandbox_analyze_and_aggregate');

    const file = await readFile(join(workspaceHost, datasetKey), 'utf8');
    expect(JSON.parse(file)).toHaveLength(LONG_ORDERS.length);
  });

  it('同一消息内多次卸载使用递增的 stepId，避免覆盖', async () => {
    const { factory } = inMemoryFactory();
    const workspaceHost = await mkdtemp(join(tmpdir(), 'mcp-offload-'));
    cleanup.push(() => rm(workspaceHost, { recursive: true, force: true }));
    const pool = new McpClientPool({
      servers: [config('prod_log', { maxResultChars: 10 })],
      transportFactory: factory,
    });
    cleanup.push(() => pool.close());
    await pool.init();
    const provider = new McpToolProvider({
      pool,
      workspace: { hostDir: workspaceHost, sandboxDir: '/workspace' },
    });
    const tool = (await provider.getTools(ctx)).find(
      (item) => item.name === 'mcp__prod_log__query_errors',
    );
    const first = JSON.parse(await tool!.execute({ service: 'a' }, ctx));
    const second = JSON.parse(await tool!.execute({ service: 'b' }, ctx));
    expect(first.datasetKey).not.toBe(second.datasetKey);
    expect(second.datasetKey).toBe('data_msgidwithspecial_2.json');
  });
});
