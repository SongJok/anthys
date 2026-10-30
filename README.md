# 钉钉智能体（阶段四）

钉钉 Stream 模式机器人：单聊与群聊 @ 机器人时，通过 AI 卡片流式输出原生思维链与 Markdown 正文；群内全量旁听并在高优故障/技术求助时主动回复，配合工作记忆、情景摘要与语义画像三层记忆。所有配置可通过管理员钉钉单聊或 Web 管理控制台在线调整，毫秒级热生效，无需重启进程。

## 架构

```
src/
├── config/      环境变量、IConfigProvider 与 DynamicConfigCenter（PostgreSQL + 内存缓存 + EventEmitter）
├── admin-api/   Hono 管理 REST API（/api/v1/admin/*）与 web-console 静态托管
├── dingtalk/    Stream 网关、消息解析器、AI 卡片流式渲染器与节流器
├── bystander/   群聊旁听缓冲、三级旁听漏斗、冷却限流与群级策略
├── harness/     AgentHarness（消息 → 记忆 → 上下文 → 引擎）、ToolRegistry 与 DynamicLoopGuard
├── react/       ReActRunner、内置工具、OpenAI/Anthropic 流式模型适配
├── tools/       企业 MCP、DWS CLI、隔离沙盒与管理员 ChatOps 工具源
├── memory/      PostgreSQL 会话仓库、三层记忆管理与上下文组装
├── db/          Drizzle Schema（会话、记忆、动态配置与审计）、连接与 Seed
└── index.ts     启动入口
web-console/     React 19 + Vite + TypeScript + TailwindCSS + Ant Design 管理控制台
```

处理链路：

1. `DWClient` 注册 `TOPIC_ROBOT`，收到回调立即 ACK，再异步解析。
2. 群聊消息（无论是否 @ 机器人）先写入 `GroupTranscriptBuffer`；非文本消息忽略；相同 `messageId` 去重。
3. @ 消息走 `AgentHarness`；未 @ 消息进入 `BystanderTriageEngine`：L1 规则/冷却/忙闲过滤 → 8 秒防抢答窗口 → L2 小模型 JSON 判定 → 置信度门禁，只有 `PROACTIVE_REPLY` 才唤醒 ReAct 并创建卡片。
4. `AgentHarness` 组装三层记忆（发言人画像、群聊旁听窗口、历史摘要），注入人设与工具说明，写入用户消息。
5. `ReActRunner` 以 `stream: true` 运行：分离 `reasoning_content` / `thinking`、正文与 `tool_calls`。
6. `CardStreamer` 把增量写入卡片三个区块：`thinking_section`、`answer_section`、`status_bar`；每 250ms 或每 80 字符刷新，工具事件与完成事件立即刷新。
7. 助手回答（含推理与 token 用量）落库；后台异步把超过阈值的早期对话压缩为情景摘要，并抽取长期有效的术语/职责画像。

动态循环不使用固定轮数：由 `DynamicLoopGuard` 按墙钟时间、Token 预算与“同工具同参数连续调用”判定是否继续；预算耗尽时以 `tool_choice: none` 做一次收尾汇总。

## 前置条件

- Node.js 24+（项目要求）
- pnpm
- PostgreSQL（默认 `postgres://localhost:5432/dingtalk_agent`），并安装 pgvector 扩展

## 钉钉侧准备

1. 在钉钉开放平台创建企业内部应用，启用机器人，消息接收方式选择 **Stream 模式**（无需公网域名或 Webhook）。
2. 记录 `AppKey`（`DINGTALK_CLIENT_ID`）、`AppSecret`（`DINGTALK_CLIENT_SECRET`）与机器人 `robotCode`（通常与 AppKey 相同）。
3. 在钉钉卡片平台创建 **AI 卡片模板**，模板变量必须包含：
   - `thinking_section`：折叠区，展示原生思维链与工具调用轨迹（Markdown）
   - `answer_section`：正文区（Markdown）
   - `status_bar`：状态角标（纯文本，建议渲染在标题栏或底部）
   将模板 ID 填入 `DINGTALK_CARD_TEMPLATE_ID`。
4. 将机器人添加到目标群；群聊中 @ 机器人 的消息会正常应答，未 @ 消息会被静默旁听，仅在命中故障/求助信号时主动回复。

