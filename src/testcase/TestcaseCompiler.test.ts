import { describe, expect, it } from 'vitest';
import type {
  TestcaseDraft,
  TestcaseWorkspace,
} from '../types/testcase-workspace.js';
import {
  buildTestcaseXlsxSheets,
  compileTestcaseWorkspace,
  toPlainTestcaseRows,
} from './TestcaseCompiler.js';
import { emptyTestcaseWorkspaceState } from './TestcaseWorkspaceStore.js';

function draft(overrides: Partial<TestcaseDraft> = {}): TestcaseDraft {
  return {
    id: 'case_login_valid',
    module: '登录',
    title: '有效账号密码登录',
    preconditions: ['账号 {{DATA: 有效账号}} 已启用'],
    steps: ['输入账号和密码，点击“登录”'],
    expectedResults: ['进入工作台'],
    priority: '高',
    testMethod: '场景法',
    scenarioType: 'normal',
    requirementIds: ['req_login'],
    evidenceIds: [],
    assumptions: [],
    status: 'ready',
    ...overrides,
  };
}

function workspace(): TestcaseWorkspace {
  const state = emptyTestcaseWorkspaceState();
  state.requirements = [
    {
      id: 'req_login',
      title: '账号密码登录',
      description: '使用有效账号密码登录',
      module: '登录',
      sourceRef: 'PRD 3.1',
      rules: [],
      constraints: [],
      status: 'active',
    },
  ];
  state.cases = [draft()];
  return {
    id: 'ws_1',
    title: '登录模块测试用例',
    conversationId: 'conv_1',
    conversationType: '1',
    ownerStaffId: 'staff_1',
    revision: 4,
    state,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('compileTestcaseWorkspace', () => {
  it('合并完全重复草稿并生成稳定编号和统计', () => {
    const input = workspace();
    input.state.cases.push(draft({ id: 'case_login_duplicate' }));
    input.state.cases.push(
      draft({
        id: 'case_login_boundary',
        title: '密码长度边界',
        scenarioType: 'boundary',
        priority: '中',
        testMethod: '边界值分析法',
      }),
    );

    const result = compileTestcaseWorkspace(input, { version: 2, now: 10 });

    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]?.caseNumber).toBe('TC_登录_001');
    expect(result.cases[1]?.caseNumber).toBe('TC_登录_002');
    expect(result.statistics.total).toBe(2);
    expect(result.statistics.byPriority).toEqual({ 高: 1, 中: 1, 低: 0 });
    expect(result.sourceRevision).toBe(4);
    expect(result.markdown).toContain('| 用例编号 | 用例标题 |');
    expect(result.rows[0]).toHaveLength(7);
  });

  it('重建数据清单、需求追溯和待确认提醒', () => {
    const input = workspace();
    input.state.openQuestions = [
      {
        id: 'q_password_rule',
        question: '密码错误次数上限是多少？',
        blocking: false,
        requirementIds: ['req_login'],
        status: 'open',
      },
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.dataItems).toEqual([
      {
        module: '登录',
        placeholder: '{{DATA: 有效账号}}',
        caseNumbers: ['TC_登录_001'],
      },
    ]);
    expect(result.traceability[0]).toMatchObject({
      requirementId: 'req_login',
      covered: true,
      caseNumbers: ['TC_登录_001'],
    });
    expect(result.markdown).toContain('数据准备清单');
    expect(result.markdown).toContain('非阻塞待确认：密码错误次数上限是多少？');
    expect(result.issues.some((item) => item.code === 'unresolved_question')).toBe(true);
  });

  it('相同输入重复编译得到相同编号', () => {
    const input = workspace();
    const first = compileTestcaseWorkspace(input, { version: 1, now: 10 });
    const second = compileTestcaseWorkspace(input, { version: 1, now: 10 });
    expect(second.rows).toEqual(first.rows);
    expect(second.markdown).toBe(first.markdown);
  });

  it('区分缺失证据、空内容和未覆盖需求', () => {
    const input = workspace();
    input.state.cases[0]!.evidenceIds = ['evidence-missing'];
    input.state.cases.push(
      draft({
        id: 'case_empty',
        title: ' ',
        preconditions: [''],
        steps: ['  '],
        expectedResults: [],
        requirementIds: [],
      }),
    );
    input.state.requirements.push({
      id: 'req_uncovered',
      title: '找回密码',
      description: '通过手机号找回密码',
      module: '登录',
      sourceRef: 'PRD 3.2',
      rules: [],
      constraints: [],
      status: 'active',
    });

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_evidence',
          evidenceId: 'evidence-missing',
        }),
        expect.objectContaining({ code: 'empty_case', caseId: 'case_empty' }),
        expect.objectContaining({ code: 'missing_requirement', caseId: 'case_empty' }),
        expect.objectContaining({
          code: 'uncovered_requirement',
          requirementId: 'req_uncovered',
        }),
      ]),
    );
  });

  it('截图标记在 Markdown 和导出行中一致且不重复', () => {
    const input = workspace();
    input.state.outputPreferences.screenshotMarkers = true;
    input.state.cases[0]!.steps = ['打开登录页', '点击登录 📷'];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.rows[0]?.[3]).toBe('1. 打开登录页<br>2. 点击登录 📷');
    expect(result.markdown.match(/点击登录 📷/gu)).toHaveLength(1);
    expect(result.rows[0]?.[3]?.match(/📷/gu)).toHaveLength(1);
  });

  it('为规范化后相同的模块编码追加稳定后缀', () => {
    const input = workspace();
    input.state.requirements = ['A B', 'A-B'].map((module, index) => ({
      id: `req_${index}`,
      title: `需求 ${index}`,
      description: `需求 ${index}`,
      module,
      sourceRef: `PRD ${index}`,
      rules: [],
      constraints: [],
      status: 'active' as const,
    }));
    input.state.cases = input.state.requirements.map((requirement, index) =>
      draft({
        id: `case_${index}`,
        module: requirement.module,
        title: `用例 ${index}`,
        requirementIds: [requirement.id],
      }),
    );

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.cases.map((item) => item.caseNumber)).toEqual([
      'TC_A_B_001',
      'TC_A_B_2_001',
    ]);
    expect(result.issues.filter((item) => item.code === 'uncovered_requirement')).toHaveLength(0);
  });

  it('将特殊模块名统计为普通自有属性', () => {
    const input = workspace();
    input.state.cases[0]!.module = '__proto__';

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(Object.hasOwn(result.statistics.byModule, '__proto__')).toBe(true);
    expect(result.statistics.byModule.__proto__).toBe(1);
    expect(JSON.parse(JSON.stringify(result.statistics.byModule))).toEqual({
      ['__proto__']: 1,
    });
  });

  it('支持组合测试方法、剥离双重序号并清理禁用后的截图标记', () => {
    const input = workspace();
    input.state.outputPreferences.screenshotMarkers = false;
    input.state.cases = [
      draft({
        id: 'case_combo',
        preconditions: ['1. 账号 {{DATA: 有效账号}} 已启用'],
        steps: ['1. 打开登录页 📷', '2. 点击登录 📷'],
        expectedResults: ['1. 进入工作台'],
        testMethod: '需求分析法 + 场景法',
      }),
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.cases[0]?.testMethod).toBe('需求分析法+场景法');
    expect(result.statistics.byMethod).toEqual({ '需求分析法+场景法': 1 });
    expect(result.issues.filter((item) => item.code === 'unsupported_method')).toHaveLength(0);
    expect(result.rows[0]?.[2]).toBe('1. 账号 {{DATA: 有效账号}} 已启用');
    expect(result.rows[0]?.[3]).toBe('1. 打开登录页<br>2. 点击登录');
    expect(result.rows[0]?.[4]).toBe('1. 进入工作台');
    expect(toPlainTestcaseRows(result)[0]?.[3]).toBe('1. 打开登录页\n2. 点击登录');
  });

  it('中段步骤已有截图标记时末步不重复添加，且区分三档自动化可行性与证据冲突', () => {
    const input = workspace();
    input.state.evidence = [
      {
        id: 'ev_1',
        type: 'document',
        sourceRef: 'PRD 3.1',
        collectedAt: 1,
        scope: '登录',
        summary: 'PRD 要求密码至少 8 位',
        confidence: 'medium',
        requirementIds: ['req_login'],
        conflictsWith: ['ev_2'],
      },
      {
        id: 'ev_2',
        type: 'ui',
        sourceRef: '页面截图',
        collectedAt: 2,
        scope: '登录',
        summary: '线上允许 6 位密码',
        confidence: 'high',
        requirementIds: ['req_login'],
        conflictsWith: ['ev_1'],
      },
    ];
    input.state.decisions = [
      {
        id: 'dec_1',
        topic: '密码最小长度',
        value: '以线上 6 位为准',
        createdAt: 3,
      },
    ];
    input.state.cases = [
      draft({
        id: 'case_mid_marker',
        steps: ['打开支付页', '调起指纹硬件校验 📷', '返回结果页'],
        expectedResults: ['完成真实支付扣款'],
      }),
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.rows[0]?.[3]).toBe('1. 打开支付页<br>2. 调起指纹硬件校验 📷<br>3. 返回结果页');
    expect(result.issues.filter((item) => item.code === 'evidence_conflict')).toHaveLength(1);
    expect(result.markdown).toContain('## 已确认口径与决策');
    expect(result.markdown).toContain('密码最小长度：以线上 6 位为准');
    expect(result.markdown).toContain('自动化可行性：暂不可自动化');
  });

  it('输出风险覆盖与缺陷复现追溯，并对未覆盖项告警', () => {
    const input = workspace();
    input.state.risks = [
      {
        id: 'risk_login_lock',
        module: '登录',
        title: '密码错误锁定规则未定义',
        detail: 'PRD 未给出错误次数上限',
        severity: '高',
        requirementIds: ['req_login'],
        evidenceIds: [],
        mitigation: '需求评审确认阈值',
        status: 'open',
      },
      {
        id: 'risk_login_gap',
        module: '登录',
        title: '第三方登录异常未设计',
        detail: '回调失败分支缺失',
        severity: '中',
        requirementIds: [],
        evidenceIds: [],
        mitigation: '补充异常用例',
        status: 'open',
      },
    ];
    input.state.defects = [
      {
        id: 'defect_login_500',
        module: '登录',
        title: '空密码提交返回 500',
        sourceRef: 'BUG-1024',
        severity: '高',
        symptom: '密码为空时接口 500',
        status: 'fixed',
      },
    ];
    input.state.cases = [draft({ riskIds: ['risk_login_lock'] })];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.riskRegister[0]).toMatchObject({
      riskId: 'risk_login_lock',
      covered: true,
      caseNumbers: ['TC_登录_001'],
    });
    expect(result.defectTraceability[0]).toMatchObject({
      defectId: 'defect_login_500',
      covered: false,
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'uncovered_risk',
          riskId: 'risk_login_gap',
        }),
        expect.objectContaining({
          code: 'uncovered_defect',
          defectId: 'defect_login_500',
        }),
      ]),
    );
    expect(result.issues.some((item) => item.riskId === 'risk_login_lock')).toBe(false);
    expect(result.markdown).toContain('## 需求评审风险');
    expect(result.markdown).toContain('## 缺陷复现追溯');
    expect(result.markdown).toContain('缺少复现或回归用例');
  });

  it('已接受风险不报未覆盖，已验证缺陷不报缺复现', () => {
    const input = workspace();
    input.state.risks = [
      {
        id: 'risk_accepted',
        module: '登录',
        title: '已接受风险',
        detail: '',
        severity: '低',
        requirementIds: [],
        evidenceIds: [],
        mitigation: '',
        status: 'accepted',
      },
      {
        id: 'risk_mitigated',
        module: '登录',
        title: '已缓解风险',
        detail: '',
        severity: '中',
        requirementIds: [],
        evidenceIds: [],
        mitigation: '已加限流',
        status: 'mitigated',
      },
    ];
    input.state.defects = [
      {
        id: 'defect_verified',
        module: '登录',
        title: '已验证缺陷',
        sourceRef: 'BUG-1',
        severity: '低',
        symptom: '',
        status: 'verified',
      },
      {
        id: 'defect_rejected',
        module: '登录',
        title: '已拒绝缺陷',
        sourceRef: 'BUG-2',
        severity: '低',
        symptom: '',
        status: 'rejected',
      },
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.issues.filter((item) => item.code === 'uncovered_risk')).toHaveLength(0);
    expect(result.issues.filter((item) => item.code === 'uncovered_defect')).toHaveLength(0);
  });

  it('用例引用不存在的风险或缺陷时分别告警', () => {
    const input = workspace();
    input.state.cases = [
      draft({ riskIds: ['risk_missing'], defectIds: ['defect_missing'] }),
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_risk', riskId: 'risk_missing' }),
        expect.objectContaining({
          code: 'missing_defect',
          defectId: 'defect_missing',
        }),
      ]),
    );
  });

  it('汇总执行结果、通过率与失败阻塞说明', () => {
    const input = workspace();
    input.state.cases = [
      draft({ id: 'case_pass', execution: { status: 'passed', executor: '测试甲' } }),
      draft({
        id: 'case_fail',
        title: '密码错误提示',
        execution: { status: 'failed', note: '提示文案与需求不一致' },
      }),
      draft({
        id: 'case_block',
        title: '短信验证码登录',
        execution: { status: 'blocked', note: '短信通道未开通' },
      }),
      draft({ id: 'case_untested', title: '记住登录状态' }),
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });

    expect(result.execution).toMatchObject({
      total: 4,
      passed: 1,
      failed: 1,
      blocked: 1,
      untested: 1,
      passRate: 33.3,
    });
    expect(result.markdown).toContain('## 执行结果与测试报告');
    expect(result.markdown).toContain('已执行用例通过率：33.3%');
    expect(result.markdown).toContain('提示文案与需求不一致');
    expect(result.markdown).toContain('短信通道未开通');
    const sheets = buildTestcaseXlsxSheets(result, input);
    expect(sheets.map((sheet) => sheet.name)).toContain('执行结果');
  });

  it('按失败、阻塞、未关闭风险、待验证缺陷与高优先级推荐回归范围', () => {
    const input = workspace();
    input.state.risks = [
      {
        id: 'risk_open',
        module: '登录',
        title: '锁定阈值待确认',
        detail: '',
        severity: '中',
        requirementIds: [],
        evidenceIds: [],
        mitigation: '',
        status: 'open',
      },
    ];
    input.state.defects = [
      {
        id: 'defect_fixed',
        module: '登录',
        title: '空密码 500',
        sourceRef: 'BUG-1',
        severity: '中',
        symptom: '',
        status: 'fixed',
      },
    ];
    input.state.cases = [
      draft({ id: 'case_high', execution: { status: 'failed' } }),
      draft({
        id: 'case_risk',
        title: '锁定阈值验证',
        priority: '低',
        riskIds: ['risk_open'],
      }),
      draft({
        id: 'case_defect',
        title: '空密码复现',
        priority: '低',
        defectIds: ['defect_fixed'],
      }),
      draft({ id: 'case_low', title: '页面文案展示', priority: '低' }),
    ];

    const result = compileTestcaseWorkspace(input, { now: 10 });
    const numberOf = (id: string) =>
      result.cases.find((item) => item.id === id)?.caseNumber;

    expect(result.regression.caseNumbers).toHaveLength(3);
    expect(result.regression.caseNumbers).toContain(numberOf('case_high'));
    expect(result.regression.caseNumbers).toContain(numberOf('case_risk'));
    expect(result.regression.caseNumbers).toContain(numberOf('case_defect'));
    expect(result.regression.caseNumbers).not.toContain(numberOf('case_low'));
    expect(result.regression.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseNumber: numberOf('case_high'),
          reason: expect.stringContaining('上轮执行失败'),
        }),
        expect.objectContaining({
          caseNumber: numberOf('case_risk'),
          reason: expect.stringContaining('关联未关闭风险 risk_open'),
        }),
      ]),
    );
    expect(result.markdown).toContain('## 回归范围建议');
    expect(buildTestcaseXlsxSheets(result, input).map((sheet) => sheet.name)).toEqual(
      expect.arrayContaining(['需求评审风险', '缺陷复现追溯', '回归范围建议']),
    );
  });

  it('selection 只合稿命中用例，且不把范围外需求报成未覆盖', () => {
    const input = workspace();
    input.state.requirements.push({
      id: 'req_logout',
      title: '退出登录',
      description: '点击退出清空会话',
      module: '会话',
      sourceRef: 'PRD 3.9',
      rules: [],
      constraints: [],
      status: 'active',
    });
    input.state.cases = [
      draft(),
      draft({
        id: 'case_logout',
        module: '会话',
        title: '退出登录清空会话',
        requirementIds: ['req_logout'],
      }),
    ];

    const result = compileTestcaseWorkspace(input, {
      now: 10,
      selection: { modules: ['登录'] },
    });

    expect(result.cases.map((item) => item.id)).toEqual(['case_login_valid']);
    expect(result.traceability.map((item) => item.requirementId)).toEqual(['req_login']);
    expect(result.issues.filter((item) => item.code === 'uncovered_requirement')).toHaveLength(0);
    expect(result.selection).toEqual({ modules: ['登录'] });
    expect(result.markdown).toContain('合稿范围：模块 登录');
  });

  it('selection 支持按执行状态与优先级筛选回归子集', () => {
    const input = workspace();
    input.state.cases = [
      draft({ id: 'case_failed', execution: { status: 'failed' } }),
      draft({
        id: 'case_passed',
        title: '已通过用例',
        execution: { status: 'passed' },
      }),
      draft({ id: 'case_low', title: '低优先级未执行', priority: '低' }),
    ];

    const result = compileTestcaseWorkspace(input, {
      now: 10,
      selection: { executionStatuses: ['failed'], priorities: ['高'] },
    });

    expect(result.cases.map((item) => item.id)).toEqual(['case_failed']);
    expect(result.execution.failed).toBe(1);
  });

  it('selection 按草稿 ID 与需求 ID 取交集，并保留范围内追溯', () => {
    const input = workspace();
    input.state.requirements.push({
      id: 'req_logout',
      title: '退出登录',
      description: '点击退出清空会话',
      module: '登录',
      sourceRef: 'PRD 3.9',
      rules: [],
      constraints: [],
      status: 'active',
    });
    input.state.cases = [
      draft(),
      draft({
        id: 'case_logout',
        title: '退出登录清空会话',
        requirementIds: ['req_logout'],
      }),
    ];

    const byCase = compileTestcaseWorkspace(input, {
      now: 10,
      selection: { caseIds: ['case_logout'], requirementIds: ['req_logout'] },
    });
    expect(byCase.cases.map((item) => item.id)).toEqual(['case_logout']);
    expect(byCase.traceability.map((item) => item.requirementId)).toEqual(['req_logout']);

    const empty = compileTestcaseWorkspace(input, {
      now: 10,
      selection: { caseIds: ['case_logout'], requirementIds: ['req_login'] },
    });
    expect(empty.cases).toHaveLength(0);
    expect(empty.statistics.total).toBe(0);
  });
});
