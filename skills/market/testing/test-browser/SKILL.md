---
name: test-browser
description: 对当前分支或 PR 影响的页面做浏览器端到端验证：定位受影响路由、逐页检查元素与交互、记录控制台错误并给出通过/失败结论。
version: 1.0.0
when_to_use: 用户要求验证页面功能是否正常、排查前端回归，或对受影响的页面做端到端冒烟检查时使用。
tags:
  - origin:qoder-market
  - browser
  - e2e
  - regression
allowed_tools:
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_navigate_back
  - mcp__playwright__browser_snapshot
  - mcp__playwright__browser_click
  - mcp__playwright__browser_fill_form
  - mcp__playwright__browser_type
  - mcp__playwright__browser_console_messages
  - mcp__playwright__browser_take_screenshot
  - mcp__playwright__browser_wait_for
  - mcp__playwright__browser_handle_dialog
  - mcp__playwright__browser_network_requests
  - github_pr
  - github_repo
  - project_history
  - project_search
risk: read
visibility: admin
max_instruction_chars: 8000
---

## 本项目适配说明

本项目没有 shell，用不了上游的 `agent-browser` CLI。浏览器操作全部走 Playwright MCP 节点（工具名 `mcp__playwright__browser_*`）。
`playwright` 节点只装在开发机并默认停用，ECS 上不安装、不启用；节点不可用时说明"浏览器验证未启用"，不要伪造页面检查结果。
没有 shell 就没有 `git diff`，改动范围用 `github_pr` / `github_repo` 查远端 PR，或用 `project_history` 看本地提交。

## Arguments
[PR number, branch name, or 'current' for current branch]

# Browser Test Command

<command_purpose>Run end-to-end browser tests on pages affected by a PR or branch changes, using the Playwright MCP node.</command_purpose>

## CRITICAL: Use the Playwright MCP node only

**DO NOT try to run shell commands** — this project has no shell.

Browser work goes through the `playwright` MCP node, whose tools are exposed as `mcp__playwright__browser_*`. The node is disabled by default and only runs on the developer machine.

## Introduction

<role>QA Engineer specializing in browser-based end-to-end testing</role>

This command tests affected pages in a real browser, catching issues that unit tests miss:
- JavaScript integration bugs
- CSS/layout regressions
- User workflow breakages
- Console errors

## Prerequisites

<requirements>
- Local development server running (e.g., `bin/dev`, `rails server`, `npm run dev`)
- `playwright` MCP node enabled on this machine
- A git repository with changes to test
</requirements>

## Setup

The `playwright` MCP node is preconfigured in `config/mcp-servers.json` (stdio, `npx -y @playwright/mcp@0.0.85`). It ships disabled; an administrator enables it in the console. Chromium must be installed once on the machine (`npx playwright install chromium`).

If the node is not available, say so and stop — never fabricate page results.

## Main Tasks

### 0. Verify the browser node

Before starting ANY browser testing, confirm the `mcp__playwright__browser_*` tools are available. If they are not, inform the user and stop.

### 1. Headless only

<ask_browser_mode>

The node runs headless and isolated; there is no headed mode to switch to. Skip the mode question and say that the run is headless.

</ask_browser_mode>

### 2. Determine Test Scope

<test_target> $ARGUMENTS </test_target>

<determine_scope>

**If PR number provided:** call `github_pr` with that number and list the changed files.

**If 'current' or empty:** use `project_history` on the current branch, or `github_pr` for the open PR of the repo.

**If branch name provided:** use `github_repo` / `github_pr` for that branch.

There is no shell, so `git diff` is not available.

</determine_scope>

### 3. Map Files to Routes

<file_to_route_mapping>

Map changed files to testable routes:

| File Pattern | Route(s) |
|-------------|----------|
| `app/views/users/*` | `/prompts:users`, `/users/:id`, `/users/new` |
| `app/controllers/settings_controller.rb` | `/prompts:settings` |
| `app/javascript/controllers/*_controller.js` | Pages using that Stimulus controller |
| `app/components/*_component.rb` | Pages rendering that component |
| `app/views/layouts/*` | All pages (test homepage at minimum) |
| `app/assets/stylesheets/*` | Visual regression on key pages |
| `app/helpers/*_helper.rb` | Pages using that helper |
| `src/app/*` (Next.js) | Corresponding routes |
| `src/components/*` | Pages using those components |