## 启动

```bash
cp .env.example .env
# 填写 DINGTALK_*、LLM_BASE_URL、LLM_API_KEY、DATABASE_URL

psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"  # 语义记忆向量列
pnpm install
pnpm run db:push      # 创建 conversations / messages / agent_configs / conversation_summaries
                      # / semantic_memories / bystander_policies / sys_configs
                      # / admin_audit_logs / react_traces
pnpm run db:seed      # 写入默认人设与大模型配置（已有行不覆盖）
pnpm build            # 构建 web-console 并编译服务端；控制台由后端静态托管
pnpm start            # 或 pnpm dev（watch 模式）
```

`pnpm start` 会同时启动 Stream 客户端与管理 API（默认 `http://localhost:8787`）。未执行 `pnpm build` 时后端仍可启动，但 `/` 不会返回控制台页面。

- 人设与大模型参数优先读取数据库 `agent_configs`，缺失时回退 `.env`；`LLM_API_KEY` 只从环境变量读取，不落库。
- `pnpm start` 会先执行配置校验，缺少必需变量时直接退出并列出缺失项。
- 进程退出时断开 Stream 连接、等待后台记忆维护任务并关闭数据库连接池。

## 管理控制台与管理员单聊（ChatOps）

控制台（`http://localhost:8787/`）提供六个页面：

- **运行大盘**：Stream 连接、今日对话轮次与 Token、MCP 节点健康、各群旁听统计、最近管理审计。
- **钉钉企业配置**：AppKey / AppSecret（掩码回显，留空表示不改）、RobotCode、AI 卡片模板 ID、管理员 StaffId 白名单、DWS CLI 开关、发送测试卡片。
- **大模型与人设**：模型渠道、Base URL / 模型 / API Key、原生思维链、采样温度、ReAct 循环预算（耗时 / Token / 同工具连续调用 / 收敛自检）、人设与语气，支持沙盒对话测试。
- **企业 MCP**：节点增删改查、一键连通性测试并浏览已发现工具 Schema、按群 / 角色控制工具调用权限。
- **群聊旁听策略**：全局默认与按群覆盖、一键紧急静音。
- **ReAct 审计轨迹**：分页查看每一步原生思维链、工具入参 / 耗时、沙盒输出与最终回答。

管理员在钉钉单聊中会额外获得四个高危工具：`admin_inspect_system_status`、`admin_manage_mcp_server`、`admin_update_llm_or_persona`、`admin_configure_group_bystander`。仅当 `conversationType === '1'` 且发送人命中管理员白名单时才挂载；普通员工与群聊环境下这些工具物理不可见。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | 空 | 管理 API Bearer Token；留空表示本地不校验 |
| `ADMIN_PORT` | `8787` | 管理 API 与静态控制台端口 |
| `ADMIN_STAFF_IDS` | 空 | 允许使用 `admin_*` 工具的管理员 StaffId（逗号分隔） |
| `DWS_CLI_ENABLED` | `false` | 是否加载 DWS CLI 工具源（可在线切换） |
| `MCP_SERVERS_CONFIG` | `config/mcp-servers.json` | 首次启动的 MCP 节点定义，之后以 `sys_configs` 为准 |

所有改动持久化到 `sys_configs`，并通过 `<scope>:changed` 事件热应用到 Stream 网关、MCP 连接池与 ReAct 引擎。Web 与 ChatOps 两条通道都会写入 `admin_audit_logs`，密钥与 MCP 凭据只记录掩码。

