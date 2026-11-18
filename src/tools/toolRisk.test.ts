import { describe, expect, it } from 'vitest';
import {
  inferRiskFromName,
  isReadOnlyTool,
  isReadOnlyToolName,
  resolveToolRisk,
} from './toolRisk.js';

describe('resolveToolRisk（fail-closed）', () => {
  it('显式声明优先', () => {
    expect(resolveToolRisk({ name: 'whatever', risk: 'read' })).toBe('read');
    expect(resolveToolRisk({ name: 'search_logs', risk: 'write' })).toBe('write');
    expect(resolveToolRisk({ name: 'x', risk: 'destructive' })).toBe(
      'destructive',
    );
  });

  it('未声明一律按 write，不再按名称放行', () => {
    expect(resolveToolRisk({ name: 'search_logs' })).toBe('write');
    expect(resolveToolRisk({ name: 'current_time' })).toBe('write');
    expect(resolveToolRisk({ name: 'delete_user' })).toBe('write');
    expect(resolveToolRisk({ name: 'mcp__crm__create_ticket' })).toBe('write');
  });
});

describe('inferRiskFromName（仅审计）', () => {
  it('统一词表区分读 / 写 / 高危', () => {
    expect(inferRiskFromName('search_logs')).toBe('read');
    expect(inferRiskFromName('dataset_lookup')).toBe('read');
    expect(inferRiskFromName('mcp__crm__create_ticket')).toBe('write');
    expect(inferRiskFromName('sync_records')).toBe('write');
    expect(inferRiskFromName('submit_report')).toBe('write');
    expect(inferRiskFromName('delete_user')).toBe('destructive');
    expect(inferRiskFromName('drop_table')).toBe('destructive');
  });
});

describe('isReadOnlyToolName', () => {
  it('子代理委派与管理员工具一律不视为只读', () => {
    expect(isReadOnlyToolName('delegate_research')).toBe(false);
    expect(isReadOnlyToolName('dispatch_worker')).toBe(false);
    expect(isReadOnlyToolName('dispatch_worker', 'read')).toBe(false);
    expect(isReadOnlyToolName('admin_set_config')).toBe(false);
    expect(isReadOnlyToolName('admin_set_config', 'read')).toBe(false);
    expect(isReadOnlyToolName('admin_inspect_system_status', 'read')).toBe(
      false,
    );
  });

  it('显式非 read 风险直接判为写操作', () => {
    expect(isReadOnlyToolName('search_logs', 'write')).toBe(false);
    expect(isReadOnlyToolName('whatever', 'destructive')).toBe(false);
  });

  it('只有显式声明 read 才算只读', () => {
    expect(isReadOnlyToolName('search_logs', 'read')).toBe(true);
    expect(isReadOnlyToolName('dws_doc_search_and_read', 'read')).toBe(true);
    expect(isReadOnlyToolName('mcp__enterprise__chat', 'read')).toBe(true);
  });

  it('未声明风险按写处理（fail-closed）', () => {
    expect(isReadOnlyToolName('search_logs')).toBe(false);
    expect(isReadOnlyToolName('dataset_lookup')).toBe(false);
    expect(isReadOnlyToolName('current_time')).toBe(false);
    expect(isReadOnlyToolName('dws_doc_search_and_read')).toBe(false);
    expect(isReadOnlyToolName('mcp__crm__create_ticket')).toBe(false);
    expect(isReadOnlyToolName('update_config')).toBe(false);
    expect(isReadOnlyToolName('delete_user')).toBe(false);
    expect(isReadOnlyToolName('send_mail')).toBe(false);
  });

  it('isReadOnlyTool 透传 name 与 risk', () => {
    expect(isReadOnlyTool({ name: 'dispatch_worker', risk: 'read' } as never)).toBe(
      false,
    );
    expect(isReadOnlyTool({ name: 'search_logs' } as never)).toBe(false);
    expect(isReadOnlyTool({ name: 'search_logs', risk: 'read' } as never)).toBe(
      true,
    );
    expect(isReadOnlyTool({ name: 'search_logs', risk: 'write' } as never)).toBe(
      false,
    );
  });
});