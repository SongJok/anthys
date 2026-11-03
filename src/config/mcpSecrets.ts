import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';

export const MCP_SECRET_MASK = '********';

export function maskMcpServers(
  servers: readonly EnterpriseMcpServerConfig[],
): EnterpriseMcpServerConfig[] {
  return servers.map((server) =>
    server.envOrHeaders
      ? {
          ...server,
          envOrHeaders: Object.fromEntries(
            Object.keys(server.envOrHeaders).map((key) => [key, MCP_SECRET_MASK]),
          ),
        }
      : { ...server },
  );
}

export function restoreMaskedMcpEnv(
  server: EnterpriseMcpServerConfig,
  existing: EnterpriseMcpServerConfig,
): EnterpriseMcpServerConfig {
  if (!server.envOrHeaders) return server;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.envOrHeaders)) {
    if (value === MCP_SECRET_MASK) {
      const previous = existing.envOrHeaders?.[key];
      if (previous !== undefined) merged[key] = previous;
      continue;
    }
    merged[key] = value;
  }
  const next = { ...server };
  delete next.envOrHeaders;
  return Object.keys(merged).length > 0
    ? { ...next, envOrHeaders: merged }
    : next;
}