Build a list of URLs to test based on the mapping.

</file_to_route_mapping>

### 4. Verify Server is Running

<check_server>

Before testing, verify the local server is accessible:

```bash
agent-browser open http://prompts:localhost-3000
agent-browser snapshot -i
```

If server is not running, inform user:
```markdown
**Server not running**

Please start your development server:
- Rails: `bin/dev` or `rails server`
- Node/Next.js: `npm run dev`

Then run `/prompts:test-browser` again.
```

</check_server>

### 5. Test Each Affected Page

<test_pages>

For each affected route, use agent-browser CLI commands (NOT Chrome MCP):

**Step 1: Navigate and capture snapshot**
```
mcp__playwright__browser_navigate(url="http://localhost:3000/[route]")
mcp__playwright__browser_snapshot()
```

**Step 2: Re-check after interaction**
```
mcp__playwright__browser_snapshot()
```

**Step 3: Verify key elements**
- Use `mcp__playwright__browser_snapshot()` to get interactive elements with refs
- Page title/heading present
- Primary content rendered
- No error messages visible
- Forms have expected fields

**Step 4: Test critical interactions**
```
mcp__playwright__browser_click(ref="<ref from snapshot>")
mcp__playwright__browser_snapshot()
```

**Step 5: Take screenshots**
```
mcp__playwright__browser_take_screenshot(filename="page-name.png", fullPage=true)
```

</test_pages>

### 6. Human Verification (When Required)

<human_verification>

Pause for human input when testing touches:

| Flow Type | What to Ask |
|-----------|-------------|
| OAuth | "Please sign in with [provider] and confirm it works" |
| Email | "Check your inbox for the test email and confirm receipt" |
| Payments | "Complete a test purchase in sandbox mode" |
| SMS | "Verify you received the SMS code" |
| External APIs | "Confirm the [service] integration is working" |

Use AskUserQuestion:
```markdown
**Human Verification Needed**

This test touches the [flow type]. Please:
1. [Action to take]
2. [What to verify]

Did it work correctly?
1. Yes - continue testing
2. No - describe the issue
```

</human_verification>

### 7. Handle Failures

<failure_handling>

When a test fails:

1. **Document the failure:**
   - Screenshot the error state: `mcp__playwright__browser_take_screenshot(filename="error.png")`
   - Note the exact reproduction steps

2. **Ask user how to proceed:**
   ```markdown
   **Test Failed: [route]**

   Issue: [description]
   Console errors: [if any]

   How to proceed?
   1. Fix now - I'll help debug and fix
   2. Create todo - Add to todos/ for later
   3. Skip - Continue testing other pages
   ```

3. **If "Fix now":**
   - Investigate the issue
   - Propose a fix
   - Apply fix
   - Re-run the failing test

4. **If "Create todo":**
   - Record the follow-up item in the test summary table
   - Continue testing

5. **If "Skip":**
   - Log as skipped
   - Continue testing

</failure_handling>

### 8. Test Summary

<test_summary>

After all tests complete, present summary:

```markdown
## Browser Test Results

**Test Scope:** PR #[number] / [branch name]
**Server:** http://prompts:localhost-3000

### Pages Tested: [count]

| Route | Status | Notes |
|-------|--------|-------|
| `/prompts:users` | Pass | |
| `/prompts:settings` | Pass | |
| `/prompts:dashboard` | Fail | Console error: [msg] |
| `/prompts:checkout` | Skip | Requires payment credentials |

### Console Errors: [count]
- [List any errors found]

### Human Verifications: [count]
- OAuth flow: Confirmed
- Email delivery: Confirmed

### Failures: [count]
- `/prompts:dashboard` - [issue description]

### Created Todos: [count]
- `005-pending-p1-browser-test-dashboard-error.md`

### Result: [PASS / FAIL / PARTIAL]
```

</test_summary>

## Quick Usage Examples

```
# Test current branch changes
测试当前分支改动的页面

# Test specific PR
对 PR 847 的改动页面做浏览器验证

# Test specific branch
验证 feature/new-dashboard 分支影响的页面
```

## 详细章节

正文其余章节已按文件拆分，需要细节时用 skill_read 读取对应文件（示例：`skill_read(name="test-browser", path="references/01-x.md")`）：

- `references/01-playwright-mcp-tool-reference.md` — Playwright MCP tool reference
