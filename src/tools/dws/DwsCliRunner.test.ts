import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../types/core.js';
import { DwsCliToolProvider } from './DwsCliToolProvider.js';
import {
  DWS_SUBCOMMAND_WHITELIST,
  DwsCliRunner,
  buildDwsArgs,
} from './DwsCliRunner.js';
import type { DwsPermissionNotice } from './DwsPermissionNotice.js';

const FAKE_DWS_SOURCE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FAKE_DWS_SLEEP === '1') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
if (process.env.FAKE_DWS_FAIL === '1') {
  process.stderr.write('permission denied');
  process.exit(3);
}
if (args[1] === 'read') {
  process.stdout.write(JSON.stringify({ doc: 'X'.repeat(2400) }));
} else {
  process.stdout.write(JSON.stringify({
    argv: args,
    staffId: process.env.DWS_OPERATOR_STAFF_ID ?? null,
    operatorId: process.env.DWS_OPERATOR_ID ?? null,
  }));
}
`;

const ctx: ExecutionContext = {
  conversationId: 'conv',
  messageId: 'msg',
  senderStaffId: 'staff-001',
  senderNick: '测试员工',
  conversationType: '1',
  deadlineAt: Date.now() + 30_000,
  now: () => Date.now(),
};

let workDir: string;
let fakeDws: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dws-runner-'));
  fakeDws = join(workDir, 'dws');
  await writeFile(fakeDws, FAKE_DWS_SOURCE, 'utf8');
  await chmod(fakeDws, 0o755);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeRunner(options: Partial<ConstructorParameters<typeof DwsCliRunner>[0]> = {}) {
  return new DwsCliRunner({
    binary: fakeDws,
    env: { ...process.env, PATH: `${workDir}:${process.env.PATH ?? ''}` },
    ...options,
  });
}

async function findTool(name: string, provider: DwsCliToolProvider) {
  const tool = (await provider.getTools(ctx)).find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('buildDwsArgs 白名单与参数校验', () => {
  it('构造只读子命令的 argv', () => {
    expect(
      buildDwsArgs({
        domain: 'doc',
        subcommand: 'search',
        flags: { query: '订单 故障', top: 5, verbose: true, dryRun: false },
        operatorStaffId: 'staff-001',
      }),
    ).toEqual([
      'doc',
      'search',
      '--query',
      '订单 故障',
      '--top',
      '5',
      '--verbose',
    ]);
  });

  it('拒绝白名单外的子命令与域', () => {
    expect(() =>
      buildDwsArgs({
        domain: 'doc',
        subcommand: 'delete',
        flags: {},
        operatorStaffId: 'staff-001',
      }),
    ).toThrow('不在白名单内');
    expect(() =>
      buildDwsArgs({
        domain: 'database' as never,
        subcommand: 'search',
        flags: {},
        operatorStaffId: 'staff-001',
      }),
    ).toThrow('不支持的 DWS 域');
  });

  it('拒绝非法参数名、空字符与缺失身份', () => {
    expect(() =>
      buildDwsArgs({
        domain: 'doc',
        subcommand: 'search',
        flags: { 'query; rm -rf /': 'x' },
        operatorStaffId: 'staff-001',
      }),
    ).toThrow('非法的 DWS 参数名');
    expect(() =>
      buildDwsArgs({
        domain: 'doc',
        subcommand: 'search',
        flags: { query: 'a\0b' },
        operatorStaffId: 'staff-001',
      }),
    ).toThrow('非法空字符');
    expect(() =>
      buildDwsArgs({
        domain: 'doc',
        subcommand: 'search',
        flags: {},
        operatorStaffId: '  ',
      }),
    ).toThrow('缺少 operatorStaffId');
  });

  it('写命令只出现在显式白名单中', () => {
    expect(DWS_SUBCOMMAND_WHITELIST.calendar).toContain('event create');
    expect(DWS_SUBCOMMAND_WHITELIST.calendar).toContain('event delete');
    expect(DWS_SUBCOMMAND_WHITELIST.todo).toContain('task create');
    expect(DWS_SUBCOMMAND_WHITELIST.contact).toContain('user invite');
    expect(DWS_SUBCOMMAND_WHITELIST.approval).toContain('create-instance');
    for (const subcommands of Object.values(DWS_SUBCOMMAND_WHITELIST)) {
      expect(subcommands).not.toContain('delete');
      expect(subcommands).not.toContain('exec');
    }
  });

  it('审批域映射到 oa approval 多段命令', () => {
    expect(
      buildDwsArgs({
        domain: 'approval',
        subcommand: 'list-pending',
        flags: { start: '2026-10-01T00:00:00+08:00', end: '2026-10-31T23:59:59+08:00' },
        operatorStaffId: 'staff-001',
      }),
    ).toEqual([
      'oa',
      'approval',
      'list-pending',
      '--start',
      '2026-10-01T00:00:00+08:00',
      '--end',
      '2026-10-31T23:59:59+08:00',
    ]);
  });

  it('支持多段子命令并拒绝非法字符', () => {
    expect(
      buildDwsArgs({
        domain: 'calendar',
        subcommand: 'event create',
        flags: { title: '周会', yes: true },
        operatorStaffId: 'staff-001',
      }),
    ).toEqual(['calendar', 'event', 'create', '--title', '周会', '--yes']);
    expect(() =>
      buildDwsArgs({
        domain: 'calendar',
        subcommand: 'event create; rm -rf /',
        flags: {},
        operatorStaffId: 'staff-001',
      }),
    ).toThrow('非法的 DWS 子命令');
  });
});

describe('DwsCliRunner', () => {
  it('通过 execFile 传递参数，注入当前员工身份', async () => {
    const runner = makeRunner();
    const result = await runner.run({
      domain: 'contact',
      subcommand: 'search',
      flags: { query: '张三; rm -rf / && $(whoami)' },
      operatorStaffId: 'staff-001',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      argv: string[];
      staffId: string;
      operatorId: string;
    };
    expect(parsed.argv).toEqual([
      'contact',
      'search',
      '--query',
      '张三; rm -rf / && $(whoami)',
    ]);
    expect(parsed.staffId).toBe('staff-001');
    expect(parsed.operatorId).toBe('staff-001');
  });

  it('对超大输出分页', async () => {
    const runner = makeRunner({ maxOutputChars: 800 });
    const request = {
      domain: 'doc' as const,
      subcommand: 'read',
      flags: { id: 'doc-1' },
      operatorStaffId: 'staff-001',
    };
    const first = await runner.run(request);
    expect(first.truncated).toBe(true);
    expect(first.page).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.stdout.length).toBe(800);

    const last = await runner.run(request, { page: first.totalPages });
    expect(last.page).toBe(first.totalPages);
    expect(last.hasMore).toBe(false);
    expect(last.stdout.length).toBeLessThanOrEqual(800);
    const totalLength = JSON.stringify({ doc: 'X'.repeat(2400) }).length;
    expect(first.stdout.length + last.stdout.length).toBe(
      totalLength % 800 === 0 ? 1600 : 800 + (totalLength % 800),
    );
  });

  it('透传非零退出码', async () => {
    const runner = makeRunner({
      env: { ...process.env, FAKE_DWS_FAIL: '1' },
    });
    const result = await runner.run({
      domain: 'todo',
      subcommand: 'task list',
      flags: {},
      operatorStaffId: 'staff-001',
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('permission denied');
  });

  it('超时后熔断并标记 timedOut', async () => {
    const runner = makeRunner({
      env: { ...process.env, FAKE_DWS_SLEEP: '1' },
      timeoutMs: 300,
    });
    const result = await runner.run({
      domain: 'calendar',
      subcommand: 'event list',
      flags: {},
      operatorStaffId: 'staff-001',
    });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
  });

  it('二进制缺失时返回 127', async () => {
    const runner = new DwsCliRunner({ binary: join(workDir, 'missing-dws') });
    const result = await runner.run({
      domain: 'doc',
      subcommand: 'list',
      flags: {},
      operatorStaffId: 'staff-001',
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('不可用');
  });
});

describe('DwsCliToolProvider', () => {
  it('暴露只读与写操作 DWS 工具', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    expect(provider.providerName).toBe('dws');
    const tools = await provider.getTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual([
      'dws_doc_search_and_read',
      'dws_org_and_schedule',
      'dws_calendar_manage',
      'dws_calendar_cancel',
      'dws_todo_manage',
      'dws_contact_manage',
      'dws_approval_manage',
    ]);
    const risks = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.risk]),
    );
    expect(risks.dws_calendar_manage).toBe('write');
    expect(risks.dws_calendar_cancel).toBe('destructive');
    expect(risks.dws_todo_manage).toBe('write');
    expect(risks.dws_contact_manage).toBe('write');
    expect(risks.dws_approval_manage).toBe('write');
  });

  it('检索文档并透传员工身份', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    const tool = await findTool('dws_doc_search_and_read', provider);
    const output = JSON.parse(
      await tool.execute(
        { target: 'wiki', action: 'search', query: '线上故障复盘' },
        ctx,
      ),
    ) as {
      ok: boolean;
      domain: string;
      subcommand: string;
      stdout: string;
    };
    expect(output.ok).toBe(true);
    expect(output.domain).toBe('wiki');
    expect(output.subcommand).toBe('search');
    const inner = JSON.parse(output.stdout) as {
      argv: string[];
      staffId: string;
    };
    expect(inner.argv).toEqual(['wiki', 'search', '--query', '线上故障复盘']);
    expect(inner.staffId).toBe('staff-001');
  });

  it('读取文档时要求 documentId 并分页', async () => {
    const provider = new DwsCliToolProvider({
      runner: makeRunner({ maxOutputChars: 600 }),
    });
    const tool = await findTool('dws_doc_search_and_read', provider);
    await expect(
      tool.execute({ target: 'doc', action: 'read' }, ctx),
    ).rejects.toThrow('必须提供 documentId');

    const first = JSON.parse(
      await tool.execute(
        { target: 'doc', action: 'read', documentId: 'doc-1' },
        ctx,
      ),
    ) as { page: number; totalPages: number; hasMore: boolean; hint?: string };
    expect(first.page).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.hint).toContain('page=2');

    const next = JSON.parse(
      await tool.execute(
        { target: 'doc', action: 'read', documentId: 'doc-1', page: 2 },
        ctx,
      ),
    ) as { page: number };
    expect(next.page).toBe(2);
  });

  it('组织与日程工具按资源校验白名单操作', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    const tool = await findTool('dws_org_and_schedule', provider);

    await expect(
      tool.execute({ resource: 'calendar', action: 'self' }, ctx),
    ).rejects.toThrow('不支持只读操作 self');
    await expect(
      tool.execute({ resource: 'calendar', action: 'event create' }, ctx),
    ).rejects.toThrow('不支持只读操作 event create');

    const output = JSON.parse(
      await tool.execute(
        {
          resource: 'calendar',
          action: 'today',
          userId: 'user-9',
          date: '2026-10-30',
        },
        ctx,
      ),
    ) as { ok: boolean; stdout: string };
    const inner = JSON.parse(output.stdout) as { argv: string[] };
    expect(inner.argv).toEqual(['calendar', '+today']);
  });

  it('校验参数类型与页码', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    const docTool = await findTool('dws_doc_search_and_read', provider);
    await expect(
      docTool.execute({ target: 'doc', action: 'search' }, ctx),
    ).rejects.toThrow('必须提供 query');
    await expect(
      docTool.execute(
        { target: 'doc', action: 'list', page: 0 },
        ctx,
      ),
    ).rejects.toThrow('page 必须是大于等于 1 的整数');
    await expect(
      docTool.execute({ target: 'drive', action: 'list' }, ctx),
    ).rejects.toThrow('不支持的文档类型');

    const orgTool = await findTool('dws_org_and_schedule', provider);
    await expect(
      orgTool.execute({ resource: 'drive', action: 'list' }, ctx),
    ).rejects.toThrow('不支持的资源类型');
  });

  it('日历写工具组装创建与取消命令', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    const create = await findTool('dws_calendar_manage', provider);
    const created = JSON.parse(
      await create.execute(
        {
          action: 'create',
          title: '周会',
          start: '2026-11-02T14:00:00+08:00',
          end: '2026-11-02T15:00:00+08:00',
          attendees: ['user-1', 'user-2'],
        },
        ctx,
      ),
    ) as { ok: boolean; stdout: string };
    expect(created.ok).toBe(true);
    expect(
      (JSON.parse(created.stdout) as { argv: string[] }).argv,
    ).toEqual([
      'calendar',
      'event',
      'create',
      '--yes',
      '--title',
      '周会',
      '--start',
      '2026-11-02T14:00:00+08:00',
      '--end',
      '2026-11-02T15:00:00+08:00',
      '--attendees',
      'user-1,user-2',
    ]);

    const cancel = await findTool('dws_calendar_cancel', provider);
    const cancelled = JSON.parse(
      await cancel.execute({ eventId: 'event-1' }, ctx),
    ) as { ok: boolean; stdout: string };
    expect((JSON.parse(cancelled.stdout) as { argv: string[] }).argv).toEqual([
      'calendar',
      'event',
      'delete',
      '--id',
      'event-1',
      '--yes',
    ]);
  });

  it('待办创建默认指派给当前提问人', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    const tool = await findTool('dws_todo_manage', provider);
    const output = JSON.parse(
      await tool.execute({ action: 'create', title: '提交周报' }, ctx),
    ) as { ok: boolean; stdout: string };
    expect((JSON.parse(output.stdout) as { argv: string[] }).argv).toEqual([
      'todo',
      'task',
      'create',
      '--title',
      '提交周报',
      '--executors',
      'staff-001',
      '--yes',
    ]);
  });

  it('审批写工具映射到 oa approval 并携带 --yes', async () => {
    const provider = new DwsCliToolProvider({ runner: makeRunner() });
    const tool = await findTool('dws_approval_manage', provider);
    const output = JSON.parse(
      await tool.execute(
        {
          action: 'create',
          processCode: 'PROC-1',
          formValues: { 事由: '测试' },
        },
        ctx,
      ),
    ) as { ok: boolean; stdout: string };
    expect((JSON.parse(output.stdout) as { argv: string[] }).argv).toEqual([
      'oa',
      'approval',
      'create-instance',
      '--process-code',
      'PROC-1',
      '--form-values',
      '{"事由":"测试"}',
      '--originator-user-id',
      'staff-001',
      '--yes',
    ]);

    const approved = JSON.parse(
      await tool.execute(
        { action: 'approve', instanceId: 'inst-1', taskId: '12345' },
        ctx,
      ),
    ) as { ok: boolean; stdout: string };
    expect(
      (JSON.parse(approved.stdout) as { argv: string[] }).argv,
    ).toEqual([
      'oa',
      'approval',
      'approve',
      '--instance-id',
      'inst-1',
      '--task-id',
      '12345',
      '--yes',
    ]);
    await expect(
      tool.execute(
        { action: 'approve', instanceId: 'inst-1', taskId: 'task-not-numeric' },
        ctx,
      ),
    ).rejects.toThrow('必须是正整数 ID');
  });

  it('权限缺失时通知管理员并对同一会话限频', async () => {
    const notices: DwsPermissionNotice[] = [];
    const provider = new DwsCliToolProvider({
      runner: makeRunner({
        env: { ...process.env, FAKE_DWS_FAIL: '1' },
      }),
      permissionNotifier: (notice) => {
        notices.push(notice);
        return true;
      },
    });
    const tool = await findTool('dws_calendar_manage', provider);
    const args = {
      action: 'create',
      title: '周会',
      start: '2026-11-02T14:00:00+08:00',
      end: '2026-11-02T15:00:00+08:00',
    };

    const first = JSON.parse(await tool.execute(args, ctx)) as {
      permissionDenied: boolean;
      adminNotified: boolean;
      instruction: string;
    };
    expect(first.permissionDenied).toBe(true);
    expect(first.adminNotified).toBe(true);
    expect(first.instruction).toContain('Calendar.Event.Write');
    expect(notices).toHaveLength(1);
    expect(notices[0].domain).toBe('calendar');

    const second = JSON.parse(await tool.execute(args, ctx)) as {
      adminNotified: boolean;
    };
    expect(second.adminNotified).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('文档资源级拒绝不通知管理员', async () => {
    const notices: DwsPermissionNotice[] = [];
    const provider = new DwsCliToolProvider({
      runner: makeRunner({
        env: { ...process.env, FAKE_DWS_FAIL: '1' },
      }),
      permissionNotifier: (notice) => {
        notices.push(notice);
        return true;
      },
    });
    const tool = await findTool('dws_doc_search_and_read', provider);
    const output = JSON.parse(
      await tool.execute({ target: 'doc', action: 'list' }, ctx),
    ) as { permissionDenied?: boolean };
    expect(output.permissionDenied).toBeUndefined();
    expect(notices).toHaveLength(0);
  });
});
