# 钉钉智能体

一个面向企业内部的知识与运维助手：以钉钉机器人的形态出现在单聊和群聊里，使用企业的 MCP 服务、钉钉 DWS 能力与隔离沙盒回答跨系统问题；在群里不打扰地旁听，只在真正需要时主动介入；回答过程与管控操作都留痕、可审计，运行期的模型、人设、预算、MCP、群策略与钉钉凭据都能在线热更新而无需重启。

- **开箱即用的钉钉接入**：基于 Stream 模式，不需要公网域名、Webhook 或内网穿透。
- **过程可见的回答**：AI 卡片实时展示状态角标与流式正文，工具调用与推理过程仍完整落库可审计。
- **克制的主动回复**：群内全量旁听，经三级漏斗判断后才对高优故障、技术求助作出回应。
- **越用越懂团队**：工作记忆 + 情景摘要 + 语义画像三层记忆，跨会话保留上下文；企业术语库把内部黑话沉淀成可检索、可校验的固定模板。
- **双通道动态管控**：管理员既可以在钉钉单聊里用自然语言下达指令，也可以在 Web 控制台逐项配置，保存即生效。
- **企业级边界**：管理员白名单、DWS 命令白名单与写操作确认、沙箱隔离、凭据掩码与全量操作审计。

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
| 流程查询 | @ 机器人问「本周日程」「我的待办」「这份文档怎么规定的」，机器人调用 DWS 查询；确认后也可建日程、建待办、发审批 |
| 知识沉淀 | 团队术语、同事职责、历史结论被逐步记住，后续回答不再从零解释 |
| 运营管控 | 管理员随时切换模型、调预算、增删 MCP、调整群策略，或一键紧急静音 |
| 需求把关 | 超过 15 分钟 / 12 万 Token 或明文写着重活的需求，机器人直接说明不认可并停止执行，避免长时间空转 |

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
5. 状态角标与正文实时写入同一张 AI 卡片，思维链与工具轨迹同步落库，员工可以边等边看。
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
2. 在钉钉卡片平台创建 **AI 卡片模板**（卡片模板场景必须选 **「AI 卡片」**），模板内需要一个用于流式输出的 **Markdown 变量**，默认名 `content`：

   | 变量 | 用途 |
   | --- | --- |
   | `content` | 卡片正文：状态角标、答案与参考来源按顺序实时写入 |

   > 钉钉的流式更新接口（`PUT /v1.0/card/streaming`）只对 AI 卡片模板的 `content` 字段生效；写入 `thinking_section` / `answer_section` / `status_bar` 等自定义变量会返回 `500 未知错误`，卡片会停在「处理中」。如模板的内容字段另有命名，通过 `DINGTALK_CARD_CONTENT_KEY` 指定。
   > 应用需在权限管理中开通 `Card.Instance.Write`、`Card.Streaming.Write` 与 `qyapi_robot_sendmsg`，并把模板关联到该应用。

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
| `DINGTALK_CARD_TEMPLATE_ID` | 必填 | AI 卡片模板 ID（场景必须为「AI 卡片」，见上） |
| `DINGTALK_CARD_LAYOUT` | `ai` | 卡片布局：`ai` 单 `content` 流式字段；`v1`/`v2` 多变量模板 |
| `DINGTALK_CARD_CONTENT_KEY` | `content` | `ai` 布局下的流式字段名，需与模板变量一致 |
| `DINGTALK_CARD_SHOW_THINKING` | `false` | 是否在卡片中展示具体思维链与工具细节；状态角标始终展示 |
| `DINGTALK_BOT_EMOTION_ENABLED` | `true` | 处理问题期间在用户消息上贴表情，回答交付后撤回 |
| `DINGTALK_BOT_EMOTION_NAME` | `Like` | 贴的表情名（钉钉表情列表英文文案，`Like` 即「赞」） |

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
| `LOOP_MAX_WALL_TIME_MS` | `900000` | 单轮回答的最大墙钟时间（15 分钟），超出即拒接并停止 |
| `LOOP_MAX_TOTAL_TOKENS` | `120000` | 单轮回答的 Token 上限，超出即拒接并停止 |
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

