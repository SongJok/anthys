import { describe, expect, it } from 'vitest';
import {
  createToolExecutionPolicy,
  parseToolExecutionPolicy,
  PolicyToolProvider,
} from './ToolExecutionPolicy.js';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parametersJsonSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  };
}

function provider(name: string, names: string[]): IToolProvider {
  return {
    providerName: name,
    getTools: async () => names.map(tool),
  };
}

function context(): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'm-1',
    senderStaffId: 'u-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: Date.now,
  };
}

describe('ToolExecutionPolicy', () => {
  it('allow 为空不限制，deny 永远优先', () => {
    const open = createToolExecutionPolicy();
    expect(open.isDefault()).toBe(true);
    expect(open.allows('delete_user')).toBe(true);

    const denied = createToolExecutionPolicy({
      allow: ['mcp__crm__*', 'delete_user'],
      deny: ['delete_user'],
    });
    expect(denied.isDefault()).toBe(false);
    expect(denied.allows('mcp__crm__create_ticket')).toBe(true);
    expect(denied.allows('delete_user')).toBe(false);
    expect(denied.allows('web_search')).toBe(false);
  });

  it('从环境变量解析并忽略空白与重复项', () => {
    const policy = parseToolExecutionPolicy({
      TOOL_EXECUTION_ALLOWLIST: ' web_* , web_search, ',
      TOOL_EXECUTION_DENYLIST: 'web_fetch',
    });
    expect(policy.describe()).toEqual({
      allow: ['web_*', 'web_search'],
      deny: ['web_fetch'],
    });
    expect(policy.allows('web_search')).toBe(true);
    expect(policy.allows('web_fetch')).toBe(false);
    expect(policy.allows('dws_doc_read')).toBe(false);
  });
});

describe('PolicyToolProvider', () => {
  it('在工具列表层过滤被禁用的工具', async () => {
    const policy = createToolExecutionPolicy({
      deny: ['delete_*', 'admin_*'],
    });
    const wrapped = new PolicyToolProvider({
      providers: () => [
        provider('a', ['search_docs', 'delete_doc']),
        provider('b', ['admin_inspect', 'create_ticket']),
      ],
      policy,
    });
    const names = (await wrapped.getTools(context())).map((item) => item.name);
    expect(names).toEqual(['search_docs', 'create_ticket']);
  });

  it('每次获取时重新解析底层 Provider，支持热更新', async () => {
    const providers: IToolProvider[] = [provider('a', ['search_docs'])];
    const wrapped = new PolicyToolProvider({
      providers: () => providers,
      policy: createToolExecutionPolicy({ deny: ['delete_*'] }),
    });
    expect((await wrapped.getTools(context())).map((item) => item.name)).toEqual([
      'search_docs',
    ]);
    providers.push(provider('b', ['delete_doc', 'create_ticket']));
    expect((await wrapped.getTools(context())).map((item) => item.name)).toEqual([
      'search_docs',
      'create_ticket',
    ]);
  });
});
