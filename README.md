# 钉钉智能体

一个面向企业内部的知识与运维助手：以钉钉机器人的形态出现在单聊和群聊里，使用企业的 MCP 服务、钉钉 DWS 能力与隔离沙盒回答跨系统问题；在群里不打扰地旁听，只在真正需要时主动介入；回答过程与管控操作都留痕、可审计，运行期的模型、人设、预算、MCP、群策略与钉钉凭据都能在线热更新而无需重启。

- **开箱即用的钉钉接入**：基于 Stream 模式，不需要公网域名、Webhook 或内网穿透。
- **过程可见的回答**：AI 卡片实时展示状态角标与流式正文，工具调用与推理过程仍完整落库可审计。
- **克制的主动回复**：群内全量旁听，经三级漏斗判断后才对高优故障、技术求助作出回应。
- **越用越懂团队**：工作记忆 + 情景摘要 + 语义画像三层记忆，跨会话保留上下文；企业术语库把内部黑话沉淀成可检索、可校验的固定模板。
- **可扩展的知识层**：技能按目录渐进披露，声明式插件只声明技能与 MCP、不执行代码，项目手册把仓库事实沉淀成可发布的 12 章说明，并可接 GitHub 只读工具做跨仓对比。
- **办公场景技能包**：内置日常聊天、链接阅读、数据分析、日周月报、项目文档、钉钉办公与调研简报等技能，覆盖从群聊链接到钉钉原生事务的常见工作流。
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
| 代码理解 | 问「这个项目从哪开始读」「这个符号在哪定义」，机器人基于项目快照给出文件、行号与提交；也可同步 GitHub 仓库、查看 Issue 与 PR |
| 知识沉淀 | 团队术语、同事职责、历史结论被逐步记住，后续回答不再从零解释 |
| 运营管控 | 管理员调整人设、预算、MCP 与群策略，或一键紧急静音；模型与密钥在 `LLM_MODEL_SOURCE=env` 时由 `.env` 统一管理 |
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
  D --> F[工具层<br/>企业 MCP · DWS · 项目 · GitHub · 公网搜索 · 沙盒 · 内置工具]
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
4. 将机器人加入目标群。群内 @ 机器人会正常应答；非 @ 消息由 DWS 长连接旁听（见下文「群聊旁听与主动回复」），命中条件才主动回复。

### 安装依赖与初始化数据库

> 建议先按下一节创建 `.env`（至少确认 `DATABASE_URL`），再执行初始化。

```bash
# 安装依赖：控制台是独立的子工程，需要单独安装
pnpm install
pnpm -C web-console install

psql "postgres://localhost:5432/dingtalk_agent" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
pnpm run db:push      # 非交互应用表结构；仅在检测到删列等数据丢失语句时中断
pnpm run db:extend    # 幂等补齐项目检索扩展与索引，旧库升级时使用
pnpm run db:seed      # 可选：预写入默认人设与模型配置，已有记录不覆盖
```

> 数据库连接串默认为 `postgres://localhost:5432/dingtalk_agent`，可通过 `DATABASE_URL` 覆盖；`psql` 命令请替换为实际连接串。
> `db:push` 已关闭逐步确认（`strict: false`）：新增表/列会自动应用，真遇到数据丢失语句仍会中断，避免非交互部署误删数据。
> 人设与模型配置在服务启动时也会自动补齐，`db:seed` 主要用于提前初始化或 CI 场景。

### 环境变量

将 `.env.example` 复制为 `.env`，按下列分组填写。缺少必需项时进程会立即退出并列出缺失的变量名。

> `.env` 以及 `.env.local`、`.env.production` 等变体已被 `.gitignore` 忽略，禁止提交到 GitHub；只提交不含真实密钥的 `.env.example` 与 `deploy/.env.production.example`。`pnpm test` 会检查示例文件没有真实密钥、Git 也没有跟踪任何 `.env` 密钥文件。

**运行时与数据库**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 运行环境标识 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `AGENT_STATE_DIR` | `.state` | 运行期状态根目录（插件安装、项目快照与索引等） |
| `AGENT_WORKSPACE_DIR` | `.workspace` | 工具工作区根目录（`deliver_artifact` 与沙箱共享） |
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

**大模型与角色路由**

模型与密钥默认由 `.env` 管理（`LLM_MODEL_SOURCE=env`），同一进程按角色使用不同供应商。控制台仍可修改人设，但模型、密钥与温度字段需改 `.env` 后重启。三个角色各自支持 `PROVIDER`、`BASE_URL`、`API_KEY`、`MODEL`、`TEMPERATURE`、`THINKING`、`MAX_TOKENS` 与 `DIALECT`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_MODEL_SOURCE` | `env` | `env`：按角色读取 `.env`；`database`：兼容旧版，允许控制台保存的模型覆盖 |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek 密钥，默认角色通过 `${DEEPSEEK_API_KEY}` 引用 |
| `KIMI_API_KEY` | 空 | Kimi / Moonshot 密钥，管理员角色通过 `${KIMI_API_KEY}` 引用 |
| `GLM_API_KEY` | 空 | 智谱密钥，主动回复角色、视觉与联网搜索共用 |
| `LLM_PROVIDER` | `openai-compatible` | 默认角色协议 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 默认角色接口地址 |
| `LLM_API_KEY` | `${DEEPSEEK_API_KEY}` | 默认角色密钥，接口与审计中只显示掩码 |
| `LLM_MODEL` | `deepseek-flash` | 默认角色：员工单聊、群聊 @ 与全量 ReAct（DeepSeek V4.1 Flash） |
| `LLM_TEMPERATURE` | `0.3` | 默认角色采样温度 |
| `LLM_THINKING` | `high` | 思维链强度：`off` / `auto` / `low` / `high` / `max` |
| `LLM_MAX_TOKENS` | `8192` | 默认角色单次输出上限；留空用供应商默认 |
| `LLM_DIALECT` | 空 | `openai` / `deepseek` / `moonshot` / `zhipu`；留空按 Base URL 推断 |
| `LLM_ADMIN_*` | 见 `.env.example` | 管理员单聊与子代理：默认 Kimi `kimi-k3.1-pro` |
| `LLM_PROACTIVE_*` | 见 `.env.example` | 旁听分类、主动回复、规划器与记忆摘要：默认 GLM `glm-5.3-flash`，`LLM_PROACTIVE_THINKING=low` 降低延迟 |
| `LLM_ENABLE_NATIVE_REASONING` | `true` | 旧变量；仅在未设置 `LLM_THINKING` 时生效 |
| `PERSONA_NAME` | `小钉` | 机器人名称 |
| `PERSONA_ROLE_PROMPT` | 见示例 | 人设 Prompt |
| `PERSONA_SPEAKING_STYLE` | 见示例 | 语气与表达风格 |

`LLM_ADMIN_*` 与 `LLM_PROACTIVE_*` 使用与 `LLM_*` 相同的后缀。任一角色的 `BASE_URL` / `API_KEY` / `MODEL` 缺失时回退默认角色，默认角色不可用时回退 `LLM_PROACTIVE_*`，启动日志会写出回退原因。供应商方言影响请求格式：DeepSeek 发送 `thinking` 与 `reasoning_effort`，Kimi 省略 `temperature` 并使用 `max_completion_tokens`，GLM-5.3 系列强制思考、只能通过 `reasoning_effort` 调节强度（`off` 会降级为 `low`），工具循环会把 `reasoning_content` 原样回传。

**公网搜索**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEB_SEARCH_ENABLED` | `true` | 是否向模型暴露 `web_search`；控制台「钉钉企业配置」可运行期开关并持久化 |
| `WEB_SEARCH_BASE_URL` | 沿用智谱地址 | 智谱 Web Search API 地址；大模型不是智谱时默认 `https://open.bigmodel.cn/api/paas/v4` |
| `WEB_SEARCH_API_KEY` | 沿用 `LLM_API_KEY` | 仅当 Base URL 指向智谱时复用模型密钥，避免把别家 Key 发到智谱 |
| `WEB_SEARCH_ENGINE` | `search_pro` | `search_std` / `search_pro` / `search_pro_sogou` / `search_pro_quark` |
| `WEB_SEARCH_COUNT` | `5` | 单次返回条数 1–50；搜狗引擎仅支持 10/20/30/40/50，会自动向上取整 |
| `WEB_SEARCH_CONTENT_SIZE` | `medium` | 摘要长度，`medium` 或 `high` |
| `WEB_SEARCH_TIMEOUT_MS` | `12000` | 单次搜索超时 |
| `WEB_SEARCH_REDACT` | `true` | 出站前脱敏手机号、邮箱、证件号与密钥；内部术语不拦截 |
| `WEB_SEARCH_CACHE_TTL_SECONDS` | `300` | 相同查询的结果缓存秒数；`0` 关闭缓存 |
| `WEB_SEARCH_MAX_CALLS_PER_HOUR` | `30` | 单会话每小时真实调用上限；`0` 不限制 |
| `WEB_SEARCH_DAILY_LIMIT` | `500` | 本进程每天真实调用上限；`0` 不限制 |

单聊与群聊都会挂载该工具。查询只发往公网搜索引擎，企业内部数据仍应走企业 MCP 或 DWS；上游鉴权失败、限流或超时会以可读错误回传模型，不阻断其余工具。

生产护栏：相同查询在 TTL 内直接复用结果，并发相同查询只发起一次请求；单会话小时配额与进程日配额用完后，工具返回「基于已有信息回答」的引导而不是继续计费。缓存与配额都是进程内状态，多实例部署时各实例独立计数。运行指标见 `/metrics`：`web_search_requests_total{result=success|empty|cache_hit|inflight_join|rate_limited|daily_limited|error}`、`web_search_results_total` 与 `web_search_duration_ms_total`。

**公网链接读取**

