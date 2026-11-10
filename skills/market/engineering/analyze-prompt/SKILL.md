---
name: analyze-prompt
description: 用七级框架分析现有提示词：判定当前等级、核对缺失章节、核对命名与流程规范，并给出分级改进建议与重构版本。
version: 1.0.0
when_to_use: 用户要求分析、优化、重写提示词，或需要判断一段提示词在七级框架里处于哪一级、缺哪些章节时使用。
tags:
  - origin:qoder-market
  - prompt
  - prompt-engineering
allowed_tools:
  - project_read
  - project_search
  - workspace_read_file
risk: read
visibility: public
max_instruction_chars: 4000
---

# Analyze Prompt

Analyze existing prompt and suggest improvements.

## 本项目适配说明

本项目没有 shell，也没有 Read/Glob/Grep 工具。读取提示词文件用 `project_read`（项目仓库内）或 `workspace_read_file`（工作区）；没有文件路径时先向用户确认。
上游引用的 `@seven-levels.md`、`@prompt-sections-reference.md` 与 `/upgrade-prompt` 命令都没有随包提供，判定表已完整写在本技能正文里；应用改进建议在当前会话直接完成。

## Arguments

- `$1`: Path to prompt file

## Instructions

You are analyzing an existing prompt to classify it and suggest improvements.

### Step 1: Validate Input

If no `$1` provided, STOP and ask user for prompt file path.

### Step 2: Read the Prompt

用 `project_read` 或 `workspace_read_file` 完整读取用户指定的提示词文件（本项目没有 `$1` 位置参数，路径由用户在对话里给出）。

### Step 3: Identify Sections

Check for presence of:

- [ ] Frontmatter (metadata)
- [ ] Title
- [ ] Purpose
- [ ] Variables
- [ ] Instructions
- [ ] Workflow
- [ ] Control Flow (conditionals, loops)
- [ ] Delegation (Task tool usage)
- [ ] Template (Specified Format)
- [ ] Expertise
- [ ] Report

### Step 4: Classify Level

Based on sections and patterns:

| Indicators | Level |
| --- | --- |
| Simple prompt, no sections | 1 |
| Has Workflow section | 2+ |
| Has conditionals/loops | 3+ |
| Delegates to agents | 4+ |
| Accepts prompt as input | 5+ |
| Has Template section | 6+ |
| Has Expertise section | 7 |

### Step 5: Analyze Quality

Check:

- [ ] Variables use SCREAMING_SNAKE_CASE
- [ ] Workflow has numbered steps
- [ ] STOP conditions are explicit
- [ ] Frontmatter has description
- [ ] Purpose is clear
- [ ] Report format specified

### Step 6: Identify Improvements

Suggest:

- Missing sections for the level
- Variable naming fixes
- Workflow structure improvements
- Level upgrade opportunities

## Output

```markdown
## Prompt Analysis

**File:** [path]
**Current Level:** [1-7] ([name])

### Sections Found
- [x] Section 1
- [ ] Section 2 (missing)
...

### Quality Score
**Score:** [X/10]

| Criteria | Status |
| --- | --- |
| Variables naming | [Pass/Fail] |
| Workflow structure | [Pass/Fail] |
| STOP conditions | [Pass/Fail] |
| Frontmatter | [Pass/Fail] |
| Purpose clarity | [Pass/Fail] |

### Improvements Suggested

**High Priority:**
1. [improvement 1]
2. [improvement 2]

**Medium Priority:**
1. [improvement 3]

### Level Upgrade Opportunity

Current: Level [N]
Potential: Level [M] if [condition]

### Refactored Version (if requested)

[Improved prompt structure]
```

## Notes

- 等级判定表已完整写在「Step 4: Classify Level」，上游的 `@seven-levels.md` 未随包提供
- 必需章节清单已写在「Step 3: Identify Sections」，上游的 `@prompt-sections-reference.md` 未随包提供
- 应用改进建议在当前会话直接完成，上游的 `/upgrade-prompt` 命令不存在