**企业术语知识库**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLOSSARY_PROMPT_ENABLED` | `true` | 是否把高频术语注入系统提示词 |
| `GLOSSARY_PROMPT_LIMIT` | `80` | 系统提示注入条数上限，最大 100 |
| `GLOSSARY_RETRIEVAL_LIMIT` | `4` | 每次提问检索的术语卡条数上限，最大 10 |

术语内容全部在控制台「术语知识库」页面维护；启用 `EMBEDDING_ENABLED` 后，术语检索会在关键词未命中时回退 pgvector 相似度召回，历史术语的向量会在启动后台补齐。

**多模态入站与产物投递**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VISION_ENABLED` | `false` | 是否调用视觉模型把用户图片转成文字描述 |
| `VISION_BASE_URL` | 沿用 `LLM_BASE_URL` | 视觉模型接口地址 |
| `VISION_API_KEY` | 沿用 `LLM_API_KEY` | 视觉模型接口密钥 |
| `VISION_MODEL` | 沿用 `LLM_MODEL` | 支持图片输入的模型名，如 `qwen-vl-max` |
| `ATTACHMENT_MAX_MB` | `20` | 入站附件大小上限 |
| `ARTIFACT_DELIVERY_ENABLED` | `true` | 是否向模型暴露 `deliver_artifact` 文件回传工具 |
| `ARTIFACT_MAX_MB` | `20` | 回传文件大小上限 |
| `ARTIFACT_ROOTS` | 空 | 额外允许回传的目录（逗号分隔，相对项目根目录） |

入站图片与文件会先按 `downloadCode` 换取下载地址，落盘到 `.workspace/attachments/<messageId>/`；启用视觉模型后，图片会附带一段文字描述再交给主模型。未启用时仅保留本地路径，可提示用户改用文字描述。

**写操作确认**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TOOL_CONFIRMATION_ENABLED` | `true` | 是否要求写操作先经 `/confirm` 确认；关闭后全部工具直接执行 |
| `TOOL_CONFIRMATION_TTL_SECONDS` | `300` | 待确认动作的有效期（秒） |

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

**规划器与子代理**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLANNER_ENABLED` | `false` | 是否在长问题/工具较多时先产出 3–7 步计划再进入 ReAct 循环 |
| `PLANNER_MIN_CHARS` | `80` | 触发规划的用户问题最小字符数 |
| `PLANNER_MIN_TOOLS` | `8` | 触发规划的最小可用工具数（与字符数条件取或） |
| `SUBAGENT_ENABLED` | `false` | 是否向模型暴露 `delegate_research`，派发只读子代理做专题检索 |
| `SUBAGENT_TIMEOUT_SECONDS` | `90` | 单个子代理的墙钟上限（秒） |
| `SUBAGENT_MAX_TOKENS` | `20000` | 单个子代理的 Token 预算 |

规划器只产出步骤文本并注入系统提示，不额外占用工具调用；计划进度会在卡片轨迹中实时更新。子代理只能使用只读工具，拥有独立预算与超时，且不会触发写操作确认流程。

