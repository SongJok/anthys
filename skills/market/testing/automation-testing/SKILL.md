---
name: automation-testing
description: 自动化测试方案设计：POM、数据驱动与 BDD 的选型，测试分层与用例编写规范，以及可直接交付的测试计划组织方式。
version: 1.0.0
when_to_use: 用户要求设计自动化测试方案、选择测试框架与分层方式，或需要一份可交付的测试计划与用例骨架时使用。
tags:
  - origin:qoder-market
  - automation-testing
  - test-strategy
allowed_tools:
  - project_read
  - project_search
  - project_map
  - workspace_read_file
risk: read
visibility: public
max_instruction_chars: 4000
---

# Automation Testing

## 本项目适配说明

本项目没有 shell、没有 CI 权限：产出是测试方案文档与测试代码文本，不能直接跑流水线。
上游的 `prompts/automation-testing.md`、`output-formats.md`、`references/`、`scripts/` 未随包提供，主准则已内联进本技能正文。

## When to Use

- Need help with automation testing in a real project context.
- Need an output that can be used directly for execution, review, or follow-up.

## Output Format Options

Markdown by default. 需要 Excel、CSV、JSON、Word 等其他格式时，在需求末尾直接说明目标格式。

## How to Use

1. 以本技能正文为主准则：先明确被测范围、环境、约束、风险、依赖与期望交付物。
2. 再按用户给出的真实项目上下文展开分层与用例设计。
3. If the input is incomplete, return a usable first version and mark missing information and assumptions.

## 参考文件

上游的提示词文件与参考目录未随包提供，方法论已内联在本技能正文里；本项目也没有可执行的转换脚本。

## Common Pitfalls

- Do not use it with vague scope and no context.
- Do not treat every area as equally important.
- Do not skip assumptions and missing information.

## Best Practices

- 先补齐上下文，再只展开与本次任务相关的分层与用例。
- Keep the output risk-driven and executable.
- If the request is incomplete, return a usable first version and mark gaps.
