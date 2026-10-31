import { describe, expect, it } from 'vitest';
import type { DwsCommandRequest } from '../types/mcp-and-sandbox.js';
import type { DwsCliRunner, DwsRunResult } from '../tools/dws/DwsCliRunner.js';
import { PersonalReportBuilder } from './PersonalReportBuilder.js';

const NOW = Date.parse('2026-10-31T10:00:00+08:00');

function result(stdout: string, overrides: Partial<DwsRunResult> = {}): DwsRunResult {
  return {
    command: ['dws'],
    exitCode: 0,
    stdout,
    stderr: '',
    truncated: false,
    page: 1,
    totalPages: 1,
    hasMore: false,
    timedOut: false,
    ...overrides,
  };
}

const EVENTS = {
  result: {
    events: [
      {
        summary: '晨会',
        start: { dateTime: '2026-10-31T09:00:00+08:00' },
        end: { dateTime: '2026-10-31T09:30:00+08:00' },
        attendees: [{ displayName: '张三' }, { displayName: '李四' }],
      },
      {
        summary: '方案评审',
        start: { dateTime: '2026-10-31T14:00:00+08:00' },
        end: { dateTime: '2026-10-31T15:30:00+08:00' },
        attendees: [{ displayName: '张三' }],
      },
    ],
  },
  success: true,
};

const TODOS = {
  result: {
    todoCards: [
      {
        subject: '提交周报',
        dueTime: NOW - 24 * 3_600_000,
        priority: 20,
      },
      {
        subject: '修复登录缺陷',
        dueTime: NOW + 2 * 3_600_000,
        priority: 30,
      },
    ],
  },
  success: true,
};

const APPROVALS = {
  result: {
    processInstanceList: [
      { title: '差旅申请', originatorName: '王五' },
    ],
  },
  success: true,
};

class FakeRunner {
  public calls: DwsCommandRequest[] = [];
  constructor(
    private readonly respond?: (
      request: DwsCommandRequest,
    ) => DwsRunResult | undefined,
  ) {}

  async run(request: DwsCommandRequest): Promise<DwsRunResult> {
    this.calls.push(request);
    const custom = this.respond?.(request);
    if (custom) return custom;
    if (request.subcommand === 'event list') {
      return result(JSON.stringify(EVENTS));
    }
    if (request.subcommand === 'task list') {
      return result(JSON.stringify(TODOS));
    }
    if (request.subcommand === 'list-pending') {
      return result(JSON.stringify(APPROVALS));
    }
    return result(JSON.stringify({ result: [], success: true }));
  }
}

function builder(runner: FakeRunner): PersonalReportBuilder {
  return new PersonalReportBuilder({
    runner: runner as unknown as DwsCliRunner,
  });
}

describe('PersonalReportBuilder', () => {
  it('生成日报并包含日程、待办与审批', async () => {
    const runner = new FakeRunner();
    const report = await builder(runner).build({
      kind: 'daily_report',
      operatorStaffId: 'staff-1',
      now: NOW,
    });

    expect(report.ok).toBe(true);
    expect(report.text).toContain('今日工作简报 · 2026年10月31日（周六）');
    expect(report.text).toContain('【今日日程】2 场');
    expect(report.text).toContain('09:00 晨会（30 分钟，2 人）');
    expect(report.text).toContain('14:00 方案评审（90 分钟）');
    expect(report.text).toContain('【明日日程】2 场');
    expect(report.text).toContain('【待办】未完成 2 项，逾期 1 项');
    expect(report.text).toContain('[逾期] 提交周报');
    expect(report.text).toContain('修复登录缺陷');
    expect(report.text).toContain('【待我审批】1 项');
    expect(report.text).toContain('差旅申请（发起人：王五）');
    expect(report.text).toContain('数据来源：钉钉日程 / 待办 / 审批');

    const calendarCall = runner.calls.find(
      (call) => call.domain === 'calendar',
    );
    expect(calendarCall?.flags.start).toBe('2026-10-31T00:00:00+08:00');
    expect(calendarCall?.flags.end).toBe('2026-10-31T23:59:59+08:00');
    expect(calendarCall?.operatorStaffId).toBe('staff-1');
    const approvalCall = runner.calls.find(
      (call) => call.domain === 'approval',
    );
    expect(approvalCall?.subcommand).toBe('list-pending');
    expect(approvalCall?.flags.start).toBe('2026-10-31T00:00:00+08:00');
  });

  it('生成周报并统计会议时长与高频参与人', async () => {
    const report = await builder(new FakeRunner()).build({
      kind: 'weekly_report',
      operatorStaffId: 'staff-1',
      now: NOW,
    });

    expect(report.ok).toBe(true);
    expect(report.text).toContain('工作周报 · 10-25 ~ 10-31');
    expect(report.text).toContain('【会议】共 2 场，累计 2 小时');
    expect(report.text).toContain('10-31 09:00 晨会');
    expect(report.text).toContain('高频参与人：张三、李四');
  });

  it('单个数据源失败时降级并标注原因', async () => {
    const runner = new FakeRunner((request) =>
      request.domain === 'approval'
        ? result('', { exitCode: 1, stderr: 'AccessTokenPermissionDenied' })
        : undefined,
    );
    const report = await builder(runner).build({
      kind: 'daily_report',
      operatorStaffId: 'staff-1',
      now: NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.text).toContain('【数据提示】');
    expect(report.text).toContain('审批：AccessTokenPermissionDenied');
    expect(report.text).toContain('【待办】未完成 2 项');
  });

  it('未完成个人授权时直接提示，不借用其他账号查询', async () => {
    const runner = new FakeRunner();
    const identity = {
      status: async () => ({
        state: 'unbound',
        record: null,
        token: null,
        message: '尚未同意个人 DWS 授权',
        checkedAt: NOW,
      }),
      run: async () => {
        throw new Error('不应执行');
      },
    };
    const report = await new PersonalReportBuilder({
      runner: runner as unknown as DwsCliRunner,
      identity: identity as never,
    }).build({
      kind: 'daily_report',
      operatorStaffId: 'staff-1',
      now: NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.text).toContain('授权链接');
    expect(report.text).not.toContain('/dws-consent');
    expect(runner.calls).toHaveLength(0);
  });

  it('配置身份服务后通过本人身份执行查询', async () => {
    const runner = new FakeRunner();
    const identityCalls: string[] = [];
    const identity = {
      status: async () => ({
        state: 'authenticated',
        record: null,
        token: null,
        checkedAt: NOW,
      }),
      run: async (staffId: string, request: Parameters<FakeRunner['run']>[0]) => {
        identityCalls.push(`${staffId}:${request.domain}`);
        return runner.run(request);
      },
    };
    const report = await new PersonalReportBuilder({
      runner: runner as unknown as DwsCliRunner,
      identity: identity as never,
    }).build({
      kind: 'daily_report',
      operatorStaffId: 'staff-1',
      now: NOW,
    });

    expect(report.ok).toBe(true);
    expect(identityCalls).toEqual([
      'staff-1:calendar',
      'staff-1:calendar',
      'staff-1:todo',
      'staff-1:approval',
    ]);
  });

  it('空数据给出明确占位', async () => {
    const runner = new FakeRunner(() => result(JSON.stringify({ result: {} })));
    const report = await builder(runner).build({
      kind: 'daily_report',
      operatorStaffId: 'staff-1',
      now: NOW,
    });
    expect(report.text).toContain('今天没有日程安排');
    expect(report.text).toContain('没有未完成待办');
    expect(report.text).toContain('暂无待处理审批');
  });
});