群聊或单聊里发来的公开链接，可由 `web_fetch` 直接打开并提取标题、描述与正文；只读、不执行网页脚本，内容会标注为外部不可信数据。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEB_FETCH_ENABLED` | `true` | 是否向模型暴露 `web_fetch` |
| `WEB_FETCH_TIMEOUT_MS` | `12000` | 单页请求超时 |
| `WEB_FETCH_MAX_MB` | `2` | 单页响应体上限（MB） |
| `WEB_FETCH_MAX_CHARS` | `2500` | 单次返回正文默认字符数，工具参数可调至 3200 |
| `WEB_FETCH_DNS_SERVERS` | 空（系统 DNS） | 可选的独立 DNS 服务器 IP，逗号分隔，例如 `223.5.5.5,119.29.29.29`；用于绕开本地代理返回的 fake-IP，解析结果仍会做私网与保留地址校验 |
| `WEB_FETCH_CACHE_TTL_SECONDS` | `600` | 相同链接结果缓存秒数；`0` 关闭缓存 |
| `WEB_FETCH_MAX_CALLS_PER_HOUR` | `20` | 单会话每小时调用上限；`0` 不限制 |
| `WEB_FETCH_DAILY_LIMIT` | `300` | 本进程每天调用上限；`0` 不限制 |

安全边界：只允许 `http` / `https` 标准端口，拒绝带账号密码的链接；解析后固定 DNS 结果再连接，本机、内网、链路本地、组播与保留地址一律拒绝，每次重定向都重新校验；最多跟随 3 次跳转。只读取 HTML、纯文本、JSON、XML 等文本内容，二进制、登录页、404 与限流会返回可读错误。响应体与耗时都有上限，压缩格式会被解开后再截断。

**推理预算**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOOP_MAX_WALL_TIME_MS` | `900000` | 单轮回答的最大墙钟时间（15 分钟），超出即拒接并停止 |
| `LOOP_MAX_TOTAL_TOKENS` | `120000` | 单轮回答的 Token 上限，超出即拒接并停止 |
| `LOOP_MAX_CONSECUTIVE_SAME_TOOL` | `2` | 同一工具同参数连续调用上限 |
| `LOOP_MAX_ITERATIONS` | `40` | 单次运行最多模型轮数（含工具轮），超出即拒接并停止 |
| `LOOP_MAX_PARALLEL_TOOLS` | `4` | 同一轮内工具调用的最大并发数 |
| `LOOP_CONVERGENCE_CHECK` | `true` | 是否启用信息收敛自检 |
| `TOOL_TIMEOUT_SECONDS` | `300` | 单次工具调用（含 MCP）的最长等待；实际还受 `config/mcp-servers.json` 的 `timeoutMs`（默认 480 秒）约束 |

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
| `EMBEDDING_DIMENSIONS` | `1536` | 向量维度；必须与数据库 `vector(1536)` 一致，否则启动时记录错误并禁用 embedding |

启用后，语义记忆写入时生成向量，召回时按余弦距离排序；术语库在关键词未命中时回退向量召回，项目同步会为所有分块写入向量并参与混合检索。`EMBEDDING_DIMENSIONS` 不是 1536 时 embedding 会被禁用，避免写入失败；embedding 服务异常会自动降级为关键词检索，不影响回答。

**企业术语知识库**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLOSSARY_PROMPT_ENABLED` | `true` | 是否把高频术语注入系统提示词 |
| `GLOSSARY_PROMPT_LIMIT` | `80` | 系统提示注入条数上限，最大 100 |
| `GLOSSARY_RETRIEVAL_LIMIT` | `4` | 每次提问检索的术语卡条数上限，最大 10 |

术语内容全部在控制台「术语知识库」页面维护；启用 `EMBEDDING_ENABLED` 后，术语检索会在关键词未命中时回退 pgvector 相似度召回，历史术语的向量会在启动后台补齐。

**技能、插件与项目**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EXTENSIONS_SKILLS_ENABLED` | `true` | 是否挂载技能目录与 `skill_*` 工具 |
| `EXTENSIONS_PLUGINS_ENABLED` | `true` | 是否启用声明式插件的安装与运行时合并 |
| `EXTENSIONS_PROJECTS_ENABLED` | `true` | 是否挂载项目工具、项目同步与项目手册 |
| `EXTENSIONS_DEFAULT_PROJECT_ID` | 空 | 问题未点名项目时使用的默认项目；空则由模型选择或主动询问 |
| `SKILL_CATALOG_LIMIT` | `20` | 注入系统提示的技能目录条数，范围 1–50 |
| `PROJECT_BRIEF_MAX_CHARS` | `2000` | 注入系统提示的项目简报长度上限，范围 200–8000 |
| `SKILLS_BUILTIN_DIR` | `skills/builtin` | 随仓库发布的内置技能目录 |
| `SKILLS_LOCAL_DIR` | `skills/local` | 团队自建技能目录，支持在线编辑与热重载 |
| `PLUGIN_ALLOWED_COMMANDS` | 空（使用 `npx,uvx,node,python3,docker`） | 插件 stdio MCP 允许的裸命令，逗号分隔 |
| `PLUGIN_ALLOW_MISSING_SECRETS` | `false` | 缺少必需密钥时是否允许先安装；允许时插件保持禁用 |
| `PROJECT_ALLOWED_ROOTS` | 空（仅仓库根目录） | `local` 来源项目允许读取的根目录，逗号分隔 |
| `PROJECT_SEED_DIR` | `projects` | 启动时导入 `<id>/project.json` 与 `manual/*.md` 的种子目录 |
| `PROJECT_SYNC_INTERVAL_SECONDS` | `900` | 未配置 `autoSyncMinutes` 时的项目自动同步间隔 |

**GitHub 只读工具**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_ENABLED` | `false` | 是否向模型暴露 `github_*` 只读工具；修改后需重启进程，控制台「项目手册」页会显示真实运行状态 |
| `GITHUB_TOKEN` | 空 | GitHub Token，只从环境变量读取；代码检索必需，公开仓库读取可选 |
| `GITHUB_API_BASE` | `https://api.github.com` | 必须是 HTTPS，且主机在默认白名单或 `GITHUB_ALLOWED_HOSTS` 内 |
| `GITHUB_ALLOWED_HOSTS` | 空 | 额外允许的 GitHub Enterprise API 主机名，逗号分隔 |
| `GITHUB_CACHE_TTL_SECONDS` | `300` | ETag / 304 缓存秒数，`0` 关闭，最大 300 |

技能、插件与项目的完整命令、清单字段和失败模式见 [开发文档](docs/skills-plugins-project-handbook-design.md)。

**多模态入站与产物投递**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VISION_ENABLED` | `false` | 是否调用视觉模型把用户图片转成文字描述 |
| `VISION_BASE_URL` | 存在 `GLM_API_KEY` 时为智谱地址，否则沿用 `LLM_BASE_URL` | 视觉模型接口地址 |
| `VISION_API_KEY` | 沿用 `GLM_API_KEY`，再回退 `LLM_API_KEY` | 视觉模型接口密钥 |
| `VISION_MODEL` | 存在 `GLM_API_KEY` 时为 `glm-5.3-flash`，否则沿用 `LLM_MODEL` | 支持图片输入的模型名 |
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
| `TOOL_EXECUTION_ALLOWLIST` | 空 | 只允许执行的工具名单（逗号分隔，支持结尾 `*`）；留空不限制 |
| `TOOL_EXECUTION_DENYLIST` | 空 | 禁止执行的工具名单，优先级高于 allow；确认路径同样拦截 |

**群聊旁听**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BYSTANDER_ENABLED` | `true` | 是否开启群聊旁听 |
| `BYSTANDER_PROACTIVE_REPLY` | `true` | 是否允许非 @ 主动回复 |
| `BYSTANDER_SILENT_INVESTIGATION_ENABLED` | `true` | 群级默认：是否允许对 SILENT 消息做只读后台调查 |
| `BYSTANDER_SLIDING_WINDOW_SIZE` | `20` | 每群保留的旁听条数 |
| `BYSTANDER_COOLDOWN_SECONDS` | `180` | 同群两次主动回复的最小间隔 |
| `BYSTANDER_CONFIDENCE_THRESHOLD` | `0.82` | 触发主动回复的最低置信度 |
| `BYSTANDER_TRIGGER_TOPICS` | `线上故障,SQL查询,接口报错,发布排期` | 重点关注主题（逗号分隔） |
| `BYSTANDER_DEBOUNCE_MS` | `8000` | 疑似提问后的防抢答等待窗口 |
| `BYSTANDER_LISTEN_ENABLED` | `true` | 是否用 DWS 长连接补齐非 @ 群消息 |
| `BYSTANDER_LISTEN_GROUPS` | 空 | 额外需要旁听的群 `openConversationId`（逗号分隔） |
| `BYSTANDER_LISTEN_IGNORE_SENDERS` | 空 | 忽略的发送人展示名或 ID，通常填机器人自己的名字 |
| `BYSTANDER_LISTEN_SETTLE_SECONDS` | `3` | 等 Stream 先处理 @ 消息的静默窗口（秒） |
| `BYSTANDER_LISTEN_REFRESH_SECONDS` | `60` | 群白名单从 `bystander_policies` 重新加载的间隔（秒） |

**用量配额与模型路由**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `USAGE_QUOTA_ENABLED` | `false` | 是否启用每日 Token 配额；用量流水始终记录 |
| `USAGE_DAILY_TOKENS_PER_USER` | `0` | 单员工每自然日 Token 上限，`0` 表示不限 |
| `USAGE_DAILY_TOKENS_PER_CONVERSATION` | `0` | 单群每自然日 Token 上限，`0` 表示不限 |
| `MODEL_PRICING_JSON` | 空 | 模型单价（人民币/百万 Token），用于估算 `usage_ledger` 成本；格式见下方 |

配额按 Asia/Shanghai 自然日切分。超出配额时，@ 消息直接收到配额提示且不再调用模型，主动回复则静默跳过。

`MODEL_PRICING_JSON` 支持 `default` 兜底价与按模型覆盖，`input`/`output` 必填，`cachedInput` 可省略（缺省按输入价计）：

```json
{"default":{"input":2,"output":8,"cachedInput":0.5},"models":{"glm-5.3-flash":{"input":0.5,"output":1}}}
```

成本按输入、缓存输入、输出三段 Token 计算，落库为人民币 micros（`cost_micros`，1 元 = 1e6）。未配置价格或模型未命中时，流水标记 `priced=false`，汇总会单独显示「已定价轮次」，不会把未定价当成 0 元。价格由部署方维护，项目不内置供应商报价。

模型按角色取自 `LLM_*`、`LLM_ADMIN_*`、`LLM_PROACTIVE_*`，详见「大模型与角色路由」。旧版 `LLM_ROUTE_*` 已移除且不再读取。

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