**多实例部署（可选）**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLUSTER_ENABLED` | `false` | 通过 PostgreSQL advisory lock 选主；仅 leader 消费 Stream，standby 只提供健康检查与管理端 |
| `CLUSTER_LOCK_KEY` | `dingtalk-agent` | 选主锁名，同时用于共享状态表的命名空间 |
| `CLUSTER_RETRY_SECONDS` | `5` | standby 重新抢主的间隔（秒） |
| `CLUSTER_HEARTBEAT_SECONDS` | `10` | leader 续约心跳间隔（秒） |
| `CLUSTER_CONFIG_POLL_SECONDS` | `30` | 从共享配置表拉取其他实例变更的间隔（秒） |

启用集群后，去重、旁听冷却与群聊转录状态写入 `cluster_shared_state` 表，任一实例重启都不会丢失去重窗口和冷却时间。配置变更会落库，其他实例在下一轮轮询时按分区（`llm`/`loopPolicy`/`dingtalk`/`mcp`/`routes`）触发对应的热更新事件。数据库不可达时自动回退到进程内状态，单实例部署无需开启。

**数据治理与脱敏**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATA_REDACTION_ENABLED` | `true` | 日志与 ReAct 轨迹落库前脱敏手机号、邮箱、身份证号与常见密钥格式 |
| `RETENTION_MESSAGES_DAYS` | `180` | 会话消息与情景摘要保留天数 |
| `RETENTION_TRACES_DAYS` | `90` | ReAct 轨迹保留天数 |
| `RETENTION_ATTACHMENTS_HOURS` | `24` | 入站附件目录保留小时数 |
| `RETENTION_AUDIT_DAYS` | `365` | 管理审计日志保留天数 |
| `RETENTION_USAGE_DAYS` | `365` | 用量流水保留天数 |
| `DATA_CLEANUP_INTERVAL_SECONDS` | `86400` | 定时清理间隔；集群模式下仅 leader 执行 |
| `DATA_CLEANUP_DRY_RUN` | `false` | 定时清理只统计不删除，适合上线前观察 |

保留期可在控制台「数据治理」页调整，调整后写入 `governance_settings`，重启后仍生效。手动清理默认 dry-run，确认后再执行删除；按会话或员工级联删除会同步清理消息、摘要、轨迹、用量、反馈、旁听策略、定时任务与对应附件目录，并要求显式 `confirm`，操作会写入管理审计。日志脱敏覆盖普通文本参数与结构化对象字段；如需排障保留原文，可临时设置 `DATA_REDACTION_ENABLED=false`。

**管理控制台与企业 MCP**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | 空 | 管理 API 的 Bearer Token；为空时不做校验 |
| `ADMIN_PORT` | `8787` | 管理 API 与控制台端口 |
| `ADMIN_STAFF_IDS` | 空 | 允许使用管理指令的钉钉 StaffId（逗号分隔），与 `DINGTALK_ADMIN` 合并去重 |
| `DINGTALK_ADMIN` | 空 | 机器人管理员的 StaffId，与 `ADMIN_STAFF_IDS` 等价；也可在控制台「系统设置」的管理员白名单中调整 |
| `DWS_CLI_ENABLED` | `true`（`.env.example` 中为 `false`） | 是否启用 DWS 命令行工具源 |
| `DWS_BINARY` | `dws` | `dws` 可执行文件路径；需要指定 Node 版本时可指向包装脚本 |
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
3. 在钉钉单聊或群里 @ 机器人问一个简单问题，确认卡片先显示「正在思考…」、随后流式渲染正文并切到「已完成」；也可先在「大模型与人设」页发起沙盒对话，快速验证模型连通性。
4. 在群里发一条非 @ 的技术求助，确认机器人按策略主动回复；再发一条闲聊，确认保持安静。

---

## 功能说明

### 会话与卡片

