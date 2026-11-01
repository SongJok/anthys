---
name: handbook-maintainer
description: 根据代码事实和人工条目起草或更新项目手册章节，输出可发布的 Markdown 草案
version: 1.0.0
when_to_use: 当管理员要求更新项目手册、补充架构说明、整理部署步骤或核对手册与代码时
tags:
  - handbook
  - 文档维护
  - 项目
allowed_tools:
  - project_list
  - project_handbook
  - project_map
  - project_search
  - project_read
risk: read
visibility: admin
max_instruction_chars: 4000
---

# 项目手册维护

## 适用场景

管理员需要新建或更新项目手册章节，或核对现有章节是否仍与代码一致。

## 步骤

1. 调用 `project_list` 确认项目和当前 commit；记录 `handbookVersion` 与 `stale` 状态。
2. 调用 `project_handbook` 读取现有章节和人工条目，先判断哪些内容是“人工维护不可覆盖”的。
3. 对要更新的章节，用 `project_map`、`project_search`、`project_read` 收集代码证据；只写有证据的事实。
4. 按固定章节输出 Markdown 草案：overview、architecture、modules、data_model、config、deploy、operations、conventions、testing、decisions、faq、risks。
5. 每个段落附来源 `path:startLine-endLine @ commit`；没有来源的段落标记 `unsourced`。
6. 明确告诉管理员：草案需要在控制台“项目 → 手册”中审核并发布，机器人不会直接写库。

## 约束

- 不覆盖人工维护的负责人、值班、环境地址、历史决策等内容。
- 不把密钥、Token、内部地址写进手册；只写变量名和来源。
- 模型叙述必须逐段带来源；没有证据时保留“待补充”，不要编造。
- 只读：不要修改代码、配置文件或数据库。
