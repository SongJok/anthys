---
name: bug-review
description: 系统化缺陷排查：先识别代码语言与版本约束、规划复现方式，再逐条记录缺陷的严重度与根因，给出最小修复、测试补充和验证计划。
version: 1.0.0
when_to_use: 收到缺陷报告、发布前自查、排查潜在缺陷，或需要一份带文件行号与根因的缺陷清单时使用。
tags:
  - origin:qoder-market
  - bug-review
  - defect
  - code-quality
allowed_tools:
  - project_read
  - project_search
  - project_symbol
  - workspace_read_file
risk: read
visibility: public
max_instruction_chars: 8000
---

## 本项目适配说明

本项目没有 shell，也没有 TodoWrite 工具。上游流程里的复现命令、静态分析器与测试执行都要以命令形式交给用户执行并回贴输出。
本项目不能直接改仓库文件：第 4 步的"准备修复"产出补丁文本与测试代码，由用户落库；不要声称已经改好。
上游声明的 `defect-tracker`、`fix-generator`、`verification-runner`、`pensive:shared`、`imbue:proof-of-work`、`imbue:diff-analysis/...` 都是别的运行时的插件，本项目没有，已从流程里删除。

## Table of Contents

- [Quick Start](#quick-start)
- [When to Use](#when-to-use)
- [输出必须覆盖的五个部分](#输出必须覆盖的五个部分)
- [Progressive Loading](#progressive-loading)
- [Workflow](#workflow)
- [Step 1: Detect Languages (`bug-review:language-detected`)](#step-1:-detect-languages-(bug-review:language-detected))
- [Step 2: Plan Reproduction (`bug-review:repro-plan`)](#step-2:-plan-reproduction-(bug-review:repro-plan))
- [Step 3: Document Defects (`bug-review:defects-documented`)](#step-3:-document-defects-(bug-review:defects-documented))
- [Step 4: Prepare Fixes (`bug-review:fixes-prepared`)](#step-4:-prepare-fixes-(bug-review:fixes-prepared))
- [Step 5: Verification Plan (`bug-review:verification-plan`)](#step-5:-verification-plan-(bug-review:verification-plan))
- [Defect Classification (Condensed)](#defect-classification-(condensed))
- [Output Format](#output-format)
- [Summary](#summary)
- [Defects Found](#defects-found)
- [[D1] file.rs:142 - Title](#[d1]-filers:142---title)
- [Proposed Fixes](#proposed-fixes)
- [Fix for D1](#fix-for-d1)
- [Test Updates](#test-updates)
- [Evidence](#evidence)
- [Best Practices](#best-practices)
- [Exit Criteria](#exit-criteria)

# Bug Review Workflow

Systematic bug identification and fixing with language-specific expertise.

## Quick Start

用户说"查缺陷 / 审一下 bug"时直接进入下面的工作流，不必等待额外指令。

## When To Use

- Reviewing code for potential bugs
- After receiving bug reports
- Before major releases
- During security audits
- Investigating production issues

## When NOT To Use

- Test coverage audit - use test-review instead

## 输出必须覆盖的五个部分

1. 语言识别结果
2. 复现方式规划
3. 缺陷清单
4. 修复准备（补丁文本）
5. 验证计划

## Progressive Loading

Load additional context as needed:
- **语言识别**: `references/language-detection.md` - manifest 推断、版本约束
- **缺陷记录**: `references/defect-documentation.md` - 严重度分级、根因分类、静态分析器命令
- **修复准备**: `references/fix-preparation.md` - 最小补丁、语言惯用写法、测试补充

## Workflow

### Step 1: Detect Languages (`bug-review:language-detected`)

Identify dominant languages using manifest files (Cargo.toml → Rust, package.json → Node, etc.).

State expertise persona appropriate for the language ecosystem.

Note version constraints (MSRV, Python versions, Node engines).

**渐进加载**: 读取 `references/language-detection.md` 获取 manifest 推断细则。

### Step 2: Plan Reproduction (`bug-review:repro-plan`)

Identify reproduction methods:
- Unit/integration test suites
- Fuzzing tools
- Manual reproduction commands

Document exact commands:
```bash
cargo test -p core
pytest tests/test_api.py
npm test -- pkg
```
**Verification:** 由用户执行 `pytest -v tests/test_api.py` 并回贴输出。

Capture blockers and propose mocks when dependencies unavailable.

### Step 3: Document Defects (`bug-review:defects-documented`)

Review code line-by-line, logging each bug with:
- **File:line reference**: Precise location
- **Severity**: Critical, High, Medium, Low
- **Root cause**: Logic error, API misuse, concurrency, resource leak
- **Impact**: What breaks and how

静态分析器（`cargo clippy`、`ruff check`、`golangci-lint`、`eslint`）需要宿主 shell，本项目无法运行：请把建议命令交给用户执行并回贴输出，或改用 `project_search` 人工核对可疑写法。

**渐进加载**: 读取 `references/defect-documentation.md` 获取分级细则与分析器命令。

### Step 4: Prepare Fixes (`bug-review:fixes-prepared`)

Draft minimal, idiomatic patches using language best practices:
- Guard clauses (Rust: pattern matching, Python: early returns)
- Resource cleanup (Go: defer, Python: context managers)
- Error propagation (Rust: ?, Go: wrapped errors)

Create tests following Red → Green pattern:
1. Write failing test
2. Apply minimal fix
3. Verify test passes

**渐进加载**: 读取 `references/fix-preparation.md` 获取各语言修复模式与测试策略。

### Step 5: Verification Plan (`bug-review:verification-plan`)

Execute reproduction steps with fixes applied.

Capture evidence:
- Test output logs
- Benchmark comparisons
- Coverage reports

剩余风险按下方「Best Practices」第 5 条打分并逐条记录。

Assign owners and deadlines for follow-up items.

## Defect Classification (Condensed)

**Severity**: Critical (crash/data loss) → High (broken features) → Medium (degraded UX) → Low (edge cases)

**Root Causes**: Logic errors | API misuse | Concurrency issues | Resource leaks | Validation gaps

## Output Format

```markdown
## Summary
[Brief scope description]

## Defects Found
### [D1] file.rs:142 - Title
- Severity: High
- Root Cause: Logic error
- Impact: Data corruption possible
- Fix: [description]

## Proposed Fixes
### Fix for D1
[code diff with explanation]

## Test Updates
[new/updated tests with Red → Green verification]

## Evidence
- Commands executed
- Logs and outputs
- External references
```
**Verification:** 由用户执行 `pytest -v` 并回贴输出。

## Best Practices

1. **Evidence-based**: Every finding has file:line reference
2. **Reproducible**: Clear steps to reproduce each bug
3. **Minimal fixes**: Smallest change that fixes the issue
4. **Test coverage**: Every fix has corresponding test
5. **Risk awareness**: Document remaining risks with severity scoring

## Exit Criteria

- All defects documented with precise references
- Fixes prepared with test coverage verified
- Verification plan includes commands and expected outputs
- Remaining risks assessed and owners assigned