- 单聊与群聊 @ 机器人走同一套回答链路，回答过程实时写入一张 AI 卡片。
- 收到消息后先投递占位卡片（`正在思考…`）再开始解析附件与推理，附件较多时用户也能立刻看到反馈；同时机器人在原消息上贴一个表情，回答交付后自动撤回。
- 群聊被 @ 提问时，回复正文第一行先点名提问人（`@昵称`）再给答案；卡片投递本身带 `atUserIds`，文本兜底则用 `@userId` + `at.atUserIds` 组成真实提及。群内主动插话、定时播报不点名。
- 卡片使用 AI 卡片模板的 `content` 单字段流式输出：状态角标、答案与参考来源按顺序合成一份 Markdown 写入，收尾时带 `isFinalize` 让卡片从「处理中」切到「完成」，答案就在第一张卡片里，不会再发一条重复消息。
- 默认**不在卡片里展示具体思维链与工具入参**，只保留状态角标（正在思考 / 正在调用工具 / 已完成）；思维链仍写入审计轨迹。需要把过程也展示给员工时置 `DINGTALK_CARD_SHOW_THINKING=true`。
- 单条卡片内容控制在约 2400 字符内（超出部分回答收尾后由文本兜底补发），避免钉钉单 block 超长导致卡片渲染空白。
- 流式刷新按「最新值合并 + 单飞」提交，QPS 由令牌桶兜底，并带超时与指数退避重试，长回答不会刷屏或把钉钉接口打满；隐藏思维链时纯思考增量不触发刷新。
- 过程性说明与最终答案分离：模型在调用工具前的铺垫先作为正文输出，一旦进入工具轮次即通过 `answer_reset` 移入思维链，正文只保留最终结论。
- 旧的多变量模板仍可通过 `DINGTALK_CARD_LAYOUT=v1|v2` 启用：分别渲染思维链/正文/状态角标，或额外渲染工具时间线、引用来源与操作区（发送 `/stop`、`/retry`）。
- 工具返回超过阈值时做头尾保留截断；来自外部 MCP 的内容会包裹为 `<untrusted_tool_output>`，提示模型按数据处理而非按指令执行。
- 关闭原生思维链后，卡片与审计轨迹都不再包含推理内容。
- 卡片创建失败，或正文/收尾更新重试耗尽时，自动降级为 `sessionWebhook` 文本回复：长答案按 1500 字符分片并标注「（i/n）」，单片失败按指数退避重试，单片仍失败也会继续发送剩余分片，保证用户至少收到部分内容。

### 附件与产物

- 支持在单聊或群里直接发送**图片、文件**（语音/视频按文件落盘）并 @ 机器人提问；附件按下载码落盘到 `.workspace/attachments/<messageId>/`，提示词里会附带文件名、大小与本地路径。
- 开启 `VISION_ENABLED` 后，图片先由视觉模型转成文字描述（界面文字、报错信息、图表要点），主模型无需支持多模态即可理解截图；视觉接口失败时只保留路径并记录告警。
- 模型可通过 `deliver_artifact` 工具把工作区内的文件回传为钉钉文件消息：先上传媒体换取 `media_id`，再按单聊/群聊接口发送；只允许白名单目录（`.workspace` 与 `ARTIFACT_ROOTS`），超限或越界会直接拒绝。
- 入站附件下载失败不会丢弃整条消息：失败项会写进提示词，用户仍可收到基于现有信息的回答；指标 `agent_attachments_total` / `agent_attachment_failures_total` 可观察下载情况。

### 写操作确认与引用来源

- 命中写操作的工具（MCP 或 DWS 中声明为 `write` / `destructive`，或按工具名推断）不会直接执行：机器人先登记一次待确认动作，把参数与风险等级展示出来，并结束本轮回答。
- 用户回复 `/confirm` 才真正执行，回复 `/cancel` 丢弃；确认请求 5 分钟（`TOOL_CONFIRMATION_TTL_SECONDS`）内有效，同一会话新请求会覆盖旧请求。
- 待确认动作只允许发起人或管理员确认；确认时执行的是登记时缓存的参数，不会让模型重新生成一遍调用。
- 设置 `TOOL_CONFIRMATION_ENABLED=false` 可关闭闸门，所有工具直接执行。
- 工具输出中的 URL 会自动提取为「参考来源」：去重、保留前若干个，并随 `citation` 事件推送到卡片引用区与轨迹。

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
| `/dws-status` | 查看 DWS CLI 授权状态与令牌到期时间（仅管理员） |
| `/dws-login` | 发起 DWS 设备码重新授权（仅管理员） |
| `/mute`、`/unmute` | 群内静音 / 恢复主动回复（仅管理员、仅群聊） |
| `/feedback <内容>` | 对最近一次回答提交反馈，写入 `user_feedback` |
| `/confirm` | 执行本会话待确认的写操作（仅发起人或管理员） |
| `/cancel` | 取消本会话待确认的写操作 |

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

### 企业术语知识库

内部黑话、缩写与项目代号在控制台「术语知识库」页面维护，每条术语固定使用同一套模板：标准名称、常见别名/缩写、定义、使用场景、示例句子、不要误解为、所属部门/项目、时效性（长期 / 项目期 / 已废弃）、敏感级别（公开 / 团队内 / 敏感）、关联文档链接与最后更新时间。

