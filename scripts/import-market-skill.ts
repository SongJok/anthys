#!/usr/bin/env tsx
/**
 * 一次性导入工具：把 Qoder 能力市场里已安装的技能包转换成本项目
 * `skills/market/<module>/<name>/SKILL.md` 形态。
 *
 * 用法：
 *   pnpm tsx scripts/import-market-skill.ts             # 全量导入
 *   pnpm tsx scripts/import-market-skill.ts --dry-run   # 只转换与校验，不落盘
 *   pnpm tsx scripts/import-market-skill.ts --only bug-review
 *
 * 这个脚本不进运行时（tsconfig 不含 scripts/，产物也不引用它）。
 * 内容以本文件里的 CURATION 表为唯一真相：改了上游包不会自动同步，
 * 要改内容就改这里再重跑。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSkillMarkdown } from '../src/skills/SkillRegistry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(os.homedir(), '.qoder-cn', 'skills');
const TARGET_ROOT = path.join(REPO_ROOT, 'skills', 'market');
const MAX_FILE_BYTES = 64 * 1024;

type Risk = 'read' | 'write';
type Visibility = 'public' | 'admin';

interface MarketMeta {
  /** 市场列表里的中文名 */
  title: string;
  /** 市场 id */
  id: string;
  canonicalName: string;
  publisher: string;
  /** 市场列表声称的版本 */
  version: string;
  category: string;
  /** 市场 tags，去掉 origin:* 后并入技能 tags */
  tags: string[];
  /** 上游仓库或提交地址，包里没有就写 null */
  sourceUrl: string | null;
  license: string | null;
  /** 包内实际版本，与市场版本不一致时两者都记录 */
  packageVersion: string | null;
  /** 上游安全审计结论 */
  securityAudit: string;
}

interface SkillSpec {
  /** ~/.qoder-cn/skills 下的目录名 */
  packageName: string;
  name: string;
  module: string;
  description: string;
  whenToUse: string;
  version: string;
  risk: Risk;
  visibility: Visibility;
  /** 正文注入上限，超过就按章节拆到 references/ */
  maxInstructionChars: number;
  allowedTools: string[];
  tags: string[];
  /** A=纯方法论可直接用；B=降级可用；C=依赖外部设施 */
  grade: 'A' | 'B' | 'C';
  /** 仍然存在的阻塞点 */
  blockers: string[];
  /** 追加到正文的本项目适配说明 */
  notes: string;
  market: MarketMeta;
  /** 包里有但本次不导入的文件/目录，写进 IMPORT.md 备查 */
  droppedFiles: string[];
  /** 包内文件 → 技能 references/ 下的文件 */
  keptResources: Array<{ from: string; to: string }>;
  /** 正文精确替换，命中不到就报错，避免上游漂移后静默失效 */
  replacements: Array<[string, string]>;
  /** 按标题删除的整节（含其子节） */
  dropSections: string[];
}

