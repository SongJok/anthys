# 钉钉智能体

一个面向企业内部的知识与运维助手：以钉钉机器人的形态出现在单聊和群聊里，使用企业的 MCP 服务、钉钉 DWS 能力与隔离沙盒回答跨系统问题；在群里不打扰地旁听，只在真正需要时主动介入；回答过程与管控操作都留痕、可审计，运行期的模型、人设、预算、MCP、群策略与钉钉凭据都能在线热更新而无需重启。

- **开箱即用的钉钉接入**：基于 Stream 模式，不需要公网域名、Webhook 或内网穿透。
- **过程可见的回答**：AI 卡片同步流式展示原生思维链、工具调用轨迹与最终正文。
- **克制的主动回复**：群内全量旁听，经三级漏斗判断后才对高优故障、技术求助作出回应。
- **越用越懂团队**：工作记忆 + 情景摘要 + 语义画像三层记忆，跨会话保留上下文。
- **双通道动态管控**：管理员既可以在钉钉单聊里用自然语言下达指令，也可以在 Web 控制台逐项配置，保存即生效。
- **企业级边界**：管理员白名单、只读命令白名单、沙箱隔离、凭据掩码与全量操作审计。

---

## 目录

- [适用场景](#适用场景)
- [工作方式](#工作方式)
- [快速部署](#快速部署)
- [功能说明](#功能说明)
- [管理控制台](#管理控制台)
- [管理员单聊（ChatOps）](#管理员单聊chatops)
- [管理 API](#管理-api)
- [安全与数据](#安全与数据)
- [运维与排障](#运维与排障)
- [已知边界](#已知边界)

---

## 适用场景

| 场景 | 员工看到的效果 |
| --- | --- |
| 故障排查 | 在群里讨论报错时，机器人主动拉取生产日志、检索代码与接口文档，给出可执行的结论 |
| 数据速查 | 单聊询问「上周订单超时的集中原因」，机器人调用数据服务并用沙盒做聚合统计 |
| 流程查询 | @ 机器人问「本周日程」「我的待办」「这份文档怎么规定的」，机器人调用 DWS 只读查询 |
| 知识沉淀 | 团队术语、同事职责、历史结论被逐步记住，后续回答不再从零解释 |
| 运营管控 | 管理员随时切换模型、调预算、增删 MCP、调整群策略，或一键紧急静音 |

---

## 工作方式

```mermaid
flowchart LR
  A[员工 / 群成员] -->|单聊、@ 机器人、群消息| B(钉钉 Stream)
  B --> C{消息路由}
  C -->|单聊或 @| D[ReAct 智能体]
  C -->|群内未 @| E[旁听判定]
  E -->|命中主题且通过冷却与置信度| D
  D --> F[工具层<br/>企业 MCP · DWS · 沙盒 · 内置工具]
  D --> G[三层记忆]
  D --> H[AI 卡片流式输出]
  I[Web 控制台 / 管理员单聊] --> J[动态配置中心]
  J -.热更新.-> B
  J -.热更新.-> D
  J -.热更新.-> F
```

1. 钉钉 Stream 推送消息，服务立即确认接收，再异步处理，避免重复投递。
2. 单聊与 @ 消息直接进入智能体；群内未 @ 的消息先进入旁听缓冲，由零 Token 的规则层过滤掉大部分噪音。
3. 少量候选消息经过防抢答等待、模型判定（低温度、无工具、无思维链）与置信度门槛，只有被判定为「需要回应」时才唤醒智能体。
4. 智能体按当前人设、三层记忆与工具说明组装上下文，动态决定调用哪些工具、调用几次。
5. 每个工具调用、思考过程与正文都实时写入同一张 AI 卡片，员工可以边等边看。
6. 回答与过程落库，后台异步压缩早期对话、抽取长期术语与职责画像。
7. 配置变更通过统一配置中心广播，Stream 连接（凭据变更时按需重建）、工具连接池与推理参数在运行中热应用。

---

## 快速部署

### 前置条件

| 项目 | 要求 |
| --- | --- |
| 运行环境 | Node.js 24 及以上、pnpm |
| 数据库 | PostgreSQL，并启用 `pgvector` 扩展（语义记忆的向量列） |
| 钉钉 | 企业内部应用 + 机器人，消息接收方式选择 **Stream 模式** |
| 大模型 | 任一 OpenAI 兼容接口（DeepSeek、GLM、Qwen 等）或 Anthropic Messages API |
| 浏览器 | 管理控制台支持现代 Chrome / Edge / Safari |

推荐部署形态：一个常驻进程同时承担机器人与管理控制台，置于内网或受控网络，由 Nginx 之类反向代理对外暴露控制台端口即可。

### 钉钉侧准备

1. 在钉钉开放平台创建企业内部应用，启用机器人，记录 **AppKey**、**AppSecret** 与 **RobotCode**（通常与 AppKey 相同）。
2. 在钉钉卡片平台创建 **AI 卡片模板**，模板变量必须包含以下三个：

   | 变量 | 用途 |
   | --- | --- |
   | `thinking_section` | 折叠区：原生思维链与工具调用轨迹（Markdown） |
   | `answer_section` | 正文区（Markdown） |
   | `status_bar` | 状态角标（纯文本，建议渲染在标题栏或底部） |

3. 记录模板 ID，稍后填入 `DINGTALK_CARD_TEMPLATE_ID`。
4. 将机器人加入目标群。群内 @ 机器人会正常应答；未 @ 的消息被静默旁听，命中条件才主动回复。

### 安装依赖与初始化数据库

> 建议先按下一节创建 `.env`（至少确认 `DATABASE_URL`），再执行初始化。

```bash
# 安装依赖：控制台是独立的子工程，需要单独安装
pnpm install
pnpm -C web-console install

psql "postgres://localhost:5432/dingtalk_agent" -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm run db:push      # 创建会话、记忆、动态配置、审计与轨迹等数据表
pnpm run db:seed      # 可选：预写入默认人设与模型配置，已有记录不覆盖
```

> 数据库连接串默认为 `postgres://localhost:5432/dingtalk_agent`，可通过 `DATABASE_URL` 覆盖；`psql` 命令请替换为实际连接串。
> 人设与模型配置在服务启动时也会自动补齐，`db:seed` 主要用于提前初始化或 CI 场景。

### 环境变量

将 `.env.example` 复制为 `.env`，按下列分组填写。缺少必需项时进程会立即退出并列出缺失的变量名。

**运行时与数据库**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 运行环境标识 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `DATABASE_URL` | `postgres://localhost:5432/dingtalk_agent` | PostgreSQL 连接串 |

**钉钉接入**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DINGTALK_CLIENT_ID` | 必填 | 企业内部应用 AppKey |
| `DINGTALK_CLIENT_SECRET` | 必填 | 应用 AppSecret |
| `DINGTALK_ROBOT_CODE` | 必填 | 机器人编码，通常等于 AppKey |
| `DINGTALK_CARD_TEMPLATE_ID` | 必填 | AI 卡片模板 ID，模板需包含三个变量（见上） |

**大模型与人设**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | `openai-compatible` | `openai-compatible` 或 `anthropic` |
| `LLM_BASE_URL` | 必填 | 兼容接口地址，例如 `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 必填 | 模型密钥，接口与审计中只显示掩码 |
| `LLM_MODEL` | `deepseek-reasoner` | 模型名称 |
| `LLM_TEMPERATURE` | `0.3` | 采样温度 |
| `LLM_ENABLE_NATIVE_REASONING` | `true` | 是否请求原生思维链 |
| `PERSONA_NAME` | `小钉` | 机器人名称 |
| `PERSONA_ROLE_PROMPT` | 见示例 | 人设 Prompt |
| `PERSONA_SPEAKING_STYLE` | 见示例 | 语气与表达风格 |

**推理预算**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOOP_MAX_WALL_TIME_MS` | `120000` | 单轮回答的最大墙钟时间 |
| `LOOP_MAX_TOTAL_TOKENS` | `64000` | 单轮回答的 Token 上限 |
| `LOOP_MAX_CONSECUTIVE_SAME_TOOL` | `2` | 同一工具同参数连续调用上限 |
| `LOOP_CONVERGENCE_CHECK` | `true` | 是否启用信息收敛自检 |

**记忆**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEMORY_WINDOW_MESSAGES` | `20` | 上下文保留的最近消息数 |
| `MEMORY_COMPRESSION_THRESHOLD_TOKENS` | `12000` | 触发情景摘要的 Token 阈值 |
| `MEMORY_COMPRESSION_RATIO` | `0.6` | 每次压缩最早的对话比例 |
| `MEMORY_SEMANTIC_LIMIT` | `6` | 每次组装上下文时召回的语义记忆条数 |

**向量语义记忆**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EMBEDDING_ENABLED` | `false` | 是否启用 pgvector 向量召回；关闭时回退关键词匹配 |
| `EMBEDDING_BASE_URL` | 沿用 `LLM_BASE_URL` | OpenAI 兼容的 embeddings 接口地址 |
| `EMBEDDING_API_KEY` | 沿用 `LLM_API_KEY` | embeddings 接口密钥 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 向量模型名称 |
| `EMBEDDING_DIMENSIONS` | `1536` | 向量维度，需与 `semantic_memories.embedding` 列一致 |

启用后，语义记忆写入时生成向量，召回时按余弦距离排序；embedding 服务异常会自动降级为关键词召回，不影响回答。

**群聊旁听**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BYSTANDER_ENABLED` | `true` | 是否开启群聊旁听 |
| `BYSTANDER_PROACTIVE_REPLY` | `true` | 是否允许非 @ 主动回复 |
| `BYSTANDER_SLIDING_WINDOW_SIZE` | `20` | 每群保留的旁听条数 |
| `BYSTANDER_COOLDOWN_SECONDS` | `180` | 同群两次主动回复的最小间隔 |
| `BYSTANDER_CONFIDENCE_THRESHOLD` | `0.82` | 触发主动回复的最低置信度 |
| `BYSTANDER_TRIGGER_TOPICS` | `线上故障,SQL查询,接口报错,发布排期` | 重点关注主题（逗号分隔） |
| `BYSTANDER_DEBOUNCE_MS` | `8000` | 疑似提问后的防抢答等待窗口 |

**用量配额与模型路由**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `USAGE_QUOTA_ENABLED` | `false` | 是否启用每日 Token 配额；用量流水始终记录 |
| `USAGE_DAILY_TOKENS_PER_USER` | `0` | 单员工每自然日 Token 上限，`0` 表示不限 |
| `USAGE_DAILY_TOKENS_PER_CONVERSATION` | `0` | 单群每自然日 Token 上限，`0` 表示不限 |
| `LLM_ROUTE_DEFAULT_MODEL` | 空 | 默认场景改用指定模型；空则沿用 `LLM_MODEL` |
| `LLM_ROUTE_PROACTIVE_MODEL` | 空 | 群聊主动回复使用的模型，可用于降低成本 |
| `LLM_ROUTE_ADMIN_MODEL` | 空 | 管理员单聊使用的模型，可用于提升质量 |

配额按 Asia/Shanghai 自然日切分。超出配额时，@ 消息直接收到配额提示且不再调用模型，主动回复则静默跳过。

**管理控制台与企业 MCP**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | 空 | 管理 API 的 Bearer Token；为空时不做校验 |
| `ADMIN_PORT` | `8787` | 管理 API 与控制台端口 |
| `ADMIN_STAFF_IDS` | 空 | 允许使用管理指令的钉钉 StaffId（逗号分隔） |
| `DWS_CLI_ENABLED` | `true`（`.env.example` 中为 `false`） | 是否启用 DWS 命令行工具源 |
| `SANDBOX_ENABLED` | `true` | 是否启用隔离沙盒工具 |
| `MCP_SERVERS_CONFIG` | `config/mcp-servers.json` | 首次启动时的 MCP 节点定义 |
| `ENTERPRISE_MCP_ENDPOINT` | 空 | 示例企业 MCP 的地址，供配置文件中 `${...}` 引用 |
| `ENTERPRISE_MCP_TOKEN` | 空 | 示例企业 MCP 的访问令牌，供配置文件中 `${...}` 引用 |

### 构建与启动

```bash
pnpm build     # 构建控制台静态资源，并编译服务端到 dist
pnpm start     # 通过 tsx 直接运行 src/index.ts
```

> 启动脚本依赖 `tsx`，安装依赖时请保留 devDependencies（不要使用 `--prod`）。

启动后：

- 机器人通过 Stream 连接钉钉，日志会出现 `dingtalk agent is ready`。
- 管理控制台监听 `http://<host>:8787/`，同时提供 `/api/v1/admin/*` 与健康检查 `/health`。
- 未执行 `pnpm build` 时服务仍可运行，但访问 `/` 不会返回控制台页面。

### 上线自检

1. 打开 `http://<host>:8787/health`，返回 `{"ok":true}`。
2. 打开控制台 → **钉钉企业配置**，确认「Stream 连接状态」为已连接。
3. 在钉钉单聊或群里 @ 机器人问一个简单问题，确认卡片能同时渲染思维链与正文；也可先在「大模型与人设」页发起沙盒对话，快速验证模型连通性。
4. 在群里发一条非 @ 的技术求助，确认机器人按策略主动回复；再发一条闲聊，确认保持安静。

---

## 功能说明

### 会话与卡片

- 单聊与群聊 @ 机器人走同一套回答链路，回答过程实时写入一张 AI 卡片。
- 卡片分三个区域：可折叠的思维链与工具轨迹、Markdown 正文、状态角标（思考中 / 调用工具 / 已完成）。
- 流式刷新按「最新值合并 + 单飞」提交，QPS 由令牌桶兜底，并带超时与指数退避重试，长回答不会刷屏或把钉钉接口打满。
- 过程性说明与最终答案分离：模型在调用工具前的铺垫先作为正文输出，一旦进入工具轮次即通过 `answer_reset` 移入思维链，正文只保留最终结论。
- 卡片模板支持 v2 布局：除思维链与正文外，额外渲染工具时间线、引用来源与操作区（发送 `/stop`、`/retry`）。
- 工具返回超过阈值时做头尾保留截断；来自外部 MCP 的内容会包裹为 `<untrusted_tool_output>`，提示模型按数据处理而非按指令执行。
- 关闭原生思维链后，卡片仅展示正文与工具轨迹。

### 对话内命令

在单聊或群里 @ 机器人发送以下命令（支持全角 `／`），不会触发模型推理：

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看可用命令 |
| `/status` | 当前会话是否正在生成、最近一次运行摘要 |
| `/stop` | 停止本会话正在进行的回答（卡片操作区同样可用） |
| `/retry` | 重跑上一条问题 |
| `/reset` | 清空本会话的历史消息 |
| `/trace` | 查看最近一次回答的推理与工具轨迹 |
| `/mute`、`/unmute` | 群内静音 / 恢复主动回复（仅管理员、仅群聊） |
| `/feedback <内容>` | 对最近一次回答提交反馈，写入 `user_feedback` |

同一会话的新问题会自动中止尚未完成的旧回答，避免并发写入同一张卡片。

### 定时任务与主动播报

管理端可以创建定时任务，在指定单聊或群聊中按固定间隔或 cron 主动发起一轮回答，例如每天 9 点汇总昨日错误日志、每小时巡检一次线上状态。

- 调度支持 `intervalSeconds`（最小 30 秒）或 5 段 cron（按 Asia/Shanghai 解释，支持 `*`、`*/n`、区间、列表，周日可写 `0` 或 `7`），二者只能选其一。
- 到点后以「定时任务」身份走完整的 ReAct 链路：卡片流式输出、工具调用、记忆与用量记账与正常问答一致。
- 单次失败不会阻塞其他任务，也不会在原定时间反复重试；失败原因写入日志，下一次仍按计划触发。
- 支持「立即执行」用于验证配置，执行后同样推进下一次触发时间。

### 群聊旁听与主动回复

机器人在群内的每一句话都会进入旁听缓冲，但绝大多数消息会在零 Token 的规则层被过滤，不会唤醒模型。是否主动回复由三级漏斗决定：

1. **规则预筛**：过滤表情、寒暄、确认短语；检查群是否处于冷却期、是否正忙于其他回答；用主题词做技术信号预筛。
2. **防抢答窗口**：疑似提问后等待一段时间，若期间已有同事回复，则保持沉默。
3. **模型判定**：对最近若干条消息做一次低温度、无工具、无思维链的结构化判定，只有 `PROACTIVE_REPLY` 且置信度达到阈值才唤醒智能体。

每个群都可以单独覆盖默认策略：

| 策略项 | 含义 |
| --- | --- |
| 旁听开关 | 是否对该群启用旁听判定与主动回复 |
| 非 @ 自主回复 | 是否允许主动发言 |
| 冷却时间 | 同群两次主动回复的最小间隔 |
| 滑动窗口 | 判定时参考的最近消息条数 |
| 置信度阈值 | 主动回复的最低把握 |
| 触发话题 | 重点关注的主题 |

管理员还可以一键**紧急静音**：关闭全部群的旁听与主动回复，机器人退回仅响应 @ 的状态。

### 三层记忆

| 层级 | 内容 | 生命周期 |
| --- | --- | --- |
| 工作记忆 | 当前会话最近消息 + 每个群的旁听窗口 | 进程内与数据库会话表 |
| 情景记忆 | 长对话经压缩后的摘要 | 持久化，随对话继续增量更新 |
| 语义记忆 | 团队术语、员工职责画像 | 持久化，按发言人、群与关键词召回 |

语义记忆在上下文组装时召回少量长期知识，避免把整段历史塞进提示词。配置 embedding 后按 pgvector 余弦距离检索，否则回退关键词匹配；embedding 服务异常时同样降级，不会阻塞回答。

### 工具能力

机器人的工具按需挂载，回答时会自行选择与组合：

| 工具源 | 能力 |
| --- | --- |
| 内置工具 | `current_time` 时区时间、`calculator` 安全表达式计算、`system_status` 进程与资源状态 |
| 企业 MCP | 通过 MCP 协议接入代码、数据、日志、接口文档等外部服务，可增删改查与热重载 |
| 钉钉 DWS | 以只读方式查询文档、知识库、日历、待办、通讯录与审批 |
| 隔离沙盒 | `sandbox_analyze_and_aggregate` 对工具返回的大批量数据做脚本化统计与聚合 |
| 管理员工具 | 仅在管理员单聊中出现的管控指令，普通员工与群聊不可见 |

#### 企业 MCP

首次启动读取 `config/mcp-servers.json`，之后以数据库中的配置为准。节点格式：

```json
{
  "servers": [
    {
      "id": "enterprise",
      "name": "企业 AI 中台",
      "domain": "general",
      "transport": "streamable-http",
      "endpointOrCommand": "${ENTERPRISE_MCP_ENDPOINT}",
      "envOrHeaders": { "authorization": "Bearer ${ENTERPRISE_MCP_TOKEN}" },
      "timeoutMs": 180000,
      "maxResultChars": 16000,
      "enabled": true
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 节点唯一标识，工具会以 `mcp__<id>__<tool>` 的形式暴露 |
| `domain` | `code` / `data` / `log` / `apidoc` / `business` / `general` |
| `transport` | `stdio` / `sse` / `streamable-http` |
| `endpointOrCommand` | HTTP 地址，或 stdio 模式的启动命令，支持 `${ENV}` 引用环境变量 |
| `args` | stdio 模式的启动参数，支持 `${ENV}` 引用环境变量 |
| `envOrHeaders` | stdio 的环境变量或 HTTP 的请求头，支持 `${ENV}` 引用环境变量 |
| `timeoutMs` / `maxResultChars` | 单次调用超时与结果长度上限 |

补充行为：

- `endpointOrCommand`、`args`、`envOrHeaders` 中的 `${VAR}` 在建立连接时按进程环境（`.env`）展开，地址与令牌只需写在 `.env`；变量缺失时连接失败并明确指出缺失的占位符。
- 连接中断会自动退避重连；节点健康状态与控制台展示同步。
- 一键连通性测试会新建连接并拉取该节点暴露的全部工具 Schema，可直接在控制台浏览。
- 超大工具结果不会原样塞进上下文，会截断为预览并落盘，供沙盒进一步分析。
- 支持按群、按角色的工具访问策略：可限制某群只能使用哪些节点、哪些工具。

#### 钉钉 DWS

启用后，机器人可以通过本机的 `dws` 命令行做只读查询，覆盖文档、知识库、日历、待办、通讯录与审批等域：

| 域 | 允许的只读子命令 |
| --- | --- |
| 文档 / 知识库 | `search`、`read`、`list`、`get` |
| 日历 | `list`、`today`、`search`、`freebusy` |
| 待办 | `list`、`search`、`get`、`today` |
| 通讯录 | `search`、`get`、`list`、`self` |
| 审批 | `list`、`search`、`get` |

使用前需要在运行机器上安装并登录 `dws` CLI。调用时不拼接 shell，当前发言人的身份通过环境变量注入；单次调用有 15 秒超时与输出长度上限，写操作不在支持范围内。

#### 隔离沙盒

`sandbox_analyze_and_aggregate` 用于处理「工具返回几百条记录，需要算个结论」这类问题：

- JavaScript 片段在受限虚拟机中执行，限制内存与时长。
- 其他语言在无网络、只读文件系统、内存受限的 Docker 容器中执行，需要运行机器已安装 Docker。
- 输入来自上一步工具结果，输出结构化统计与结论，避免把原始数据全部喂给模型。

### 动态推理预算

回答不是固定轮数，而是按预算动态收敛：

- **墙钟时间**：单轮回答超过时间上限即停止继续调用工具。
- **Token 预算**：累计 Token 触及上限后进入收尾。
- **同工具连续调用**：同一工具同参数重复调用达到上限会被拦截，迫使模型换思路。
- **信息收敛自检**：发现信息已足够时提前收尾，避免无意义的多轮调用。

预算耗尽时，机器人会做一次不带工具的汇总，保证仍有完整回答。

---

## 管理控制台

控制台与机器人同进程提供，默认地址 `http://<host>:8787/`，共七个页面：

| 页面 | 可以做什么 |
| --- | --- |
| **运行大盘** | 查看 Stream 状态、今日对话轮次与 Token、MCP 节点健康与工具数、各群旁听与主动回复统计、最近管理操作审计 |
| **在线对话** | 用一次性票据订阅 SSE，直接在浏览器体验与钉钉相同的流式推理、工具调用与最终回答 |
| **钉钉企业配置** | 修改 AppKey / AppSecret、RobotCode、AI 卡片模板、管理员白名单、DWS 开关；发送测试卡片验证链路 |
| **大模型与人设** | 切换模型渠道与模型、修改 Base URL / API Key / 温度 / 原生思维链、调整 ReAct 预算、在线编辑人设与语气，并发起沙盒对话测试 |
| **企业 MCP** | 增删改查节点、启停并热应用、一键连通性测试并浏览工具 Schema、维护按群 / 角色的工具权限 |
| **群聊旁听策略** | 查看全局默认策略、按群覆盖旁听与主动回复参数、一键紧急静音 |
| **ReAct 审计轨迹** | 按群过滤并分页查看每次回答的思维链、工具入参、耗时、沙盒输出与最终答案 |

使用说明：

- 首次打开会提示填写 **管理 API Token**，对应服务端 `ADMIN_API_TOKEN`，保存在浏览器本地。
- 所有改动保存后立即生效，无需重启；页面会显示热更新结果。
- AppSecret、模型 API Key 与 MCP 请求头不会回传明文。读取时显示掩码，**留空或保持掩码即表示不修改**；填写新值才会覆盖。
- 生产环境请通过反向代理限制控制台访问来源，并设置强随机 `ADMIN_API_TOKEN`。

---

## 管理员单聊（ChatOps）

管理员不需要打开网页，直接在钉钉里和机器人单聊就能完成大部分管控。例如：

- 「把默认大模型切换为 DeepSeek-R1」
- 「帮我测试并重载日志 MCP 服务」
- 「把研发大群的非 @ 主动回复冷却时间改成 10 分钟」
- 「查看今天调用耗时最长的 5 次查询」
- 「帮我看看今天消耗了多少 Token」
- 「紧急静音所有群」

对应的管控能力：

| 能力 | 说明 |
| --- | --- |
| `admin_inspect_system_status` | 在线 MCP 健康状态、今日 Token 与轮次、各群旁听与主动回复统计 |
| `admin_manage_mcp_server` | 启用 / 禁用 / 重载指定 MCP 节点，并返回最新工具清单 |
| `admin_update_llm_or_persona` | 切换模型、调整温度与原生思维链、修改人设与 ReAct 预算 |
| `admin_configure_group_bystander` | 查询群列表、开关旁听与主动回复、调整冷却等策略、一键紧急静音 |
| `admin_query_traces` | 按耗时或 Token 查询今日轨迹，定位最慢 / 最贵的调用 |

权限边界：

- 只有**单聊**且发送人命中 `ADMIN_STAFF_IDS` 白名单时，这些工具才会挂载。
- 普通员工的单聊与任何群聊中，管理工具在物理层面不存在，无法被提示词诱导调用。
- 每一次配置变更都会写入审计记录，包含操作人、动作类型与前后快照。

---

## 管理 API

控制台通过以下 REST 接口操作；ChatOps 在进程内复用同一配置中心与审计链路。接口前缀 `/api/v1/admin`，需要带上 `Authorization: Bearer <ADMIN_API_TOKEN>`（未配置 Token 时不校验）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health`、`/healthz` | 健康检查（无需鉴权） |
| GET | `/readyz` | 就绪探针：数据库与 Stream 连接，未就绪返回 503 |
| GET | `/metrics` | Prometheus 文本指标（需鉴权，可用 `?token=`） |
| GET | `/dashboard` | 大盘数据 |
| GET / PUT | `/config/dingtalk` | 读取 / 更新钉钉企业配置 |
| POST | `/config/dingtalk/test-card` | 发送测试卡片 |
| GET / PUT | `/config/llm` | 读取 / 更新模型、人设与预算 |
| POST | `/config/llm/test` | 沙盒对话测试 |
| GET | `/groups` | 已接入的群列表与最近活跃 |
| GET / PUT | `/groups/:conversationId/policy` | 读取 / 更新单群旁听策略 |
| POST | `/groups/emergency-mute` | 紧急静音（可指定单群或全部群） |
| GET / POST / PUT / DELETE | `/mcp-servers` `/mcp-servers/:id` | MCP 节点管理 |
| POST | `/mcp-servers/:id/test` | 连通性测试并返回工具 Schema |
| GET / PUT | `/mcp-access-policies` | 按群 / 角色的工具权限 |
| GET | `/traces` | 分页查询 ReAct 轨迹（支持按群、时间过滤） |
| GET | `/audit-logs` | 管理操作审计 |
| POST | `/chat/tickets` | 换取一次性 SSE 票据（60 秒内有效、用后即焚） |
| GET | `/api/v1/chat/stream?ticket=&question=` | 浏览器在线对话流（SSE，事件与钉钉卡片同源） |
| GET | `/feedback` | 用户反馈列表 |
| GET | `/usage?days=1` | 用量汇总：总 Token、按员工与按群排名 |
| GET / POST | `/scheduled-tasks` | 定时任务列表 / 创建 |
| PUT / DELETE | `/scheduled-tasks/:id` | 更新 / 删除定时任务 |
| POST | `/scheduled-tasks/:id/run` | 立即执行一次 |

---

## 安全与数据

| 方面 | 做法 |
| --- | --- |
| 管理入口 | 管理 API 用 Bearer Token；ChatOps 用管理员 StaffId 白名单；未设置 Token 时会在启动日志中明确告警 |
| 凭据保护 | AppSecret、模型 API Key、MCP 请求头在接口与审计中只出现掩码，前端不可回读明文 |
| 命令执行 | DWS 仅开放只读子命令；参数做白名单与长度校验 |
| 代码执行 | 沙盒无网络、只读文件系统、内存与时长受限 |
| 群内行为 | 旁听不响应、主动回复受冷却与置信度双重限制，支持一键静音 |
| 审计 | 每次配置变更记录操作人、动作类型、变更前后快照与时间 |
| 数据存储 | 会话、记忆与动态配置存于 PostgreSQL；密钥不会通过接口或审计明文回传 |

主要数据表：

| 表 | 内容 |
| --- | --- |
| `conversations` / `messages` | 会话与消息（含推理过程、Token 用量） |
| `conversation_summaries` | 情景摘要 |
| `semantic_memories` | 术语与职责画像（含向量） |
| `bystander_policies` | 群级旁听策略 |
| `sys_configs` | 动态配置（钉钉、模型、预算、MCP、默认群策略） |
| `react_traces` | ReAct 执行轨迹 |
| `admin_audit_logs` | 管理操作审计 |
| `user_feedback` | 用户对回答的反馈（`/feedback` 命令） |
| `usage_ledger` | 每次模型调用的 Token、模型、耗时与场景 |
| `scheduled_tasks` | 定时主动播报任务与下次触发时间 |

---

## 运维与排障

日常运维要点：

- 健康检查：`GET /health`。
- 配置以数据库为准，重启后自动恢复；数据库不可用时进程会启动失败，请先确认连接与建表已就绪。
- 日志按级别输出到标准流，交由容器或系统日志收集。
- 机器人与管理控制台同进程，单实例部署；水平扩容时注意 Stream 连接与群内冷却状态的一致性。

常见问题：

| 现象 | 排查方向 |
| --- | --- |
| 启动即退出并列出缺失变量 | 按提示补齐 `.env` 中的必需项 |
| 访问 `/` 是 404 | 未执行 `pnpm build`，控制台静态资源不存在 |
| 控制台接口返回 401 | `ADMIN_API_TOKEN` 与控制台里填写的 Token 不一致 |
| 控制台任何请求都能进 | 服务端未设置 `ADMIN_API_TOKEN`，仅应在受控网络使用 |
| MCP 节点显示连接失败 | 检查网络 / 代理 / 证书与请求头令牌；用「测试」按钮查看具体错误 |
| MCP 显示在线但工具数为 0 | 节点未暴露工具，或启动时连接尚未完成；点「测试」可确认该节点实际暴露的工具 |
| 群里不主动回复 | 检查群策略开关、冷却时间、置信度阈值，以及是否处于防抢答窗口 |
| 卡片没有思维链 | 关闭了原生思维链，或所用模型不返回推理内容 |
| 审计轨迹为空 | 还没有产生过 ReAct 调用；先让机器人回答一次问题 |
| DWS 查询报错 | 本机 `dws` 登录态过期，需要重新登录后重试 |
| 工具结果被截断 | 超过了节点 `maxResultChars`，可调大上限或用沙盒对落盘数据做聚合 |

---

## 已知边界

- 动态配置面向单实例进程；多实例部署需要额外的配置分发与广播机制。
- 群聊旁听缓冲位于进程内存，重启后由新消息重新积累；摘要与语义记忆不受影响。
- 主动回复由模型判定驱动，不解析固定口令；对主题词与置信度的调整比改提示词更有效。
- DWS 仅支持只读查询，审批处理、文档写入等写操作不在范围内。
- 管理控制台是现代浏览器单页应用，不提供旧版浏览器兼容。
- 真实钉钉、真实模型与企业 MCP 的联通性取决于部署环境的网络与凭据，需要在实际环境中验证。

---

## 反馈

问题、建议或接入需求，欢迎在 [Issues](https://github.com/SongJok/anthys/issues) 中提出。
