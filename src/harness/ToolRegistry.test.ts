import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  AgentStreamEvent,
  ChatCompletionRequest,
  ChatModel,
  ChatStreamChunk,
  DynamicLoopPolicy,
  ExecutionContext,
} from '../types/core.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import { ReActRunner } from '../react/ReActRunner.js';
import { DwsCliRunner } from '../tools/dws/DwsCliRunner.js';
import type { McpTransportFactory } from '../tools/mcp/McpClientPool.js';
import { loadMcpServerConfigs, ToolRegistry } from './ToolRegistry.js';

const ORDERS = Array.from({ length: 120 }, (_, index) => ({
  orderId: `ORDER-${index}`,
  status: index % 3 === 0 ? 'FAILED' : 'PAID',
  amount: 100 + index,
  traceId: `trace-${index}`,
}));

const FAILED_COUNT = ORDERS.filter((order) => order.status === 'FAILED').length;
const TOTAL_AMOUNT = ORDERS.reduce((sum, order) => sum + order.amount, 0);
const FAILED_AMOUNT = ORDERS.filter((order) => order.status === 'FAILED').reduce(
  (sum, order) => sum + order.amount,
  0,
);

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn) await fn();
  }
});

async function startMcpPartner(serverId: string): Promise<{
  transport: Transport;
  server: Server;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: `fake-${serverId}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const isLog = serverId === 'prod_log';
  const tools = isLog
    ? [
        {
          name: 'dump_orders',
          description: '导出近 1 小时订单样本',
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'dump_orders') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(ORDERS) }],
      };
    }
    if (request.params.name === 'blame_file') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              file: request.params.arguments?.file,
              line: request.params.arguments?.line,
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
  cleanup.push(async () => {
    await server.close();
  });
  return { transport: clientTransport, server };
}

function serverConfig(
  id: string,
  domain: EnterpriseMcpServerConfig['domain'],
): EnterpriseMcpServerConfig {
  return {
    id,
    name: id,
    domain,
    transport: 'streamable-http',
    endpointOrCommand: `http://127.0.0.1/${id}`,
    timeoutMs: 5_000,
    enabled: true,
    maxResultChars: 400,
  };
}

function toolTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ChatStreamChunk[] {
  return [
    {
      toolCallDelta: {
        index: 0,
        id,
        name,
        argumentsDelta: JSON.stringify(args),
      },
    },
    { finishReason: 'tool_calls', usage: { totalTokens: 10 } },
  ];
}

function toolContents(messages: ChatCompletionRequest['messages']): string {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');
}

/**
 * 模拟真实模型的 5 轮决策：查询订单 → 定位代码提交人 → 沙盒聚合
 * → 查钉钉知识库 → 汇总回答。后两轮读取前序真实工具观察。
 */
class CompositeModel implements ChatModel {
  public readonly modelName = 'composite-model';
  public turns = 0;

  public async *streamChat(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatStreamChunk> {
    this.turns += 1;
    let chunks: ChatStreamChunk[];
    switch (this.turns) {
      case 1:
        chunks = toolTurn('call_orders', 'mcp__prod_log__dump_orders', {});
        break;
      case 2:
        chunks = toolTurn('call_blame', 'mcp__git_code__blame_file', {
          file: 'src/order.js',
          line: 42,
        });
        break;
      case 3:
        chunks = this.sandboxTurn(toolContents(request.messages));
        break;
      case 4:
        chunks = toolTurn('call_doc', 'dws_doc_search_and_read', {
          target: 'wiki',
          action: 'search',
          query: '订单超时复盘',
        });
        break;
      default:
        chunks = this.finalTurn(toolContents(request.messages));
    }
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  private sandboxTurn(observations: string): ChatStreamChunk[] {
    const datasetKey = observations.match(/"datasetKey":"([^"]+)"/)?.[1];
    if (!datasetKey) {
      return [
        { contentDelta: '未能获取卸载后的 datasetKey。', finishReason: 'stop' },
      ];
    }
    const code = [
      `const orders = datasets['${datasetKey}'];`,
      'const failed = orders.filter((o) => o.status === "FAILED");',
      'result = {',
      '  total: orders.length,',
      '  failed: failed.length,',
      '  paid: orders.length - failed.length,',
      '  failedAmount: failed.reduce((s, o) => s + o.amount, 0),',
      '  totalAmount: orders.reduce((s, o) => s + o.amount, 0),',
      '};',
    ].join('\n');
    return toolTurn('call_sandbox', 'sandbox_analyze_and_aggregate', {
      language: 'javascript',
      code,
      datasetKeys: [datasetKey],
    });
  }

  private finalTurn(observations: string): ChatStreamChunk[] {
    const number = (key: string): string => {
      const matched = observations.match(
        new RegExp(`\\\\?"${key}\\\\?":(\\d+)`),
      );
      return matched?.[1] ?? '未知';
    };
    const author =
      observations.match(/"author":"([^"]+)"/)?.[1] ?? '未知提交人';
    const hasDoc = observations.includes('订单超时复盘');
    const answer =
      `订单服务共 ${number('total')} 单，其中失败 ${number('failed')} 单，` +
      `失败金额 ${number('failedAmount')}，总金额 ${number('totalAmount')}；` +
      `报错行由 ${author} 提交；` +
      (hasDoc ? '已匹配知识库文档《订单超时复盘》。' : '知识库未检索到复盘文档。');
    return [{ contentDelta: answer }, { finishReason: 'stop' }];
  }
}