机器人按性价比分三层使用术语：

| 层次 | 做法 | 适用 |
| --- | --- | --- |
| 系统提示注入 | 按注入权重、命中次数选出 Top N（默认 80、上限 100）高频术语，压缩成单行速查并随每轮系统提示下发 | 高频、稳定、可公开的术语 |
| 按问检索 | 先按标准名 / 别名 / 定义命中，未命中再走 pgvector；命中的术语以完整模板卡片加入本轮上下文 | 长尾术语与项目期黑话 |
| `glossary_lookup` 工具 | 模型遇到不确定的词时主动查询，返回定义、别名、示例、易误解点与来源文档；未收录时明确提示向提问者确认 | 模型无法判断时兜底 |

安全与质量策略：

- 敏感级别术语永不进入系统提示；群聊中的检索与查询工具也会自动排除，只有单聊可以按需命中。
- 已废弃术语不参与提示注入，命中时会标注「已废弃」提醒改用规范说法。
- 管理页提供质量校验：缺定义、非法文档链接、名称/别名冲突、项目期术语长期未更新、废弃术语仍开启注入等问题会分级列出。
- 术语写入带 30 秒进程内缓存，管理端新增、更新、删除后立即失效，无需重启。
- 审计日志只记录术语的元数据快照，不复制敏感术语正文。

### 工具能力

机器人的工具按需挂载，回答时会自行选择与组合：

| 工具源 | 能力 |
| --- | --- |
| 内置工具 | `current_time` 时区时间、`calculator` 安全表达式计算、`system_status` 进程与资源状态 |
| 企业 MCP | 通过 MCP 协议接入代码、数据、日志、接口文档等外部服务，可增删改查与热重载 |
| 钉钉 DWS | 查询文档、知识库、日历、待办、通讯录与审批；写操作（建日程、建待办、改通讯录、发审批）经 `/confirm` 二次确认 |
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

启用后，机器人可以通过本机的 `dws` 命令行查询并办理文档、知识库、日历、待办、通讯录与审批等事务：

| 域 | 只读命令 | 写命令（需 `/confirm`） |
| --- | --- | --- |
| 文档 / 知识库 | `search`、`read`、`list`、`get` | — |
| 日历 | `list`、`today`、`search`、`freebusy` | `event create`、`event update`、`event delete` |
| 待办 | `list`、`search`、`get`、`today` | `task create`、`task update`、`task done` |
| 通讯录 | `search`、`get`、`list`、`self` | `user invite`、`user update` |
| 审批 | `list-pending`、`list-submitted`、`detail`、`records`、`tasks`、`list-forms`、`search-forms`、`form-schema` | `create-instance`、`approve`、`reject` |

对应的模型工具：

| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `dws_doc_search_and_read` | read | 文档与知识库检索、读取 |
| `dws_org_and_schedule` | read | 通讯录、日程、待办、审批的只读查询，只接受只读子命令 |
| `dws_calendar_manage` | write | 创建 / 修改日程 |
| `dws_calendar_cancel` | destructive | 取消（删除）日程 |
| `dws_todo_manage` | write | 创建 / 修改 / 完成待办，创建时执行人默认当前提问人 |
| `dws_contact_manage` | write | 邀请员工或修改员工组织信息 |
| `dws_approval_manage` | write | 发起、同意、拒绝审批 |

写工具统一声明 `write` / `destructive`，会先进入「写操作确认」闸门：机器人展示参数与风险，用户回复 `/confirm` 后才真正执行；执行时携带 `--yes`，避免 CLI 在无终端环境中等待交互确认。

使用前需要在运行机器上安装并登录 `dws` CLI。调用时不拼接 shell，当前发言人的身份通过环境变量注入；单次调用有 15 秒超时与输出长度上限。

**权限缺失时主动通知管理员：**

