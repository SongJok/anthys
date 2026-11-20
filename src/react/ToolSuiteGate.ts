import type { ToolDefinition } from '../types/core.js';

/** 一个可按需激活的工具套件：能力说明 + 触发词 + 成员判定 */
export interface ToolSuite {
  id: string;
  label: string;
  /** 给模型看的能力说明与触发词，进入稳定头部系统提示 */
  description: string;
  matches: (tool: ToolDefinition) => boolean;
}

/**
 * 低频的项目手册 / 代码仓库套件。DWS、沙盒数据分析等高频或通用能力保持常驻，
 * 只把明显属于「查项目代码 / 读 GitHub 仓库」的工具收纳进来，避免召回回归。
 */
export const PROJECT_CODE_SUITE: ToolSuite = {
  id: 'project_code',
  label: '项目手册与代码仓库',
  description:
    '项目手册、项目代号、代码/符号检索、项目历史、GitHub 仓库目录/文件/搜索/PR 读取。触发词：项目手册、项目代号、代码、源码、仓库、github、符号、commit、PR。',
  matches: (tool) => tool.source === 'projects' || tool.source === 'github',
};

export interface SuitePartition {
  resident: ToolDefinition[];
  /** suiteId -> 该套件实际加载到的工具（可能为空，表示当前上下文无此能力） */
  gated: Map<string, ToolDefinition[]>;
}

/** 把已加载工具按套件切分为常驻与门控两部分；未命中任何套件的工具一律常驻 */
export function partitionSuites(
  tools: ToolDefinition[],
  suites: ToolSuite[],
): SuitePartition {
  const gated = new Map<string, ToolDefinition[]>();
  for (const suite of suites) gated.set(suite.id, []);
  const resident: ToolDefinition[] = [];
  for (const tool of tools) {
    const suite = suites.find((candidate) => candidate.matches(tool));
    if (suite) gated.get(suite.id)?.push(tool);
    else resident.push(tool);
  }
  return { resident, gated };
}

/** 静态套件目录：注入头部系统提示，内容不随问题变化，保持缓存前缀稳定 */
export function buildSuiteCatalog(suites: ToolSuite[]): string {
  return [
    '## 按需工具套件',
    '以下能力默认未加载工具。当问题涉及对应场景时，先调用 activate_tools（参数 suite 填套件 ID）激活，激活后其工具会出现在可用工具列表中，再调用具体工具；无关问题无需激活。',
    ...suites.map((suite) => `- ${suite.id}（${suite.label}）：${suite.description}`),
  ].join('\n');
}

/** activate_tools 元工具：只读、无副作用，返回 activateTools 让 ReAct 核心追加套件 schema */
export function buildActivateToolsTool(suites: ToolSuite[]): ToolDefinition {
  const ids = suites.map((suite) => suite.id);
  const activate = async (
    args: Record<string, unknown>,
  ): Promise<{ text: string; suiteId?: string }> => {
    const suiteId = typeof args.suite === 'string' ? args.suite.trim() : '';
    const suite = suites.find((candidate) => candidate.id === suiteId);
    if (!suite) {
      return { text: `Error: 未知套件 "${suiteId}"，可选：${ids.join('、')}` };
    }
    return {
      text: `已激活套件「${suite.label}」，现在可以调用其工具。`,
      suiteId: suite.id,
    };
  };
  return {
    name: 'activate_tools',
    description:
      '按需激活默认未加载的工具套件。当问题涉及某套件能力（见系统提示「按需工具套件」）时，先调用本工具激活对应套件，再调用具体工具；无关问题不要激活。',
    risk: 'read',
    source: 'builtin',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        suite: {
          type: 'string',
          enum: ids,
          description: '要激活的套件 ID',
        },
      },
      required: ['suite'],
      additionalProperties: false,
    },
    execute: async (args) => (await activate(args)).text,
    executeStructured: async (args) => {
      const result = await activate(args);
      return {
        text: result.text,
        summary: result.suiteId ? `激活套件 ${result.suiteId}` : result.text,
        ...(result.suiteId ? { activateTools: [result.suiteId] } : {}),
      };
    },
  };
}

/** 把套件目录追加到头部系统提示，保持「头部 + 目录」稳定前缀 */
export function injectSuiteCatalog(
  messages: Array<{ role: string; content: string }>,
  catalog: string,
): void {
  const head = messages.find((message) => message.role === 'system');
  if (head) head.content = `${head.content}\n\n${catalog}`;
  else messages.unshift({ role: 'system', content: catalog });
}