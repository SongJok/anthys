---
name: repo-review
description: 评审代码仓库或 PR 的工程健康度、架构风险、依赖与测试情况，并输出可执行结论
version: 1.0.0
when_to_use: 当用户要求看看某个开源项目、评审仓库、或询问某个 PR 有什么风险时
tags:
  - github
  - code-review
  - architecture
  - 项目
allowed_tools:
  - project_list
  - project_handbook
  - project_map
  - project_search
  - project_read
  - project_symbol
  - project_history
  - github_repo
  - github_pr
  - github_tree
  - github_file
risk: read
visibility: public
max_instruction_chars: 4000
---

# 仓库与 PR 工程评审

## 适用场景

用户要求评估一个仓库、一个 PR 或一段变更的工程风险、可维护性与上线风险。

## 步骤

1. 调用 `project_list` 确认项目是否已登记；未登记时用 `github_repo` 读取公开元数据，并说明无法做完整代码评审。
2. 调用 `project_handbook` 的 `overview`，确认项目定位、技术栈、维护状态和已知风险。
3. 调用 `project_map` 获取仓库地图，找出入口、核心模块、测试与 CI 配置。
4. 针对高风险点调用 `project_search` / `project_read` / `project_symbol` 核实，不要只凭 README 下结论。
5. 如果用户给了 PR，调用 `github_pr` 读取标题、变更范围与描述；必要时用 `project_history` 查看相关提交。
6. 输出评审表：项目定位、技术栈、活跃度、依赖风险、测试与 CI、安全注意点、结论与建议。

## 约束

- 每个结论必须带 `path:startLine-endLine @ commit` 或 GitHub URL 引用。
- 没有证据时明确写“未验证”，不要猜测；无法访问的私有仓库要直接说明。
- 不要一次读取超过 200 行；需要更多内容时分段读取。
- 只读评审：不要提交评论、修改仓库或执行仓库脚本。