const policy: DynamicLoopPolicy = {
  maxWallTimeMs: 120_000,
  maxTotalTokens: 64_000,
  maxConsecutiveSameTool: 2,
  convergenceCheck: false,
};

function makeContext(deadlineAt = Date.now() + 60_000): ExecutionContext {
  return {
    conversationId: 'conv-phase2',
    messageId: 'msg-phase2',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt,
    now: () => Date.now(),
  };
}

async function writeFakeDws(dir: string): Promise<string> {
  const script = join(dir, 'dws');
  await writeFile(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const argv = process.argv.slice(2);',
      'if (process.env.FAKE_DWS_LOG) {',
      "  fs.appendFileSync(process.env.FAKE_DWS_LOG, JSON.stringify({",
      '    argv,',
      '    operator: process.env.DWS_OPERATOR_STAFF_ID,',
      '  }) + "\\n");',
      '}',
      'process.stdout.write(JSON.stringify({',
      '  items: [{ title: "订单超时复盘", docId: "doc-1" }],',
      '  argv,',
      '}));',
    ].join('\n'),
    'utf8',
  );
  await chmod(script, 0o755);
  return script;
}

describe('ToolRegistry 阶段二联调', () => {
  it('ReAct 多步串联 MCP 日志 + 代码 + 沙盒聚合 + DWS 知识库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-registry-'));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const workspace = { hostDir: join(root, 'workspace'), sandboxDir: '/workspace' };
    const dwsLog = join(root, 'dws-calls.log');
    const dwsBinary = await writeFakeDws(root);

    const factory: McpTransportFactory = async (config) => {
      const partner = await startMcpPartner(config.id);
      return partner.transport;
    };
    const registry = await ToolRegistry.create({
      mcpServers: [
        serverConfig('prod_log', 'log'),
        serverConfig('git_code', 'code'),
      ],
      transportFactory: factory,
      workspace,
      dwsRunner: new DwsCliRunner({
        binary: dwsBinary,
        env: { ...process.env, FAKE_DWS_LOG: dwsLog },
      }),
    });
    cleanup.push(async () => {
      await registry.close();
    });

    expect(registry.providers.map((provider) => provider.providerName)).toEqual([
      'builtin',
      'mcp',
      'dws',
      'sandbox',
    ]);
    expect(registry.pool?.listEnabledServers().map((server) => server.id)).toEqual(
      ['prod_log', 'git_code'],
    );

    const model = new CompositeModel();
    const runner = new ReActRunner({
      model,
      toolProviders: registry.providers,
      policy,
    });
    const events: AgentStreamEvent[] = [];
    const result = await runner.run({
      messages: [
        {
          role: 'user',
          content:
            '帮我查一下订单服务最近 30 分钟的 ERROR 日志，结合代码库看看报错那行是谁提交的，' +
            '再查一下线上库过去 1 小时的失败订单数并汇总分析，最后找一下知识库里的复盘文档。',
        },
      ],
      context: makeContext(),
      emit: (event) => events.push(event),
    });

    expect(model.turns).toBe(5);
    expect(result.usage.steps).toBe(5);
    expect(
      events
        .filter((event) => event.type === 'tool_start')
        .map((event) => (event.type === 'tool_start' ? event.toolName : '')),
    ).toEqual([
      'mcp__prod_log__dump_orders',
      'mcp__git_code__blame_file',
      'sandbox_analyze_and_aggregate',
      'dws_doc_search_and_read',
    ]);
    const toolEnds = events.filter((event) => event.type === 'tool_end');
    expect(toolEnds).toHaveLength(4);
    expect(
      toolEnds.map((event) =>
        event.type === 'tool_end' ? event.isError : true,
      ),
    ).toEqual([false, false, false, false]);

    const summaries = events
      .filter((event) => event.type === 'tool_end')
      .map((event) => (event.type === 'tool_end' ? event.summary : ''));
    expect(summaries[0]).toContain('"offloaded":true');
    expect(summaries[0]).toContain('"datasetKey":"data_');
    expect(summaries[1]).toContain('alice');
    expect(summaries[3]).toContain('订单超时复盘');

    const datasetFiles = (await readdir(workspace.hostDir)).filter((name) =>
      /^data_.*\.json$/.test(name),
    );
    expect(datasetFiles).toHaveLength(1);
    const datasetFile = await readFile(
      join(workspace.hostDir, datasetFiles[0]),
      'utf8',
    );
    expect(JSON.parse(datasetFile)).toHaveLength(ORDERS.length);

    const dwsCalls = (await readFile(dwsLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; operator: string });
    expect(dwsCalls).toEqual([
      {
        argv: ['wiki', 'search', '--query', '订单超时复盘'],
        operator: 'staff-1',
      },
    ]);

    expect(result.answer).toContain(`共 ${ORDERS.length} 单`);
    expect(result.answer).toContain(`失败 ${FAILED_COUNT} 单`);
    expect(result.answer).toContain(`失败金额 ${FAILED_AMOUNT}`);
    expect(result.answer).toContain(`总金额 ${TOTAL_AMOUNT}`);
    expect(result.answer).toContain('alice');
    expect(result.answer).toContain('订单超时复盘');
  });
});

