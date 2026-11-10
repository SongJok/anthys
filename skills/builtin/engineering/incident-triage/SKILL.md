---
name: incident-triage
description: 结合项目手册、代码证据和日志工具定位线上故障，给出按可能性排序的排查步骤
version: 1.0.0
when_to_use: 当用户报告线上异常、接口报错、任务失败或需要排查故障原因时
tags:
  - incident
  - 故障排查
  - 运维
  - 项目
allowed_tools:
  - project_list
  - project_handbook
  - project_search
  - project_read
  - project_history
risk: read
visibility: public
max_instruction_chars: 4000
---

# 线上故障排查

## 适用场景

用户报告报错、超时、数据异常、任务失败等线上问题，需要快速缩小范围。

## 步骤

1. 先问清或提取：发生时间、影响范围、错误文案/状态码、最近变更、是否能稳定复现。信息不足时只问最关键的一两个问题。
2. 调用 `project_list` 确认项目，再调用 `project_handbook` 读取 `operations`、`deploy` 和 `risks` 章节。
3. 用 `project_search` 搜索错误文案、错误码、日志关键字和配置键，定位抛出点。
4. 用 `project_read` 读取抛出点上下文和相关调用链；用 `project_history` 查看最近相关提交（如果可用）。
5. 如果配置了日志/监控类 MCP 工具，按时间窗口和关键字段查询；一次只查一个假设。
6. 输出：最可能原因（按概率排序）、每条的证据、下一步验证命令或操作、需要人工确认的风险点。

## 约束

- 不要执行重启、回滚、删除数据等写操作；需要时给出操作建议并提示管理员确认。
- 证据不足时明确写“待验证”，不要用猜测填补日志空白。
- 引用日志时保留时间戳和请求 ID；引用代码时带 `path:startLine-endLine @ commit`。
- 涉及个人信息、密钥或内部地址时做脱敏。
