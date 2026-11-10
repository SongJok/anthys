---
name: work-report
description: 汇总日程、待办、审批、听记与既有日志，按公司模版起草并提交日报、周报或月报
version: 1.0.0
when_to_use: 当用户要写日报、周报、月报，回顾本周期产出，或按公司日志模版提交工作汇报时
tags:
  - report
  - 日报
  - 周报
  - 月报
  - 日志
allowed_tools:
  - dws_report_read
  - dws_report_submit
  - dws_org_and_schedule
  - dws_minutes
  - personal_report
risk: write
visibility: public
max_instruction_chars: 4000
---

# 日报 / 周报 / 月报

## 适用场景

用户要求写工作汇报、回顾本周产出、按钉钉日志模版提交日周月报，或把会议与待办整理成汇报。

## 步骤

1. 先确认四件事：报告周期（起止日期）、提交模版、接收人、语气（简洁/详细）。缺超过两项时只问最关键的一个问题。
2. 用 `dws_report_read` 的 `templates` 列出模版，再用 `template` 读取字段名和必填项；没有可用模版时使用通用结构：本期完成、进行中、风险与阻塞、下期计划。
3. 收集事实来源：
   - 日程与会议：`dws_org_and_schedule` 的 calendar=list/today。
   - 待办完成情况：`dws_org_and_schedule` 的 todo=list/get。
   - 会议结论：`dws_minutes` 的 list/latest → summary/todos。
   - 历史日志：`dws_report_read` 的 outbox/latest，避免重复或遗漏。
   - 单聊中可选用 `personal_report` 的 preview 生成确定性汇总作为底稿。
4. 按“动作 + 对象 + 结果 + 影响”写每条事项，能量化就量化；没有数据的条目不要编造百分比。
5. 风险与阻塞单独成段，写清需要谁支持、何时需要；不把抱怨写进汇报。
6. 把草稿先发给用户确认，明确模版字段、接收人列表和最终正文；用户确认后调用 `dws_report_submit`，按模版字段填入 `contents`。
7. 提交属于普通写操作，本人 DWS 授权有效时直接执行；如果工具返回待确认，提示用户回复 `/confirm`。执行前不要声称已提交，完成后如实反馈结果。

## 约束

- 不虚构工作内容、数据、接收人或提交结果；来源不足时在草稿里标“待补充”。
- 写操作必须经过确认流程；`toUserIds` 至少一人，群发前要用户明确同意。
- 涉及他人评价、客户信息、未公开业务数据时先脱敏，并提醒用户确认可见范围。
- 一份报告只服务一个周期；跨周期内容拆开，不要把旧内容重复计入。
