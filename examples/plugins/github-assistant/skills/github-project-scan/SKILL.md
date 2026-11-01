---
name: github-project-scan
description: 调研公开 GitHub 项目并输出选型对比，覆盖活跃度、维护成本与风险
version: 1.0.0
when_to_use: 用户要求调研、对比或选型 GitHub 开源项目时
tags:
  - github
  - research
  - selection
allowed_tools:
  - project_search
  - project_read
  - project_map
risk: read
visibility: public
max_instruction_chars: 4000
---
# 公开项目调研流程

1. 明确约束：用途、许可证、语言栈、部署环境、预算、是否允许商用。
2. 对每个候选仓库收集：最近提交时间、发布节奏、issue/PR 响应、贡献者数量、测试与 CI、许可证。
3. 优先使用 GitHub MCP 的仓库与搜索工具；工具不可用时明确说明数据缺口，不要编造指标。
4. 对关键结论给出证据链接或工具返回的字段值。
5. 输出对比表：项目、许可证、活跃度、学习成本、集成成本、主要风险、结论。
6. 最后给出推荐方案与备选方案，并说明在什么条件下推荐会改变。

约束：

- 只做只读调研。
- 区分“事实”和“判断”，事实必须可追溯。
- 不评估或推荐存在明显供应链风险（无许可证、可疑安装脚本）的项目而不加提示。
