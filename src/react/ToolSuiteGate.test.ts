import { describe, expect, it } from 'vitest';
import {
  BROWSER_AUTOMATION_SUITE,
  DEFAULT_TOOL_SUITES,
  DWS_OFFICE_WRITE_SUITE,
  FINANCE_MARKET_SUITE,
  LBS_AND_TRAVEL_SUITE,
  PROJECT_CODE_SUITE,
  buildActivateToolsTool,
  buildSuiteCatalog,
  injectSuiteCatalog,
  partitionSuites,
  resolveToolSuites,
} from './ToolSuiteGate.js';
import type { ToolDefinition } from '../types/core.js';

function tool(
  name: string,
  source: string,
  risk: 'read' | 'write' | 'destructive' = 'read',
): ToolDefinition {
  return {
    name,
    description: name,
    source,
    risk,
    parametersJsonSchema: { type: 'object', properties: {} },
    execute: async () => name,
  };
}

describe('partitionSuites', () => {
  it('按 source 把项目/代码工具收进套件，其余常驻', () => {
    const tools = [
      tool('current_time', 'builtin'),
      tool('project_search', 'projects'),
      tool('github_file', 'github'),
      tool('sandbox_analyze_and_aggregate', 'sandbox'),
      tool('dws_org_and_schedule', 'dws'),
    ];
    const { resident, gated } = partitionSuites(tools, [PROJECT_CODE_SUITE]);
    expect(resident.map((t) => t.name)).toEqual([
      'current_time',
      'sandbox_analyze_and_aggregate',
      'dws_org_and_schedule',
    ]);
    expect(gated.get('project_code')?.map((t) => t.name)).toEqual([
      'project_search',
      'github_file',
    ]);
  });

  it('无命中工具时套件为空数组', () => {
    const { resident, gated } = partitionSuites(
      [tool('current_time', 'builtin')],
      [PROJECT_CODE_SUITE],
    );
    expect(resident).toHaveLength(1);
    expect(gated.get('project_code')).toEqual([]);
  });
});

describe('buildSuiteCatalog', () => {
  it('目录含套件 ID、标签与激活指引', () => {
    const catalog = buildSuiteCatalog([PROJECT_CODE_SUITE]);
    expect(catalog).toContain('按需工具套件');
    expect(catalog).toContain('activate_tools');
    expect(catalog).toContain('project_code');
    expect(catalog).toContain('项目手册与代码仓库');
  });
});

describe('buildActivateToolsTool', () => {
  it('合法套件返回 activateTools，未知套件报错且不激活', async () => {
    const meta = buildActivateToolsTool([PROJECT_CODE_SUITE]);
    expect(meta.name).toBe('activate_tools');
    expect(meta.risk).toBe('read');

    const ok = await meta.executeStructured?.({ suite: 'project_code' }, {} as never);
    expect(ok?.activateTools).toEqual(['project_code']);
    expect(ok?.text).toContain('已激活');

    const bad = await meta.executeStructured?.({ suite: 'nope' }, {} as never);
    expect(bad?.activateTools).toBeUndefined();
    expect(bad?.text).toContain('未知套件');

    const plain = await meta.execute({ suite: 'project_code' }, {} as never);
    expect(plain).toContain('已激活');
  });

  it('参数 schema 用枚举限定可选套件', () => {
    const meta = buildActivateToolsTool([PROJECT_CODE_SUITE]);
    const props = meta.parametersJsonSchema.properties as Record<string, unknown>;
    expect((props.suite as { enum: string[] }).enum).toEqual(['project_code']);
    expect(meta.parametersJsonSchema.required).toEqual(['suite']);
  });
});

describe('injectSuiteCatalog', () => {
  it('追加到首个 system 消息，保持头部前缀', () => {
    const messages = [
      { role: 'system', content: '头部' },
      { role: 'user', content: '问题' },
    ];
    injectSuiteCatalog(messages, '目录');
    expect(messages[0].content).toBe('头部\n\n目录');
    expect(messages[1]).toEqual({ role: 'user', content: '问题' });
  });

  it('无 system 消息时前置一条', () => {
    const messages = [{ role: 'user', content: '问题' }];
    injectSuiteCatalog(messages, '目录');
    expect(messages[0]).toEqual({ role: 'system', content: '目录' });
    expect(messages[1]).toEqual({ role: 'user', content: '问题' });
  });
});

describe('多域工具套件与批量激活', () => {
  it('DEFAULT_TOOL_SUITES 按域切分工具，保持高频只读工具常驻', () => {
    const tools = [
      tool('current_time', 'builtin', 'read'),
      tool('dws_org_and_schedule', 'dws', 'read'),
      tool('dws_calendar_manage', 'dws', 'write'),
      tool('dws_calendar_cancel', 'dws', 'destructive'),
      tool('mcp__playwright__browser_click', 'mcp', 'write'),
      tool('mcp__amap__maps_geo', 'mcp', 'read'),
      tool('market_data_fetch', 'market', 'read'),
      tool('project_search', 'projects', 'read'),
    ];
    const { resident, gated } = partitionSuites(tools, [...DEFAULT_TOOL_SUITES]);
    expect(resident.map((t) => t.name)).toEqual([
      'current_time',
      'dws_org_and_schedule',
    ]);
    expect(gated.get(DWS_OFFICE_WRITE_SUITE.id)?.map((t) => t.name)).toEqual([
      'dws_calendar_manage',
      'dws_calendar_cancel',
    ]);
    expect(gated.get(BROWSER_AUTOMATION_SUITE.id)?.map((t) => t.name)).toEqual([
      'mcp__playwright__browser_click',
    ]);
    expect(gated.get(LBS_AND_TRAVEL_SUITE.id)?.map((t) => t.name)).toEqual([
      'mcp__amap__maps_geo',
    ]);
    expect(gated.get(FINANCE_MARKET_SUITE.id)?.map((t) => t.name)).toEqual([
      'market_data_fetch',
    ]);
  });

  it('activate_tools 支持 extraSuites 单轮激活多个套件且 resolveToolSuites 支持环境变量过滤', async () => {
    const selected = resolveToolSuites({
      TOOL_SUITES_LIST: 'project_code,lbs_and_travel',
    });
    expect(selected.map((s) => s.id)).toEqual(['project_code', 'lbs_and_travel']);

    const meta = buildActivateToolsTool(selected);
    const res = await meta.executeStructured?.(
      { suite: 'project_code', extraSuites: ['lbs_and_travel'] },
      {} as never,
    );
    expect(res?.activateTools).toEqual(['project_code', 'lbs_and_travel']);
  });
});