## 群聊旁听与非 @ 自主回复

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BYSTANDER_ENABLED` | `true` | 是否开启群聊旁听缓冲 |
| `BYSTANDER_PROACTIVE_REPLY` | `true` | 是否允许非 @ 主动回复 |
| `BYSTANDER_SLIDING_WINDOW_SIZE` | `20` | 每群保留的旁听条数 |
| `BYSTANDER_COOLDOWN_SECONDS` | `180` | 同群两次主动回复的最小间隔 |
| `BYSTANDER_CONFIDENCE_THRESHOLD` | `0.82` | 触发主动回复的最低置信度 |
| `BYSTANDER_TRIGGER_TOPICS` | `线上故障,SQL查询,接口报错,发布排期` | 重点关注主题（逗号分隔） |
| `BYSTANDER_DEBOUNCE_MS` | `8000` | 疑似提问后的防抢答等待窗口 |

- 三级漏斗保证非 @ 消息不会直接进入 ReAct：L1 零 Token 规则（表情/确认短语、冷却、群忙闲、技术信号预筛）→ 防抢答等待（期间有同事回复即静默）→ L2 JSON 分类器 → 置信度门禁。
- 群级策略可在数据库 `bystander_policies` 表中覆盖上述默认值；数据库不可用时回退环境变量。
- 主动回复使用与 @ 回复相同的 AI 卡片与 MCP/DWS 工具链路。

## 三层记忆

- **Working Memory**：当前会话历史窗口 + 每群 `GroupTranscriptBuffer` 滑动窗口。
- **Episodic Memory**：单会话上下文超过 `MEMORY_COMPRESSION_THRESHOLD_TOKENS`（默认 12000）时，后台压缩最早 `MEMORY_COMPRESSION_RATIO`（默认 0.6）的对话，写入 `conversation_summaries`，并按已覆盖消息 ID 避免重复压缩。
- **Semantic Memory**：从对话中抽取长期有效的团队术语与员工职责画像，写入 `semantic_memories`；组装上下文时按发言人、群与关键词（可选 pgvector 余弦排序）按需召回，召回条数由 `MEMORY_SEMANTIC_LIMIT` 控制。

## LLM 兼容性

- `LLM_PROVIDER=openai-compatible`：DeepSeek-R1、GLM、Qwen 等，读取 `reasoning_content` 或 `reasoning` 增量。
- `LLM_PROVIDER=anthropic`：原生 Messages API，读取 `thinking_delta`；原生思考开启时自动省略 temperature，并约束 `budget_tokens < max_tokens`。
- `LLM_ENABLE_NATIVE_REASONING=false` 时不请求原生思考，卡片只展示正文与工具轨迹。

## 内置工具

| 工具 | 作用 |
| --- | --- |
| `current_time` | 返回指定时区（`Asia/Shanghai` / `UTC`）的当前时间、Unix 毫秒、星期 |
| `calculator` | 安全表达式计算（不使用 `eval`），支持 `+ - * / % ^`、括号、科学计数法 |
| `system_status` | 进程、Node 版本、平台、运行时长、负载与内存占用 |

## 验证

```bash
pnpm run typecheck
pnpm test
```

覆盖内容：动态预算与重复调用拦截、上下文窗口、ReAct 流式事件与多步工具、内置工具边界、消息解析、群聊 @ 过滤、Stream ACK/去重、卡片三区块节流与收尾、AgentHarness 多轮持久化；群聊旁听缓冲裁剪与多群隔离、三级漏斗（闲聊静默/报错主动触发/防抢答/冷却/置信度）、群聊旁听→主动回复→@ 追问携带上下文的完整链路、长对话摘要归档与画像/术语召回；动态配置热更新广播、管理员单聊工具的上下文权限隔离、管理 REST 接口 CRUD 与 MCP 凭据掩码回显。

真实钉钉与真实模型链路的端到端验收需要有效的企业应用凭据、卡片模板与 LLM Key；本仓库的自动化测试不访问外部网络。`src/harness/ToolRegistry.test.ts` 与 `src/tools/sandbox/IsolatedSandbox.test.ts` 依赖 `isolated-vm` 原生构建，缺失本机 ABI 构建时会跳过用例。

## 阶段四边界

- 动态配置持久化在 PostgreSQL `sys_configs`，进程重启后自动恢复；数据库不可用时回退 `.env` 默认值。
- 管理员单聊口令由 ReAct 自主选择 `admin_*` 工具执行，权限边界完全依赖 `conversationType` 与 StaffId 白名单，不额外解析自然语言意图。
- 群聊旁听缓冲保存在进程内存，重启后由新消息重新积累；情景摘要与语义记忆持久化在 PostgreSQL。
- `ReAct 审计轨迹` 仅展示经 `react_traces` 落库的调用；未产生消息时为空。
- 前端为单页应用，生产构建产物由后端静态托管，单容器即可部署；不含前端单测。
