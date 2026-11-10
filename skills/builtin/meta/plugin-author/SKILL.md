---
name: plugin-author
description: 设计、校验和发布声明式插件包，把技能、MCP 节点与密钥声明打成可回滚的分发包
version: 1.0.0
when_to_use: 当用户要打包技能、接入市场 MCP、设计 plugin.json，或排查插件安装失败与版本回滚时
tags:
  - plugin
  - 插件
  - MCP
  - 分发
  - 清单
allowed_tools:
  - skill_search
  - skill_read
risk: read
visibility: public
max_instruction_chars: 4000
---

# 声明式插件设计

## 适用场景

用户要把一组技能和/或 MCP 节点打成插件、把市场 MCP 接入机器人、写 `plugin.json`，或排查安装、升级、回滚失败。

## 步骤

1. 先确认：插件要解决的任务、包含哪些技能、是否需要 MCP、需要哪些环境变量、目标 agent 版本。插件是**纯声明包**，不执行安装脚本或任意代码。
2. 用 `skill_search` 查重；需要参考完整清单时用 `skill_read` 读取本技能的 `references/plugin-template.json` 与 `references/review-checklist.md`。
3. 设计目录：
   - `plugin.json`
   - `skills/<skill-name>/SKILL.md`（以及可选的 `references/`）
   - `README.md`（面向安装者的说明）
4. 填写 `plugin.json`：
   - `schemaVersion` 固定为 `1`；`id` 小写字母/数字/点/连字符，2–64 字符，建议用反向域名。
   - `version` 用语义化版本；`engines.agent` 写兼容范围，如 `>=0.1.0`。
   - `trust` 固定为 `declarative`。
   - `skills` 写相对插件根目录的技能目录数组。
   - `mcpServers` 每项包含 `id`、`name`、`domain`、`transport`、`endpointOrCommand`，stdio 还要 `args`，远程还要鉴权头。
   - `secrets` 只声明环境变量名、是否必填和说明；值从 `.env` 读取，不写进清单。
   - `permissions` 仅用于展示与审计，不能替代运行时权限。
5. 校验规则：
   - 技能名不能与内置/本地技能冲突；插件技能以 `plugin:<插件id>:<技能名>` 暴露。
   - 插件 MCP 节点以 `plugin-<插件id>-<节点id>` 注册，工具名为 `mcp__plugin-<插件id>-<节点id>__<tool>`。
   - stdio 裸命令必须在 `PLUGIN_ALLOWED_COMMANDS` 白名单内（默认 `npx,uvx,node,python3,docker`）。
   - `${ENV_VAR}` 占位符必须有对应环境变量；缺失时安装会失败，除非允许缺失密钥（插件保持禁用）。
6. 安全评审：
   - 最小权限：只声明必要技能和 MCP；不需要文件访问就不要给文件系统权限。
   - 不把密钥写进 `args`、命令、技能正文或日志；只用 `${ENV_VAR}`。
   - 外部 MCP 要评估来源、维护活跃度、网络访问范围和可写操作；默认只读优先。
   - 插件不能覆盖内置技能或手工 MCP 节点，不能携带可执行安装钩子。
7. 测试路径：全新安装 → 缺密钥安装（应禁用并提示）→ 升级 → 回滚 → 停用/启用 → 卸载；每一步检查技能目录和 MCP 工具是否按命名空间出现。
8. 安装与发布：控制台「声明式插件」上传 zip 或填服务器目录；或调用 `POST /api/v1/admin/plugins/validate`、`/plugins/install`、`/plugins/:id/upgrade`、`/rollback`。安装、升级、回滚都要保留版本记录。

## 约束

- 不执行插件包里的脚本；不把插件当作任意代码运行时。
- 不声明无法验证来源的 MCP；不把个人 Token 写进仓库。
- 不在插件技能里绕过 `/confirm`、审批或权限检查。
- 升级前先确认兼容的 `engines.agent`；回滚目标必须存在且密钥齐全。
- 插件失败时如实报告阶段（manifest / skills / mcp / secrets / conflict），不要猜测成功。
