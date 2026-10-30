import { describe, expect, it } from 'vitest';
import {
  classifyToolRisk,
  createToolApprovalGate,
  formatApprovalPrompt,
  PendingActionStore,
} from './ToolApprovalGate.js';

describe('classifyToolRisk', () => {
  it('优先使用工具声明的风险等级', () => {
    expect(classifyToolRisk({ name: 'search_logs', risk: 'write' })).toBe('write');
    expect(classifyToolRisk({ name: 'delete_user', risk: 'read' })).toBe('read');
  });

  it('按名称推断写操作与高危操作', () => {
    expect(classifyToolRisk({ name: 'mcp__crm__create_ticket' })).toBe('write');
    expect(classifyToolRisk({ name: 'update_config' })).toBe('write');
    expect(classifyToolRisk({ name: 'delete_user' })).toBe('destructive');
    expect(classifyToolRisk({ name: 'drop_table' })).toBe('destructive');
  });

  it('读操作与名称中的普通单词不误判', () => {
    expect(classifyToolRisk({ name: 'search_logs' })).toBe('read');
    expect(classifyToolRisk({ name: 'dataset_lookup' })).toBe('read');
    expect(classifyToolRisk({ name: 'current_time' })).toBe('read');
    expect(classifyToolRisk({ name: 'dws_doc_search_and_read' })).toBe('read');
  });
});

describe('PendingActionStore', () => {
  it('按会话保存、覆盖并取出待确认动作', () => {
    const store = new PendingActionStore({ ttlMs: 1_000, now: () => 100 });
    const first = store.put({
      conversationId: 'cid-1',
      toolName: 'create_ticket',
      args: { title: 'a' },
      risk: 'write',
      requestedBy: { staffId: 'staff-1' },
    });
    const second = store.put({
      conversationId: 'cid-1',
      toolName: 'create_ticket',
      args: { title: 'b' },
      risk: 'write',
      requestedBy: { staffId: 'staff-1' },
    });
    expect(first.id).not.toBe(second.id);
    expect(store.peek('cid-1')?.args).toEqual({ title: 'b' });
    expect(store.take('cid-1')?.id).toBe(second.id);
    expect(store.peek('cid-1')).toBeNull();
  });

  it('过期动作会被清理', () => {
    let now = 0;
    const store = new PendingActionStore({ ttlMs: 1_000, now: () => now });
    store.put({
      conversationId: 'cid-1',
      toolName: 'create_ticket',
      args: {},
      risk: 'write',
      requestedBy: { staffId: 's' },
    });
    now = 1_500;
    expect(store.peek('cid-1')).toBeNull();
    expect(store.cancel('cid-1')).toBe(false);
  });
});

describe('createToolApprovalGate', () => {
  function gate(options: { enabled?: boolean; ttlMs?: number } = {}) {
    const store = new PendingActionStore({ ttlMs: options.ttlMs ?? 60_000 });
    return {
      store,
      approve: createToolApprovalGate({
        store,
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      }),
    };
  }

  it('读操作直接放行', async () => {
    const { approve, store } = gate();
    await expect(
      approve({
        toolName: 'search_logs',
        args: {},
        conversationId: 'cid-1',
        senderStaffId: 'staff-1',
      }),
    ).resolves.toEqual({ approved: true });
    expect(store.size).toBe(0);
  });

  it('写操作登记待确认并给出确认提示', async () => {
    const { approve, store } = gate();
    const decision = await approve({
      toolName: 'mcp__crm__create_ticket',
      args: { title: '线上故障' },
      conversationId: 'cid-1',
      senderStaffId: 'staff-1',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('create_ticket');
    expect(decision.reason).toContain('/confirm');
    expect(decision.reason).toContain('60 秒内有效');
    expect(store.peek('cid-1')).toMatchObject({
      toolName: 'mcp__crm__create_ticket',
      args: { title: '线上故障' },
      risk: 'write',
      requestedBy: { staffId: 'staff-1' },
    });
  });

  it('关闭闸门后写操作直接放行', async () => {
    const { approve, store } = gate({ enabled: false });
    await expect(
      approve({
        toolName: 'delete_user',
        args: {},
        conversationId: 'cid-1',
        senderStaffId: 'staff-1',
      }),
    ).resolves.toEqual({ approved: true });
    expect(store.size).toBe(0);
  });
});

describe('formatApprovalPrompt', () => {
  it('截断过长参数并保留确认指引', () => {
    const prompt = formatApprovalPrompt(
      {
        id: 'a',
        conversationId: 'cid-1',
        toolName: 'update_config',
        args: { payload: 'x'.repeat(2_000) },
        risk: 'destructive',
        requestedBy: { staffId: 's' },
        createdAt: 0,
        expiresAt: 1,
      },
      300,
    );
    expect(prompt).toContain('高危写操作');
    expect(prompt).toContain('/cancel');
    expect(prompt.length).toBeLessThan(900);
  });
});
