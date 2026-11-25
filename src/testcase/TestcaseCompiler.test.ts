import { describe, expect, it } from 'vitest';
import type {
  TestcaseDraft,
  TestcaseWorkspace,
} from '../types/testcase-workspace.js';
import { compileTestcaseWorkspace } from './TestcaseCompiler.js';
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
});
