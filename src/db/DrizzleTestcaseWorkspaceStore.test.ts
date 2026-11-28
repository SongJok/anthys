import { describe, expect, it } from 'vitest';
import { emptyTestcaseWorkspaceState } from '../testcase/TestcaseWorkspaceStore.js';
import type { TestcaseWorkspaceState } from '../types/testcase-workspace.js';
import {
  toTestcaseWorkspace,
  toTestcaseWorkspaceSummary,
} from './DrizzleTestcaseWorkspaceStore.js';
import type { testcaseWorkspaces } from './testcaseWorkspaceSchema.js';

type Row = typeof testcaseWorkspaces.$inferSelect;

function row(state: TestcaseWorkspaceState): Row {
  return {
    id: 'ws-1',
    title: '结算回归',
    conversationId: 'conv-1',
    conversationType: '1',
    ownerStaffId: 'staff-1',
    projectId: null,
    revision: 3,
    stateJson: state,
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
  };
}

function legacyState(): TestcaseWorkspaceState {
  const state = emptyTestcaseWorkspaceState();
  state.cases = [
    {
      id: 'draft-1',
      module: '结算',
      title: '正常下单',
      preconditions: [],
      steps: ['提交订单'],
      expectedResults: ['下单成功'],
      priority: '高',
      testMethod: '场景法',
      scenarioType: 'normal',
      requirementIds: [],
      evidenceIds: [],
      assumptions: [],
      status: 'ready',
    },
  ];
  // 旧行落盘时还没有风险与缺陷集合
  delete (state as Partial<TestcaseWorkspaceState>).risks;
  delete (state as Partial<TestcaseWorkspaceState>).defects;
  return state;
}

describe('DrizzleTestcaseWorkspaceStore row mappers', () => {
  it('读取旧 jsonb 时补齐风险与缺陷集合', () => {
    const workspace = toTestcaseWorkspace(row(legacyState()));

    expect(workspace.state.risks).toEqual([]);
    expect(workspace.state.defects).toEqual([]);
    expect(workspace.state.cases).toHaveLength(1);
    expect(workspace.updatedAt).toBe(2_000);
  });

  it('旧行的摘要计数不因缺失集合而报错', () => {
    const summary = toTestcaseWorkspaceSummary(row(legacyState()));

    expect(summary).toMatchObject({
      caseCount: 1,
      riskCount: 0,
      defectCount: 0,
      archived: false,
    });
  });

  it('摘要只统计待处理风险与待修复或待验证缺陷', () => {
    const state = emptyTestcaseWorkspaceState();
    state.risks = [
      { id: 'r1', module: '结算', title: '待处理', detail: '', severity: '高', requirementIds: [], evidenceIds: [], mitigation: '', status: 'open' },
      { id: 'r2', module: '结算', title: '已缓解', detail: '', severity: '中', requirementIds: [], evidenceIds: [], mitigation: '', status: 'mitigated' },
      { id: 'r3', module: '结算', title: '已接受', detail: '', severity: '低', requirementIds: [], evidenceIds: [], mitigation: '', status: 'accepted' },
    ];
    state.defects = [
      { id: 'd1', module: '结算', title: '待修复', sourceRef: 'BUG-1', severity: '高', symptom: '', status: 'open' },
      { id: 'd2', module: '结算', title: '待验证', sourceRef: 'BUG-2', severity: '中', symptom: '', status: 'fixed' },
      { id: 'd3', module: '结算', title: '已验证', sourceRef: 'BUG-3', severity: '低', symptom: '', status: 'verified' },
      { id: 'd4', module: '结算', title: '已拒绝', sourceRef: 'BUG-4', severity: '低', symptom: '', status: 'rejected' },
    ];

    const summary = toTestcaseWorkspaceSummary(row(state));

    expect(summary.riskCount).toBe(1);
    expect(summary.defectCount).toBe(2);
  });
});