保留期可在控制台「数据治理」页调整，调整后写入 `governance_settings`，重启后仍生效。手动清理默认 dry-run，确认后再执行删除；按会话或员工级联删除会同步清理消息、摘要、轨迹、用量、任务结果、反馈、旁听策略、定时任务与对应附件目录，并要求显式 `confirm`，操作会写入管理审计。日志脱敏覆盖普通文本参数与结构化对象字段；如需排障保留原文，可临时设置 `DATA_REDACTION_ENABLED=false`。

**管理控制台与企业 MCP**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | 空 | 管理 API 的 Bearer Token；为空时不做校验 |
| `ADMIN_PORT` | `8787` | 管理 API 与控制台端口 |
| `ADMIN_STAFF_IDS` | 空 | 允许使用管理指令的钉钉 StaffId（逗号分隔），与 `DINGTALK_ADMIN` 合并去重 |
| `DINGTALK_ADMIN` | 空 | 机器人管理员的 StaffId，与 `ADMIN_STAFF_IDS` 等价；也可在控制台「系统设置」的管理员白名单中调整 |
| `DWS_CLI_ENABLED` | `true`（`.env.example` 中为 `false`） | 是否启用 DWS 命令行工具源 |
| `DWS_BINARY` | `dws` | `dws` 可执行文件路径；需要指定 Node 版本时可指向包装脚本 |
| `DWS_PROFILE_ROOT` | `.state/dws-profiles` | 每员工独立 DWS home 根目录（0700，按 profile 隔离配置），已在 `.gitignore` 中忽略 |
| `DWS_CORP_ID` | 空 | 设备码授权的目标企业 corpId；配置后登录显式指向该组织，并拒绝绑定其他组织账号 |
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

### 阿里云 ECS 部署（单机 + 自建 PostgreSQL）

`deploy/` 目录提供可直接执行的脚本，适用于 Ubuntu 24.04 / Alibaba Cloud Linux 3：

| 文件 | 作用 |
| --- | --- |
| `deploy/install-system-deps.sh` | 安装 Node 24、pnpm、构建工具链、PostgreSQL 16 + pgvector、Docker |
| `deploy/init-database.sh` | 创建数据库角色与库，启用 `vector` 扩展 |
| `deploy/.env.production.example` | 生产环境变量模板 |
| `deploy/dingtalk-agent.service` | systemd 常驻单元 |
| `deploy/nginx.conf` | 控制台反向代理（含来源 IP 限制与 SSE 配置） |
| `deploy/deploy.sh` | 幂等部署：拉代码 → 装依赖 → 构建 → 建表 → 重启 → 健康检查 |

首次部署顺序：

```bash
sudo bash deploy/install-system-deps.sh
sudo bash deploy/init-database.sh                 # 打印生成的 DATABASE_URL
sudo useradd -m -s /bin/bash anthys 2>/dev/null || true
sudo -u anthys git clone git@github.com:SongJok/anthys.git /opt/anthys/app
sudo cp deploy/.env.production.example /opt/anthys/app/.env
sudo chown anthys:anthys /opt/anthys/app/.env && sudo chmod 600 /opt/anthys/app/.env
sudo -u anthys pnpm -C /opt/anthys/app install && sudo -u anthys pnpm -C /opt/anthys/app/web-console install
# 填好 .env 后建表
sudo -u anthys pnpm -C /opt/anthys/app run db:push
sudo -u anthys pnpm -C /opt/anthys/app run db:extend
sudo -u anthys pnpm -C /opt/anthys/app build
sudo cp deploy/dingtalk-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dingtalk-agent
sudo cp deploy/nginx.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx
```

后续升级只需 `sudo bash deploy/deploy.sh`：脚本会拉代码、装依赖、构建、执行 `db:push` 与 `db:extend`、重启并做健康检查。只想跳过表结构同步时设置 `SKIP_DB_PUSH=1`。

> 钉钉 Stream 模式是出站长连接，服务器无需为机器人开放公网入站端口；只有管理控制台需要对外暴露，请用安全组与 Nginx 双重限制来源 IP。
> 依赖安装**不要加 `--prod`**：启动脚本使用的 `tsx` 在 devDependencies 中。`isolated-vm` 需要现场编译，故依赖脚本会安装 `build-essential` 与 `python3`。

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
- 待确认动作持久化在 `pending_actions` 表，进程重启后未过期的请求仍可继续 `/confirm`。
- 设置 `TOOL_CONFIRMATION_ENABLED=false` 可关闭闸门，所有工具直接执行。
- 执行层另有一道全局白名单：`TOOL_EXECUTION_ALLOWLIST` / `TOOL_EXECUTION_DENYLIST` 在工具提供方外层统一过滤，主代理、静默调查、Worker 与子代理都看不到被禁工具；`/confirm` 执行前会再次校验，避免策略变更后旧待确认动作绕过限制。
- 工具输出中的 URL 会自动提取为「参考来源」：去重、保留前若干个，并随 `citation` 事件推送到卡片引用区与轨迹。

### 对话内命令

在单聊或群里 @ 机器人发送以下命令（支持全角 `／`），不会触发模型推理：

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看可用命令 |
| `/status` | 当前会话是否正在生成、最近一次运行摘要 |
| `/stop` | 停止本会话正在进行的回答，并清空排队中的问题（卡片操作区同样可用） |
| `/retry` | 重跑上一条问题 |
| `/reset` | 清空本会话的历史消息 |
| `/trace` | 查看最近一次回答的推理与工具轨迹 |
| `/dws-status` | 查看本人 DWS 授权状态、账号、授权范围与令牌到期时间 |
| `/dws-consent [agree\|write\|read\|revoke]` | 单聊内查看、同意或调整本人 DWS 授权范围 |
| `/dws-login` | 单聊内发起本人 DWS 设备码授权 |
| `/dws-logout` | 单聊内清除本人本机 DWS 登录态（保留同意记录） |
| `/dws-system` | 查看系统级 DWS 授权状态（仅管理员，仅用于旁听等基础设施） |
| `/dws-system-login` | 发起系统级 DWS 设备授权（仅管理员） |
| `/mute`、`/unmute` | 群内静音 / 恢复主动回复（仅管理员、仅群聊） |
| `/group [show\|purpose\|responsibility\|goal\|task\|note] ...` | 群内维护本群定位、职责、目标与任务，或手动沉淀一条群记忆（仅群聊） |
| `/pref [show\|length\|lang\|address\|extra\|on\|off\|reset]` | 单聊内查看 / 设置回答长度、语言、称呼与补充要求 |
| `/privacy [show\|groups\|allow\|deny\|clear]` | 单聊内设置个人记忆在群聊中的使用档位与生效群白名单 |
| `/feedback <内容>` | 对最近一次回答提交反馈，写入 `user_feedback` |
| `/confirm` | 执行本会话待确认的写操作（仅发起人或管理员） |
| `/cancel` | 取消本会话待确认的写操作 |
| `/remind <时间> <内容>` | 单聊内创建一次性提醒，到点用机器人单聊推送；`/remind list`、`/remind cancel <ID>` |
| `/report <周期> <时间>` | 单聊内订阅日 / 周 / 月工作简报；`/report list`、`/report preview [weekly\|monthly]`、`/report cancel <ID>` |
| `/job <需求>` | 提交后台任务，完成后机器人单聊通知结果；任务持久化到 `agent_jobs`，进程重启不丢 |
| `/worker <research\|ops\|report> <需求>` | 交给指定 Worker 执行：独立工具白名单、预算与结构化回执 |
| `/task new <需求>` | 创建任务线程并提交后台任务，自动关联来源消息、会话与作业 |
| `/task list`、`/task show <ID>` | 查看本会话任务线程与详情（ID 支持前缀） |
| `/task link <ID> <类型> <引用> [说明]` | 关联 URL、文档、议题、卡片或已有后台任务 |
| `/task subscribe <ID>`、`/task unsubscribe <ID>` | 订阅 / 取消订阅线程更新 |
| `/task close <ID>` | 关闭任务线程（不会自动取消后台任务） |
| `/jobs` | 查看本会话最近的后台任务 |
| `/job-status <ID>` | 查看后台任务状态、耗时与结果摘要（ID 支持前缀） |
| `/job-cancel <ID>` | 取消排队或执行中的后台任务（仅发起人或管理员） |
| `/job-resume <ID> [补充要求]` | 恢复被看门狗暂停的任务，可追加一句约束后重新排队（仅发起人或管理员） |

同一会话（单聊或群聊）严格按到达顺序串行处理：群里多人先后 @ 机器人时，先 @ 的问题先回答完整，后来的问题进入队列等待，不会为了回答下一条而中断未完成的任务。只有 `/stop`（或进程退出）会中止当前回答，并同时清空该会话排队中的问题；排队中的卡片会显示前面还有几条问题。后台任务不占用该会话队列，由独立 JobRunner 按配额领取执行。

### 后台任务队列

`/job` 把耗时需求交给持久化队列，适合需要多轮检索、跨系统查询或结果整理的任务：

