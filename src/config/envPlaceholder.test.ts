import { describe, expect, it } from 'vitest';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import {
  expandEnvPlaceholder,
  expandServerEnvPlaceholders,
} from './envPlaceholder.js';

function server(
  overrides: Partial<EnterpriseMcpServerConfig> = {},
): EnterpriseMcpServerConfig {
  return {
    id: 'enterprise',
    name: '企业 AI 中台',
    domain: 'general',
    transport: 'streamable-http',
    endpointOrCommand: '${ENTERPRISE_MCP_ENDPOINT}',
    envOrHeaders: { authorization: 'Bearer ${ENTERPRISE_MCP_TOKEN}' },
    timeoutMs: 180000,
    maxResultChars: 16000,
    enabled: true,
    ...overrides,
  };
}

describe('expandEnvPlaceholder', () => {
  it('展开已设置的变量，保留未设置的占位符', () => {
    expect(
      expandEnvPlaceholder('${A}/x/${B}', { A: 'https://mcp.example.com' }),
    ).toBe('https://mcp.example.com/x/${B}');
  });
});

describe('expandServerEnvPlaceholders', () => {
  it('展开 endpointOrCommand、args 与 envOrHeaders', () => {
    const resolved = expandServerEnvPlaceholders(
      server({ args: ['--dir', '${CODEBASE_DIR}'] }),
      {
        ENTERPRISE_MCP_ENDPOINT: 'https://dd-agent.tuwan.com/mcp/chat',
        ENTERPRISE_MCP_TOKEN: 'secret-token',
        CODEBASE_DIR: '/srv/code',
      },
    );
    expect(resolved.endpointOrCommand).toBe(
      'https://dd-agent.tuwan.com/mcp/chat',
    );
    expect(resolved.args).toEqual(['--dir', '/srv/code']);
    expect(resolved.envOrHeaders).toEqual({
      authorization: 'Bearer secret-token',
    });
  });

  it('不修改原始配置对象', () => {
    const original = server();
    expandServerEnvPlaceholders(original, {
      ENTERPRISE_MCP_ENDPOINT: 'https://example.com/mcp',
    });
    expect(original.endpointOrCommand).toBe('${ENTERPRISE_MCP_ENDPOINT}');
  });
});