- DWS 返回应用/接口级权限错误（如 `AccessTokenPermissionDenied`、`没有调用该接口的权限`）时，机器人会停止重复调用，并给 `ADMIN_STAFF_IDS` 中的管理员（不含提问人本人）发一条单聊通知。
- 通知包含提问人、会话、命令、原始错误、需要开通的权限点，以及处理办法：开放平台权限管理开通、`dws dev app permission ...` 命令行开通、权限点需审批时创建版本 → 提审 → 发布生效、管理员重新 `/dws-login` 授权、或暂时在「钉钉企业配置」关闭 DWS 开关。
- 同一会话同一操作 10 分钟内只通知一次，避免刷屏；文档/知识库的单篇文档无权访问不会升级为管理员通知。
- 工具结果会附带指令，要求模型向提问人说明「缺少哪项权限、已通知管理员」，而不是编造操作成功。

**授权过期时不会卡住用户：**

- 每次调用 DWS 前检查 `dws auth status`（结果缓存 60 秒）；工具执行失败且报错涉及登录/令牌时立即强制复检。
- 一旦确认过期，当前会话会立即收到一条提醒：管理员收到可直接打开的钉钉设备授权链接与授权码（15 分钟内有效），非管理员则收到「联系管理员」提示。本轮回答继续完成，不需要等待授权。
- 管理员也可以随时发送 `/dws-login` 手动发起授权，或发送 `/dws-status` 查看当前账号与令牌到期时间。
- 授权完成后会自动通知原会话，并自动重跑刚才那条问题，无需用户重新提问。
- 只有管理员能发起新的设备授权，因为完成授权会把授权人的钉钉身份绑定到本机 `dws` 配置。
- 如果 `dws` 因 Node 版本或 PATH 问题无法启动，会按「不可用」处理并保留原始错误，不会误报成授权过期。

#### 隔离沙盒

`sandbox_analyze_and_aggregate` 用于处理「工具返回几百条记录，需要算个结论」这类问题：

- JavaScript 片段在受限虚拟机中执行，限制内存与时长。
- 其他语言在无网络、只读文件系统、内存受限的 Docker 容器中执行，需要运行机器已安装 Docker。
- 输入来自上一步工具结果，输出结构化统计与结论，避免把原始数据全部喂给模型。

### 需求准入与拒接

机器人只接单轮可在 15 分钟内完成、且不超过 12 万 Token 的需求；判断为过重时明确拒接而不是硬扛：

- **明文超时即拒接**：提问里写明「需要 20 分钟以上」「大概 40 分钟」「跑 2 小时」这类任务耗时，或出现「通宵」「数小时」「全量迁移」等长时间任务字眼时，不调用模型、不写记忆，直接回复「机器人不认可这个需求，已关闭执行」，并建议拆成几分钟内能完成的小任务。
- **短任务不误伤**：「25 分钟后提醒我开会」「会议时长改成 30 分钟」这类时长描述不是任务耗时，仍正常执行。
- **运行时超限即中止**：执行超过 15 分钟或累计超过 120000 tokens 时立即停止调用工具，不再补一轮汇总，卡片只展示拒接说明与拆分建议，不会用半成品拼凑答案。
- **旁听不扰民**：群里旁听到的需求超限时静默跳过，不主动发言。
- 阈值由 `LOOP_MAX_WALL_TIME_MS` / `LOOP_MAX_TOTAL_TOKENS` 控制，管理控制台「大模型与人设」页可在线调整并即时生效。

### 动态推理预算

回答不是固定轮数，而是按预算动态收敛：

- **墙钟时间**：单轮回答超过时间上限即停止并拒接。
- **Token 预算**：累计 Token 触及上限后停止并拒接。
- **同工具连续调用**：同一工具同参数重复调用达到上限会被拦截，迫使模型换思路。
- **信息收敛自检**：发现信息已足够时提前收尾，避免无意义的多轮调用。

预算耗尽属于「需求过重」，机器人会输出拒接说明并关闭执行，不再做收尾汇总。

---

## 管理控制台

控制台与机器人同进程提供，默认地址 `http://<host>:8787/`，共九个页面：