- 任务写入 PostgreSQL `agent_jobs`，状态包含 `queued` / `running` / `paused` / `succeeded` / `failed` / `cancelled`；进程崩溃后，租约过期的 `running` 任务会被其他实例重新领取。
- JobRunner 用 `FOR UPDATE SKIP LOCKED` 原子领取任务，默认每 5 秒轮询、单实例并发 2 个；执行过程写入 `agent_job_events`，可通过 `/job-status` 查看。
- 任务复用对话会话、记忆与工具链，但不会打断当前对话；结果同时写入会话历史，并通过机器人单聊通知发起人。
- 失败任务按 `maxAttempts` 自动退避重试；连续失败进入 `failed` 并通知发起人。
- 命中运行看门狗的硬预算时任务进入 `paused` 并通知发起人；`paused` 任务不会被自动领取，需要 `/job-resume <ID>` 显式恢复。
- 集群模式下只有持有主锁的实例运行 JobRunner 与定时调度器，避免重复执行。
- 任务成功后结果写入 `task_results`（每个会话保留最近 300 条），模型可用 `task_result_search` 检索本会话历史任务结果；检索严格按会话隔离，定时播报不重复沉淀。设置 `TASK_MEMORY_ENABLED=false` 可关闭写入与工具挂载。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JOB_RUNNER_INTERVAL_SECONDS` | `5` | 后台任务轮询间隔（秒） |
| `JOB_LEASE_SECONDS` | `1800` | 任务执行租约，需大于单任务最长执行时间；租约过期可被重新领取 |
| `JOB_MAX_CONCURRENCY` | `2` | 单实例同时执行的后台任务数 |
| `TASK_MEMORY_ENABLED` | `true` | 是否沉淀任务结果并挂载 `task_result_search` |

**Worker 化执行**：`/worker <research|ops|report> <需求>` 把任务交给带独立画像的执行单元。三类 Worker 共用持久化队列、租约与用量归因，但各自拥有工具白名单、独立预算和结构化回执：

| Worker | 工具范围 | 默认预算（墙钟 / Token / 轮数） |
| --- | --- | --- |
| `research` | 只读工具；排除管理工具、破坏性工具与递归委派 | 600s / 100k / 20 |
| `ops` | 业务工具（破坏性工具除外），写操作仍需 `/confirm` | 900s / 160k / 30 |
| `report` | 默认只读，只汇总数据源并生成报告 | 900s / 120k / 25 |

- 工具过滤在执行层完成：`ScopedToolProvider` 只向 Worker 暴露白名单内工具，模型即使被提示词诱导也看不到写工具或管理工具；`research` 始终只读，无法通过配置放开。
- Worker 最终输出 JSON 回执（`status` / `summary` / `findings` / `actions` / `sources` / `openQuestions`）。机器人以 `summary` 作为任务结果，并在 `/job-status` 与完成通知中展示状态、关键发现与来源；解析失败时回退为原始回答，不会让任务失败。
- 用量流水会记录 `worker=research|ops|report`，便于按执行单元核算成本；任务详情会标注 Worker 与结构化状态。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WORKER_<NAME>_MAX_WALL_SECONDS` | 见上表 | 单个 Worker 任务的墙钟上限 |
| `WORKER_<NAME>_MAX_TOKENS` | 见上表 | 单个 Worker 任务的 Token 预算 |
| `WORKER_<NAME>_MAX_ITERATIONS` | 见上表 | 单个 Worker 任务的最大模型轮数 |
| `WORKER_OPS_READ_ONLY` / `WORKER_REPORT_READ_ONLY` | `false` / `true` | 是否强制只读；`research` 恒为只读 |
| `WORKER_<NAME>_TOOL_ALLOWLIST` / `WORKER_<NAME>_TOOL_DENYLIST` | 空 | 逗号分隔的工具名单，结尾 `*` 为前缀匹配 |

### 任务线程与订阅

`/task new` 把一次后台需求升级为可追踪的线程，写入 `agent_tasks`，并自动建立三类关联：来源消息（`message`）、所属会话（`conversation`）与派生后台任务（`job`）。发起人自动订阅，群内其他成员可用 `/task subscribe` 跟进。

- 后台任务完成或失败时，线程状态与摘要同步更新；订阅者收到机器人单聊通知，发起人沿用原任务通知，不会重复发送。任务被取消时线程标记为失败并记录“后台任务已取消”。
- `/task link` 可把 `url`、`doc`、`issue`、`card`、`message`、`job`、`conversation`、`other` 绑定到线程，同一线程内相同 `kind + ref` 幂等；`/task show` 展示全部链接与订阅者。
- `/task close` 只关闭线程，不会隐式取消仍在执行的后台任务；任务详情与通知会显示线程 ID，便于回到 `/task show`。
- 新增 `agent_tasks`、`agent_task_links`、`agent_task_subscriptions` 三张表；升级部署后需执行 `pnpm db:push`。

### 运行看门狗

ReAct 循环内置看门狗（`src/watchdog/RunWatchdog.ts`），只观察不执行工具，专门处理“工具一直在跑、但信息不再增加”的空转，以及预算即将耗尽的风险：

- **检测**：连续多步工具输出没有新内容、相同工具与参数被反复调用、连续多步工具全部失败、Token / 墙钟预算达到告警比例。
- **分级干预**：先向模型注入收敛约束（要求停止探索或更换查询条件）；多次提醒仍无改善则**降级**——停用工具，要求基于已有信息直接作答；预算达到硬阈值则**升级**——后台任务进入 `paused` 等待人工确认，交互运行直接停止，避免继续消耗。
- **可恢复**：后台任务暂停后不会自动重跑，发起人可 `/job-resume <ID> 补充要求` 追加约束并重新排队；`/job-cancel <ID>` 直接终止。恢复会从头执行任务，而不是从暂停的那一步继续。
- **可审计**：干预会发出 `watchdog` 流式事件、写入 `agent_job_events`（类型 `watchdog` / `paused`），并记录指标 `agent_watchdog_total{action,code}`；`/job-status` 会展示暂停原因或降级说明。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WATCHDOG_ENABLED` | `true` | 是否启用运行看门狗 |
| `WATCHDOG_NO_PROGRESS_STEPS` | `3` | 连续多少步没有新信息后开始干预 |
| `WATCHDOG_MAX_INJECTIONS` | `2` | 降级前最多注入几轮约束 |
| `WATCHDOG_TOOL_ERROR_STEPS` | `3` | 连续多少步工具全部失败后干预 |
| `WATCHDOG_WARN_RATIO` | `0.8` | 预算使用比例达到该值时注入收敛约束 |
| `WATCHDOG_HARD_RATIO` | `0.95` | 预算使用比例达到该值时暂停后台任务 / 停止交互运行 |

### 个人提醒与工作报告

这两个能力只在**单聊**中开放，避免把个人事务和工作数据发到群里；群里发送会直接提示改用单聊。

**一次性提醒**（`/remind`）

- 时间支持相对量与绝对量：`25分钟后`、`2小时后`、`3天后`、`今天18:30`、`明天9点`、`2026-11-01 09:00`、`11月1日 9点`；只写时刻且已过则顺延到明天。
- 提醒至少要在 30 秒之后、一年之内；到点后由机器人以单聊文本推送 `⏰ 提醒：<内容>`，任务随即自动停用，不会重复触发。
- 每人同时最多保留 12 个个人定时任务；`/remind list` 只列出自己的任务，ID 支持前缀匹配取消。

**定时工作简报**（`/report`）

- 支持三种周期：`/report daily 09:00`、`/report weekly 周一 09:00`、`/report monthly 1 09:00`（每月日期限制在 1–28，避免短月缺失；时间按 Asia/Shanghai 解释）。
- 报告由钉钉日程、待办、审批数据**确定性生成**，不消耗模型 token：日报告含今日 / 明日日程、未完成与逾期待办、待我审批；周报 / 月报额外统计会议场次、累计时长与高频参与人。
- `/report preview` 立即生成一份当日简报用于校验，`/report preview weekly|monthly` 预览周 / 月报告。
- 每人最多订阅 4 份周期报告；任意 DWS 查询失败不会中断报告，失败原因会列在报告末尾的「数据提示」中，并提示可在单聊直接问授权状态。
- 报告与提醒按创建者的 DWS 身份查询和推送；创建者首次在单聊提问时机器人会自动发起授权，不会借用管理员账号。

单聊里也可以直接用自然语言让模型设置，例如「25 分钟后提醒我开会」「每周一 9 点给我发工作周报」；群聊中对应的工具不会挂载。创建只影响本人的提醒与订阅，因此不经过 `/confirm` 写操作闸门。

### 定时任务与主动播报

管理端可以创建定时任务，在指定单聊或群聊中按固定间隔或 cron 主动发起一轮回答，例如每天 9 点汇总昨日错误日志、每小时巡检一次线上状态。

- 调度支持 `intervalSeconds`（最小 30 秒）或 5 段 cron（按 Asia/Shanghai 解释，支持 `*`、`*/n`、区间、列表，周日可写 `0` 或 `7`），二者只能选其一。
- 任务分三类 `kind`：`prompt`（管理端创建的主动播报，默认）、`reminder`（一次性个人提醒，触发后自动停用）、`daily_report` / `weekly_report` / `monthly_report`（个人定时报告）。后两类由单聊的 `/remind`、`/report` 或模型工具创建，投递走管理员文本通道（1200 字分片），不经过模型。
- `prompt` 类型到点后以「定时任务」身份走完整的 ReAct 链路：卡片流式输出、工具调用、记忆与用量记账与正常问答一致。
- 单次失败不会阻塞其他任务，也不会在原定时间反复重试；失败原因写入日志，下一次仍按计划触发。
- 支持「立即执行」用于验证配置，执行后同样推进下一次触发时间。

### 群聊旁听与主动回复

机器人在群内的每一句话都会进入旁听缓冲，但绝大多数消息会在零 Token 的规则层被过滤，不会唤醒模型。是否主动回复由三级漏斗决定：

1. **规则预筛**：过滤表情、寒暄、确认短语；检查群是否处于冷却期、是否正忙于其他回答；用主题词做技术信号预筛。
2. **防抢答窗口**：疑似提问后等待一段时间，若期间已有同事回复，则保持沉默。
3. **模型判定**：对最近若干条消息做一次低温度、无工具、无思维链的结构化判定，只有 `PROACTIVE_REPLY` 且置信度达到阈值才唤醒智能体。

**入站来源**：钉钉机器人回调只推送 @ 机器人的群消息，非 @ 消息不会到达 Stream，因此旁听额外接一路 DWS 个人事件长连接：

- 启动时以 `dws event consume user_im_message_receive_group_all --flatten --ephemeral --format ndjson` 拉取当前账号收到的群消息，进程异常退出后按退避重连。
- 需要使用**系统级** DWS 登录态（管理员 `/dws-system-login`，默认读取本机 `~/.dws`），且该登录账号必须本身就在目标群里；这是平台限制下唯一能拿到非 @ 消息的途径。员工个人身份不参与旁听。
- 只旁听**显式开启**的群：`BYSTANDER_LISTEN_GROUPS` 指定的 `openConversationId`，加上控制台里 `bystander_policies` 中 `bystanderEnabled=true` 的群，白名单每分钟重新加载一次。
- 收到消息后先等待 `BYSTANDER_LISTEN_SETTLE_SECONDS`，让 Stream 先处理 @ 消息；同一条 `messageId` 已被 Stream 处理则跳过，避免双重回复。
- 富文本/卡片 JSON 与图片等非文本消息直接丢弃；机器人自己的发言通过 `BYSTANDER_LISTEN_IGNORE_SENDERS`（默认补充人设名）过滤，防止自问自答。

每个群都可以单独覆盖默认策略：

| 策略项 | 含义 |
| --- | --- |
| 旁听开关 | 是否对该群启用旁听判定与主动回复 |
| 非 @ 自主回复 | 是否允许主动发言 |
| 静默调查 | 是否对未触发主动回复的可疑消息做只读后台查证 |
| 冷却时间 | 同群两次主动回复的最小间隔 |
| 滑动窗口 | 判定时参考的最近消息条数 |
| 置信度阈值 | 主动回复的最低把握 |
| 触发话题 | 重点关注的主题 |

管理员还可以一键**紧急静音**：关闭全部群的旁听与主动回复，机器人退回仅响应 @ 的状态。

**静默调查（只读）**：如果模型判定某条消息「可疑但不该主动插话」，机器人可以把它转入后台调查，而不是直接放弃：

- 调查使用独立的低温度引擎，执行层通过 `toolFilter` 只暴露 `risk=read` 的工具；即使模型被群消息诱导，也看不到写操作或审批入口。
- 调查不写会话历史、不向群里流式输出过程，只在用量流水中归因为 `jobKind=investigation`、`worker=research`。
- 输出必须是结构化 JSON：`confidence`、`findings`、`sources`、`answer`。系统按确定性规则评分：模型自评占 35%，可核实 findings 与 sources 占其余部分，并对「无法确认/不确定」等对冲表述降权。
- 证据分达到 `SILENT_INVESTIGATION_EVIDENCE_THRESHOLD` 才浮出发言；否则静默丢弃，连「我查过」都不会说。
- 每次真实调查都写入 `silent_investigations` 审计表（状态、证据分、Token、耗时、丢弃原因），便于复盘误报与成本。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SILENT_INVESTIGATION_ENABLED` | `true` | 静默调查总开关 |
| `SILENT_INVESTIGATION_MIN_CONFIDENCE` | `0.65` | 旁听判定置信度低于该值不启动调查 |
| `SILENT_INVESTIGATION_EVIDENCE_THRESHOLD` | `0.65` | 证据分达到该值才浮出 |
| `SILENT_INVESTIGATION_MAX_TOKENS` | `8000` | 单次调查 Token 预算，超出即丢弃 |
| `SILENT_INVESTIGATION_MAX_WALL_TIME_SECONDS` | `45` | 单次调查墙钟上限 |
| `SILENT_INVESTIGATION_COOLDOWN_SECONDS` | `600` | 同群两次调查的最小间隔 |
| `SILENT_INVESTIGATION_MIN_QUERY_CHARS` | `10` | 待核实问题的最短字符数 |
| `SILENT_INVESTIGATION_MAX_CONCURRENCY` | `1` | 进程内同时执行的调查数量上限 |

