---
name: production-code-audit
description: 逐行扫描整个代码库，找出安全、性能、架构、可靠性与可维护性缺陷，按优先级排序并产出企业级生产就绪审计报告与整改清单。
version: 1.0.1
when_to_use: 用户要求做生产级代码审计、上线前质量体检、生成整改清单，或排查安全与性能隐患时使用。
tags:
  - origin:qoder-market
  - code-audit
  - production-readiness
  - security
allowed_tools:
  - project_read
  - project_search
  - project_map
  - project_symbol
  - workspace_read_file
risk: read
visibility: public
max_instruction_chars: 8000
---

# Production Code Audit

## 本项目适配说明

本项目没有 shell，也不能改宿主机文件：上游流程里的"运行命令/安装依赖/直接改文件"改为输出命令清单与补丁建议，由用户执行。
扫描范围用 `project_map` + `project_search` + `project_read` 获取，报告里的每条结论都要带真实的文件路径与行号。

## Overview

Autonomously analyze the entire codebase to understand its architecture, patterns, and purpose, then systematically transform it into production-grade, corporate-level professional code. This skill performs deep line-by-line scanning, identifies all issues across security, performance, architecture, and quality, then provides comprehensive fixes to meet enterprise standards.

## When to Use This Skill

- Use when user says "make this production-ready"
- Use when user says "audit my codebase"
- Use when user says "make this professional/corporate-level"
- Use when user says "optimize everything"
- Use when user wants enterprise-grade quality
- Use when preparing for production deployment
- Use when code needs to meet corporate standards

## How It Works

### Step 1: Autonomous Codebase Discovery

**Automatically scan and understand the entire codebase:**

1. **Read all files** - Scan every file in the project recursively
2. **Identify tech stack** - Detect languages, frameworks, databases, tools
3. **Understand architecture** - Map out structure, patterns, dependencies
4. **Identify purpose** - Understand what the application does
5. **Find entry points** - Locate main files, routes, controllers
6. **Map data flow** - Understand how data moves through the system

**Do this automatically without asking the user.**

### Step 2: Comprehensive Issue Detection

**Scan line-by-line for all issues:**

**Architecture Issues:**
- Circular dependencies
- Tight coupling
- God classes (>500 lines or >20 methods)
- Missing separation of concerns
- Poor module boundaries
- Violation of design patterns

**Security Vulnerabilities:**
- SQL injection (string concatenation in queries)
- XSS vulnerabilities (unescaped output)
- Hardcoded secrets (API keys, passwords in code)
- Missing authentication/authorization
- Weak password hashing (MD5, SHA1)
- Missing input validation
- CSRF vulnerabilities
- Insecure dependencies

**Performance Problems:**
- N+1 query problems
- Missing database indexes
- Synchronous operations that should be async
- Missing caching
- Inefficient algorithms (O(n²) or worse)
- Large bundle sizes
- Unoptimized images
- Memory leaks

**Code Quality Issues:**
- High cyclomatic complexity (>10)
- Code duplication
- Magic numbers
- Poor naming conventions
- Missing error handling
- Inconsistent formatting
- Dead code
- TODO/FIXME comments

**Testing Gaps:**
- Missing tests for critical paths
- Low test coverage (<80%)
- No edge case testing
- Flaky tests
- Missing integration tests

**Production Readiness:**
- Missing environment variables
- No logging/monitoring
- No error tracking
- Missing health checks
- Incomplete documentation
- No CI/CD pipeline

### Step 3: Automatic Fixes and Optimizations

**Fix everything automatically:**

1. **Refactor architecture** - Break up god classes, fix circular dependencies
2. **Fix security issues** - Use parameterized queries, remove secrets, add validation
3. **Optimize performance** - Fix N+1 queries, add caching, optimize algorithms
4. **Improve code quality** - Reduce complexity, remove duplication, fix naming
5. **Add missing tests** - Write tests for untested critical paths
6. **Add production infrastructure** - Logging, monitoring, health checks
7. **Optimize everything** - Bundle size, images, database queries
8. **Add documentation** - README, API docs, architecture docs

### Step 4: Verify and Report

**After making all changes:**

1. Run all tests to ensure nothing broke
2. Verify all security issues are fixed
3. Measure performance improvements
4. Generate comprehensive report
5. Provide before/after metrics

## 详细章节

正文其余章节已按文件拆分，需要细节时用 skill_read 读取对应文件（示例：`skill_read(name="production-code-audit", path="references/01-x.md")`）：

- `references/01-examples.md` — Examples / Best Practices
- `references/02-autonomous-scanning-instructions.md` — Autonomous Scanning Instructions / Common Pitfalls / Production Audit Checklist / Audit Report Template / Related Skills / Additional Resources