| 页面 | 可以做什么 |
| --- | --- |
| **运行大盘** | 查看 Stream 状态、今日对话轮次与 Token、MCP 节点健康与工具数、各群旁听与主动回复统计、最近管理操作审计 |
| **在线对话** | 用一次性票据订阅 SSE，直接在浏览器体验与钉钉相同的流式推理、工具调用与最终回答 |
| **钉钉企业配置** | 修改 AppKey / AppSecret、RobotCode、AI 卡片模板、管理员白名单、DWS 开关；发送测试卡片验证链路 |
| **大模型与人设** | 切换模型渠道与模型、修改 Base URL / API Key / 温度 / 原生思维链、调整 ReAct 预算、在线编辑人设与语气，并发起沙盒对话测试 |
| **企业 MCP** | 增删改查节点、启停并热应用、一键连通性测试并浏览工具 Schema、维护按群 / 角色的工具权限 |
| **群聊旁听策略** | 查看全局默认策略、按群覆盖旁听与主动回复参数、一键紧急静音 |
| **ReAct 审计轨迹** | 按群过滤并分页查看每次回答的思维链、工具入参、耗时、沙盒输出与最终答案 |
| **术语知识库** | 按固定模板增删改查内部黑话，按名称 / 别名 / 时效性 / 敏感级别检索，查看注入命中统计、质量校验结果与系统提示预览 |
| **数据治理** | 调整各表保留期、查看超期行数与附件占用、先 dry-run 再清理，以及按会话 / 员工级联删除 |

使用说明：

- 首次打开会提示填写 **管理 API Token**，对应服务端 `ADMIN_API_TOKEN`，保存在浏览器本地。
- 管理员身份来自 `.env` 的 `DINGTALK_ADMIN`（与 `ADMIN_STAFF_IDS` 合并），也可以在控制台「系统设置」的管理员白名单里改，保存即生效。
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

- 只有**单聊**且发送人命中管理员白名单（`.env` 的 `DINGTALK_ADMIN` / `ADMIN_STAFF_IDS`，或控制台里配置的名单）时，这些工具才会挂载。
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
| GET | `/glossary` | 术语列表（支持名称 / 别名搜索、时效性 / 敏感级别 / 只看已注入过滤） |
| GET | `/glossary/stats` | 术语总数、注入数、敏感 / 废弃 / 缺定义统计 |
| GET | `/glossary/validate` | 术语质量校验报告 |
| GET | `/glossary/prompt-preview` | 预览实际注入系统提示的术语段落 |
| GET | `/glossary/:id` | 读取单条术语 |
| POST | `/glossary` | 创建术语 |
| PUT / DELETE | `/glossary/:id` | 更新 / 删除术语 |
| GET | `/audit-logs` | 管理操作审计 |
| POST | `/chat/tickets` | 换取一次性 SSE 票据（60 秒内有效、用后即焚） |
| GET | `/api/v1/chat/stream?ticket=&question=` | 浏览器在线对话流（SSE，事件与钉钉卡片同源） |
| GET | `/feedback` | 用户反馈列表 |
| GET | `/usage?days=1` | 用量汇总：总 Token、按员工与按群排名 |
| GET / POST | `/scheduled-tasks` | 定时任务列表 / 创建 |
| PUT / DELETE | `/scheduled-tasks/:id` | 更新 / 删除定时任务 |
| POST | `/scheduled-tasks/:id/run` | 立即执行一次 |
| GET | `/governance` | 保留策略、各表行数与超期行数、附件占用 |
| PUT | `/governance/retention` | 更新保留期（落库，重启后仍生效） |
| POST | `/governance/cleanup` | 清理过期数据，默认 `dryRun: true` |
| POST | `/governance/delete-conversation` | 按会话级联删除（需 `confirm: true`） |
| POST | `/governance/delete-user` | 按员工级联删除（需 `confirm: true`） |

---

## 安全与数据

