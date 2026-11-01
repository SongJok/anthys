import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
} from '../types/core.js';
import type { WorkerToolScope } from '../types/workers.js';
import { isReadOnlyTool } from '../tools/toolRisk.js';
import { matchesToolPattern } from '../harness/ToolPattern.js';

export { matchesToolPattern } from '../harness/ToolPattern.js';

export interface ScopedToolProviderOptions {
  /** 每次 getTools 时解析，确保后注册的工具（如子代理）也能即时生效 */
  providers: () => IToolProvider[];
  scope: WorkerToolScope;
  providerName?: string;
}

/**
 * 执行层工具白名单：Worker 只能看到画像允许的工具。
 * 只读画像额外复用命名 + risk 双重判定，管理员工具与递归委派永远不可见。
 */
export function isToolAllowedForScope(
  tool: ToolDefinition,
  scope: WorkerToolScope,
): boolean {
  if (tool.name.startsWith('admin_')) return false;
  if (tool.name === 'delegate_research') return false;
  if (scope.allow && !scope.allow.some((p) => matchesToolPattern(p, tool.name))) {
    return false;
  }
  if (scope.deny?.some((p) => matchesToolPattern(p, tool.name))) return false;
  if (scope.readOnly) return isReadOnlyTool(tool);
  // 后台执行单元一律不直接获得破坏性工具，写操作最多走审批流程
  return tool.risk !== 'destructive';
}

export class ScopedToolProvider implements IToolProvider {
  public readonly providerName: string;

  constructor(private readonly options: ScopedToolProviderOptions) {
    this.providerName = options.providerName ?? 'worker-scoped';
  }

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const loaded = await Promise.all(
      this.options.providers().map((provider) => provider.getTools(ctx)),
    );
    const seen = new Set<string>();
    const tools: ToolDefinition[] = [];
    for (const tool of loaded.flat()) {
      if (seen.has(tool.name)) continue;
      if (!isToolAllowedForScope(tool, this.options.scope)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
    return tools;
  }
}