const CURATION: SkillSpec[] = [
  {
    packageName: 'analyze-prompt',
    name: 'analyze-prompt',
    module: 'engineering',
    description:
      '用七级框架分析现有提示词：判定当前等级、核对缺失章节、核对命名与流程规范，并给出分级改进建议与重构版本。',
    whenToUse:
      '用户要求分析、优化、重写提示词，或需要判断一段提示词在七级框架里处于哪一级、缺哪些章节时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 4000,
    allowedTools: ['project_read', 'project_search', 'workspace_read_file'],
    tags: ['origin:qoder-market', 'prompt', 'prompt-engineering'],
    grade: 'A',
    blockers: [],
    notes: [
      '本项目没有 shell，也没有 Read/Glob/Grep 工具。读取提示词文件用 `project_read`（项目仓库内）或 `workspace_read_file`（工作区）；没有文件路径时先向用户确认。',
      '上游引用的 `@seven-levels.md`、`@prompt-sections-reference.md` 与 `/upgrade-prompt` 命令都没有随包提供，判定表已完整写在本技能正文里；应用改进建议在当前会话直接完成。',
    ].join('\n'),
    market: {
      title: '提示词优化',
      id: 'official_4YGFW2Fg',
      canonicalName: 'melodic-software-analyze-prompt',
      publisher: 'melodic-software',
      version: '1.0.0',
      category: 'Code Review',
      tags: ['origin:modelscope'],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit: '包内无审计报告；正文为纯提示词，无脚本、无网络调用、无外部命令。',
    },
    droppedFiles: [],
    keptResources: [],
    replacements: [
      [
        'Read the prompt file at `$1` completely.',
        '用 `project_read` 或 `workspace_read_file` 完整读取用户指定的提示词文件（本项目没有 `$1` 位置参数，路径由用户在对话里给出）。',
      ],
      [
        '- See @seven-levels.md for level indicators',
        '- 等级判定表已完整写在「Step 4: Classify Level」，上游的 `@seven-levels.md` 未随包提供',
      ],
      [
        '- See @prompt-sections-reference.md for required sections',
        '- 必需章节清单已写在「Step 3: Identify Sections」，上游的 `@prompt-sections-reference.md` 未随包提供',
      ],
      [
        '- Use /upgrade-prompt to apply suggested improvements',
        '- 应用改进建议在当前会话直接完成，上游的 `/upgrade-prompt` 命令不存在',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'analyze-code',
    name: 'analyze-code',
    module: 'engineering',
    description:
      '深度分析代码：按正确性、类型安全、可观测性、韧性、清晰度等维度找出隐患，按 CRITICAL 到 INFO 分级给出改进建议与技术债清单。',
    whenToUse:
      '用户要求深度分析代码、评估代码健康度、排查技术债与潜在缺陷，或需要一份按影响排序的重构建议清单时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 4000,
    allowedTools: [
      'project_read',
      'project_search',
      'project_map',
      'project_symbol',
      'workspace_read_file',
    ],
    tags: ['origin:qoder-market', 'code-analysis', 'technical-debt'],
    grade: 'B',
    blockers: [
      '上游靠派子代理（Task + consultant CLI）完成分析，本项目没有子代理机制，改为在主会话里按同一套准则执行',
    ],
    notes: [
      '本项目没有子代理、Task 工具和 consultant CLI，也没有 shell。分析在主会话内完成：用 `project_map` / `project_search` / `project_symbol` / `project_read` 读取目标代码，再按下面的准则逐条给结论。',
      '无法执行静态分析器（eslint、tsc、clippy 等），需要证据时把建议命令交给用户执行并回贴输出，不要假装跑过。',
    ].join('\n'),
    market: {
      title: '代码分析',
      id: 'official_ZNwrwxZu',
      canonicalName: 'diegosouzapw-analyze-code',
      publisher: 'diegosouzapw',
      version: '1.0.0',
      category: 'Code Review',
      tags: ['origin:modelscope', 'qoder-pro'],
      sourceUrl: 'https://github.com/majiayu000/claude-skill-registry-data',
      license: null,
      packageVersion: null,
      securityAudit:
        '包内无审计报告；metadata.json 声明来自 GitHub 索引仓，正文无脚本与外部命令。',
    },
    droppedFiles: ['metadata.json'],
    keptResources: [],
    replacements: [
      [
        "Use the Task tool with `subagent_type='consultant:consultant'`. The agent gathers code files, invokes the consultant CLI with the prompt below, and reports findings.",
        '本项目没有子代理、Task 工具和 consultant CLI。请直接用 `project_map` / `project_search` / `project_symbol` / `project_read` 读取目标代码，按下面的准则清单完成分析，并直接输出分析结论。',
      ],
      ['# Consultant Prompt', '# 分析准则'],
      [
        'Without specific targets, analyze most critical code paths in the current working directory.',
        '用户没有指定目标时，分析当前项目里最关键的代码路径，并用实际读取到的文件与行号作为证据。',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'bug-review',
    name: 'bug-review',
    module: 'engineering',
    description:
      '系统化缺陷排查：先识别代码语言与版本约束、规划复现方式，再逐条记录缺陷的严重度与根因，给出最小修复、测试补充和验证计划。',
    whenToUse:
      '收到缺陷报告、发布前自查、排查潜在缺陷，或需要一份带文件行号与根因的缺陷清单时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: ['project_read', 'project_search', 'project_symbol', 'workspace_read_file'],
    tags: ['origin:qoder-market', 'bug-review', 'defect', 'code-quality'],
    grade: 'B',
    blockers: [
      '上游声明的 defect-tracker / fix-generator / verification-runner / pensive:shared / imbue:* 依赖在本项目都不存在，已删除',
      '本项目没有 shell，静态分析器与测试命令只能交给用户执行',
    ],
    notes: [
      '本项目没有 shell，也没有 TodoWrite 工具。上游流程里的复现命令、静态分析器与测试执行都要以命令形式交给用户执行并回贴输出。',
      '本项目不能直接改仓库文件：第 4 步的"准备修复"产出补丁文本与测试代码，由用户落库；不要声称已经改好。',
      '上游声明的 `defect-tracker`、`fix-generator`、`verification-runner`、`pensive:shared`、`imbue:proof-of-work`、`imbue:diff-analysis/...` 都是别的运行时的插件，本项目没有，已从流程里删除。',
    ].join('\n'),
    market: {
      title: '漏洞BUG',
      id: 'official_mPfA6ebJ',
      canonicalName: 'athola-bug-review',
      publisher: 'athola',
      version: '1.0.0',
      category: 'Code Review',
      tags: ['origin:modelscope'],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit:
        '包内无审计报告；正文提到 cargo clippy / ruff / golangci-lint / eslint 等静态分析器命令，属于文档示例，本项目不执行。',
    },
    droppedFiles: [],
    keptResources: [
      { from: 'modules/defect-documentation.md', to: 'references/defect-documentation.md' },
      { from: 'modules/fix-preparation.md', to: 'references/fix-preparation.md' },
      { from: 'modules/language-detection.md', to: 'references/language-detection.md' },
    ],
    replacements: [
      [
        '- [Required TodoWrite Items](#required-todowrite-items)',
        '- [输出必须覆盖的五个部分](#输出必须覆盖的五个部分)',
      ],
      [
        '## Quick Start\n\n```bash\n/bug-review\n```\n**Verification:** Run the command with `--help` flag to verify availability.\n',
        '## Quick Start\n\n用户说"查缺陷 / 审一下 bug"时直接进入下面的工作流，不必等待额外指令。\n',
      ],
      [
        '## Required TodoWrite Items\n\n1. `bug-review:language-detected`\n2. `bug-review:repro-plan`\n3. `bug-review:defects-documented`\n4. `bug-review:fixes-prepared`\n5. `bug-review:verification-plan`\n',
        '## 输出必须覆盖的五个部分\n\n1. 语言识别结果\n2. 复现方式规划\n3. 缺陷清单\n4. 修复准备（补丁文本）\n5. 验证计划\n',
      ],
      [
        '- **Language Detection**: `@include modules/language-detection.md` - Manifest heuristics, expertise framing, version constraints\n- **Defect Documentation**: `@include modules/defect-documentation.md` - Severity classification, root cause analysis, static analyzers\n- **Fix Preparation**: `@include modules/fix-preparation.md` - Minimal patches, idiomatic patterns, test coverage',
        '- **语言识别**: `references/language-detection.md` - manifest 推断、版本约束\n- **缺陷记录**: `references/defect-documentation.md` - 严重度分级、根因分类、静态分析器命令\n- **修复准备**: `references/fix-preparation.md` - 最小补丁、语言惯用写法、测试补充',
      ],
      [
        '**Progressive**: Load `modules/language-detection.md` for detailed manifest heuristics.',
        '**渐进加载**: 读取 `references/language-detection.md` 获取 manifest 推断细则。',
      ],
      [
        '**Progressive**: Load `modules/defect-documentation.md` for classification details and analyzer commands.',
        '**渐进加载**: 读取 `references/defect-documentation.md` 获取分级细则与分析器命令。',
      ],
      [
        '**Progressive**: Load `modules/fix-preparation.md` for language-specific patterns and test strategies.',
        '**渐进加载**: 读取 `references/fix-preparation.md` 获取各语言修复模式与测试策略。',
      ],
      [
        'Run static analyzers (`cargo clippy`, `ruff check`, `golangci-lint`, `eslint`).\n\nUse `imbue:proof-of-work` for reproducible capture.',
        '静态分析器（`cargo clippy`、`ruff check`、`golangci-lint`、`eslint`）需要宿主 shell，本项目无法运行：请把建议命令交给用户执行并回贴输出，或改用 `project_search` 人工核对可疑写法。',
      ],
      [
        'Document remaining risks using `imbue:diff-analysis/modules/risk-assessment-framework`.',
        '剩余风险按下方「Best Practices」第 5 条打分并逐条记录。',
      ],
      [
        '**Verification:** Run `pytest -v tests/test_api.py` to verify.',
        '**Verification:** 由用户执行 `pytest -v tests/test_api.py` 并回贴输出。',
      ],
      [
        '**Verification:** Run `pytest -v` to verify tests pass.',
        '**Verification:** 由用户执行 `pytest -v` 并回贴输出。',
      ],
    ],
    dropSections: ['Troubleshooting'],
  },
  {
    packageName: 'code-quality-analyzer',
    name: 'code-quality-analyzer',
    module: 'engineering',
    description:
      '按可读性、可维护性、性能与安全性四个维度做代码质量评估，输出分级问题清单、改进建议与质量报告。',
    whenToUse:
      '用户要求做代码质量分析、代码异味检查、复杂度评估，或需要一份带评分与改进项的质量报告时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 4000,
    allowedTools: ['project_read', 'project_search', 'project_map', 'workspace_read_file'],
    tags: ['origin:qoder-market', 'code-quality', 'refactoring'],
    grade: 'B',
    blockers: [
      '上游是按次收费的商业服务（USDC 定价），已删除全部定价内容，改为免费的方法论',
      '本项目没有 shell，eslint 等静态检查器不能直接运行',
    ],
    notes: [
      '本项目没有 shell，无法运行 eslint、tsc、ruff 等静态检查器。分析基于读到的源码文本；需要工具证据时给出命令让用户执行并回贴输出。',
      '上游的定价与"团队订阅"属于商业服务内容，与本项目无关，已全部删除，只保留方法论部分。',
    ].join('\n'),
    market: {
      title: '代码质量分析器',
      id: 'official_c3Oss0lm',
      canonicalName: 'code-quality-analyzer',
      publisher: 'a1ucard2q',
      version: '1.0.0',
      category: 'Code Review',
      tags: ['代码质量分析', '静态代码检查', '编程辅助', 'origin:skillatlas'],
      sourceUrl:
        'https://github.com/openclaw/skills/commit/f49cca9fe594a14cd64cda04d3fb3d90e9ff8413',
      license: null,
      packageVersion: '1.0.0',
      securityAudit: '包内无审计报告；正文为纯文本方法论，无脚本与外部调用。',
    },
    droppedFiles: ['_meta.json'],
    keptResources: [],
    replacements: [
      [
        '### 1. 单文件分析 ($5)\n- 代码复杂度评估\n- 潜在bug检测\n- 命名规范检查\n- 改进建议\n\n### 2. 项目级分析 ($20)\n- 整体架构评估\n- 模块依赖分析\n- 代码重复检测\n- 性能优化建议\n- 安全漏洞扫描\n\n### 3. 团队订阅 ($50/月)\n- 无限次分析\n- 自定义规则\n- CI/CD 集成指南\n- 优先支持',
        '### 1. 单文件分析\n- 代码复杂度评估\n- 潜在 bug 检测\n- 命名规范检查\n- 改进建议\n\n### 2. 项目级分析\n- 整体架构评估\n- 模块依赖分析\n- 代码重复检测\n- 性能优化建议\n- 安全漏洞扫描\n\n### 3. 定制规则\n- 按项目约定自定义检查项\n- CI/CD 集成建议',
      ],
      [
        '*好代码 = 好产品 = 好生意 🔍*',
        '*好代码 = 好产品 = 好生意*',
      ],
    ],
    dropSections: ['定价'],
  },
  {
    packageName: 'production-code-audit',
    name: 'production-code-audit',
    module: 'engineering',
    description:
      '逐行扫描整个代码库，找出安全、性能、架构、可靠性与可维护性缺陷，按优先级排序并产出企业级生产就绪审计报告与整改清单。',
    whenToUse:
      '用户要求做生产级代码审计、上线前质量体检、生成整改清单，或排查安全与性能隐患时使用。',
    version: '1.0.1',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: [
      'project_read',
      'project_search',
      'project_map',
      'project_symbol',
      'workspace_read_file',
    ],
    tags: ['origin:qoder-market', 'code-audit', 'production-readiness', 'security'],
    grade: 'A',
    blockers: [],
    notes: [
      '本项目没有 shell，也不能改宿主机文件：上游流程里的"运行命令/安装依赖/直接改文件"改为输出命令清单与补丁建议，由用户执行。',
      '扫描范围用 `project_map` + `project_search` + `project_read` 获取，报告里的每条结论都要带真实的文件路径与行号。',
    ].join('\n'),
    market: {
      title: '代码审计',
      id: 'official_R7zSmfaa',
      canonicalName: 'aiskillstore-production-code-audit',
      publisher: 'aiskillstore',
      version: '1.0.0',
      category: 'Code Review',
      tags: ['origin:modelscope'],
      sourceUrl:
        'https://github.com/sickn33/antigravity-awesome-skills/tree/main/skills/production-code-audit',
      license: 'MIT',
      packageVersion: '1.0.1',
      securityAudit:
        '上游 skill-report.json：risk_level=low，is_blocked=false，safe_to_publish=true；53 条静态告警经上游判定全为误报（外部命令是 markdown 示例，网络地址是文档链接）。',
    },
    droppedFiles: ['skill-report.json'],
    keptResources: [],
    replacements: [],
    dropSections: [],
  },
  {
    packageName: 'systematic-debugging',
    name: 'systematic-debugging',
    module: 'testing',
    description:
      '四阶段系统化调试框架：先复现并收集证据、再定位根因、然后验证单一假设、最后做最小修复并验证；未完成根因调查不允许动手改。',
    whenToUse:
      '遇到 bug、测试失败、报错或任何意外行为时使用；在给出任何修复方案之前先用它做根因调查。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: ['project_read', 'project_search', 'project_symbol', 'workspace_read_file'],
    tags: ['origin:qoder-market', 'debugging', 'root-cause'],
    grade: 'A',
    blockers: [],
    notes: [
      '本项目不能改仓库文件、也不能跑测试：第 4 阶段"实施修复"要产出补丁文本与验证命令，交由用户执行并回贴结果，再进入第 4 阶段验证。',
      '上游引用的 `superpowers:test-driven-development` 与 `superpowers:verification-before-completion` 是别的运行时的技能，本项目没有；对应的"先写失败测试""确认修好了再说"的要求保留在正文里。',
    ].join('\n'),
    market: {
      title: '调试测试',
      id: 'official_Gpok7ZP9',
      canonicalName: 'boisenoise-superpowers-systematic-debugging',
      publisher: 'boisenoise',
      version: '1.0.0',
      category: 'Security & Testing',
      tags: ['origin:modelscope', 'qoder-pro'],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit:
        '包内无审计报告；正文为纯文本方法论。市场上另有 12 个同名变体（body 差异不到 5%），只导入本包一个。',
    },
    droppedFiles: [
      'CREATION-LOG.md',
      'condition-based-waiting-example.ts',
      'find-polluter.sh',
      'test-academic.md',
      'test-pressure-1.md',
      'test-pressure-2.md',
      'test-pressure-3.md',
    ],
    keptResources: [
      { from: 'root-cause-tracing.md', to: 'references/root-cause-tracing.md' },
      { from: 'defense-in-depth.md', to: 'references/defense-in-depth.md' },
      { from: 'condition-based-waiting.md', to: 'references/condition-based-waiting.md' },
    ],
    replacements: [
      [
        'See `root-cause-tracing.md` in this directory for the complete backward tracing technique.',
        '完整的回溯追踪方法见 `references/root-cause-tracing.md`。',
      ],
      [
        '- Use the `superpowers:test-driven-development` skill for writing proper failing tests',
        '- 本项目没有内置的 TDD 技能，"先写一个会失败的测试"这条要求保留，请直接在会话里产出测试代码文本',
      ],
      [
        '- **superpowers:test-driven-development** - For creating failing test case (Phase 4, Step 1)\n- **superpowers:verification-before-completion** - Verify fix worked before claiming success',
        '- **先写失败测试**（第 4 阶段第 1 步）\n- **确认修好了再说**（声称修复完成前必须拿到验证输出）',
      ],
      [
        'These techniques are part of systematic debugging and available in this directory:',
        '这些补充技法随技能一起提供：',
      ],
      [
        '- **`root-cause-tracing.md`** - Trace bugs backward through call stack to find original trigger\n- **`defense-in-depth.md`** - Add validation at multiple layers after finding root cause\n- **`condition-based-waiting.md`** - Replace arbitrary timeouts with condition polling',
        '- **`references/root-cause-tracing.md`** - 沿调用栈回溯，定位最初触发点\n- **`references/defense-in-depth.md`** - 找到根因后在多层加校验\n- **`references/condition-based-waiting.md`** - 用条件轮询替代固定超时',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'database-optimizer',
    name: 'database-optimizer',
    module: 'data',
    description:
      '数据库性能调优方法论：执行计划分析、查询重写、索引设计、N+1 治理、多层缓存、分区与分片，以及云数据库优化与迁移规划。',
    whenToUse:
      '用户要求优化 SQL 性能、设计索引、排查慢查询或 N+1、规划数据迁移与分库分表时使用。',
    version: '1.0.1',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: ['project_read', 'project_search', 'workspace_read_file'],
    tags: ['origin:qoder-market', 'database', 'performance', 'indexing'],
    grade: 'A',
    blockers: [],
    notes: [
      '本项目没有数据库直连工具，不能自己连库跑 EXPLAIN：请用户贴出 SQL 与 `EXPLAIN ANALYZE` 输出，再基于这些材料做分析。',
      '上游提到的 `resources/implementation-playbook.md` 没有随包提供，相关示例已收录在本技能正文里。',
    ].join('\n'),
    market: {
      title: 'SQL数据库优化',
      id: 'official_gQLDuHsX',
      canonicalName: 'aiskillstore-database-optimizer',
      publisher: 'aiskillstore',
      version: '1.0.0',
      category: 'Database & Analytics',
      tags: ['origin:modelscope'],
      sourceUrl:
        'https://github.com/sickn33/antigravity-awesome-skills/tree/main/skills/database-optimizer',
      license: 'MIT',
      packageVersion: '1.0.1',
      securityAudit:
        '上游 skill-report.json：risk_level=safe，is_blocked=false，safe_to_publish=true；纯提示词，无可执行代码、网络或文件访问。',
    },
    droppedFiles: ['skill-report.json'],
    keptResources: [],
    replacements: [
      [
        '- If detailed examples are required, open `resources/implementation-playbook.md`.',
        '- 需要详细示例时直接看下方各章节；上游提到的 `resources/implementation-playbook.md` 未随包提供。',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'auto-gen-testcase-from-req',
    name: 'auto-gen-testcase-from-req',
    module: 'testing',
    description:
      '从需求文档生成标准 Markdown 功能测试用例：七列固定结构、具体输入值、真实数据占位符、UI 路径、可观察断言与模块级数据准备清单。',
    whenToUse:
      '用户要求根据 PRD、需求文档、模块说明或截图生成、设计、修改功能测试用例时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: ['project_read', 'project_search', 'workspace_read_file', 'deliver_artifact'],
    tags: ['origin:qoder-market', 'test-case', 'prd', 'qa'],
    grade: 'B',
    blockers: [
      '上游承诺"可由 auto-test-from-testcase 直接执行"，该配套技能不在本项目，输出改为纯用例文档',
    ],
    notes: [
      '本项目没有自动执行器：输出是功能测试用例文档，执行由人或外部测试平台完成，不要承诺"可直接执行"。',
      '`📷` 只是截图节点标记，本项目不会真的截图；文档产出用 `deliver_artifact` 交付，正文文本直接回复。',
    ].join('\n'),
    market: {
      title: '需求自动生成测试用例',
      id: '8bd5d119-6f50-433c-ba23-d952d011bd51',
      canonicalName: 'auto-gen-testcase-from-req',
      publisher: 'LAUFLO',
      version: '1.0.0',
      category: 'Security & Testing',
      tags: [],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit: '包内无审计报告；正文为方法论，三个 references 为纯文档。',
    },
    droppedFiles: ['agents/openai.yaml'],
    keptResources: [
      { from: 'references/test-methods.md', to: 'references/test-methods.md' },
      {
        from: 'references/testcase-splitting-rules.md',
        to: 'references/testcase-splitting-rules.md',
      },
      { from: 'references/output-example.md', to: 'references/output-example.md' },
    ],
    replacements: [
      [
        '生成可追溯、可直接执行且不编造业务行为的功能测试用例。',
        '生成可追溯、字段完整且不编造业务行为的功能测试用例文档（不含自动执行器，执行由人或外部测试平台完成）。',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'frontend-dev',
    name: 'frontend-dev',
    module: 'engineering',
    description:
      '前端页面与动效方法论：视觉设计规范、动效与性能预算、素材生成流程、转化文案框架与生成艺术创作步骤。',
    whenToUse:
      '用户要求做落地页、营销页或产品页，设计高级动效，规划视觉素材，或撰写转化文案时使用。',
    version: '0.1.1',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: [
      'project_read',
      'project_search',
      'web_fetch',
      'web_search',
      'deliver_artifact',
    ],
    tags: ['origin:qoder-market', 'frontend', 'design', 'motion', 'copywriting'],
    grade: 'B',
    blockers: [
      '上游的 AI 素材生成脚本依赖 MINIMAX_API_KEY 与本地 python 环境，本项目没有 shell 也没有密钥，素材生成整章降级为素材需求清单',
      '上游的 canvas-fonts/ 有 5.5 MB 字体与 4 个 p5.js 生成模板，本项目不能执行也不需要，已删除',
    ],
    notes: [
      '本项目没有 shell、没有 npm/dev server、不能落盘写文件：产出是 HTML/CSS/JS 代码文本、动效参数与设计方案，由用户在自己的项目里落地。',
      '素材生成（`scripts/minimax_*.py`）需要 `MINIMAX_API_KEY` 与本地 python，本项目两者都没有：改为输出素材需求清单（类型、数量、规格、提示词），由用户用自有工具生成。',
      '上游的 `canvas-fonts/`、`templates/` 与 minimax 系列参考文档已随本次导入删除，只保留动效配方、素材提示词规则与排障清单。',
    ].join('\n'),
    market: {
      title: '前端开发',
      id: '460ea0fa-6a89-4a84-932a-a7c6cc2b8517',
      canonicalName: 'frontend-dev',
      publisher: 'aliyun-1641957599603554',
      version: '0.1.1',
      category: 'Coding',
      tags: [],
      sourceUrl: null,
      license: 'MIT',
      packageVersion: '0.1.1',
      securityAudit:
        '包内无审计报告；scripts/ 是调用 minimax 开放平台的 python 脚本，需要外部 API Key，本项目不执行。',
    },
    droppedFiles: [
      'canvas-fonts/',
      'scripts/',
      'templates/',
      'references/minimax-cli-reference.md',
      'references/minimax-image-guide.md',
      'references/minimax-music-guide.md',
      'references/minimax-tts-guide.md',
      'references/minimax-video-guide.md',
      'references/minimax-voice-catalog.md',
    ],
    keptResources: [
      { from: 'references/motion-recipes.md', to: 'references/motion-recipes.md' },
      { from: 'references/troubleshooting.md', to: 'references/troubleshooting.md' },
      { from: 'references/asset-prompt-guide.md', to: 'references/asset-prompt-guide.md' },
    ],
    replacements: [
      [
        '## Invocation\n\n```\n/frontend-dev <request>\n```\n\nThe user provides their request as natural language (e.g. "build a landing page for a music streaming app").',
        '## Invocation\n\n用户用自然语言提出需求（例如"做一个音乐流媒体应用的落地页"），直接按下面的流程产出设计与代码文本。',
      ],
      [
        '## Skill Structure\n\n```\nfrontend-dev/\n├── SKILL.md                      # Core skill (this file)\n├── scripts/                      # Asset generation scripts\n│   ├── minimax_tts.py            # Text-to-speech\n│   ├── minimax_music.py          # Music generation\n│   ├── minimax_video.py          # Video generation (async)\n│   └── minimax_image.py          # Image generation\n├── references/                   # Detailed guides (read as needed)\n│   ├── minimax-cli-reference.md  # CLI flags quick reference\n│   ├── asset-prompt-guide.md     # Asset prompt engineering rules\n│   ├── minimax-tts-guide.md      # TTS usage & voices\n│   ├── minimax-music-guide.md    # Music prompts & lyrics format\n│   ├── minimax-video-guide.md    # Camera commands & models\n│   ├── minimax-image-guide.md    # Ratios & batch generation\n│   ├── minimax-voice-catalog.md  # All voice IDs\n│   ├── motion-recipes.md         # Animation code snippets\n│   ├── env-setup.md              # Environment setup\n│   └── troubleshooting.md        # Common issues\n├── templates/                    # Visual art templates\n│   ├── viewer.html               # p5.js interactive art base\n│   └── generator_template.js     # p5.js code reference\n└── canvas-fonts/                 # Static art fonts (TTF + licenses)\n```',
        '## Skill Structure\n\n```\nfrontend-dev/\n├── SKILL.md                      # 核心方法论（本文件）\n└── references/                   # 按需读取的细则\n    ├── asset-prompt-guide.md     # 素材提示词规则\n    ├── motion-recipes.md         # 动效代码配方\n    └── troubleshooting.md        # 常见问题\n```\n\n素材生成脚本、p5.js 模板与字体资源没有随本次导入保留：本项目没有 shell 也没有素材 API 密钥，素材部分只输出需求清单与提示词。',
      ],
      [
        '## 3.1 Scripts\n\n| Type | Script | Pattern |\n|------|--------|---------|\n| TTS | `scripts/minimax_tts.py` | Sync |\n| Music | `scripts/minimax_music.py` | Sync |\n| Video | `scripts/minimax_video.py` | Async (create → poll → download) |\n| Image | `scripts/minimax_image.py` | Sync |\n\nEnv: `MINIMAX_API_KEY` (required).',
        '## 3.1 素材类型与规格\n\n| Type | 规格 | 备注 |\n|------|--------|------|\n| TTS | 旁白配音 | 本项目只给文案与语速/情绪参数 |\n| Music | 背景音乐 | 本项目只给曲风与结构标签 |\n| Video | 主视觉视频 | 本项目只给分镜与运镜参数 |\n| Image | 主视觉图 | 本项目只给构图与光影提示词 |\n\n上游用 `scripts/minimax_*.py` + `MINIMAX_API_KEY` 生成素材，本项目两者都没有，请改为输出素材需求清单交由用户生成。',
      ],
      [
        '3. **Execute:** Show prompt to user, **MUST confirm before generating**, then run script',
        '3. **Execute:** 把提示词与规格给用户确认；本项目不生成素材，交付物是提示词与规格清单',
      ],
      [
        '4. **Save:** `<project>/public/assets/{images,videos,audio}/` as `{type}-{descriptor}-{timestamp}.{ext}` — **MUST save locally**',
        '4. **Save:** 建议用户保存到 `<project>/public/assets/{images,videos,audio}/`，命名为 `{type}-{descriptor}-{timestamp}.{ext}`',
      ],
      [
        '5. **Post-process:** Images → WebP, Videos → ffmpeg compress, Audio → normalize',
        '5. **Post-process:** 由用户本地处理（Images → WebP、Videos → ffmpeg 压缩、Audio → 归一化）',
      ],
      [
        '## 3.4 Reference\n\n- `references/minimax-cli-reference.md` — CLI flags\n- `references/asset-prompt-guide.md` — Prompt rules\n- `references/minimax-voice-catalog.md` — Voice IDs\n- `references/minimax-tts-guide.md` — TTS usage\n- `references/minimax-music-guide.md` — Music generation (prompts, lyrics, structure tags)\n- `references/minimax-video-guide.md` — Camera commands\n- `references/minimax-image-guide.md` — Ratios, batch',
        '## 3.4 Reference\n\n- `references/asset-prompt-guide.md` — 素材提示词规则',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'automation-testing',
    name: 'automation-testing',
    module: 'testing',
    description:
      '自动化测试方案设计：POM、数据驱动与 BDD 的选型，测试分层与用例编写规范，以及可直接交付的测试计划组织方式。',
    whenToUse:
      '用户要求设计自动化测试方案、选择测试框架与分层方式，或需要一份可交付的测试计划与用例骨架时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 4000,
    allowedTools: ['project_read', 'project_search', 'project_map', 'workspace_read_file'],
    tags: ['origin:qoder-market', 'automation-testing', 'test-strategy'],
    grade: 'B',
    blockers: [
      '上游引用的 prompts/automation-testing.md、output-formats.md、references/、scripts/ 都没有随包提供，已把主提示词内联进正文',
    ],
    notes: [
      '本项目没有 shell、没有 CI 权限：产出是测试方案文档与测试代码文本，不能直接跑流水线。',
      '上游的 `prompts/automation-testing.md`、`output-formats.md`、`references/`、`scripts/` 未随包提供，主准则已内联进本技能正文。',
    ].join('\n'),
    market: {
      title: '自动化测试',
      id: 'official_JCQg8JQf',
      canonicalName: 'automation-testing',
      publisher: 'naodeng',
      version: '1.0.0',
      category: 'Security & Testing',
      tags: [],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit: '包内无审计报告；包内只有 SKILL.md，无脚本。',
    },
    droppedFiles: [],
    keptResources: [],
    replacements: [
      [
        '# Automation Testing (English)\n\n**中文版：** 见对应中文技能。',
        '# Automation Testing',
      ],
      [
        'If you need Excel, CSV, JSON, Word, or other supported formats, append the format request at the end and check [output-formats.md](output-formats.md).',
        '需要 Excel、CSV、JSON、Word 等其他格式时，在需求末尾直接说明目标格式。',
      ],
      [
        '1. Open `prompts/automation-testing.md` and use it as the main prompt.\n2. Add the real project context: scope, environment, constraints, risks, dependencies, and expected deliverable.',
        '1. 以本技能正文为主准则：先明确被测范围、环境、约束、风险、依赖与期望交付物。\n2. 再按用户给出的真实项目上下文展开分层与用例设计。',
      ],
      [
        '## Reference Files\n\n- `prompts/automation-testing.md`: main prompt for this skill.\n- `output-formats.md`: optional output format instructions.\n- `references/`: supporting notes loaded only when needed.\n- `scripts/`: helper scripts or converters for this skill.',
        '## 参考文件\n\n上游的提示词文件与参考目录未随包提供，方法论已内联在本技能正文里；本项目也没有可执行的转换脚本。',
      ],
      [
        '- Start from the prompt file, then add only the context that matters.',
        '- 先补齐上下文，再只展开与本次任务相关的分层与用例。',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'analytics-data-analysis',
    name: 'analytics-data-analysis',
    module: 'data',
    description:
      '数据分析与可视化最佳实践：pandas 数据处理与校验、matplotlib/seaborn 绘图规范、Jupyter 组织方式与统计口径要求。',
    whenToUse:
      '用户要求做数据分析、写 pandas 代码、设计可视化图表，或需要 notebook 结构与结果可复现性的规范时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'public',
    maxInstructionChars: 8000,
    allowedTools: [
      'project_read',
      'project_search',
      'workspace_read_file',
      'sandbox_analyze_and_aggregate',
    ],
    tags: ['origin:qoder-market', 'data-analysis', 'visualization', 'pandas'],
    grade: 'B',
    blockers: [
      '沙箱是 read-only 且无网络，装不了 pandas/matplotlib/seaborn，只有标准库可用',
    ],
    notes: [
      '沙箱能跑 python 但 read-only 且无网络：`pip install pandas` 之类的操作不可能成功，只有标准库可用。',
      '需要 pandas/matplotlib 的代码请交给用户在本地环境执行；要在沙箱里出结果，就用标准库完成同一计算，并把结论写成交付物。',
    ].join('\n'),
    market: {
      title: '分析数据分析',
      id: 'official36467869',
      canonicalName: 'analytics-data-analysis',
      publisher: 'Mindrally',
      version: '1.0.0',
      category: 'Database & Analytics',
      tags: ['qoder-vibe'],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit: '包内无审计报告；正文为纯文本规范，无脚本。',
    },
    droppedFiles: [],
    keptResources: [],
    replacements: [],
    dropSections: [],
  },
  {
    packageName: 'amap-lbs-skill',
    name: 'amap-lbs-skill',
    module: 'other',
    description:
      '高德地图综合服务：地点与周边搜索、地理编码取经纬度、步行/驾车/公交路径规划、旅游行程规划与热力图链接生成。',
    whenToUse:
      '用户要搜地点或周边、查地址经纬度、规划出行路线、安排旅游行程，或要把地理数据做成热力图链接时使用。',
    version: '2.0.0',
    risk: 'read',
    visibility: 'admin',
    maxInstructionChars: 8000,
    allowedTools: [
      'mcp__amap__maps_text_search',
      'mcp__amap__maps_geo',
      'mcp__amap__maps_weather',
      'mcp__amap__maps_direction_walking',
      'mcp__amap__maps_direction_driving',
      'mcp__amap__maps_direction_transit',
    ],
    tags: ['origin:qoder-market', 'map', 'poi', 'routing', '周边', '附近', '酒店', '美食', '景点'],
    grade: 'C',
    blockers: [
      '需要管理员在控制台启用 `amap` MCP 节点并配置 `AMAP_WEB_KEY`（高德开放平台 Web 服务类型 Key），未启用时本技能不可用',
    ],
    notes: [
      '本项目通过高德官方 MCP 节点调用，工具名带 `mcp__amap__` 前缀（如 `mcp__amap__maps_text_search`、`mcp__amap__maps_geo`、`mcp__amap__maps_direction_walking`）；上游的 node + axios 脚本在本项目不可执行，已删除。',
      '`amap` 节点默认停用，需要管理员在控制台启用并配好 `AMAP_WEB_KEY`。节点不可用时明确告诉用户"地图服务未启用"，不要编造查询结果。',
    ].join('\n'),
    market: {
      title: '高德地图综合服务技能',
      id: 'official_4S946Bk5',
      canonicalName: 'amap-lbs-skill',
      publisher: 'duxiaohuidxh',
      version: '1.0.0',
      category: 'Database & Analytics',
      tags: ['高德地图', '路径规划', 'POI搜索', 'origin:skillatlas'],
      sourceUrl:
        'https://github.com/openclaw/skills/commit/086f8c60dcd8716890c49a7883a17c4f6fc88c72',
      license: 'MIT',
      packageVersion: '2.0.0',
      securityAudit:
        '包内无审计报告；上游声明依赖 AMAP_WEBSERVICE_KEY、node 与 axios，通过脚本直连 restapi.amap.com。本项目改为走官方 MCP 节点。',
    },
    droppedFiles: ['index.js', 'scripts/', 'package.json', 'config.example.json', '_meta.json'],
    keptResources: [],
    replacements: [
      [
        '## 首次配置\n\n首次使用时需要配置高德 Web Service Key：\n\n1. 访问 [高德开放平台](https://lbs.amap.com/api/webservice/create-project-and-key) 创建应用并获取 Key\n2. 设置环境变量：`export AMAP_WEBSERVICE_KEY=your_key`\n3. 或运行时自动提示输入并保存到本地配置文件',
        '## 首次配置\n\n本项目已预置高德官方 MCP 节点（`config/mcp-servers.json` 里的 `amap`），需要管理员完成两步：\n\n1. 在[高德开放平台](https://lbs.amap.com/api/webservice/create-project-and-key)创建 **Web 服务** 类型的 Key\n2. 把 Key 填进 `.env` 的 `AMAP_WEB_KEY` 并重启，然后在控制台启用 `amap` 节点\n\n节点未启用时，本技能直接告知用户"地图服务未启用"，不要编造查询结果。',
      ],
      [
        '**前置条件：** 需要用户提供高德开放平台的 API Key。',
        '**前置条件：** 需要管理员已启用 `amap` MCP 节点（工具名 `mcp__amap__*`）。',
      ],
      [
        '#### 第二步：检查 API Key\n\n- 如果用户之前未提供过 Key，**先提示用户提供高德 API Key**，等待用户回复后再继续\n- 如果用户已提供 Key，直接使用',
        '#### 第二步：确认 MCP 节点可用\n\n- 调用 `mcp__amap__maps_geo` 前先确认节点已启用；不可用时直接说明并停止，不要退回到拼 URL 猜结果',
      ],
      [
        '**请求 Key 的回复模板：**\n\n```\n🔑 搜索「{位置}」周边的{搜索类别}需要使用高德 API，请提供你的高德开放平台 API Key。\n\n（如果还没有 Key，可以在 https://lbs.amap.com 注册并创建应用获取）\n```',
        '**节点未启用时的回复模板：**\n\n```\n🔑 地图查询需要高德 MCP 节点，当前未启用。请管理员在控制台启用 `amap` 节点（配置项 `AMAP_WEB_KEY`）。\n```',
      ],
      [
        '**执行 curl 请求：**\n\n```bash\ncurl -s "https://restapi.amap.com/v3/geocode/geo?address={位置}&output=JSON&key={用户的key}"\n```',
        '**调用方式：** 用 `mcp__amap__maps_geo`（address = 位置）拿经纬度，不要自己拼 REST URL。',
      ],
      [
        '2. 调用地理编码 API：`curl -s "https://restapi.amap.com/v3/geocode/geo?address=西直门&output=JSON&key=xxx"`',
        '2. 调用 `mcp__amap__maps_geo`（address = 西直门）',
      ],
      [
        '## 场景四：POI 详细搜索\n\n使用高德 Web 服务 API 进行更详细的 POI 搜索，支持更多参数和筛选条件。',
        '## 场景四：POI 详细搜索\n\n用 `mcp__amap__maps_text_search` 做 POI 搜索，支持关键词、城市、类型与周边半径等筛选条件。',
      ],
      [
        '## 场景五：路径规划\n\n规划不同出行方式的路线。',
        '## 场景五：路径规划\n\n用 `mcp__amap__maps_direction_walking` / `_driving` / `_transit` 规划不同出行方式的路线。',
      ],
      [
        '## 场景六：智能旅游规划\n\n自动搜索兴趣点并规划游览路线，生成地图可视化链接。',
        '## 场景六：智能旅游规划\n\n先用 `mcp__amap__maps_text_search` 找兴趣点，再用路径规划工具串成游览路线并给出可视化链接。',
      ],
      [
        '## 配置管理\n\n配置文件位于 `config.json`，包含以下内容：\n\n```json\n{\n  "webServiceKey": "your_amap_webservice_key_here"\n}\n```\n\n设置 Key 的方式：\n\n1. **环境变量**：`export AMAP_WEBSERVICE_KEY=your_key`\n2. **命令行参数**：`node index.js your_key`\n3. **自动提示**：首次运行时自动提示输入\n4. **手动编辑**：直接编辑 `config.json` 文件',
        '## 配置管理\n\nKey 只走项目根目录 `.env` 的 `AMAP_WEB_KEY`，由 `config/mcp-servers.json` 的 `amap` 节点引用。不要在任何回复、日志或交付物里回显 Key。',
      ],
      [
        '- 场景二、四、五、六需要用户提供高德 API Key，**必须先获取 Key 后再发起请求**，不能跳过',
        '- 场景二、四、五、六需要 `amap` MCP 节点已启用，**节点不可用就明说，不要跳过更不要编造结果**',
      ],
      [
        '- 请妥善保管你的 Web Service Key，不要分享给他人',
        '- Key 由管理员在 `.env` 里保管，模型与用户都不需要看到它',
      ],
    ],
    dropSections: [],
  },
  {
    packageName: 'test-browser',
    name: 'test-browser',
    module: 'testing',
    description:
      '对当前分支或 PR 影响的页面做浏览器端到端验证：定位受影响路由、逐页检查元素与交互、记录控制台错误并给出通过/失败结论。',
    whenToUse:
      '用户要求验证页面功能是否正常、排查前端回归，或对受影响的页面做端到端冒烟检查时使用。',
    version: '1.0.0',
    risk: 'read',
    visibility: 'admin',
    maxInstructionChars: 8000,
    allowedTools: [
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_navigate_back',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_fill_form',
      'mcp__playwright__browser_type',
      'mcp__playwright__browser_console_messages',
      'mcp__playwright__browser_take_screenshot',
      'mcp__playwright__browser_wait_for',
      'mcp__playwright__browser_handle_dialog',
      'mcp__playwright__browser_network_requests',
      'github_pr',
      'github_repo',
      'project_history',
      'project_search',
    ],
    tags: ['origin:qoder-market', 'browser', 'e2e', 'regression'],
    grade: 'C',
    blockers: [
      '需要管理员在本地启用 `playwright` MCP 节点；该节点只装在开发机，ECS 上不安装不启用',
      '上游依赖 `agent-browser` CLI 与 bash，本项目没有 shell，已改为 Playwright MCP 工具',
    ],
    notes: [
      '本项目没有 shell，用不了上游的 `agent-browser` CLI。浏览器操作全部走 Playwright MCP 节点（工具名 `mcp__playwright__browser_*`）。',
      '`playwright` 节点只装在开发机并默认停用，ECS 上不安装、不启用；节点不可用时说明"浏览器验证未启用"，不要伪造页面检查结果。',
      '没有 shell 就没有 `git diff`，改动范围用 `github_pr` / `github_repo` 查远端 PR，或用 `project_history` 看本地提交。',
    ].join('\n'),
    market: {
      title: '浏览器测试',
      id: 'official_dwc0n2ND',
      canonicalName: 'carmandale-test-browser',
      publisher: 'carmandale',
      version: '1.0.0',
      category: 'Security & Testing',
      tags: ['origin:modelscope'],
      sourceUrl: null,
      license: null,
      packageVersion: null,
      securityAudit:
        '包内无审计报告；上游正文依赖 agent-browser CLI 与 npm 全局安装，本项目不执行。',
    },
    droppedFiles: [],
    keptResources: [],
    replacements: [
      [
        '<command_purpose>Run end-to-end browser tests on pages affected by a PR or branch changes using agent-browser CLI.</command_purpose>',
        '<command_purpose>Run end-to-end browser tests on pages affected by a PR or branch changes, using the Playwright MCP node.</command_purpose>',
      ],
      [
        '## CRITICAL: Use agent-browser CLI Only\n\n**DO NOT use Chrome MCP tools (mcp__claude-in-chrome__*).**\n\nThis command uses the `agent-browser` CLI exclusively. The agent-browser CLI is a Bash-based tool from Vercel that runs headless Chromium. It is NOT the same as Chrome browser automation via MCP.\n\nIf you find yourself calling `mcp__claude-in-chrome__*` tools, STOP. Use `agent-browser` Bash commands instead.',
        '## CRITICAL: Use the Playwright MCP node only\n\n**DO NOT try to run shell commands** — this project has no shell.\n\nBrowser work goes through the `playwright` MCP node, whose tools are exposed as `mcp__playwright__browser_*`. The node is disabled by default and only runs on the developer machine.',
      ],
      [
        '<requirements>\n- Local development server running (e.g., `bin/dev`, `rails server`, `npm run dev`)\n- agent-browser CLI installed (see Setup below)\n- Git repository with changes to test\n</requirements>',
        '<requirements>\n- Local development server running (e.g., `bin/dev`, `rails server`, `npm run dev`)\n- `playwright` MCP node enabled on this machine\n- A git repository with changes to test\n</requirements>',
      ],
      [
        '## Setup\n\n**Check installation:**\n```bash\ncommand -v agent-browser >/dev/null 2>&1 && echo "Installed" || echo "NOT INSTALLED"\n```\n\n**Install if needed:**\n```bash\nnpm install -g agent-browser\nagent-browser install  # Downloads Chromium (~160MB)\n```\n\nSee the `agent-browser` skill for detailed usage.',
        '## Setup\n\nThe `playwright` MCP node is preconfigured in `config/mcp-servers.json` (stdio, `npx -y @playwright/mcp@0.0.85`). It ships disabled; an administrator enables it in the console. Chromium must be installed once on the machine (`npx playwright install chromium`).\n\nIf the node is not available, say so and stop — never fabricate page results.',
      ],
      [
        '### 0. Verify agent-browser Installation\n\nBefore starting ANY browser testing, verify agent-browser is installed:\n\n```bash\ncommand -v agent-browser >/dev/null 2>&1 && echo "Ready" || (echo "Installing..." && npm install -g agent-browser && agent-browser install)\n```\n\nIf installation fails, inform the user and stop.',
        '### 0. Verify the browser node\n\nBefore starting ANY browser testing, confirm the `mcp__playwright__browser_*` tools are available. If they are not, inform the user and stop.',
      ],
      [
        '### 1. Ask Browser Mode\n\n<ask_browser_mode>\n\nBefore starting tests, ask user if they want to watch the browser:\n\nUse AskUserQuestion with:\n- Question: "Do you want to watch the browser tests run?"\n- Options:\n  1. **Headed (watch)** - Opens visible browser window so you can see tests run\n  2. **Headless (faster)** - Runs in background, faster but invisible\n\nStore the choice and use `--headed` flag when user selects "Headed".\n\n</ask_browser_mode>',
        '### 1. Headless only\n\n<ask_browser_mode>\n\nThe node runs headless and isolated; there is no headed mode to switch to. Skip the mode question and say that the run is headless.\n\n</ask_browser_mode>',
      ],
      [
        '**If PR number provided:**\n```bash\ngh pr view [number] --json files -q \'.files[].path\'\n```\n\n**If \'current\' or empty:**\n```bash\ngit diff --name-only main...HEAD\n```\n\n**If branch name provided:**\n```bash\ngit diff --name-only main...[branch]\n```',
        '**If PR number provided:** call `github_pr` with that number and list the changed files.\n\n**If \'current\' or empty:** use `project_history` on the current branch, or `github_pr` for the open PR of the repo.\n\n**If branch name provided:** use `github_repo` / `github_pr` for that branch.\n\nThere is no shell, so `git diff` is not available.',
      ],
      [
        '**Step 1: Navigate and capture snapshot**\n```bash\nagent-browser open "http://localhost:3000/[route]"\nagent-browser snapshot -i\n```\n\n**Step 2: For headed mode (visual debugging)**\n```bash\nagent-browser --headed open "http://localhost:3000/[route]"\nagent-browser --headed snapshot -i\n```',
        '**Step 1: Navigate and capture snapshot**\n```\nmcp__playwright__browser_navigate(url="http://localhost:3000/[route]")\nmcp__playwright__browser_snapshot()\n```\n\n**Step 2: Re-check after interaction**\n```\nmcp__playwright__browser_snapshot()\n```',
      ],
      [
        '**Step 3: Verify key elements**\n- Use `agent-browser snapshot -i` to get interactive elements with refs',
        '**Step 3: Verify key elements**\n- Use `mcp__playwright__browser_snapshot()` to get interactive elements with refs',
      ],
      [
        '**Step 4: Test critical interactions**\n```bash\nagent-browser click @e1  # Use ref from snapshot\nagent-browser snapshot -i\n```',
        '**Step 4: Test critical interactions**\n```\nmcp__playwright__browser_click(ref="<ref from snapshot>")\nmcp__playwright__browser_snapshot()\n```',
      ],
      [
        '**Step 5: Take screenshots**\n```bash\nagent-browser screenshot page-name.png\nagent-browser screenshot --full page-name-full.png  # Full page\n```',
        '**Step 5: Take screenshots**\n```\nmcp__playwright__browser_take_screenshot(filename="page-name.png", fullPage=true)\n```',
      ],
      [
        '1. **Document the failure:**\n   - Screenshot the error state: `agent-browser screenshot error.png`\n   - Note the exact reproduction steps',
        '1. **Document the failure:**\n   - Screenshot the error state: `mcp__playwright__browser_take_screenshot(filename="error.png")`\n   - Note the exact reproduction steps',
      ],
      [
        '4. **If "Create todo":**\n   - Create `{id}-pending-p1-browser-test-{description}.md`\n   - Continue testing',
        '4. **If "Create todo":**\n   - Record the follow-up item in the test summary table\n   - Continue testing',
      ],
      [
        '## Quick Usage Examples\n\n```bash\n# Test current branch changes\n/prompts:test-browser\n\n# Test specific PR\n/prompts:test-browser 847\n\n# Test specific branch\n/prompts:test-browser feature/new-dashboard\n```',
        '## Quick Usage Examples\n\n```\n# Test current branch changes\n测试当前分支改动的页面\n\n# Test specific PR\n对 PR 847 的改动页面做浏览器验证\n\n# Test specific branch\n验证 feature/new-dashboard 分支影响的页面\n```',
      ],
      [
        '## agent-browser CLI Reference\n\n**ALWAYS use these Bash commands. NEVER use mcp__claude-in-chrome__* tools.**\n\n```bash\n# Navigation\nagent-browser open <url>           # Navigate to URL\nagent-browser back                 # Go back\nagent-browser close                # Close browser\n\n# Snapshots (get element refs)\nagent-browser snapshot -i          # Interactive elements with refs (@e1, @e2, etc.)\nagent-browser snapshot -i --json   # JSON output\n\n# Interactions (use refs from snapshot)\nagent-browser click @e1            # Click element\nagent-browser fill @e1 "text"      # Fill input\nagent-browser type @e1 "text"      # Type without clearing\nagent-browser press Enter          # Press key\n\n# Screenshots\nagent-browser screenshot out.png       # Viewport screenshot\nagent-browser screenshot --full out.png # Full page screenshot\n\n# Headed mode (visible browser)\nagent-browser --headed open <url>      # Open with visible browser\nagent-browser --headed click @e1       # Click in visible browser\n\n# Wait\nagent-browser wait @e1             # Wait for element\nagent-browser wait 2000            # Wait milliseconds\n```',
        '## Playwright MCP tool reference\n\n**Only use these tools. There is no shell in this project.**\n\n```\n# Navigation\nmcp__playwright__browser_navigate(url=...)        # Navigate to URL\nmcp__playwright__browser_navigate_back()          # Go back\nmcp__playwright__browser_close()                  # Close browser\n\n# Snapshots (get element refs)\nmcp__playwright__browser_snapshot()               # Interactive elements with refs\n\n# Interactions (use refs from snapshot)\nmcp__playwright__browser_click(ref=...)             # Click element\nmcp__playwright__browser_fill_form(ref=..., text=...)\nmcp__playwright__browser_type(ref=..., text=...)\nmcp__playwright__browser_press_key(key=...)\nmcp__playwright__browser_wait_for(...)\n\n# Diagnostics\nmcp__playwright__browser_console_messages()      # Console errors\nmcp__playwright__browser_network_requests()      # Network calls\nmcp__playwright__browser_take_screenshot(filename=..., fullPage=true)\n```',
      ],
    ],
    dropSections: [],
  },
];

/* ------------------------------------------------------------------ */
/* 转换实现                                                            */
/* ------------------------------------------------------------------ */

interface Section {
  level: number;
  title: string;
  text: string;
}

function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/gu, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const end = normalized.indexOf('\n---\n', 3);
  if (end < 0) return normalized;
  return normalized.slice(end + 5);
}

function applyReplacements(body: string, replacements: Array<[string, string]>): string {
  let result = body;
  for (const [from, to] of replacements) {
    if (!result.includes(from)) {
      throw new Error(`替换目标不存在：\n${from.slice(0, 120)}`);
    }
    result = result.replace(from, () => to);
  }
  return result;
}

function applyDropSections(body: string, titles: string[]): string {
  let lines = body.split('\n');
  for (const title of titles) {
    const index = lines.findIndex((line) => {
      const match = /^(#{1,6})\s+(.*)$/u.exec(line);
      return match ? match[2]?.trim() === title : false;
    });
    if (index < 0) throw new Error(`要删除的章节不存在：${title}`);
    const heading = /^(#{1,6})\s/u.exec(lines[index] ?? '');
    const level = heading ? heading[0].length : 1;
    let end = index + 1;
    while (end < lines.length) {
      const match = /^(#{1,6})\s/u.exec(lines[end] ?? '');
      if (match && match[0].length <= level) break;
      end += 1;
    }
    lines = [...lines.slice(0, index), ...lines.slice(end)];
  }
  return lines.join('\n');
}

/** 拆成章节单元：一级与二级标题各起一个单元，三级及以下并入所属单元。 */
function splitSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split('\n');
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/u.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,2})\s+(.*)$/u.exec(line);
    if (match) {
      current = { level: match[1]?.length ?? 1, title: match[2]?.trim() ?? '', text: `${line}\n` };
      sections.push(current);
      continue;
    }
    if (current) current.text += `${line}\n`;
    else preamble.push(line);
  }
  return { preamble: preamble.join('\n'), sections };
}

function slugify(title: string, index: number): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return ascii.length > 0 ? ascii.slice(0, 40) : `part-${String(index).padStart(2, '0')}`;
}

/**
 * 正文超过注入上限时：主文件保留开头若干章节，其余章节拆到 references/，
 * 主文件末尾给出 references 索引。
 */
function composeBody(
  body: string,
  notes: string,
  cap: number,
  skillName: string,
): { main: string; refs: Array<{ path: string; title: string; content: string }> } {
  const notesBlock = `## 本项目适配说明\n\n${notes}`;
  const { preamble, sections } = splitSections(body);
  const budget = Math.max(1200, cap - notesBlock.length - 400);

  // 一级标题（技能名）放在最前，适配说明紧随其后，避免正文开头出现无标题的说明段。
  const title = sections[0]?.level === 1 ? sections.shift() : null;
  const head = title ? title.text.trimEnd() : preamble.trim();
  const parts: string[] = [head, notesBlock];

  const remaining: Section[] = [];
  let length = parts.join('\n\n').length;
  for (const section of sections) {
    if (remaining.length === 0 && length + section.text.length <= budget) {
      parts.push(section.text.trimEnd());
      length += section.text.length + 2;
    } else {
      remaining.push(section);
    }
  }

  let main = parts.filter((part) => part.length > 0).join('\n\n');
  if (remaining.length === 0) {
    return { main, refs: [] };
  }

  const refs: Array<{ path: string; title: string; content: string }> = [];
  let group: Section[] = [];
  let groupLength = 0;
  const flush = () => {
    if (group.length === 0) return;
    const index = refs.length + 1;
    const first = group[0];
    const path = `references/${String(index).padStart(2, '0')}-${slugify(first?.title ?? '', index)}.md`;
    const content = group.map((item) => item.text).join('\n').trimEnd();
    refs.push({ path, title: group.map((item) => item.title).join(' / '), content });
    group = [];
    groupLength = 0;
  };
  for (const section of remaining) {
    if (groupLength > 0 && groupLength + section.text.length > cap) flush();
    group.push(section);
    groupLength += section.text.length;
  }
  flush();

  const indexLines = refs.map(
    (ref) => `- \`${ref.path}\` — ${ref.title}`,
  );
  main += `\n\n## 详细章节\n\n正文其余章节已按文件拆分，需要细节时用 skill_read 读取对应文件（示例：\`skill_read(name="${skillName}", path="references/01-x.md")\`）：\n\n${indexLines.join('\n')}`;
  return { main, refs };
}

function renderFrontmatter(spec: SkillSpec): string {
  const lines = [
    '---',
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    `version: ${spec.version}`,
    `when_to_use: ${spec.whenToUse}`,
    'tags:',
    ...spec.tags.map((tag) => `  - ${tag}`),
    'allowed_tools:',
    ...spec.allowedTools.map((tool) => `  - ${tool}`),
    `risk: ${spec.risk}`,
    `visibility: ${spec.visibility}`,
    `max_instruction_chars: ${spec.maxInstructionChars}`,
    '---',
  ];
  return lines.join('\n');
}

function renderImportDoc(spec: SkillSpec, importedAt: string, changes: string[]): string {
  const m = spec.market;
  const rows = [
    ['市场名称', m.title],
    ['canonicalName', m.canonicalName],
    ['市场 id', m.id],
    ['市场 version', m.version],
    ['包内 version', m.packageVersion ?? '未随包提供'],
    ['publisher', m.publisher],
    ['市场分类', m.category],
    ['上游 source_url', m.sourceUrl ?? '未随包提供'],
    ['license', m.license ?? '未随包提供'],
    ['security_audit', m.securityAudit],
    ['importedAt', importedAt],
    ['可用度分级', spec.grade],
    ['目标模块', spec.module],
    ['风险等级', spec.risk],
    ['可见性', spec.visibility],
  ];
  const table = rows.map(([key, value]) => `| ${key} | ${value} |`).join('\n');
  const blockers =
    spec.blockers.length > 0
      ? spec.blockers.map((item) => `- ${item}`).join('\n')
      : '- 无';
  return [
    `# 导入记录：${spec.name}`,
    '',
    '| 字段 | 值 |',
    '| --- | --- |',
    table,
    '',
    '## 转换改动',
    '',
    ...changes.map((item) => `- ${item}`),
    '',
    '## 阻塞点',
    '',
    blockers,
    '',
    '## 来源说明',
    '',
    '本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。',
    '市场安装凭证（installRef）不落盘。',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

interface Converted {
  spec: SkillSpec;
  skillMd: string;
  importDoc: string;
  refs: Array<{ path: string; content: string }>;
  changes: string[];
}

async function convert(spec: SkillSpec, importedAt: string): Promise<Converted> {
  const sourceDir = path.join(SOURCE_ROOT, spec.packageName);
  const raw = await readFile(path.join(sourceDir, 'SKILL.md'), 'utf8');
  let body = stripFrontmatter(raw);

  body = applyReplacements(body, spec.replacements);
  body = applyDropSections(body, spec.dropSections);

  const { main, refs } = composeBody(body, spec.notes, spec.maxInstructionChars, spec.name);
  const skillMd = `${renderFrontmatter(spec)}\n\n${main}\n`;

  const changes = [
    `description：重写为 ${spec.description.length} 字符（上限 160）`,
    `when_to_use：上游全部缺失，按需补写为 ${spec.whenToUse.length} 字符（上限 200）`,
    `version：取${spec.market.packageVersion ? '包内版本' : '市场版本'} ${spec.version}（市场版本 ${spec.market.version}）`,
    `allowed_tools：按本项目真实工具名映射，共 ${spec.allowedTools.length} 个`,
    `risk=${spec.risk}，visibility=${spec.visibility}，max_instruction_chars=${spec.maxInstructionChars}`,
    spec.replacements.length > 0
      ? `正文替换 ${spec.replacements.length} 处（上游引用的不可用工具、缺失文件与商业定价内容）`
      : '正文未做替换',
    spec.dropSections.length > 0 ? `删除章节：${spec.dropSections.join('、')}` : '未删除章节',
    refs.length > 0
      ? `正文超上限，按章节拆出 ${refs.length} 个 references 文件`
      : '正文未超上限，未拆分',
    spec.keptResources.length > 0
      ? `保留资源：${spec.keptResources.map((item) => item.to).join('、')}`
      : '未保留资源',
    spec.droppedFiles.length > 0
      ? `未导入：${spec.droppedFiles.join('、')}`
      : '无丢弃文件',
  ];

  return {
    spec,
    skillMd,
    importDoc: renderImportDoc(spec, importedAt, changes),
    refs: refs.map((ref) => ({ path: ref.path, content: ref.content })),
    changes,
  };
}

async function writeSkill(converted: Converted): Promise<void> {
  const { spec } = converted;
  const targetDir = path.join(TARGET_ROOT, spec.module, spec.name);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  await writeFile(path.join(targetDir, 'SKILL.md'), converted.skillMd, 'utf8');
  await writeFile(path.join(targetDir, 'IMPORT.md'), converted.importDoc, 'utf8');

  for (const ref of converted.refs) {
    const refPath = path.join(targetDir, ref.path);
    await mkdir(path.dirname(refPath), { recursive: true });
    await writeFile(refPath, ref.content, 'utf8');
  }

  for (const resource of spec.keptResources) {
    const from = path.join(SOURCE_ROOT, spec.packageName, resource.from);
    const to = path.join(targetDir, resource.to);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, await readFile(from, 'utf8'), 'utf8');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
  const importedAt = new Date().toISOString().slice(0, 10);

  const specs = only
    ? CURATION.filter((spec) => spec.name === only || spec.packageName === only)
    : CURATION;
  if (specs.length === 0) {
    throw new Error(`没有匹配的技能：${only}`);
  }

  const failures: string[] = [];
  for (const spec of specs) {
    try {
      const converted = await convert(spec, importedAt);
      const parsed = parseSkillMarkdown(converted.skillMd, spec.name);
      if (parsed.frontmatter.name !== spec.name) {
        throw new Error('frontmatter name 与预期不一致');
      }
      const bytes = Buffer.byteLength(converted.skillMd, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(`SKILL.md 超过 ${MAX_FILE_BYTES} 字节：${bytes}`);
      }
      if (!dryRun) await writeSkill(converted);
      console.log(
        `[ok] ${spec.module}/${spec.name}  正文字符=${parsed.body.length}  文件字节=${bytes}  references=${converted.refs.length}${dryRun ? '  (dry-run)' : ''}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${spec.name}: ${message}`);
      console.error(`[fail] ${spec.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 个技能转换失败`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n完成：${specs.length} 个技能${dryRun ? '（未落盘）' : ''}`);
}

await main();
