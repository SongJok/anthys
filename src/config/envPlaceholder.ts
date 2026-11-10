import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const UNRESOLVED_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * 展开 `${VAR}`；变量未设置或为空值时保留原样，便于日志定位缺失项。
 * 空值等价于未配置：否则 `AMAP_WEB_KEY=` 会被展开成 `?key=`，绕过“未配置”校验去发空密钥请求。
 */
export function expandEnvPlaceholder(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(PLACEHOLDER, (match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined || replacement.trim() === '') return match;
    return replacement;
  });
}

/** 列出仍未解析的 `${VAR}` 变量名：报错时只点名缺失项，不回显可能含密钥的原文 */
export function listUnresolvedEnvNames(value: string): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(PLACEHOLDER)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * 供密钥/地址等启动必需项使用：展开 `${VAR}`，仍存在未解析占位符时返回空串，
 * 让缺少密钥的配置按“未配置”参与回退，而不是把 `${KIMI_API_KEY}` 当成真实密钥。
 */
export function resolveEnvValue(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = value?.trim();
  if (!raw) return '';
  const expanded = expandEnvPlaceholder(raw, env).trim();
  return UNRESOLVED_PLACEHOLDER.test(expanded) ? '' : expanded;
}

/** 连接前展开 MCP 节点中可由 .env 提供的 endpointOrCommand / args / envOrHeaders */
export function expandServerEnvPlaceholders(
  server: EnterpriseMcpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseMcpServerConfig {
  return {
    ...server,
    endpointOrCommand: expandEnvPlaceholder(server.endpointOrCommand, env),
    ...(server.args
      ? { args: server.args.map((item) => expandEnvPlaceholder(item, env)) }
      : {}),
    ...(server.envOrHeaders
      ? {
          envOrHeaders: Object.fromEntries(
            Object.entries(server.envOrHeaders).map(([key, value]) => [
              key,
              expandEnvPlaceholder(value, env),
            ]),
          ),
        }
      : {}),
  };
}
