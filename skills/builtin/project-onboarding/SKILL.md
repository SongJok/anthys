---
name: project-onboarding
description: 带新人快速读懂一个已登记项目，给出阅读顺序、模块地图和上手任务
version: 1.0.0
when_to_use: 当用户问“从哪开始读”“怎么上手这个项目”“新人应该先看什么”时
tags:
  - onboarding
  - 新人上手
  - 项目
  - 学习路径
allowed_tools:
  - project_list
  - project_handbook
  - project_map
  - project_read
  - project_search
risk: read
visibility: public
max_instruction_chars: 4000
---

# 项目新人上手

## 适用场景

新成员需要快速理解项目结构、运行方式、核心流程和下一步任务。

## 步骤

1. 调用 `project_list` 确认项目，记录当前快照 commit 和最后同步时间；快照过旧时提醒管理员同步。
2. 调用 `project_handbook` 读取 `overview`、`architecture` 和 `deploy` 章节；没有手册时说明“手册未发布”。
3. 调用 `project_map` 找到入口文件、配置目录、核心模块和测试目录。
4. 用 `project_read` 读取入口文件、README、启动脚本和一份代表性测试，形成“启动 → 请求 → 核心逻辑 → 数据”的最小路径。
5. 输出三部分：项目一句话定位、建议阅读顺序（文件 + 行号）、第一个可完成的小任务。
6. 如果用户说明了角色（前端/后端/测试/运维），按角色调整阅读顺序。

## 约束

- 必须给出具体的 `path:startLine-endLine @ commit`，不要只给目录名。
- 明确区分“仓库事实”和“团队约定”；团队约定优先引用手册人工条目。
- 不执行构建或脚本，不修改仓库；需要运行时信息时建议用户运行并反馈。