### 身份归一与分层人设

同一个员工在钉钉里可能有 `staffId`、`openDingTalkId` 与外部加密 ID 多个标识。系统把它们映射为稳定的 `personKey`（`staff:<staffId>` / `external:<id>`），作为记忆和人设的归属键：

- 机器人 @ 消息能同时拿到 `staffId` 与 `openDingTalkId`，首次出现即归到同一个 `personKey`。
- DWS 群旁听事件只有 `openDingTalkId`，未绑定前按 `external:<openId>` 独立隔离，不会误认成其他员工。
- 控制台「人设与身份」页可把两个标识绑定为同一员工；绑定会迁移旧 `personKey` 下的个人记忆、分层人设与已合并的子孙身份，并立即清除解析缓存。
- 人设按「系统默认 → 群设定 → 个人设定」逐层覆盖：群设定描述该群负责什么、不负责什么；个人设定在单聊中可整体覆盖，在群聊中只调整说话风格，不改变群职责。安全与权限边界固定写入系统提示，不会被任何人设覆盖。
- 员工个人偏好（`person_preferences`）只影响单聊表达：回答长度、回答语言、称呼与额外要求可在单聊用 `/pref` 调整，也可在控制台「人设与身份」页维护；群聊不注入个人偏好，避免个人设定影响群职责。
- 跨群记忆授权（`person_memory_consents`）决定个人语义记忆能否在群聊召回：`off` 完全不用，`shareable`（默认）只用显式标记可共享的条目，`all` 使用全部非敏感记忆；可再配置生效群白名单。员工可在单聊用 `/privacy` 调整，管理员可在控制台修改。

### 群工作区与按群模型路由

每个群可以有独立的工作区，回答时自动带上该群的长期上下文：

- `group_workspaces` 保存群定位与职责，`group_goals` 保存群目标，`group_tasks` 保存群任务；这些数据彼此隔离，不会跨群注入。
- 每次群聊组装提示时会追加一段「本群工作区」简报：群定位、职责、进行中 / 已暂停的目标与未完成任务，超长时截断，未配置时完全不注入。
- 群成员可在群里发送 `/group purpose ...`、`/group responsibility add|remove ...`、`/group goal add|list|done|pause|resume|archive ...`、`/group task add|list|start|done|cancel ...`、`/group note ...`；机器人也能调用 `group_workspace_view`、`group_goal_create`、`group_task_update`、`group_memory_save` 等群内工具。目标与任务的状态变更仅限创建人或管理员。
- 控制台「群工作区」页可以维护群定位、职责、目标与任务，与群内指令读写同一份数据。
- 按群模型路由（`group_model_routes`）让同一机器人在不同群使用不同供应商或模型，只对群聊生效（含该群的主动回复），单聊仍走默认角色模型。未填写的供应商、Base URL、温度、思维链与最大 Token 沿用默认模型档案；API Key 只保存环境变量名（例如 `GROUP_A_MODEL_KEY`），密钥仍留在部署环境，控制台只显示是否已配置。本实例保存后立即生效，跨实例最多 60 秒生效；若填了变量名但部署环境未提供对应密钥，该群自动回退默认引擎并记录告警，不会让群聊中断。

### 三层记忆

| 层级 | 内容 | 生命周期 |
| --- | --- | --- |
| 工作记忆 | 当前会话最近消息 + 每个群的旁听窗口 | 进程内与数据库会话表 |
| 情景记忆 | 长对话经压缩后的摘要 | 持久化，随对话继续增量更新 |
| 语义记忆 | 团队术语、员工职责画像 | 持久化，按发言人、群与关键词召回 |

语义记忆在上下文组装时召回少量长期知识，避免把整段历史塞进提示词。配置 embedding 后按 pgvector 余弦距离检索，否则回退关键词匹配；embedding 服务异常时同样降级，不会阻塞回答。

语义记忆分为 `global` / `group` / `user` 三种作用域，并带来源、置信度、敏感级别、状态和过期时间：

- 用户级记忆默认只在单聊召回；要在该员工所在的群里使用，需要把授权档位设为 `shareable`（默认，只召回显式可共享条目）或 `all`，并可用群白名单限定生效范围。员工可在单聊用 `/privacy` 调整，管理员可在控制台「人设与身份」页修改。
- 群级记忆只在对应群召回，不会跨群泄露；全局记忆对所有会话可见。
- 已停用（`retired`）或已过期的记忆不参与召回；修改记忆正文会清空 embedding，等待重新沉淀。
- 控制台「记忆治理」页可按作用域、类型、状态、归属与关键词筛选，调整共享范围、敏感级别、置信度、状态与过期时间，所有写操作都落审计。

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

### 技能、插件与项目手册

#### 技能 Skills

技能是一段受控的操作步骤，用来教机器人"这类任务应该怎么做"，而不是把新的可执行代码带进进程。

- **渐进披露**：系统提示只注入技能目录（名称、描述、适用场景，受 `SKILL_CATALOG_LIMIT` 限制）；模型命中任务后调用 `use_skill` 加载正文，需要细节时再用 `skill_read` 分页读取技能目录内的参考文件。单次正文最多 4000 字符，参考文件单次最多 500 行 / 4000 字符，单文件上限 1MB。
- **来源**：`SKILLS_BUILTIN_DIR`（默认 `skills/builtin`）随仓库发布，`SKILLS_LOCAL_DIR`（默认 `skills/local`）用于团队自建。内置技能分两类：代码与项目类 `code-reading`、`repo-review`、`incident-triage`、`project-onboarding`、`github-project-scan`、`handbook-maintainer`；办公与通用类 `everyday-chat`、`link-reader`、`data-analysis`、`work-report`、`project-docs`、`dingtalk-office`、`research-brief`。
- **格式**：每个技能是一个目录，`SKILL.md` 以 YAML frontmatter 开头，字段包括 `name`、`description`、`version`、`when_to_use`、`tags`、`allowed_tools`、`risk`、`visibility` 与 `max_instruction_chars`；正文按「适用场景 / 步骤 / 约束」组织，可附带 `references/` 等资源文件。
- **管理**：控制台「技能 Skills」可查看目录预览、校验草稿、启用 / 停用、在线编辑 `SKILL.md` 与资源文件，并查看近 7 天调用次数。保存后立即热更新，无需重启。
- **边界**：技能正文只来自管理员维护的本地目录；聊天内容、工具返回、仓库文件都不会被当作指令注入。`EXTENSIONS_SKILLS_ENABLED=false` 可整体关闭。

#### 声明式插件

插件是**纯声明包**，用于把技能与 MCP 节点成套分发，不执行任意安装脚本或运行时代码。

