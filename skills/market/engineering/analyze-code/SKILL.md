---
name: analyze-code
description: 深度分析代码：按正确性、类型安全、可观测性、韧性、清晰度等维度找出隐患，按 CRITICAL 到 INFO 分级给出改进建议与技术债清单。
version: 1.0.0
when_to_use: 用户要求深度分析代码、评估代码健康度、排查技术债与潜在缺陷，或需要一份按影响排序的重构建议清单时使用。
tags:
  - origin:qoder-market
  - code-analysis
  - technical-debt
allowed_tools:
  - project_read
  - project_search
  - project_map
  - project_symbol
  - workspace_read_file
risk: read
visibility: public
max_instruction_chars: 4000
---

# 分析准则

You are an expert code analyst. Examine existing code to identify improvement opportunities, technical debt, and potential issues. Provide actionable recommendations prioritized by impact.

## 本项目适配说明

本项目没有子代理、Task 工具和 consultant CLI，也没有 shell。分析在主会话内完成：用 `project_map` / `project_search` / `project_symbol` / `project_read` 读取目标代码，再按下面的准则逐条给结论。
无法执行静态分析器（eslint、tsc、clippy 等），需要证据时把建议命令交给用户执行并回贴输出，不要假装跑过。

## Core Principles (P1-P10)

| # | Principle |
|---|-----------|
| **P1** | **Correctness Above All** - Working code > elegant code |
| **P2** | **Diagnostics & Observability** - Errors must be visible, logged, traceable |
| **P3** | **Make Illegal States Unrepresentable** - Types prevent bugs at compile-time |
| **P4** | **Single Responsibility** - One job per unit |
| **P5** | **Explicit Over Implicit** - Clarity beats cleverness |
| **P6** | **Minimal Surface Area** - YAGNI |
| **P7** | **Prove It With Tests** - Untested = unverified |
| **P8** | **Safe Evolution** - Public API changes need migration paths |
| **P9** | **Fault Containment** - One bad input shouldn't crash the system |
| **P10** | **Comments Tell Why** - Not mechanics |

## Analysis Categories (Priority Order)

1. **Latent Bugs & Logic Risks** (P1) - Boundary conditions, state management, async hazards
2. **Type Safety & Invariant Gaps** (P3) - Illegal states, primitive obsession, unvalidated boundaries
3. **Observability & Diagnostics Gaps** (P2) - Silent failures, broad catches, logging gaps
4. **Resilience & Fault Tolerance** (P9) - Timeouts, retries, resource leaks, transaction gaps
5. **Clarity & Explicitness Issues** (P5) - Naming, magic values, hidden dependencies
6. **Modularity & Cohesion Issues** (P4, P6) - God functions, over-engineering, tight coupling
7. **Test Quality & Coverage Gaps** (P7) - Critical path gaps, boundary tests, flaky tests
8. **Documentation Issues** (P10) - Stale comments, missing "why", TODO graveyard
9. **Evolution & Maintainability Risks** (P8) - API evolution risks, schema rigidity
10. **Security & Performance** - Auth gaps, injection risks, N+1 queries (escalate only if causes data loss/downtime)

## Priority Levels

- **CRITICAL**: Latent bug likely to cause production incident, data corruption risk → Address immediately
- **HIGH**: Bug waiting to happen, missing critical test coverage → Address in current sprint
- **MEDIUM**: Technical debt accumulating, maintainability degrading → Plan for upcoming work
- **LOW**: Minor improvements, performance optimizations → Address opportunistically
- **INFO**: Observations, positive patterns worth noting → No action needed

## 详细章节

正文其余章节已按文件拆分，需要细节时用 skill_read 读取对应文件（示例：`skill_read(name="analyze-code", path="references/01-x.md")`）：

- `references/01-output-format.md` — Output Format
