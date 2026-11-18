import type { ToolDefinition } from '../types/core.js';

type ToolRisk = NonNullable<ToolDefinition['risk']>;

/**
 * 统一风险判定（fail-closed）：显式声明优先，未声明一律按 write 处理，
 * 必须经过审批闸门。名称推断不再参与放行决策，只用于审计提示。
 */
export function resolveToolRisk(tool: {
  name: string;
  risk?: ToolRisk;
  source?: string;
}): ToolRisk {
  return tool.risk ?? 'write';
}

const DESTRUCTIVE_VERBS =
  'delete|remove|drop|purge|destroy|revoke|terminate|truncate|reset|unbind|wipe|uninstall';
const WRITE_VERBS =
  'create|update|upsert|insert|set|add|write|upload|send|post|publish|move|rename|import|apply|execute|run|approve|reject|grant|assign|enable|disable|start|stop|restart|mute|cancel|manage|configure|modify|change|edit|patch|deploy|install|archive|sync|commit|merge|push|fork|transfer|bind|link|unlink|subscribe|unsubscribe|trigger|invoke|submit|schedule|register|unregister|attach|detach|copy|clone|restore|rollback|migrate|flush|clear|prune|close|lock|unlock|block|ban|kick|invite|pin|vote';
const VERB_PATTERN = new RegExp(
  `(^|[^a-z])(${DESTRUCTIVE_VERBS}|${WRITE_VERBS})([^a-z]|$)`,
  'i',
);
const DESTRUCTIVE_PATTERN = new RegExp(
  `(^|[^a-z])(${DESTRUCTIVE_VERBS})([^a-z]|$)`,
  'i',
);

/** 仅用于审计：按名称猜测风险，提示补齐显式声明；不参与任何放行决策 */
export function inferRiskFromName(name: string): ToolRisk {
  if (DESTRUCTIVE_PATTERN.test(name)) return 'destructive';
  if (VERB_PATTERN.test(name)) return 'write';
  return 'read';
}

/**
 * 只读工具判定：显式 risk 为 read 才算只读，未声明按写处理。
 * 管理工具与子代理委派一律不视为只读，避免研究单元获得写权限或递归委派。
 */
export function isReadOnlyToolName(
  name: string,
  risk?: ToolRisk,
): boolean {
  if (name === 'delegate_research' || name === 'dispatch_worker') {
    return false;
  }
  if (name.startsWith('admin_')) return false;
  return resolveToolRisk({ name, risk }) === 'read';
}

export function isReadOnlyTool(tool: ToolDefinition): boolean {
  return isReadOnlyToolName(tool.name, tool.risk);
}