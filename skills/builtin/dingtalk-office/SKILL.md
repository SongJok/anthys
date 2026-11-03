---
name: dingtalk-office
description: 用钉钉原生能力处理日程、待办、通讯录、审批与在线文档等日常办公事务
version: 1.0.0
when_to_use: 当用户要约会议、查日程、建待办、找同事、发起或处理审批、读写钉钉文档时
tags:
  - dingtalk
  - 办公
  - 日程
  - 待办
  - 审批
  - 文档
allowed_tools:
  - dws_org_and_schedule
  - dws_calendar_manage
  - dws_calendar_cancel
  - dws_todo_manage
  - dws_contact_manage
  - dws_approval_manage
  - dws_doc_search_and_read
  - dws_doc_manage
risk: write
visibility: public
max_instruction_chars: 4000
---

# 钉钉办公事务

## 适用场景

用户在钉钉里要求安排会议、管理待办、查同事信息、处理审批或读写在线文档。

## 通用流程

1. 先判断是只读查询还是写操作；写操作先复述关键信息（对象、时间、接收人、影响范围），得到用户确认后再调用对应工具。
2. 身份始终使用当前提问人的钉钉身份；不要猜测或冒用他人身份。
3. 写操作提交后会进入待确认动作，提示用户回复 `/confirm`；不要提前声称已完成。

## 日程

- 查日程用 `dws_org_and_schedule` 的 calendar=list/today/search/freebusy；时间统一用 ISO-8601 带时区，默认 Asia/Shanghai。
- 建/改日程用 `dws_calendar_manage`，create 需要 title、start、end；参会人用 userId，先用通讯录确认。
- 取消日程用 `dws_calendar_cancel`，属于高危操作：先读出日程标题与时间让用户确认，再提交。
- 约会议前先查 freebusy，冲突时给出两个可选时间，不要擅自改期。

## 待办

- 查待办用 `dws_org_and_schedule` 的 todo=list/today/get。
- 建/改/完成待办用 `dws_todo_manage`；executors 省略时默认当前用户，指派他人要明确说明。

## 通讯录

- 按姓名或关键词搜索用 `dws_org_and_schedule` 的 contact=search；拿到 userId 后再查详情。
- 只返回工作所需信息；不在群聊公开手机号、邮箱等个人信息。

## 审批

- 先只读：list-pending/list-submitted 查列表，detail/records/tasks 看详情，form-schema 看表单字段。
- 发起、同意、拒绝用 `dws_approval_manage`；taskId 必须是查询得到的数字 ID。
- 同意或拒绝前必须复述审批标题、发起人和意见；不要代替用户做价值判断。

## 文档

- 搜索与阅读用 `dws_doc_search_and_read`；结果只包含提问人本人有权限查看的文档与知识库，不是全组织检索。
- 分析文档时：先确认文档名称、链接或主题，search 找到候选后让用户确认，再 read/get 读取正文；返回 hasMore=true 时按 page 继续读关键章节。
- 输出结论时给出依据，包括文档标题、文档 ID 和原文要点；区分“文档里写的”和“我的推断”。
- 找不到或提示无权访问时，如实说明可能受个人文档权限限制，建议用户提供文档链接或联系文档所有者；不要断言文档不存在。
- 新建或追加用 `dws_doc_manage`；覆盖会清空原文，默认不做，除非用户明确要求并已备份。

## 约束

- 不执行未授权的写操作；不批量改日程、不批量审批。
- 工具返回权限不足时如实说明需要联系管理员开通，不尝试绕过。
- 所有时间写清时区；跨天、跨时区场景要与用户确认。
