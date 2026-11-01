import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const UNRESOLVED_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/** 展开 `${VAR}`；变量未设置时保留原样，便于日志定位缺失项 */
export function expandEnvPlaceholder(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(PLACEHOLDER, (match, name: string) => {
    const replacement = env[name];
    return replacement === undefined ? match : replacement;
  });
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
