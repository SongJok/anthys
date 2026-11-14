import { describe, expect, it } from 'vitest';
import { isReadOnlyTool, isReadOnlyToolName } from './toolRisk.js';

describe('isReadOnlyToolName', () => {
  it('子代理委派与管理员工具一律不视为只读', () => {
    expect(isReadOnlyToolName('delegate_research')).toBe(false);
    expect(isReadOnlyToolName('dispatch_worker')).toBe(false);
    expect(isReadOnlyToolName('dispatch_worker', 'read')).toBe(false);
    expect(isReadOnlyToolName('admin_set_config')).toBe(false);
    expect(isReadOnlyToolName('admin_set_config', 'read')).toBe(false);
  });

  it('显式非 read 风险直接判为写操作', () => {
    expect(isReadOnlyToolName('search_logs', 'write')).toBe(false);
    expect(isReadOnlyToolName('whatever', 'destructive')).toBe(false);
  });

  it('纯检索工具按名称兜底判为只读', () => {
    expect(isReadOnlyToolName('search_logs')).toBe(true);
    expect(isReadOnlyToolName('dataset_lookup')).toBe(true);
    expect(isReadOnlyToolName('current_time')).toBe(true);
    expect(isReadOnlyToolName('dws_doc_search_and_read')).toBe(true);
  });

  it('名称含写操作语义时判为非只读', () => {
    expect(isReadOnlyToolName('mcp__crm__create_ticket')).toBe(false);
    expect(isReadOnlyToolName('update_config')).toBe(false);
    expect(isReadOnlyToolName('delete_user')).toBe(false);
    expect(isReadOnlyToolName('send_mail')).toBe(false);
  });

  it('isReadOnlyTool 透传 name 与 risk', () => {
    expect(isReadOnlyTool({ name: 'dispatch_worker', risk: 'read' } as never)).toBe(
      false,
    );
    expect(isReadOnlyTool({ name: 'search_logs' } as never)).toBe(true);
    expect(isReadOnlyTool({ name: 'search_logs', risk: 'write' } as never)).toBe(
      false,
    );
  });
});