import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';

export const MCP_SECRET_MASK = '********';

/** 常见把密钥放在 query 里的参数名；高德是 key，百度是 ak，多数开放平台是 token */
const SECRET_QUERY_PARAM =
  /^(?:key|ak|apikey|api_?key|token|access_?token|secret)$/iu;

/** 纯 `${VAR}` 占位符不是密钥本身，保留原文才能看出该配哪个环境变量 */
const ENV_PLACEHOLDER_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

const QUERY_PAIR = /([?&])([^=&#]+)=([^&#]*)/gu;

/**
 * 按原始字符串替换 query 参数，不走 URL 规范化。
 * 否则同一 endpoint 里未处理的 `${VAR}` 会被编码成 `%24%7B...%7D`，配置就被改写了。
 */
function rewriteSecretParams(
  endpoint: string,
  rewrite: (name: string, rawValue: string) => string | null,
): string {
  if (!endpoint.includes('?')) return endpoint;
  return endpoint.replace(
    QUERY_PAIR,
    (match, separator: string, rawName: string, rawValue: string) => {
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        return match;
      }
      if (!SECRET_QUERY_PARAM.test(name)) return match;
      const replacement = rewrite(name, rawValue);
      return replacement === null
        ? match
        : `${separator}${rawName}=${replacement}`;
    },
  );
}

function decodeValue(rawValue: string): string | null {
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return null;
  }
}

function queryParamsOf(endpoint: string): Map<string, string> {
  const params = new Map<string, string>();
  const queryIndex = endpoint.indexOf('?');
  if (queryIndex < 0) return params;
  const search = new URLSearchParams(endpoint.slice(queryIndex + 1).split('#')[0]);
  for (const [key, value] of search) params.set(key, value);
  return params;
}

/** 脱敏 endpoint 里的 query 密钥（如高德 `?key=...`） */
export function maskEndpointSecrets(endpoint: string): string {
  return rewriteSecretParams(endpoint, (_name, rawValue) => {
    if (!rawValue || rawValue === MCP_SECRET_MASK) return null;
    const decoded = decodeValue(rawValue);
    if (decoded === null || ENV_PLACEHOLDER_ONLY.test(decoded)) return null;
    return MCP_SECRET_MASK;
  });
}

/** 控制台把掩码原样提交回来时，从旧配置取回真实密钥，避免把 ******** 写进配置 */
export function restoreMaskedEndpoint(next: string, previous: string): string {
  if (!next.includes(MCP_SECRET_MASK)) return next;
  const previousParams = queryParamsOf(previous);
  return rewriteSecretParams(next, (name, rawValue) => {
    if (rawValue !== MCP_SECRET_MASK) return null;
    const previousValue = previousParams.get(name);
    if (previousValue === undefined) return null;
    return ENV_PLACEHOLDER_ONLY.test(previousValue)
      ? previousValue
      : encodeURIComponent(previousValue);
  });
}

export function maskMcpServers(
  servers: readonly EnterpriseMcpServerConfig[],
): EnterpriseMcpServerConfig[] {
  return servers.map((server) => ({
    ...server,
    endpointOrCommand: maskEndpointSecrets(server.endpointOrCommand),
    ...(server.envOrHeaders
      ? {
          envOrHeaders: Object.fromEntries(
            Object.keys(server.envOrHeaders).map((key) => [key, MCP_SECRET_MASK]),
          ),
        }
      : {}),
  }));
}

export function restoreMaskedMcpEnv(
  server: EnterpriseMcpServerConfig,
  existing: EnterpriseMcpServerConfig,
): EnterpriseMcpServerConfig {
  const endpointOrCommand = restoreMaskedEndpoint(
    server.endpointOrCommand,
    existing.endpointOrCommand,
  );
  if (!server.envOrHeaders) {
    return endpointOrCommand === server.endpointOrCommand
      ? server
      : { ...server, endpointOrCommand };
  }
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.envOrHeaders)) {
    if (value === MCP_SECRET_MASK) {
      const previous = existing.envOrHeaders?.[key];
      if (previous !== undefined) merged[key] = previous;
      continue;
    }
    merged[key] = value;
  }
  const next = { ...server, endpointOrCommand };
  delete next.envOrHeaders;
  return Object.keys(merged).length > 0
    ? { ...next, envOrHeaders: merged }
    : next;
}
