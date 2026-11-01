# 架构

## 分层

| 目录 | 职责 |
| --- | --- |
| `src/index.ts` | 组装数据库、配置中心、Stream 网关、管理 API、工具与后台任务 |
| `src/dingtalk/` | Stream 连接、AI 卡片、消息发送与身份 |
| `src/harness/` | 智能体循环、上下文组装、工具注册与执行、工作区 |
| `src/tools/` | 内置工具与各 Provider（记忆、术语、搜索、沙盒、技能、项目、GitHub） |
| `src/memory/` | 三层记忆：窗口、情景摘要、语义事实 |
| `src/bystander/` | 群内旁听缓冲、规则过滤、防抢答、模型判定与冷却 |
| `src/config/` | 环境配置、动态配置中心与热更新 |
| `src/admin-api/` | 管理 REST API、鉴权、审计 |
| `src/db/` | Drizzle schema、扩展 SQL、种子与数据访问 |
| `src/skills/` `src/plugins/` `src/projects/` | 扩展能力：技能、声明式插件、项目快照与手册 |
| `web-console/` | React + Ant Design 管理控制台（独立子工程） |
| `deploy/` | 阿里云 ECS 单机部署脚本与 systemd/Nginx 配置 |

## 运行时数据流

1. `index.ts` 读取环境配置，建立数据库连接并执行幂等种子。
2. `DynamicConfigCenter` 合并环境默认值与数据库覆盖值，向各模块提供热更新配置。
3. Stream 网关接收消息，路由到智能体或旁听判定。
4. 智能体从 `ToolRegistry` 获取当前用户可用工具（含 MCP 授权过滤），执行 ReAct 循环。
5. 工具输出被统一裁剪、脱敏并标记为不可信内容后进入上下文。
6. 结果写入 AI 卡片、对话库、审计与记忆；后台任务异步压缩与抽取。

## 扩展装配

- 技能：启动时扫描 `skills/builtin`、`skills/local` 与已启用插件，写入技能表；通过 `SkillToolProvider` 按需加载 SKILL.md 与资源。
- 插件：`PluginService` 校验 `plugin.json`、解压到状态目录、注册技能与 MCP（命名空间 `plugin__<id>__<tool>`），不执行插件代码。
- 项目：`ProjectService` 登记项目、同步不可变快照、扫描/分块/符号索引；`ProjectToolProvider` 提供检索、读取、地图、符号、历史与手册工具。
- GitHub：`GithubClient` 只访问 HTTPS 的 GitHub 域或显式白名单，`GithubToolProvider` 暴露 repo/tree/file/search/pr 只读工具。

## 存储

- PostgreSQL 16 + pgvector + pg_trgm；代码检索用 tsvector/GIN 与 trigram，向量可选。
- 配置、对话、记忆、术语、审计、技能、插件、项目与手册均在数据库中；状态文件放在 `.state/`。