- **包结构**：插件根目录包含 `plugin.json`，技能目录（默认 `skills/`）与可选的说明文件；通过控制台上传 zip，或填写服务器上已解包的目录。
- **清单字段**：`schemaVersion`、`id`、`name`、`version`（SemVer）、`description`、`engines.agent`、`trust`、`skills`、`mcpServers`、`secrets`、`permissions`（仅展示与审计）。
- **安装校验**：检查 id / 版本格式、agent 版本区间、技能名冲突、MCP 传输方式、stdio 裸命令是否在 `PLUGIN_ALLOWED_COMMANDS`（默认 `npx,uvx,node,python3,docker`）内、`${ENV_VAR}` 占位符是否有对应环境变量；任何 error 都不会落盘。
- **版本与回滚**：可安装、升级、启用、停用、回滚、卸载，保留最近两个版本；升级或回滚后技能与 MCP 节点热替换。
- **命名空间**：插件技能以 `plugin:<插件id>:<技能名>` 暴露；插件 MCP 节点以 `plugin-<插件id>-<节点id>` 注册，工具名相应为 `mcp__plugin-<插件id>-<节点id>__<tool>`，不会与手工节点冲突。
- **密钥**：清单只声明变量名，值从 `.env` 读取；勾选「允许缺失密钥」时插件先安装但保持禁用，补齐后启用即可。
- **边界**：`EXTENSIONS_PLUGINS_ENABLED=false` 可整体关闭；插件不能携带可执行安装钩子，也不能覆盖内置技能或手工 MCP 节点。

#### 项目手册与代码理解

项目登记后，机器人可以像熟悉仓库的同事一样回答"入口在哪、这个符号怎么定义、上线要注意什么"，并且每个结论都能落到具体文件与提交。

- **来源**：`local`（服务器上的目录，只能读 `PROJECT_ALLOWED_ROOTS`，默认仓库根；绝对路径不写入手册）、`github`（`owner/name` + ref，按 GitHub 只读接口拉取）与 `manual`（只维护手册与人工条目，不扫描代码）。
- **同步与快照**：每次同步生成不可变快照，记录 commit、文件清单、分块索引与符号表；检索结果与引用统一带 `path:line @ commit`，历史版本可追溯。定期同步由项目的 `autoSyncMinutes` 控制，缺省回退到 `PROJECT_SYNC_INTERVAL_SECONDS`。
- **扫描边界**：`.env`、私钥、证书、凭据文件不进入索引；`.env.example` / `.sample` / `.template` 会保留，用于在手册里只列出变量名而不泄露取值。超大文件、二进制与依赖目录会被跳过。仓库根目录的 `.anthysignore` 可按行声明额外排除的 glob（`#` 注释，不影响 git 跟踪）；`anthys` 种子用它排除 `eval/golden/**` 与 `tmp/**`，避免评测答案和临时产物进入语料。
- **混合检索**：关键词（全文与 trigram）、路径、符号与可选 pgvector 向量一起召回；查询会拆成 token 分别做全文与子串匹配，再按 token 稀有度（IDF 近似）加权路径 / 符号命中，避免通用词淹没真正的定义文件。可按 `pathGlob`、语言与类型（`code` / `doc` / `config` / `test`）过滤。启用 `EMBEDDING_ENABLED` 后，同步会按批为所有分块生成 1536 维向量；旧快照缺少向量统计时会在下一次同步自动重建一次。embedding 失败只记录 `embeddingError` 并降级关键词检索，不会让同步失败。`private` 项目只在单聊中向 owner 或管理员开放，`admin` 项目仅管理员可见。
- **项目工具**：`project_list`、`project_handbook`、`project_map`、`project_search`、`project_read`、`project_symbol`、`project_history`。`project_history` 在 GitHub 来源下可直接查 issues / PRs，其余来源会说明能力边界。
- **项目手册**：按固定 12 章生成草稿——项目概览、架构设计、模块地图、数据模型、配置与密钥、构建与部署、运维与故障、编码约定、测试与验收、历史决策、常见问题、风险与边界。草稿可以预览、重新生成和发布；发布后才进入模型上下文，并递增 `handbookVersion`。手册内容只汇总变量名、脚本路径与命令，不展开密钥值或部署脚本正文；本地仓库绝对路径、服务器地址、主机名与端口不会进入手册或项目简报。若来源是 GitHub，或在 `package.json` 中配置了 GitHub `repository`，概览会展示公开项目地址，并邀请读者到 GitHub 点 Star。
- **章节编辑与状态**：控制台可基于最新草稿（没有草稿时基于最新发布版）逐章修改标题与 Markdown，保存会生成新草稿而不改动已发布版本；审核后再发布。`GET /projects/:id/status` 汇总索引文件数 / 分块数 / 已向量化分块数、最近同步任务与错误、发布与草稿版本、是否过期；控制台会如实展示这些状态与降级原因。
- **人工条目**：管理员可在任意章节新增、编辑、删除人工条目，设置可见性、敏感级别、是否注入项目简报与优先级。人工条目优先于自动生成内容，重新生成不会覆盖管理员编辑。
- **种子目录**：启动时读取 `PROJECT_SEED_DIR`（默认 `projects`）下的 `<projectId>/project.json` 与 `manual/*.md`。项目不存在才创建，配置更新不会覆盖已有记录；种子人工条目只更新由 `seed:projects/manual` 自己写入的版本，管理员改过的条目会被跳过。
- `EXTENSIONS_PROJECTS_ENABLED=false` 可整体关闭；`EXTENSIONS_DEFAULT_PROJECT_ID` 指定问题未点名项目时的默认项目。

#### GitHub 只读工具

启用 `GITHUB_ENABLED=true` 后，模型可以使用五个只读工具：

| 工具 | 说明 |
| --- | --- |
| `github_repo` | 仓库元信息：默认分支、语言、可见性、Star、License、更新时间与 topics |
| `github_tree` | 指定 ref / 目录的树状结构，按深度与条数收敛 |
| `github_file` | 读取文件，支持行区间与续读；单文件上限 1MB |
| `github_search` | 代码检索需要 Token；issues / PRs 检索无需 Token |
| `github_pr` | PR 详情、合并 / 可合并状态、讨论统计与变更文件，补丁按长度截断 |

安全与稳定性：

- Token 只从 `GITHUB_TOKEN` 读取，不落库、不回传控制台；代码检索必须配置 Token，未配置时会明确提示。
- `GITHUB_API_BASE` 必须是 HTTPS，且主机为 `api.github.com`、`*.github.com` 或 `GITHUB_ALLOWED_HOSTS` 中的白名单；客户端不跟随重定向。
- 相同请求按 ETag / 304 缓存，TTL 由 `GITHUB_CACHE_TTL_SECONDS` 控制；限流错误会带出重置时间，而不是静默失败。
- 仓库内容属于外部不可信数据：只作为参考材料展示，不当作指令执行，也不会自动写入项目手册的权威结论。
- 未启用时不会挂载 `github_*` 工具；GitHub 来源项目的 issues / PRs 查询会返回"需要开启 `GITHUB_ENABLED`"的说明，本地项目能力不受影响。
- 控制台「项目手册」页顶部展示进程内真实状态（`GITHUB_ENABLED`、客户端、Token、工具是否可用、默认仓库与初始化错误），并可对指定或默认仓库做一次绕过缓存的连通性测试；修改 `.env` 后必须重启进程，状态卡片不会把文件里的新值伪装成已生效。
- 连通性测试只返回仓库元数据与延迟，不返回 Token；测试动作写入审计日志。

### 工具能力

机器人的工具按需挂载，回答时会自行选择与组合：

| 工具源 | 能力 |
| --- | --- |
| 内置工具 | `current_time` 时区时间、`calculator` 安全表达式计算、`system_status` 进程与资源状态 |
| 技能 | `skill_search` 按任务检索技能、`use_skill` 加载操作步骤、`skill_read` 分页读取技能内参考文件 |
| 项目 | `project_list` / `project_map` / `project_search` / `project_read` / `project_symbol` / `project_history` 读取已登记项目快照，`project_handbook` 读取已发布手册 |
| GitHub（只读） | `github_repo` / `github_tree` / `github_file` / `github_search` / `github_pr`，按白名单 HTTPS 访问并缓存 |
| 企业 MCP | 通过 MCP 协议接入代码、数据、日志、接口文档等外部服务，可增删改查与热重载 |
| 钉钉 DWS | 查询文档、知识库、日历、待办、通讯录、审批、日志、听记与 AI 表格；写操作（建日程、建待办、改通讯录、发审批、写文档、提交日志）经 `/confirm` 二次确认 |
| 公网搜索 | `web_search` 调用智谱 Web Search API 检索公开网页，返回标题、链接、发布时间与摘要，并作为引用展示；相同查询短期缓存、单会话与进程级调用配额，单聊与群聊均可用，可在控制台关闭 |
| 公网链接 | `web_fetch` 打开群聊或单聊中的公开网页链接，提取标题、描述与正文并生成引用；拒绝本机与内网地址，跟随跳转时重新校验，短时缓存与调用配额 |
| 工作区文件 | `workspace_read_file` 读取消息附件或工作区内的文本文件（CSV/JSON/Markdown 等），带路径校验、二进制识别与字符截断 |
| 隔离沙盒 | `sandbox_analyze_and_aggregate` 对工作区文件、消息附件或工具返回的大批量数据做脚本化统计与聚合，支持嵌套附件路径 |
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

启用后，机器人可以通过本机的 `dws` 命令行查询并办理文档、知识库、日历、待办、通讯录、审批、日志、听记与 AI 表格等事务：

| 域 | 只读命令 | 写命令（需 `/confirm`） |
| --- | --- | --- |
| 文档 / 知识库 | `search`、`read`、`list`、`get` | `create`、`update`（追加 / 覆盖） |
| 日历 | `event list`、`+today`、`+search-event`、`busy search` | `event create`、`event update`、`event delete` |
| 待办 | `task list`、`task get`、`+due-today`、`+search` | `task create`、`task update`、`task done` |
| 通讯录 | `search`、`get`、`list`、`self` | `user invite`、`user update` |
| 审批 | `list-pending`、`list-submitted`、`detail`、`records`、`tasks`、`list-forms`、`search-forms`、`form-schema` | `create-instance`、`approve`、`reject` |
| 日志 / 报告 | `template list`、`template get`、`inbox list`、`outbox list`、`entry get`、`entry stats`、`+report-latest` | `entry submit` |
| AI 听记 | `list mine/shared/all`、`+latest`、`+search`、`get info/summary/transcription/keywords/todos`、`+action-items` | — |
| AI 表格 | `base list/search/get`、`table get`、`field get`、`record query/stats/group-stats` | — |

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
| `dws_doc_manage` | write | 创建钉钉文档，或向已有文档追加 / 覆盖 Markdown；长正文自动写入临时文件 |
| `dws_report_read` | read | 日志模版、收件箱、发件箱、单份正文与已读统计 |
| `dws_report_submit` | write | 按模版提交日报 / 周报 / 月报，`contents` 字段名必须与模版一致 |
| `dws_aitable` | read | AI 表格 Base、表、字段、记录查询与分组聚合统计 |
| `dws_minutes` | read | AI 听记列表、摘要、转写、关键词、待办与行动项 |

