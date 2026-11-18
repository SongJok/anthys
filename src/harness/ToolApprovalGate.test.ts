import { describe, expect, it } from 'vitest';
import {
  classifyToolRisk,
  createToolApprovalGate,
  formatApprovalPrompt,
  PendingActionStore,
  type PendingActionPersistence,
  type PendingToolAction,
} from './ToolApprovalGate.js';

describe('classifyToolRisk', () => {
  it('优先使用工具声明的风险等级', () => {
    expect(classifyToolRisk({ name: 'search_logs', risk: 'write' })).toBe('write');
    expect(classifyToolRisk({ name: 'delete_user', risk: 'read' })).toBe('read');
  });

  it('未声明风险一律按 write 进入审批（fail-closed）', () => {
    expect(classifyToolRisk({ name: 'mcp__crm__create_ticket' })).toBe('write');
    expect(classifyToolRisk({ name: 'update_config' })).toBe('write');
    expect(classifyToolRisk({ name: 'delete_user' })).toBe('write');
    expect(classifyToolRisk({ name: 'drop_table' })).toBe('write');
    expect(classifyToolRisk({ name: 'search_logs' })).toBe('write');
    expect(classifyToolRisk({ name: 'dataset_lookup' })).toBe('write');
    expect(classifyToolRisk({ name: 'current_time' })).toBe('write');
    expect(classifyToolRisk({ name: 'dws_doc_search_and_read' })).toBe('write');
  });

  it('显式声明 read 的检索工具直接放行', () => {
    expect(classifyToolRisk({ name: 'search_logs', risk: 'read' })).toBe('read');
    expect(classifyToolRisk({ name: 'dws_doc_search_and_read', risk: 'read' })).toBe('read');
  });
});

interface FakeRow extends PendingToolAction {
  status: string;
  detail?: string;
  settledAt?: number;
}

