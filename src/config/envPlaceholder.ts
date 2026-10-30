import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

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