模型工具使用稳定的 action 名称（日历 `list` / `today` / `search` / `freebusy`，待办 `list` / `search` / `get` / `today`，日志 `templates` / `template` / `inbox` / `outbox` / `entry` / `stats` / `latest`），再映射到上表的真实 CLI 子命令，避免 `dws` 升级后提示词漂移；`dws_org_and_schedule` 只接受只读 action，写操作必须走对应的专用写工具。

写工具统一声明 `write` / `destructive`，会先进入「写操作确认」闸门：机器人展示参数与风险，用户回复 `/confirm` 后才真正执行；执行时携带 `--yes`，避免 CLI 在无终端环境中等待交互确认。文档覆盖（`overwrite`）还会要求显式 `confirmOverwrite=true`；提交日志必须至少提供一个接收人，否则日志对任何人都不可见。AI 表格单次记录查询上限 100 条、分组统计上限 1000 条，超出时建议缩小过滤范围或改用沙盒分析。

使用前需要在运行机器上安装 `dws` CLI。所有业务查询和写操作都使用**提问人本人**的 DWS 身份，不再借用管理员账号；调用时不拼接 shell，单次调用有 15 秒超时与输出长度上限。

#### 每员工独立 DWS 身份（同意 + 设备码授权 + 加密令牌）

- **独立 home**：每个员工在 `DWS_PROFILE_ROOT`（默认 `.state/dws-profiles`）下有独立的 `0700` 目录，设置 `DWS_CONFIG_DIR`、`XDG_DATA_HOME`，配置、日志、待绑定状态互不干扰；令牌由钉钉 CLI 按 `corpId:userId` profile 存入本机 macOS Keychain，每个员工独立一条，其他员工无法复用。`DWS_DISABLE_KEYCHAIN=1` 的 file-DEK 模式首次授权会因 `dek missing` 无法落盘，因此不启用。
- **自动授权、无需记命令**：员工提问时如果令牌缺失或过期，机器人会自动记录当前版本的只读同意并发起该员工本人的设备码登录。单聊直接把授权链接与授权码发在对话里；群聊只通过私聊发给提问人，群里不回传链接和授权码。用户只需打开链接完成授权。`/dws-consent`、`/dws-login` 仍保留，用于员工主动查看范围或手动重发。
- **默认只读**：自动同意的范围仅包含日程、待办、审批、通讯录、文档/知识库、日志、听记与 AI 表格的只读查询。写操作（建日程、建待办、发审批、改通讯录、创建/更新文档、提交日志）必须额外发送 `/dws-consent write`；工具层会在执行前拦截未授权的写调用。
- **身份校验**：登录完成后读取 `dws profile list`，只有 profile 的 `userId` 与当前钉钉 StaffId 一致才绑定；不一致会取消绑定并清空该员工的 home。配置 `DWS_CORP_ID` 时还会限定企业。
- **授权完成自动续跑**：授权成功后自动通知原会话，并自动重跑刚才那条问题，无需用户重新提问；同一对话 2 分钟内不会重复推送授权链接。
- **撤销**：`/dws-logout` 清除本机登录态但保留同意记录；`/dws-consent revoke` 同时撤销同意并删除加密凭据目录。
- **系统级身份**：旁听等基础设施仍需一个系统级 DWS 登录态，由管理员通过 `/dws-system` / `/dws-system-login` 管理；它不参与任何员工业务查询。

**权限缺失时主动通知管理员：**

- DWS 返回应用/接口级权限错误（如 `AccessTokenPermissionDenied`、`没有调用该接口的权限`）时，机器人会停止重复调用，并给 `ADMIN_STAFF_IDS` 中的管理员（不含提问人本人）发一条单聊通知。
- 通知包含提问人、会话、命令、原始错误、需要开通的权限点，以及处理办法：开放平台权限管理开通、`dws dev app permission ...` 命令行开通、权限点需审批时创建版本 → 提审 → 发布生效、员工本人在单聊重新 `/dws-login` 刷新个人授权、或暂时在「钉钉企业配置」关闭 DWS 开关。
- 同一会话同一操作 10 分钟内只通知一次，避免刷屏；文档/知识库的单篇文档无权访问不会升级为管理员通知。
- 工具结果会附带指令，要求模型向提问人说明「缺少哪项权限、已通知管理员」，而不是编造操作成功。

**授权过期时不会卡住用户：**

- 每次调用 DWS 前检查该员工自己的 `dws auth status`（按员工缓存 60 秒）；工具执行失败且报错涉及登录/令牌时立即强制复检。
- 一旦确认令牌缺失或过期，立刻自动发起**该员工本人**的设备码授权：单聊直接推送可打开的链接与授权码（15 分钟内有效），群聊通过私聊发给提问人，群里只说明已私聊发送。本轮回答继续完成，不需要等待授权。
- 未同意或未绑定的用户也一样：机器人自动记录只读同意并拉起登录，不会让用户去记或执行命令，也不会使用管理员令牌代替其查询。
- 员工仍可随时发送 `/dws-status` 查看本人授权状态，或用 `/dws-consent`、`/dws-login` 主动管理授权；这些命令只是可选入口。
- 授权完成后会自动通知原会话，并自动重跑刚才那条问题，无需用户重新提问。
- 授权完成后会校验 profile 的 `userId` 与提问人一致；不一致会拒绝绑定，避免把别人的钉钉账号绑定到当前用户。
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

控制台与机器人同进程提供，默认地址 `http://<host>:8787/`，共十五个页面：

| 页面 | 可以做什么 |
| --- | --- |
| **运行大盘** | 查看 Stream 状态、今日对话轮次与 Token、MCP 节点健康与工具数、各群旁听与主动回复统计、最近管理操作审计 |
| **在线对话** | 用一次性票据订阅 SSE，直接在浏览器体验与钉钉相同的流式推理、工具调用与最终回答 |
| **钉钉企业配置** | 修改 AppKey / AppSecret、RobotCode、AI 卡片模板、管理员白名单、DWS 开关、公网联网搜索开关；发送测试卡片验证链路 |
| **大模型与人设** | 切换模型渠道与模型、修改 Base URL / API Key / 温度 / 原生思维链、调整 ReAct 预算、在线编辑人设与语气，并发起沙盒对话测试 |
| **企业 MCP** | 增删改查节点、启停并热应用、一键连通性测试并浏览工具 Schema、维护按群 / 角色的工具权限 |
| **群聊旁听策略** | 查看全局默认策略、按群覆盖旁听与主动回复参数、为该群配置独立模型路由、一键紧急静音 |
| **群工作区** | 维护每个群的定位、职责、群目标与群任务，与群内 `/group` 指令共用同一份数据 |
| **人设与身份** | 维护群职责与人设、员工个人表达偏好与跨群记忆授权；把 `staffId` / `openDingTalkId` 绑定为同一员工并迁移记忆与人设 |
| **记忆治理** | 按作用域 / 类型 / 状态筛选语义记忆，调整群内共享、敏感级别、置信度与过期时间，停用或删除错误记忆 |
| **ReAct 审计轨迹** | 按群过滤并分页查看每次回答的思维链、工具入参、耗时、沙盒输出与最终答案 |
| **术语知识库** | 按固定模板增删改查内部黑话，按名称 / 别名 / 时效性 / 敏感级别检索，查看注入命中统计、质量校验结果与系统提示预览 |
| **技能 Skills** | 浏览技能目录与触发条件预览、校验草稿、启用 / 停用、在线编辑 `SKILL.md` 与资源文件，查看近 7 天调用次数 |
| **声明式插件** | 校验并安装插件包，升级 / 回滚 / 启停 / 卸载，查看版本记录、缺失密钥与合并后的技能和 MCP 节点 |
| **项目手册** | 登记与同步项目、浏览快照与混合检索结果、生成 / 发布项目手册，维护各章节人工条目 |
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