function memoryPersistence(): PendingActionPersistence & {
  rows: Map<string, FakeRow>;
} {
  const rows = new Map<string, FakeRow>();
  const strip = (row: FakeRow): PendingToolAction => ({
    id: row.id,
    conversationId: row.conversationId,
    toolName: row.toolName,
    args: row.args,
    risk: row.risk,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
  return {
    rows,
    async load(nowMs) {
      return [...rows.values()]
        .filter((row) => row.status === 'pending' && row.expiresAt > nowMs)
        .map(strip);
    },
    async save(action) {
      rows.set(action.id, { ...action, status: 'pending' });
    },
    async remove(conversationId, actionId) {
      for (const [id, row] of rows) {
        if (row.conversationId !== conversationId) continue;
        if (actionId && id !== actionId) continue;
        rows.delete(id);
      }
    },
    async claim(actionId, _owner, nowMs) {
      const row = rows.get(actionId);
      if (!row || row.status !== 'pending' || row.expiresAt <= nowMs) {
        return null;
      }
      row.status = 'executing';
      return strip(row);
    },
    async settle(actionId, status, detail, nowMs) {
      const row = rows.get(actionId);
      if (row && (row.status === 'executing' || row.status === 'pending')) {
        row.status = status;
        row.detail = detail;
        row.settledAt = nowMs;
      }
    },
    async cancelPending(conversationId, actionId, nowMs) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.conversationId !== conversationId) continue;
        if (actionId && row.id !== actionId) continue;
        if (row.status !== 'pending') continue;
        row.status = 'cancelled';
        row.settledAt = nowMs ?? Date.now();
        count += 1;
      }
      return count;
    },
    async recoverExecuting(nowMs) {
      const affected: PendingToolAction[] = [];
      for (const row of rows.values()) {
        if (row.status !== 'executing') continue;
        row.status = 'unknown';
        row.settledAt = nowMs;
        affected.push(strip(row));
      }
      return affected;
    },
    async markExpired(nowMs) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.status === 'pending' && row.expiresAt <= nowMs) {
          row.status = 'expired';
          row.settledAt = nowMs;
          count += 1;
        }
      }
      return count;
    },
    async purgeSettled(beforeMs) {
      let count = 0;
      for (const [id, row] of rows) {
        if (
          ['succeeded', 'failed', 'cancelled', 'expired', 'unknown'].includes(
            row.status,
          ) &&
          (row.settledAt ?? 0) < beforeMs
        ) {
          rows.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };
}

const putInput = {
  conversationId: 'cid-1',
  toolName: 'create_ticket',
  args: { title: 'a' },
  risk: 'write' as const,
  requestedBy: { staffId: 'staff-1' },
};

describe('PendingActionStore', () => {
  it('按会话保存、覆盖并 CAS 取出待确认动作', async () => {
    const store = new PendingActionStore({ ttlMs: 1_000, now: () => 100 });
    const first = await store.put(putInput);
    const second = await store.put({ ...putInput, args: { title: 'b' } });
    expect(first.id).not.toBe(second.id);
    expect(store.peek('cid-1')?.args).toEqual({ title: 'b' });
    const claimed = await store.claimForExecution('cid-1', undefined, 'p1');
    expect(claimed?.id).toBe(second.id);
    expect(store.peek('cid-1')).toBeNull();
    // 重复确认拿不到动作
    expect(await store.claimForExecution('cid-1', undefined, 'p1')).toBeNull();
  });

  it('持久化优先：落库成功后才进入内存队列', async () => {
    const persistence = memoryPersistence();
    const store = new PendingActionStore({ persistence, now: () => 100 });
    const action = await store.put(putInput);
    expect(persistence.rows.get(action.id)?.status).toBe('pending');
    expect(store.peek('cid-1')?.id).toBe(action.id);
  });

  it('落库失败时 put 抛错且不进入内存队列（fail-closed）', async () => {
    const persistence = memoryPersistence();
    persistence.save = async () => {
      throw new Error('db down');
    };
    const store = new PendingActionStore({ persistence });
    await expect(store.put(putInput)).rejects.toThrow('db down');
    expect(store.size).toBe(0);
  });

  it('通过持久层恢复未过期的待确认动作，claim 后落定状态', async () => {
    const persistence = memoryPersistence();
    const first = new PendingActionStore({
      ttlMs: 1_000,
      now: () => 100,
      persistence,
    });
    const action = await first.put(putInput);

    const restored = new PendingActionStore({
      ttlMs: 1_000,
      now: () => 200,
      persistence,
    });
    await restored.hydrate();
    expect(restored.peek('cid-1')?.id).toBe(action.id);

    const claimed = await restored.claimForExecution('cid-1', undefined, 'p2');
    expect(claimed?.id).toBe(action.id);
    expect(persistence.rows.get(action.id)?.status).toBe('executing');
    await restored.settle(action.id, 'succeeded', '完成');
    expect(persistence.rows.get(action.id)?.status).toBe('succeeded');
    expect(persistence.rows.get(action.id)?.detail).toBe('完成');
  });

  it('重启时 executing 动作标记 unknown 并返回，不重新入队', async () => {
    const persistence = memoryPersistence();
    const first = new PendingActionStore({
      ttlMs: 60_000,
      now: () => 100,
      persistence,
    });
    const action = await first.put(putInput);
    await first.claimForExecution('cid-1', undefined, 'old-process');
    expect(persistence.rows.get(action.id)?.status).toBe('executing');

    const restarted = new PendingActionStore({
      ttlMs: 60_000,
      now: () => 200,
      persistence,
    });
    const unknown = await restarted.hydrate();
    expect(unknown.map((item) => item.id)).toEqual([action.id]);
    expect(persistence.rows.get(action.id)?.status).toBe('unknown');
    expect(restarted.peek('cid-1')).toBeNull();
    expect(restarted.size).toBe(0);
  });

  it('过期动作会被清理并标记 expired', async () => {
    let now = 0;
    const persistence = memoryPersistence();
    const store = new PendingActionStore({
      ttlMs: 1_000,
      now: () => now,
      persistence,
    });
    const action = await store.put(putInput);
    now = 1_500;
    expect(store.peek('cid-1')).toBeNull();
    expect(await store.cancel('cid-1')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persistence.rows.get(action.id)?.status).toBe('expired');
  });

  it('用户取消保留审计记录（cancelled 而非删除）', async () => {
    const persistence = memoryPersistence();
    const store = new PendingActionStore({ persistence });
    const action = await store.put(putInput);
    expect(await store.cancel('cid-1')).toBe(true);
    expect(persistence.rows.get(action.id)?.status).toBe('cancelled');
  });

  it('指定 staffId 无匹配时不回退队尾，避免误取消他人操作', async () => {
    const store = new PendingActionStore({ multiPending: true, ttlMs: 60_000 });
    const mine = await store.put({
      ...putInput,
      conversationId: 'group-1',
      requestedBy: { staffId: 'staff-a' },
    });
    expect(store.peek('group-1', { staffId: 'staff-b' })).toBeNull();
    expect(
      await store.claimForExecution('group-1', { staffId: 'staff-b' }, 'p'),
    ).toBeNull();
    expect(await store.cancel('group-1', { staffId: 'staff-b' })).toBe(false);
    expect(store.peek('group-1', { staffId: 'staff-a' })?.id).toBe(mine.id);
    expect(await store.cancel('group-1', { staffId: 'staff-a' })).toBe(true);
    expect(store.size).toBe(0);
  });

  it('开启 multiPending 后同会话多用户互不覆盖并按 staffId / actionIdPrefix 精确抢占', async () => {
    const store = new PendingActionStore({ multiPending: true });
    const a1 = await store.put({
      ...putInput,
      conversationId: 'group-1',
      requestedBy: { staffId: 'staff-a' },
    });
    const a2 = await store.put({
      ...putInput,
      conversationId: 'group-1',
      toolName: 'send_mail',
      args: { to: 'b@example.com' },
      requestedBy: { staffId: 'staff-b' },
    });
    expect(store.peekAll('group-1')).toHaveLength(2);
    expect(
      (await store.claimForExecution('group-1', { staffId: 'staff-a' }, 'p'))?.id,
    ).toBe(a1.id);
    expect(store.peek('group-1', { actionIdPrefix: a2.id.slice(0, 6) })?.id).toBe(
      a2.id,
    );
    expect(
      (
        await store.claimForExecution(
          'group-1',
          { actionIdPrefix: a2.id.slice(0, 6) },
          'p',
        )
      )?.id,
    ).toBe(a2.id);
    expect(store.size).toBe(0);
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
        risk: 'read',
        conversationId: 'cid-1',
        senderStaffId: 'staff-1',
      }),
    ).resolves.toEqual({ approved: true });
    expect(store.size).toBe(0);
  });

  it('未声明风险的工具按写操作登记待确认（fail-closed）', async () => {
    const { approve, store } = gate();
    const decision = await approve({
      toolName: 'search_logs',
      args: {},
      conversationId: 'cid-1',
      senderStaffId: 'staff-1',
    });
    expect(decision.approved).toBe(false);
    expect(store.size).toBe(1);
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
    expect(decision.reason).toContain('「确认」');
    expect(decision.reason).toContain('60 秒内有效');
    expect(store.peek('cid-1')).toMatchObject({
      toolName: 'mcp__crm__create_ticket',
      args: { title: '线上故障' },
      risk: 'write',
      requestedBy: { staffId: 'staff-1' },
    });
  });

  it('持久化不可用时拒绝执行而不是放行', async () => {
    const persistence = memoryPersistence();
    persistence.save = async () => {
      throw new Error('db down');
    };
    const store = new PendingActionStore({ persistence });
    const approve = createToolApprovalGate({ store });
    const decision = await approve({
      toolName: 'mcp__crm__create_ticket',
      args: {},
      conversationId: 'cid-1',
      senderStaffId: 'staff-1',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('审批登记失败');
    expect(store.size).toBe(0);
  });

  it('写操作登记时保存发起人的完整上下文', async () => {
    const { approve, store } = gate();
    await approve(
      {
        toolName: 'mcp__crm__create_ticket',
        args: { title: '线上故障' },
        conversationId: 'cid-1',
        senderStaffId: 'staff-1',
      },
      {
        conversationId: 'cid-1',
        messageId: 'msg-9',
        senderStaffId: 'staff-1',
        senderNick: '张三',
        conversationType: '1',
        personKey: 'staff:staff-1',
        deadlineAt: Date.now() + 60_000,
        now: Date.now,
      },
    );
    expect(store.peek('cid-1')?.requestedBy).toEqual({
      staffId: 'staff-1',
      nick: '张三',
      messageId: 'msg-9',
      conversationType: '1',
      personKey: 'staff:staff-1',
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
  it('截断过长参数、说明影响并保留确认指引', () => {
    const prompt = formatApprovalPrompt(
      {
        id: 'a',
        conversationId: 'cid-1',
        toolName: 'update_config',
        args: { payload: 'x'.repeat(3_000) },
        risk: 'destructive',
        requestedBy: { staffId: 's' },
        createdAt: 0,
        expiresAt: 1,
      },
      300,
    );
    expect(prompt).toContain('高危写操作');
    expect(prompt).toContain('无法自动撤销');
    expect(prompt).toContain('「取消」');
    expect(prompt.length).toBeLessThan(1_600);
  });

  it('普通写操作也给出影响说明', () => {
    const prompt = formatApprovalPrompt(
      {
        id: 'b',
        conversationId: 'cid-1',
        toolName: 'group_schedule_manage',
        args: { action: 'create' },
        risk: 'write',
        requestedBy: { staffId: 's' },
        createdAt: 0,
        expiresAt: 1,
      },
      300,
    );
    expect(prompt).toContain('影响');
    expect(prompt).toContain('写操作');
  });
});