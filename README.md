# 钉钉智能体（阶段一）

钉钉 Stream 模式机器人：单聊与群聊 @ 机器人时，通过 AI 卡片流式输出原生思维链与 Markdown 正文，内置可配置人设、PostgreSQL 多轮记忆与动态 ReAct 工具循环。

## 架构

```
src/
├── config/      环境变量与 IConfigProvider
├── dingtalk/    Stream 网关、消息解析器、AI 卡片流式渲染器与节流器
├── harness/     AgentHarness（消息 → 记忆 → 上下文 → 引擎）与 DynamicLoopGuard
├── react/       ReActRunner、内置工具、OpenAI/Anthropic 流式模型适配
├── memory/      PostgreSQL 会话仓库与上下文组装
├── db/          Drizzle Schema、连接与 Seed
└── index.ts     启动入口
```

处理链路：

1. `DWClient` 注册 `TOPIC_ROBOT`，收到回调立即 ACK，再异步解析。
2. 群聊中未 @ 机器人的消息直接忽略；非文本消息忽略；相同 `messageId` 去重。
3. `AgentHarness` 拉取最近 `MEMORY_WINDOW_MESSAGES` 条历史，注入人设与工具说明，写入用户消息。
4. `ReActRunner` 以 `stream: true` 运行：分离 `reasoning_content` / `thinking`、正文与 `tool_calls`。
5. `CardStreamer` 把增量写入卡片三个区块：`thinking_section`、`answer_section`、`status_bar`；每 250ms 或每 80 字符刷新，工具事件与完成事件立即刷新。
6. 助手回答（含推理与 token 用量）落库，完成多轮记忆。

动态循环不使用固定轮数：由 `DynamicLoopGuard` 按墙钟时间、Token 预算与“同工具同参数连续调用”判定是否继续；预算耗尽时以 `tool_choice: none` 做一次收尾汇总。

## 前置条件

- Node.js 20 LTS（项目要求 `NODE_VERSION` 20）
- pnpm
- PostgreSQL（默认 `postgres://localhost:5432/dingtalk_agent`）

## 钉钉侧准备

1. 在钉钉开放平台创建企业内部应用，启用机器人，消息接收方式选择 **Stream 模式**（无需公网域名或 Webhook）。
2. 记录 `AppKey`（`DINGTALK_CLIENT_ID`）、`AppSecret`（`DINGTALK_CLIENT_SECRET`）与机器人 `robotCode`（通常与 AppKey 相同）。
3. 在钉钉卡片平台创建 **AI 卡片模板**，模板变量必须包含：
   - `thinking_section`：折叠区，展示原生思维链与工具调用轨迹（Markdown）
   - `answer_section`：正文区（Markdown）
   - `status_bar`：状态角标（纯文本，建议渲染在标题栏或底部）
   将模板 ID 填入 `DINGTALK_CARD_TEMPLATE_ID`。
4. 将机器人添加到目标群；群聊中只有 @ 机器人 的消息会得到响应。

## 启动

```bash
cp .env.example .env
# 填写 DINGTALK_*、LLM_BASE_URL、LLM_API_KEY、DATABASE_URL

pnpm install
pnpm run db:push      # 创建 conversations / messages / agent_configs
pnpm run db:seed      # 写入默认人设与大模型配置（已有行不覆盖）
pnpm start            # 或 pnpm dev（watch 模式）
```

- 人设与大模型参数优先读取数据库 `agent_configs`，缺失时回退 `.env`；`LLM_API_KEY` 只从环境变量读取，不落库。
- `pnpm start` 会先执行配置校验，缺少必需变量时直接退出并列出缺失项。
- 进程退出时断开 Stream 连接并关闭数据库连接池。

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

覆盖内容：动态预算与重复调用拦截、上下文窗口、ReAct 流式事件与多步工具、内置工具边界、消息解析、群聊 @ 过滤、Stream ACK/去重、卡片三区块节流与收尾、AgentHarness 多轮持久化。

真实钉钉与真实模型链路的端到端验收需要有效的企业应用凭据、卡片模板与 LLM Key；本仓库的自动化测试不访问外部网络。

## 阶段一边界

- 不接入外部 MCP Server，不执行 DWS CLI。
- 群聊中非 @ 消息旁听即忽略。
- 不提供前端页面，配置由 `.env` 与数据库初始 Seed 提供。
