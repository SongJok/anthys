import { describe, expect, it } from 'vitest';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';
import type { WorkerToolScope } from '../types/workers.js';
import {
  ScopedToolProvider,
  isToolAllowedForScope,
  matchesToolPattern,
} from './ScopedToolProvider.js';

function tool(
  name: string,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parametersJsonSchema: { type: 'object', properties: {} },
    async execute() {
      return 'ok';
    },
    ...overrides,
  };
}

function ctx(): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: 10_000,
    now: () => 1_000,
  };
}

function provider(
  name: string,
  tools: ToolDefinition[],
): IToolProvider {
  return {
    providerName: name,
    async getTools() {
      return tools;
    },
  };
}

const ALL_TOOLS = [
  tool('search_docs', { risk: 'read' }),
  tool('list_items', { risk: 'read' }),
  tool('create_ticket', { risk: 'write' }),
  tool('delete_repo', { risk: 'destructive' }),
  tool('admin_inspect_system', { risk: 'read' }),
  tool('delegate_research', { risk: 'read' }),
];

describe('matchesToolPattern', () => {
  it('支持精确匹配与结尾通配', () => {
    expect(matchesToolPattern('search_docs', 'search_docs')).toBe(true);
    expect(matchesToolPattern('search_*', 'search_docs')).toBe(true);
    expect(matchesToolPattern('search_*', 'list_search')).toBe(false);
    expect(matchesToolPattern('search_docs', 'search_docs_v2')).toBe(false);
  });
});

describe('isToolAllowedForScope', () => {
  it('只读范围拒绝写工具、管理工具与递归委派', () => {
    const scope: WorkerToolScope = { readOnly: true };
    expect(isToolAllowedForScope(tool('search_docs', { risk: 'read' }), scope)).toBe(true);
    expect(isToolAllowedForScope(tool('create_ticket', { risk: 'write' }), scope)).toBe(false);
    expect(isToolAllowedForScope(tool('admin_inspect_system'), scope)).toBe(false);
    expect(isToolAllowedForScope(tool('delegate_research'), scope)).toBe(false);
  });

  it('写范围允许写工具但仍排除破坏性工具与管理员工具', () => {
    const scope: WorkerToolScope = { readOnly: false };
    expect(isToolAllowedForScope(tool('create_ticket', { risk: 'write' }), scope)).toBe(true);
    expect(isToolAllowedForScope(tool('delete_repo', { risk: 'destructive' }), scope)).toBe(false);
    expect(isToolAllowedForScope(tool('admin_inspect_system', { risk: 'read' }), scope)).toBe(false);
  });

  it('允许名单先收敛，再应用拒绝名单', () => {
    const scope: WorkerToolScope = {
      readOnly: false,
      allow: ['mcp__code__*', 'search_docs'],
      deny: ['mcp__code__delete_*'],
    };
    expect(isToolAllowedForScope(tool('search_docs', { risk: 'read' }), scope)).toBe(true);
    expect(isToolAllowedForScope(tool('mcp__code__query', { risk: 'read' }), scope)).toBe(true);
    expect(isToolAllowedForScope(tool('mcp__code__delete_branch', { risk: 'write' }), scope)).toBe(false);
    expect(isToolAllowedForScope(tool('create_ticket', { risk: 'write' }), scope)).toBe(false);
  });
});

describe('ScopedToolProvider', () => {
  it('合并多个来源、去重并按范围过滤', async () => {
    const scoped = new ScopedToolProvider({
      providers: () => [
        provider('a', ALL_TOOLS.slice(0, 4)),
        provider('b', [tool('search_docs', { risk: 'read' }), tool('list_items', { risk: 'read' })]),
      ],
      scope: { readOnly: true },
    });
    const tools = await scoped.getTools(ctx());
    expect(tools.map((item) => item.name)).toEqual(['search_docs', 'list_items']);
  });

  it('每次调用重新解析提供方，后注册的工具即时可见', async () => {
    const providers: IToolProvider[] = [provider('a', [tool('search_docs', { risk: 'read' })])];
    const scoped = new ScopedToolProvider({
      providers: () => providers,
      scope: { readOnly: true },
    });
    expect((await scoped.getTools(ctx())).map((item) => item.name)).toEqual(['search_docs']);
    providers.push(provider('b', [tool('get_issue', { risk: 'read' })]));
    expect((await scoped.getTools(ctx())).map((item) => item.name)).toEqual([
      'search_docs',
      'get_issue',
    ]);
  });
});
