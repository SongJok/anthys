import { describe, expect, it } from 'vitest';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import {
  MCP_SECRET_MASK,
  maskEndpointSecrets,
  maskMcpServers,
  restoreMaskedEndpoint,
  restoreMaskedMcpEnv,
} from './mcpSecrets.js';

function server(
  overrides: Partial<EnterpriseMcpServerConfig> = {},
): EnterpriseMcpServerConfig {
  return {
    id: 'amap',
    name: '高德地图',
    domain: 'general',
    transport: 'streamable-http',
    endpointOrCommand: 'https://mcp.amap.com/mcp?key=${AMAP_WEB_KEY}',
    timeoutMs: 15_000,
    maxResultChars: 8_000,
    enabled: true,
    ...overrides,
  };
}

describe('MCP endpoint 密钥脱敏', () => {
  it('query 里的字面量 key 被替换成掩码', () => {
    expect(
      maskEndpointSecrets('https://mcp.amap.com/mcp?key=abc123&format=0'),
    ).toBe(`https://mcp.amap.com/mcp?key=${MCP_SECRET_MASK}&format=0`);
  });

  it('纯 ${VAR} 占位符保留原文，能看出缺哪个环境变量', () => {
    const endpoint = 'https://mcp.amap.com/mcp?key=${AMAP_WEB_KEY}';
    expect(maskEndpointSecrets(endpoint)).toBe(endpoint);
  });

  it('非密钥参数不动，stdio 命令原样返回', () => {
    expect(maskEndpointSecrets('https://mcp.amap.com/mcp?format=0')).toBe(
      'https://mcp.amap.com/mcp?format=0',
    );
    expect(maskEndpointSecrets('npx -y some-mcp-server')).toBe(
      'npx -y some-mcp-server',
    );
  });

  it('token / ak 同样脱敏，大小写不敏感', () => {
    expect(maskEndpointSecrets('https://x.example.com/mcp?AK=real&Token=t1')).toBe(
      `https://x.example.com/mcp?AK=${MCP_SECRET_MASK}&Token=${MCP_SECRET_MASK}`,
    );
  });

  it('掩码原样提交时从旧配置取回真实值，不把 ******** 写进配置', () => {
    expect(
      restoreMaskedEndpoint(
        `https://mcp.amap.com/mcp?key=${MCP_SECRET_MASK}`,
        'https://mcp.amap.com/mcp?key=real-key',
      ),
    ).toBe('https://mcp.amap.com/mcp?key=real-key');
  });

  it('旧配置也是占位符时恢复成占位符', () => {
    expect(
      restoreMaskedEndpoint(
        `https://mcp.amap.com/mcp?key=${MCP_SECRET_MASK}`,
        'https://mcp.amap.com/mcp?key=${AMAP_WEB_KEY}',
      ),
    ).toBe('https://mcp.amap.com/mcp?key=${AMAP_WEB_KEY}');
  });

  it('没有掩码时原样返回，不做 URL 规范化改写', () => {
    const endpoint = 'https://mcp.amap.com/mcp?key=abc123';
    expect(restoreMaskedEndpoint(endpoint, '')).toBe(endpoint);
  });

  it('maskMcpServers 同时遮蔽 endpoint 与 envOrHeaders', () => {
    const [masked] = maskMcpServers([
      server({
        endpointOrCommand: 'https://mcp.amap.com/mcp?key=abc123',
        envOrHeaders: { authorization: 'Bearer token' },
      }),
    ]);
    expect(masked.endpointOrCommand).toBe(
      `https://mcp.amap.com/mcp?key=${MCP_SECRET_MASK}`,
    );
    expect(masked.envOrHeaders).toEqual({ authorization: MCP_SECRET_MASK });
  });

  it('控制台读改写一轮后配置与原来一致', () => {
    const existing = server({
      endpointOrCommand: 'https://mcp.amap.com/mcp?key=abc123',
      envOrHeaders: { authorization: 'Bearer token' },
    });
    const [masked] = maskMcpServers([existing]);
    const restored = restoreMaskedMcpEnv({ ...masked, name: '高德地图 v2' }, existing);
    expect(restored.endpointOrCommand).toBe(existing.endpointOrCommand);
    expect(restored.envOrHeaders).toEqual(existing.envOrHeaders);
    expect(restored.name).toBe('高德地图 v2');
  });
});