控制台通过以下 REST 接口操作；ChatOps 在进程内复用同一配置中心与审计链路。除健康检查、就绪探针与指标外，接口前缀为 `/api/v1/admin`，需要带上 `Authorization: Bearer <ADMIN_API_TOKEN>`（未配置 Token 时不校验）。`/health`、`/healthz`、`/readyz` 与 `/metrics` 挂在服务根路径，其中 `/metrics` 单独校验 Token。

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
| GET / PUT | `/groups/:conversationId/workspace` | 读取 / 更新群定位、职责与备注 |
| POST | `/groups/:conversationId/goals` | 新建群目标（`due` 支持 `YYYY-MM-DD` 或时间戳） |
| PUT / DELETE | `/groups/:conversationId/goals/:goalId` | 更新 / 删除群目标 |
| POST | `/groups/:conversationId/tasks` | 新建群任务 |
| PUT / DELETE | `/groups/:conversationId/tasks/:taskId` | 更新 / 删除群任务（完成时自动记录完成时间） |
| GET | `/group-model-routes` | 全部按群模型路由 |
| GET / PUT / DELETE | `/groups/:conversationId/model-route` | 读取 / 保存 / 删除该群模型路由，并回显密钥环境变量是否已配置 |
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
| GET / POST | `/skills` | 技能列表 / 新建本地技能 |
| POST | `/skills/validate`、`/skills/reload`、`/skills/preview` | 校验草稿 / 重新扫描 / 预览目录 |
| GET | `/skills/usage` | 技能整体调用统计 |
| GET / PUT / DELETE | `/skills/:id` | 查看 / 更新 / 删除技能 |
| POST | `/skills/:id/enable`、`/skills/:id/disable` | 启用 / 停用技能 |
| GET / PUT / DELETE | `/skills/:id/resource` | 读取 / 写入 / 删除技能资源文件 |
| GET | `/skills/:id/usage` | 单技能调用统计 |
| GET | `/plugins` | 插件列表与运行时状态 |
| POST | `/plugins/validate`、`/plugins/install` | 校验插件包 / 安装（上传 zip 或服务器目录） |
| POST | `/plugins/:id/upgrade`、`/enable`、`/disable`、`/rollback` | 升级 / 启用 / 停用 / 回滚 |
| GET | `/plugins/:id`、`/plugins/:id/versions` | 插件详情 / 版本记录 |
| DELETE | `/plugins/:id` | 卸载插件 |
| GET / POST | `/projects` | 项目列表 / 登记项目 |
| GET / PUT / DELETE | `/projects/:id` | 项目详情 / 更新 / 删除 |
| POST | `/projects/:id/sync` | 触发一次同步（异步任务） |
| GET | `/projects/:id/status` | 索引统计、向量补齐、最近任务、手册版本与过期标记 |
| GET | `/projects/:id/sync-jobs`、`/snapshots`、`/search` | 同步任务 / 快照 / 混合检索 |
| GET / POST | `/projects/:id/manual-entries` | 人工条目列表 / 新增 |
| PUT / DELETE | `/projects/:id/manual-entries/:entryId` | 更新 / 删除人工条目 |
| GET | `/projects/:id/handbook`、`/handbooks` | 当前发布手册与最新草稿 / 全部版本 |
| PUT | `/projects/:id/handbook` | 基于最新草稿保存章节修改，生成新草稿 |
| POST | `/projects/:id/handbook/generate`、`/publish` | 生成草稿 / 发布指定版本或最新草稿 |
| GET | `/github/status` | GitHub 工具的真实运行状态（不读取 `.env` 文件中的未生效值） |
| POST | `/github/test` | 对指定或默认仓库做连通性测试（绕过缓存，写审计） |
| GET / PUT / DELETE | `/personas/:scope/:subjectKey` | 读取 / 更新 / 删除群或员工的分层人设（`scope` 为 `group` / `user`） |
| GET | `/identities` | 员工身份列表（含别名与合并关系） |
| POST | `/identities/bind` | 绑定 `staffId` / `openDingTalkId` 并迁移旧身份的记忆与人设 |
| GET / PUT | `/person-settings/preferences` | 列出 / 读取 / 更新员工个人偏好（`personKey` 作查询参数） |
| GET / PUT | `/person-settings/consents` | 列出 / 读取 / 更新员工跨群记忆授权与生效群白名单 |
| GET | `/memories` | 按作用域 / 类型 / 状态 / 归属 / 关键词检索语义记忆 |
| PATCH / DELETE | `/memories/:id` | 治理或删除语义记忆：共享范围、敏感级别、状态、置信度、过期时间 |
| GET | `/audit-logs` | 管理操作审计 |
| POST | `/chat/tickets` | 换取一次性 SSE 票据（60 秒内有效、用后即焚） |
| GET | `/api/v1/chat/stream?ticket=&question=` | 浏览器在线对话流（SSE，事件与钉钉卡片同源） |
| GET | `/feedback` | 用户反馈列表 |
| GET | `/usage?days=1` | 用量汇总：总 Token、输入/输出拆分、成本与按员工/群/模型/Worker/任务类型排名 |
| GET / POST | `/scheduled-tasks` | 定时任务列表（含各 `kind`）/ 创建主动播报 |
| PUT / DELETE | `/scheduled-tasks/:id` | 更新 / 删除定时任务；个人提醒与报告只允许删除，不支持管理端改期或立即执行 |
| POST | `/scheduled-tasks/:id/run` | 立即执行一次（仅主动播报） |
| GET | `/flow-eval?days=7&limit=500` | 基于真实 ReAct 轨迹的消息流评测：回答率、工具错误、引用、看门狗与窗口延迟 |
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
| 技能与插件 | 技能只来自本地受控目录；插件是纯声明包，安装前校验清单、命令白名单与密钥占位，不执行安装脚本；插件技能与 MCP 节点使用独立命名空间，不能覆盖手工配置 |
| 公网访问 | `web_fetch` 只允许 http/https 标准端口，固定 DNS 后连接并在每次跳转重新校验，拒绝本机、内网与保留地址；限制重定向次数、响应体大小与超时；网页内容按不可信数据处理，不执行其中指令 |
| 工作区文件 | `workspace_read_file` 与沙盒数据加载只解析工作区内路径，真实路径校验防目录穿越与软链接逃逸；二进制与超大文件直接拒绝 |
| 项目与 GitHub | 项目只读快照，敏感文件不入索引，`private` 项目限制单聊可见；GitHub 仅 HTTPS + 白名单主机且不跟随重定向，Token 只读环境变量，外部仓库内容按不可信数据处理 |
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
| `skills` / `skill_usage` | 技能元数据（正文仍在技能目录）与调用统计 |
| `plugins` / `plugin_versions` | 插件当前状态、清单与可回滚版本 |
| `projects` / `project_snapshots` / `project_sync_jobs` | 项目登记、不可变快照与同步任务 |
| `project_documents` / `project_chunks` / `project_symbols` | 项目文件、分块与符号索引（分块可选向量） |
| `project_handbooks` / `project_manual_entries` | 项目手册版本与人工条目 |
| `bystander_policies` | 群级旁听策略 |
| `sys_configs` | 动态配置（钉钉、模型、预算、MCP、默认群策略） |
| `react_traces` | ReAct 执行轨迹 |
| `admin_audit_logs` | 管理操作审计 |
| `user_feedback` | 用户对回答的反馈（`/feedback` 命令） |
| `usage_ledger` | 每次模型调用的 Token 拆分、模型、耗时、场景与估算成本 |
| `task_results` | 已完成后台任务的精简结果快照，供同会话历史追问检索 |
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
| DWS 查询报错 | 员工个人登录态过期：机器人会在提问时自动发起设备码授权并私聊推送链接；若员工长时间未授权，可让其在下一次提问时重试，或在单聊发送 `/dws-login` 手动重发 |
| DWS 提示缺权限 | 应用未开通对应权限点：管理员会收到含权限点与开通命令的单聊通知；按通知开通后，员工在单聊重新 `/dws-login` 刷新个人授权 |
| 工具结果被截断 | 超过了节点 `maxResultChars`，可调大上限或用沙盒对落盘数据做聚合 |

### 测试与质量评测

```bash
pnpm typecheck
pnpm test                    # 单元/集成测试，含 .env 安全约束与 golden set 题库校验
pnpm -C web-console build
```

30 题 golden set 评测需要可达的 `DATABASE_URL` 与已同步的项目（首次会自动导入 `projects/anthys` 种子）：

```bash
pnpm eval:golden -- --project=anthys --json=tmp/golden-report.json
pnpm eval:golden -- --no-sync   # 复用当前快照，不做重新同步
```

报告包含引用命中率、引用完整率、事实代理覆盖率（检索证据中 `factKeywords` 的命中比例）、`project_search` p95 与安全探针结果。它是确定性检索评测，不生成回答文本，事实覆盖率不等同于人工判分；安全项覆盖密钥泄露、敏感文件与 `.env` 读取探针，不覆盖模型是否服从仓库内提示注入。未达标时命令以非零状态退出，可用于发布前检查。

消息流评测读取 `react_traces` 中已落库的真实消息轨迹，不调用模型也不产生额外费用：

```bash
pnpm eval:flow -- --days=7 --limit=500 --json=tmp/flow-report.json
pnpm eval:flow -- --days=7 --cases=eval/flow/cases.json
```

报告包含回答率、含工具轮次的错误率、引用覆盖率、看门狗触发率、Token/耗时均值与 p95。传入 `--cases` 时按 `question`（忽略空白、大小写和句末标点）匹配最近一条轨迹，并校验期望关键词、必须/禁止工具、引用、步数与 Token 上限；任用例未通过时命令以非零状态退出。用例文件格式：

```json
{
  "description": "发布流程回归",
  "cases": [
    {
      "id": "publish",
      "question": "如何发布到生产？",
      "expectedKeywords": ["pnpm db:push", "systemd"],
      "expectedTools": ["project_search"],
      "forbiddenTools": ["dws_approval_manage"],
      "requireCitation": true,
      "maxSteps": 8,
      "maxTokens": 60000
    }
  ]
}
```

同一份汇总也可通过管理端 `GET /flow-eval?days=7` 获取。控制台「大盘」页展示今日成本归因；更长时间窗口可直接调用 `/usage?days=N`。

---

## 已知边界

- 动态配置面向单实例进程；多实例部署需要额外的配置分发与广播机制。
- 群聊旁听缓冲位于进程内存，重启后由新消息重新积累；摘要与语义记忆不受影响。
- 按群模型路由只覆盖交互式群聊（含主动回复）；静默调查仍沿用默认调查引擎，不读取群路由。
- 群目标与群任务是轻量工作项，用于给群聊提供长期上下文，不复用后台任务队列的租约、重试与 Worker 预算。
- 未绑定的 DWS `openDingTalkId` 会按 `external:<id>` 独立隔离，避免误并到其他员工；需要管理员在控制台确认后绑定，才能与同一员工的 `staffId` 共享记忆与人设。
- 主动回复由模型判定驱动，不解析固定口令；对主题词与置信度的调整比改提示词更有效。
- DWS 的写操作（建日程、建待办、改通讯录、发审批）需要应用开通对应权限点；缺失时机器人会通知管理员，但不会自动替管理员开通或发版。
- 项目符号与引用基于轻量解析与全文索引，不是编译器级 AST；复杂泛型、动态导入与跨语言调用链的推导有限，结论仍应回到 `path:line @ commit` 核对。
- 项目手册由确定性规则生成，可选补充人工条目，不调用模型撰写叙述；需要总结或对比时由模型基于手册与代码现场回答。
- 插件第一期只做声明式分发，不执行任意安装脚本，也不提供插件市场；需要新的可执行能力时通过 MCP 节点或技能接入。
- GitHub 工具只读并受 GitHub API 速率与网络可达性限制；私有仓库需配置 Token，企业内网实例需把 API 主机加入 `GITHUB_ALLOWED_HOSTS`。
- 管理控制台是现代浏览器单页应用，不提供旧版浏览器兼容。
- 真实钉钉、真实模型与企业 MCP 的联通性取决于部署环境的网络与凭据，需要在实际环境中验证。

---

## 反馈

问题、建议或接入需求，欢迎在 [Issues](https://github.com/SongJok/anthys/issues) 中提出。

项目主页：https://github.com/SongJok/anthys 。如果这个项目对你有帮助，欢迎到 GitHub 点个 Star（点赞）。