| 方面 | 做法 |
| --- | --- |
| 管理入口 | 管理 API 用 Bearer Token；ChatOps 用管理员 StaffId 白名单；未设置 Token 时会在启动日志中明确告警 |
| 凭据保护 | AppSecret、模型 API Key、MCP 请求头在接口与审计中只出现掩码，前端不可回读明文 |
| 命令执行 | DWS 子命令白名单 + 参数校验；写操作必须经 `/confirm` 二次确认，取消日程等标记为高危 |
| 代码执行 | 沙盒无网络、只读文件系统、内存与时长受限 |
| 群内行为 | 旁听不响应、主动回复受冷却与置信度双重限制，支持一键静音 |
| 审计 | 每次配置变更记录操作人、动作类型、变更前后快照与时间 |
| 脱敏与保留 | 日志/轨迹默认掩码手机号、邮箱、身份证号与密钥；各表按保留期定时清理，支持按会话/员工级联删除 |
| 数据存储 | 会话、记忆与动态配置存于 PostgreSQL；密钥不会通过接口或审计明文回传 |

主要数据表：

| 表 | 内容 |
| --- | --- |
| `conversations` / `messages` | 会话与消息（含推理过程、Token 用量） |
| `conversation_summaries` | 情景摘要 |
| `semantic_memories` | 术语与职责画像（含向量） |
| `glossary_terms` | 企业术语知识库：固定模板字段、注入权重、命中次数与向量 |
| `bystander_policies` | 群级旁听策略 |
| `sys_configs` | 动态配置（钉钉、模型、预算、MCP、默认群策略） |
| `react_traces` | ReAct 执行轨迹 |
| `admin_audit_logs` | 管理操作审计 |
| `user_feedback` | 用户对回答的反馈（`/feedback` 命令） |
| `usage_ledger` | 每次模型调用的 Token、模型、耗时与场景 |
| `scheduled_tasks` | 定时主动播报任务与下次触发时间 |
| `cluster_shared_state` | 多实例共享的去重窗口、旁听冷却与群聊转录状态（仅集群模式写入） |
| `governance_settings` | 管理端调整的保留期策略（覆盖 env 默认值） |

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
| 卡片没有思维链 | 默认如此：`DINGTALK_CARD_SHOW_THINKING=false`；置 `true` 才展示。若开启后仍为空，检查是否关闭了原生思维链或模型不返回推理内容 |
| 卡片没刷新但收到了纯文本答案 | 卡片接口/模板异常触发降级，查看日志中 `card answer delivery unrecoverable` 与 `text fallback` 记录 |
| 卡片一直停在「处理中」，答案另发一条消息 | 日志 `streamingUpdate failed` 若为 `500 未知错误`，多为模板不是「AI 卡片」场景或模板没有 `content` 变量；按上文重新创建模板或调整 `DINGTALK_CARD_CONTENT_KEY` |
| 消息上没有出现处理中表情 | 应用未开通机器人表情权限，日志中会有 `reply emotion failed`；可置 `DINGTALK_BOT_EMOTION_ENABLED=false` 关闭 |
| 审计轨迹为空 | 还没有产生过 ReAct 调用；先让机器人回答一次问题 |
| DWS 查询报错 | 本机 `dws` 登录态过期：管理员发送 `/dws-login` 扫码授权；授权完成后机器人会自动重跑原问题 |
| DWS 提示缺权限 | 应用未开通对应权限点：管理员会收到含权限点与开通命令的单聊通知；按通知开通并重新 `/dws-login` 后重试 |
| 工具结果被截断 | 超过了节点 `maxResultChars`，可调大上限或用沙盒对落盘数据做聚合 |

---

## 已知边界

- 动态配置面向单实例进程；多实例部署需要额外的配置分发与广播机制。
- 群聊旁听缓冲位于进程内存，重启后由新消息重新积累；摘要与语义记忆不受影响。
- 主动回复由模型判定驱动，不解析固定口令；对主题词与置信度的调整比改提示词更有效。
- DWS 的写操作（建日程、建待办、改通讯录、发审批）需要应用开通对应权限点；缺失时机器人会通知管理员，但不会自动替管理员开通或发版。
- 管理控制台是现代浏览器单页应用，不提供旧版浏览器兼容。
- 真实钉钉、真实模型与企业 MCP 的联通性取决于部署环境的网络与凭据，需要在实际环境中验证。

---

## 反馈

问题、建议或接入需求，欢迎在 [Issues](https://github.com/SongJok/anthys/issues) 中提出。