describe('loadMcpServerConfigs', () => {
  async function tempConfig(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-config-'));
    cleanup.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'mcp-servers.json');
    await writeFile(path, content, 'utf8');
    return path;
  }

  it('支持 servers 包装格式并展开环境变量', async () => {
    const path = await tempConfig(
      JSON.stringify({
        servers: [
          {
            id: 'mcp-codebase',
            name: '代码库',
            domain: 'code',
            transport: 'stdio',
            endpointOrCommand: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '${CODEBASE_DIR}'],
            envOrHeaders: { TOKEN: '${CODE_TOKEN}' },
            timeoutMs: 20000,
            enabled: true,
            maxResultChars: 9000,
          },
        ],
      }),
    );
    const [server] = await loadMcpServerConfigs(path, {
      CODEBASE_DIR: '/srv/code',
      CODE_TOKEN: 'secret-token',
    });
    expect(server).toMatchObject({
      id: 'mcp-codebase',
      name: '代码库',
      domain: 'code',
      transport: 'stdio',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/code'],
      envOrHeaders: { TOKEN: 'secret-token' },
      timeoutMs: 20000,
      maxResultChars: 9000,
      enabled: true,
    });
  });

  it('缺少环境变量时保留占位符', async () => {
    const path = await tempConfig(
      JSON.stringify([
        {
          id: 'mcp-apidoc',
          domain: 'apidoc',
          transport: 'streamable-http',
          endpointOrCommand: '${APIDOC_URL}',
          timeoutMs: 15000,
          maxResultChars: 8000,
        },
      ]),
    );
    const [server] = await loadMcpServerConfigs(path, {});
    expect(server.endpointOrCommand).toBe('${APIDOC_URL}');
    expect(server.name).toBe('mcp-apidoc');
    expect(server.enabled).toBe(true);
  });

  it('配置不存在时返回空列表', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-missing-'));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await expect(
      loadMcpServerConfigs(join(root, 'absent.json'), {}),
    ).resolves.toEqual([]);
  });

  it('拒绝非法 JSON、传输协议与过小阈值', async () => {
    const broken = await tempConfig('{ not json');
    await expect(loadMcpServerConfigs(broken, {})).rejects.toThrow(
      '不是合法 JSON',
    );

    const badTransport = await tempConfig(
      JSON.stringify([
        {
          id: 'bad',
          domain: 'log',
          transport: 'grpc',
          endpointOrCommand: 'x',
          timeoutMs: 1000,
          maxResultChars: 8000,
        },
      ]),
    );
    await expect(loadMcpServerConfigs(badTransport, {})).rejects.toThrow(
      'transport 非法',
    );

    const smallLimit = await tempConfig(
      JSON.stringify([
        {
          id: 'small',
          domain: 'log',
          transport: 'sse',
          endpointOrCommand: 'http://127.0.0.1/sse',
          timeoutMs: 1000,
          maxResultChars: 10,
        },
      ]),
    );
    await expect(loadMcpServerConfigs(smallLimit, {})).rejects.toThrow(
      'maxResultChars 必须 >= 200',
    );
  });
});
