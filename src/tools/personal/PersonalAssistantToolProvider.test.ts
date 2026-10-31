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
  it('群聊不挂载，单聊挂载两个工具', async () => {
    const calls = newCalls();
    const provider = new PersonalAssistantToolProvider({
      service: fakeService(calls),
    });
    expect(await provider.getTools(ctx({ conversationType: '2' }))).toEqual([]);
    expect(
      (await provider.getTools(ctx())).map((tool) => tool.name),
    ).toEqual(['personal_reminder', 'personal_report']);
  });

  it('创建/查看/取消提醒', async () => {
    const calls = newCalls();
    const provider = new PersonalAssistantToolProvider({
      service: fakeService(calls),
    });
    const tool = await findTool(provider, 'personal_reminder', ctx());

    const created = JSON.parse(
      await tool.execute(
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
      await tool.execute({ action: 'list' }, ctx()),
    ) as { reminders: Array<{ id: string }> };
    expect(list.reminders.map((item) => item.id)).toEqual(['reminder-1']);

    const missing = JSON.parse(
      await tool.execute({ action: 'cancel', id: 'nope' }, ctx()),
    ) as { ok: boolean };
    expect(missing.ok).toBe(false);
  });

  it('创建周报并预览', async () => {
    const calls = newCalls();
    const provider = new PersonalAssistantToolProvider({
      service: fakeService(calls),
    });
    const tool = await findTool(provider, 'personal_report', ctx());

    const created = JSON.parse(
      await tool.execute(
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

    const preview = await tool.execute({ action: 'preview', period: 'weekly' }, ctx());
    expect(preview).toBe('PREVIEW weekly_report');
  });
});
