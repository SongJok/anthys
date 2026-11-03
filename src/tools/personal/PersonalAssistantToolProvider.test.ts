import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type {
  PersonalAssistantService,
  ReportSpec,
} from '../../personal/PersonalAssistantService.js';
import { PersonalAssistantToolProvider } from './PersonalAssistantToolProvider.js';

const NOW = Date.parse('2026-10-31T10:00:00+08:00');

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-dm',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: NOW + 60_000,
    now: () => NOW,
    ...overrides,
  };
}

interface TestCalls {
  reminders: Array<{ staffId: string; conversationId: string; raw: string }>;
  reports: Array<{ staffId: string; conversationId: string; spec: ReportSpec }>;
}

function newCalls(): TestCalls {
  return { reminders: [], reports: [] };
}

function fakeService(calls: TestCalls): PersonalAssistantService {
  return {
    createReminderFromText: async (input: {
      staffId: string;
      conversationId: string;
      raw: string;
    }) => {
      calls.reminders.push(input);
      return {
        id: 'reminder-1',
        title: '提醒：开会',
        nextRunAt: '2026-10-31T02:25:00.000Z',
      };
    },
    createReport: async (input: {
      staffId: string;
      conversationId: string;
      spec: ReportSpec;
    }) => {
      calls.reports.push(input);
      return {
        id: 'report-1',
        title: '每周工作周报 09:00',
        cron: '0 9 * * 1',
        nextRunAt: '2026-11-02T01:00:00.000Z',
      };
    },
    listOwn: async () => [
      {
        id: 'reminder-1',
        kind: 'reminder',
        title: '提醒：开会',
        nextRunAt: '2026-10-31T02:25:00.000Z',
      },
      {
        id: 'report-1',
        kind: 'daily_report',
        title: '每日工作简报 09:00',
        cron: '0 9 * * *',
        nextRunAt: '2026-11-01T01:00:00.000Z',
      },
    ],
    cancelOwn: async (_staffId: string, id: string) =>
      id === 'reminder-1' ? { id, title: '提醒：开会', kind: 'reminder' } : null,
    previewReport: async (_staffId: string, kind: string) => `PREVIEW ${kind}`,
  } as unknown as PersonalAssistantService;
}

async function findTool(
  provider: PersonalAssistantToolProvider,
  name: string,
  context: ExecutionContext,
): Promise<ToolDefinition> {
  const tools = await provider.getTools(context);
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('PersonalAssistantToolProvider', () => {
  it('群聊不挂载，单聊按读写拆分挂载四个工具', async () => {
    const calls = newCalls();
    const provider = new PersonalAssistantToolProvider({
      service: fakeService(calls),
    });
    expect(await provider.getTools(ctx({ conversationType: '2' }))).toEqual([]);
    const tools = await provider.getTools(ctx());
    expect(tools.map((tool) => tool.name)).toEqual([
      'personal_reminder',
      'personal_reminder_manage',
      'personal_report',
      'personal_report_manage',
    ]);
    expect(
      tools.map((tool) => [tool.name, tool.risk]),
    ).toEqual([
      ['personal_reminder', 'read'],
      ['personal_reminder_manage', 'write'],
      ['personal_report', 'read'],
      ['personal_report_manage', 'write'],
    ]);
  });

  it('通过独立写工具创建和取消，读工具只能查询', async () => {
    const calls = newCalls();
    const provider = new PersonalAssistantToolProvider({
      service: fakeService(calls),
    });
    const readTool = await findTool(provider, 'personal_reminder', ctx());
    const writeTool = await findTool(
      provider,
      'personal_reminder_manage',
      ctx(),
    );

    await expect(
      readTool.execute(
        { action: 'create', when: '25分钟后', text: '开会' },
        ctx(),
      ),
    ).rejects.toThrow('不支持的 action');

    const created = JSON.parse(
      await writeTool.execute(
        { action: 'create', when: '25分钟后', text: '开会' },
        ctx(),
      ),
    ) as { ok: boolean; taskId: string };
    expect(created).toMatchObject({ ok: true, taskId: 'reminder-1' });
    expect(calls.reminders[0]).toMatchObject({
      staffId: 'staff-1',
      conversationId: 'cid-dm',
      raw: '25分钟后 开会',
    });

    const list = JSON.parse(
      await readTool.execute({ action: 'list' }, ctx()),
    ) as { reminders: Array<{ id: string }> };
    expect(list.reminders.map((item) => item.id)).toEqual(['reminder-1']);

    const missing = JSON.parse(
      await writeTool.execute({ action: 'cancel', id: 'nope' }, ctx()),
    ) as { ok: boolean };
    expect(missing.ok).toBe(false);
  });

  it('通过独立写工具创建周期报告，读工具提供预览', async () => {
    const calls = newCalls();
    const provider = new PersonalAssistantToolProvider({
      service: fakeService(calls),
    });
    const readTool = await findTool(provider, 'personal_report', ctx());
    const writeTool = await findTool(provider, 'personal_report_manage', ctx());

    const created = JSON.parse(
      await writeTool.execute(
        { action: 'create', frequency: 'weekly', time: '09:00', weekday: 1 },
        ctx(),
      ),
    ) as { ok: boolean; cron: string };
    expect(created).toMatchObject({ ok: true, cron: '0 9 * * 1' });
    expect(calls.reports[0]?.spec).toMatchObject({
      frequency: 'weekly',
      weekday: 1,
      hour: 9,
      minute: 0,
    });

    const preview = await readTool.execute(
      { action: 'preview', period: 'weekly' },
      ctx(),
    );
    expect(preview).toBe('PREVIEW weekly_report');
  });
});
