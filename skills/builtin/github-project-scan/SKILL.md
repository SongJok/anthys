---
name: github-project-scan
description: 扫描公开 GitHub 仓库的元数据、目录结构和关键文件，用于技术选型与快速评估
version: 1.0.0
when_to_use: 当用户想了解一个公开 GitHub 项目、比较技术方案或评估是否值得引入时
tags:
  - github
  - 技术选型
  - 开源
allowed_tools:
  - github_repo
  - github_tree
  - github_file
risk: read
visibility: public
max_instruction_chars: 4000
---

# 公开 GitHub 项目扫描

## 适用场景

用户给出一个公开 GitHub 仓库，想快速了解它是什么、是否活跃、是否适合引入。

## 步骤

1. 从用户输入解析 `owner/repo` 或 GitHub URL；不明确时先确认。
2. 调用 `github_repo` 获取描述、默认分支、语言、Star、更新时间、Topics。
3. 调用 `github_tree` 查看顶层目录，重点找 `src/`、`packages/`、`docs/`、`tests/`、CI 配置和依赖清单。
4. 按需调用 `github_file` 读取 README、依赖清单（package.json / pyproject.toml / go.mod）、入口文件和 CI 配置。
5. 输出：项目定位、技术栈、活跃度、目录结构、依赖与构建方式、测试与发布、风险与替代方案。

## 约束

- 只访问公开仓库；遇到 404 或限流要如实说明，不要编造内容。
- 引用 GitHub 文件时给 `owner/repo/path@ref` 或可访问 URL。
- 不克隆、不执行仓库代码；不安装依赖。
- README 可能是营销内容，结论要尽量用目录、配置和代码佐证。
