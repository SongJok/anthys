import type { ToolDefinition } from '../types/core.js';

const WRITE_TOOL_PATTERN =
  /(^|[^a-z])(delete|remove|drop|purge|destroy|revoke|terminate|truncate|reset|unbind|wipe|uninstall|create|update|upsert|insert|set|add|write|upload|send|post|publish|move|rename|import|apply|execute|run|approve|reject|grant|assign|enable|disable|start|stop|restart|mute|cancel|manage|configure|modify|change|edit|patch|deploy|install|archive)([^a-z]|$)/i;

/**
 * 只读工具判定：既看显式 risk，也用命名兜底覆盖未标注风险的老工具。
 * 管理工具与子代理委派一律不视为只读，避免研究单元获得写权限或递归委派。
 */
export function isReadOnlyTool(tool: ToolDefinition): boolean {
  if (tool.name === 'delegate_research' || tool.name === 'dispatch_worker') {
    return false;
  }
  if (tool.name.startsWith('admin_')) return false;
  if (tool.risk && tool.risk !== 'read') return false;
  return !WRITE_TOOL_PATTERN.test(tool.name);
}
