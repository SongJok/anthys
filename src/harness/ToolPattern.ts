/** 工具名单项支持精确匹配与结尾 `*` 前缀匹配，例如 `mcp__code__*` */
export function matchesToolPattern(pattern: string, name: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}
