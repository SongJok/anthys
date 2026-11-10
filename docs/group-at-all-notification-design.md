# 群聊「@所有人」原生全员通知：现状诊断与改造方案

> 版本：v1.1（A/B 期已实现，见 §10 落地状态）
> 日期：2026-11-10
> 适用仓库：`anthys`（钉钉智能体）
> 读者：研发、运维、产品、群管理员
> 范围声明：**本文只做设计与改动说明，不修改业务代码、不发送任何真实群消息。** 所有接口契约均已对照钉钉官方文档与本地安装的 `@alicloud/dingtalk@2.2.48` SDK 核实。
> 结论一句话：**当前项目不支持原生「@所有人」。截图里的 `@所有人` 只是模型写进正文的普通文字，不会触发全员提醒。要支持，需要在「模型工具层 + 权限确认层 + 投递层」三处改动，核心是把卡片群投递模型的 `atUserIds` 设为 `{"@ALL":"@ALL"}`（或文本兜底 `at.isAtAll:true`），并用管理员校验 + 二次确认 + 限流 + 审计把它管起来。**

---

## 0. 结论与建议

### 0.1 三句话诊断

1. **机器人从来没有发出过任何「全员」参数。** 群聊卡片只 @ 提问人一个人（[src/dingtalk/CardStreamer.ts:966-974](../src/dingtalk/CardStreamer.ts#L966)），文本兜底硬编码 `isAtAll:false`（[src/dingtalk/TextFallback.ts:92-94](../src/dingtalk/TextFallback.ts#L92)），提及工具只会拼提问人（[src/dingtalk/Mentions.ts:29-43](../src/dingtalk/Mentions.ts#L29)）。
2. **截图里的 `@所有人` 是模型「写」出来的文字，不是钉钉「渲染」出来的提及。** 模型在正文里打了 `@所有人` 五个字，钉钉客户端把它当普通文本显示，既不高亮也不推送提醒；同时模型还暗示「已通知大家」，属于虚假成功。
3. **能力底座其实都在仓库里。** 卡片 SDK 的群投递模型支持 `atUserIds: Map<string,string>`，可以承载 `{"@ALL":"@ALL"}`；确认闸门（`PendingActionStore`）、管理员判定（`DynamicConfigCenter.isAdmin`）、会话级限流（`CooldownLimiter`）都已存在，缺的只是一个受控的「全员通知」工具入口和投递层的一行参数。

### 0.2 建议（分期）

| 期 | 内容 | 工期 | 依赖 | 见效方式 |
| --- | --- | --- | --- | --- |
| **A 期（最小可用）** | 新增 `group_notify_all` 工具 + 管理员校验 + 二次确认 + 卡片 `{"@ALL":"@ALL"}` 投递 + 文本兜底 `isAtAll` | 2～3 天 | 无 | 管理员在群里说「通知所有人…」，确认后真正触发全员提醒 |
| **B 期（安全加固）** | 会话级限流/冷却 + 幂等去重 + 审计落库 + 防虚假成功契约 + 群管理员身份解析 | 2～3 天 | A 期 | 防刷屏、防重复、可追溯、非管理员不可用 |
| **C 期（可选扩展）** | 定时/主动全员播报（需解决合成身份与 webhook 失效）+ 控制台开关与配额 | 3～5 天 | B 期；需合规确认 | 群定时任务到点全员提醒 |

**为什么 A 期就能见效**：原生全员通知的「开关」就是投递时的一个参数，钉钉在 `createAndDeliver`（投放）那一刻触发提醒，不需要新接口、不需要公网域名。把参数接上、把入口管住，即可上线。

---

## 1. 现状诊断（带代码证据）

### 1.1 三条投递路径，没有一条带「全员」

| 路径 | 触发场景 | 当前提及能力 | 代码证据 | 能否原生 @所有人 |
| --- | --- | --- | --- | --- |
| AI 卡片（主路径） | 群聊被 @ 提问、单聊 | 群投递模型只 `atUserIds:{[staffUserId]:staffUserId}`，即只 @ 提问人 | [CardStreamer.ts:966-974](../src/dingtalk/CardStreamer.ts#L966) | **能**，改成 `{"@ALL":"@ALL"}` 即可（见 §2.1） |
| 文本兜底（markdown） | 卡片不可用/整轮异常 | `at:{atUserIds, isAtAll:false}`，且 `atUserIds` 为空时干脆不带 `at` | [TextFallback.ts:92-94](../src/dingtalk/TextFallback.ts#L92) | **能**，加 `isAtAll:true` 输入（见 §2.2） |
| 主动/定时群播报 | 群定时任务到点 | 合成 `scheduler` 身份、`cardDeliverUserId:''`，走卡片群投递但不带任何 `atUserIds` | [index.ts:3389-3408](../src/index.ts#L3389) | 卡片路径同 §2.1 可带；但无有效 webhook、无真实提问人，需单独设计（见 §3.6） |

### 1.2 提及逻辑只认「提问人」

- `replyMention()`：群聊非主动回复时返回 `@${昵称}\n`，仅作正文前缀（[Mentions.ts:8-16](../src/dingtalk/Mentions.ts#L8)）。
- `webhookMention()`：返回 `{ text:'@'+userId+'\n', atUserIds:[userId] }`，**只有提问人一个**；外部群成员（加密 id）退回纯昵称、`atUserIds:[]`（[Mentions.ts:29-43](../src/dingtalk/Mentions.ts#L29)）。
- `isStaffUserId()` 排除 `$:`、`cid`、`scheduler`、`admin-api` 等非真实员工 id（[userIds.ts:5-14](../src/dingtalk/userIds.ts#L5)）。这也是为什么定时播报的 `scheduler` 身份不会进入 `atUserIds`。

### 1.3 模型工具面没有「全员通知」入口

群工作区工具 `group_schedule_manage` 只能建/取消群定时任务，参数为 `action/when/text/mode/id`，**没有任何「立即全员通知」或 `atAll` 字段**（[GroupWorkspaceToolProvider.ts:759-839](../src/tools/groups/GroupWorkspaceToolProvider.ts#L759)）。模型想「通知所有人」时无工具可用，只能在正文里打 `@所有人` 文字——这正是截图问题的直接成因。

### 1.4 入站消息没有「群管理员」身份

`InboundMessage` 字段里没有 `isAdmin`/群主标识（[types/core.ts:19-39](../src/types/core.ts#L19)）；`MessageParser` 也没有解析钉钉回调里的 `isAdmin`（[MessageParser.ts:109-187](../src/dingtalk/MessageParser.ts#L109)）。当前唯一可用的管理员判定是**机器人级管理员白名单** `DynamicConfigCenter.isAdmin(staffId)`（[DynamicConfigCenter.ts:203-205](../src/config/DynamicConfigCenter.ts#L203)），群目标播报就是这么管的（[GroupReportService.ts:266-267](../src/groups/GroupReportService.ts#L266)）。若要支持「本群群主/群管理员」也能用，需要额外解析入站 `isAdmin`（见 §3.3）。

---

## 2. 钉钉官方接口契约（已核实）

### 2.1 AI 卡片：群投递模型 `atUserIds = {"@ALL":"@ALL"}`

- 投放接口 `POST /v1.0/card/instances/createAndDeliver`，群投递模型 `imGroupOpenDeliverModel.atUserIds` 是 `Map<string,string>`。
- **全员规则：键和值都填字符串 `@ALL`**，即 `atUserIds: { "@ALL": "@ALL" }`，钉钉据此触发原生「@所有人」提醒。这是官方文档明确给出的全员写法（不是 `isAtAll` 布尔字段——卡片群投递模型里没有该字段）。
- 本地 SDK 可承载：`CreateAndDeliverRequestImGroupOpenDeliverModel` 字段为 `atUserIds`(map)、`extension`、`recipients`(string[])、`robotCode`（`node_modules/.pnpm/@alicloud+dingtalk@2.2.48/.../dist/card_1_0/client.d.ts:1978`）。当前代码已在用 `atUserIds:{[staffUserId]:staffUserId}`（[CardStreamer.ts:970-972](../src/dingtalk/CardStreamer.ts#L970)），换成 `{"@ALL":"@ALL"}` 是同一字段的合法取值。
- **提醒时机：在 `createAndDeliver`（投放）那一刻触发，`streamingUpdate` 流式刷新不会再触发提醒。** 因此全员通知必须在「创建并投放」时带上参数，不能指望流式更新补发。
- 全员与单人互斥语义：`{"@ALL":"@ALL"}` 表示全员；若同时还想保留提问人高亮，正文前缀仍可写 `@昵称`，但提醒以投递参数为准。建议全员场景**不再叠加单人 `atUserIds`**，避免歧义。

### 2.2 机器人文本消息：`at.isAtAll = true`

- sessionWebhook / 机器人 markdown 消息体支持 `at: { isAtAll: true }`（text/markdown/actionCard 均可）。
- **高亮差异：text 类型会高亮「@所有人」；markdown / actionCard 会触发全员提醒但正文不渲染高亮提及。** 本项目文本兜底走 markdown（[TextFallback.ts:90-91](../src/dingtalk/TextFallback.ts#L90)），所以兜底全员通知「会提醒、不高亮」，需在验收预期里写明。
- 当前 `TextFallbackInput` 只有 `atUserIds?`，没有 `isAtAll`（[TextFallback.ts:40-52](../src/dingtalk/TextFallback.ts#L40)），且发送体硬编码 `isAtAll:false`（[TextFallback.ts:92-94](../src/dingtalk/TextFallback.ts#L92)）。需新增 `isAtAll?:boolean` 输入并透传。

### 2.3 边界与限制

- **sessionWebhook 会过期**（`sessionWebhookExpiredTime`）。主动/定时路径常常没有有效 webhook，文本兜底全员通知在这些路径不可靠，应优先走卡片群投递（§2.1）。
- 全员通知是**强打扰**能力，钉钉侧与群设置侧都可能限制机器人 @所有人 的权限；若投放返回权限错误，必须如实降级为「仅发送普通群消息 + 说明未能全员提醒」，不得谎称已通知（见 §3.7）。

---

## 3. 方案设计

### 3.1 总体链路

```mermaid
flowchart TD
  U[群成员: 通知所有人 明天9点开会] --> P{权限校验<br/>管理员/群管理员?}
  P -- 否 --> D[拒绝: 仅管理员可全员通知]
  P -- 是 --> G[登记待确认动作<br/>PendingActionStore.put]
  G --> Q[回复: 将全员通知, 回复 确认 执行]
  Q --> C{用户回复 确认?}
  C -- 取消/超时 --> X[放弃, 不发送]
  C -- 确认 --> L{限流/幂等<br/>CooldownLimiter?}
  L -- 冷却中 --> R[拒绝: N秒内已全员通知过]
  L -- 通过 --> T[执行 group_notify_all]
  T --> A[审计落库 + 标记冷却]
  A --> S{投递}
  S -- 卡片可用 --> K[createAndDeliver<br/>atUserIds:&#123;'@ALL':'@ALL'&#125;]
  S -- 卡片失败 --> W[文本兜底<br/>at.isAtAll:true]
  K --> OK[如实回执: 已全员通知 / 失败原因]
  W --> OK
```

### 3.2 模型工具层：新增 `group_notify_all`

挂在现有群工作区工具 provider（与 `group_schedule_manage` 同处，[GroupWorkspaceToolProvider.ts:759](../src/tools/groups/GroupWorkspaceToolProvider.ts#L759)），仅群聊（`conversationType==='2'`）暴露：

```jsonc
{
  "name": "group_notify_all",
  "description": "在当前群发起一次原生@所有人通知（仅群聊、仅管理员、需二次确认）。text 为通知正文。会真正触发全员提醒，请仅在用户明确要求通知所有人时使用。",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "全员通知正文" }
    },
    "required": ["text"],
    "additionalProperties": false
  },
  "risk": "write",          // 名称含 notify/send 语义，classifyToolRisk 也会判为 write
  "source": "group-workspace"
}
```

要点：
- `risk:'write'`（甚至可标 `destructive` 以强制走确认），确保进入确认闸门而非被自动放行。注意 `resolveToolApproval` 目前对部分群工具自动放行（[index.ts:1018-1024](../src/index.ts#L1018)），**新工具不要加入该自动放行白名单**。
- 工具 `execute` 不直接发消息，而是返回「已登记待确认」结构，由确认路由在用户回复「确认」后真正投递（复用 §3.3 的 `PendingActionStore` 机制）。这样模型无法绕过确认直接全员轰炸。
- 工具描述里明确「会真正触发全员提醒」，并配合 §3.7 的回答契约，杜绝模型把文字 `@所有人` 当成已通知。

### 3.3 权限与二次确认

**权限（两道，满足其一即可，建议默认只用第一道）：**
1. 机器人级管理员：`DynamicConfigCenter.isAdmin(senderStaffId)`（[DynamicConfigCenter.ts:203](../src/config/DynamicConfigCenter.ts#L203)），与群目标播报一致（[GroupReportService.ts:266](../src/groups/GroupReportService.ts#L266)）。零新增解析，A 期即可用。
2. （B 期可选）本群群主/群管理员：在 `MessageParser` 解析钉钉回调 `isAdmin` 字段并加到 `InboundMessage`（[MessageParser.ts:184](../src/dingtalk/MessageParser.ts#L184)、[types/core.ts:19](../src/types/core.ts#L19)）。注意该字段仅在机器人已发布后可靠携带，需做缺省兜底。

**二次确认（复用现有闸门，不新造轮子）：**
- 用 `PendingActionStore.put()` 登记 `{conversationId, toolName:'group_notify_all', args:{text}, risk, requestedBy}`（[ToolApprovalGate.ts](../src/harness/ToolApprovalGate.ts) 的 `PendingToolAction`/`put`）。每会话只保留一个待确认动作、默认 5 分钟 TTL、DB 持久化。
- 提示文案复用 `formatApprovalPrompt` 风格：「将向本群所有人发送通知：<text>。回复「确认」执行，或「取消」放弃；300 秒内有效。」
- 用户回复「确认/取消」由 `CommandRouter` 中文别名路由到 `confirm/cancel`（[CommandRouter.ts:112-144](../src/commands/CommandRouter.ts#L112)），确认后 `take()` 取出动作并真正投递。
- **校验确认人 == 发起人**：`requestedBy.staffId` 必须与回复「确认」的人一致，避免群里他人代为确认。

### 3.4 限流、幂等与审计

- **限流/冷却**：复用 `CooldownLimiter`（[CooldownLimiter.ts:11-51](../src/bystander/CooldownLimiter.ts#L11)），key 用 `conversationId`，`markReplied` 在成功投递后调用，`isCoolingDown` 在执行前检查。建议默认冷却 60s（可配），防止短时间内反复全员轰炸。
- **幂等去重**：以 `outTrackId`/动作 id 去重，确认重放或网络重试不得产生第二次全员提醒。卡片投放本身用唯一 `outTrackId`，文本兜底用动作 id 做一次性标记。
- **审计**：落库一条全员通知记录（conversationId、发起人 staffId、text 摘要、时间、投递路径 card/text、成功/失败、错误码），供控制台追溯。可挂在现有审计/trace 存储上。

### 3.5 投递层改造（核心一行参数）

**卡片路径**（[CardStreamer.ts:966-974](../src/dingtalk/CardStreamer.ts#L966)）：
- 在 `CardCreateInput.deliver` 增加 `atAll?:boolean`（[CardStreamer.ts:41-46](../src/dingtalk/CardStreamer.ts#L41)）。
- 群投递模型按 `atAll` 分支：
  ```ts
  imGroupOpenDeliverModel: input.deliver.conversationType === '2'
    ? new this.sdk.CreateAndDeliverRequestImGroupOpenDeliverModel({
        robotCode: input.deliver.robotCode,
        ...(input.deliver.atAll
          ? { atUserIds: { '@ALL': '@ALL' } }           // 原生全员
          : staffUserId ? { atUserIds: { [staffUserId]: staffUserId } } : {}),
      })
    : undefined,
  ```
- 提醒在投放时触发；`streamingUpdate` 不变（[CardStreamer.ts:1007](../src/dingtalk/CardStreamer.ts#L1007)）。

**文本兜底路径**（[TextFallback.ts:40-94](../src/dingtalk/TextFallback.ts#L40)）：
- `TextFallbackInput` 增加 `isAtAll?:boolean`。
- 发送体改为：
  ```ts
  ...(input.isAtAll
    ? { at: { isAtAll: true } }
    : atUserIds.length > 0 ? { at: { atUserIds, isAtAll: false } } : {}),
  ```
- 注意 markdown 全员「提醒但不高亮」（§2.2），验收预期需写明。

**提及前缀**：全员场景正文可不带 `@提问人` 前缀（`mention` 选项，[CardStreamer.ts:140-141](../src/dingtalk/CardStreamer.ts#L140)），避免与「@所有人」语义混淆；是否保留由产品决定。

### 3.6 主动/定时路径的限制（C 期）

群定时播报用合成 `scheduler` 身份、`cardDeliverUserId:''`（[index.ts:3389-3408](../src/index.ts#L3389)）：
- 卡片群投递不依赖真实提问人，理论上可带 `atAll:true` 触发全员；但**没有有效 sessionWebhook**，文本兜底不可用。
- 定时全员属于「无人值守强打扰」，必须有：任务创建时的管理员授权 + 明确的全员标记 + 冷却/配额 + 审计。建议 C 期再做，并在 `group_schedule_manage` 增加显式 `atAll` 参数而非默认全员。

### 3.7 防虚假成功契约

- 工具/技能文案明确：**只有投递接口返回成功，才能说「已通知所有人」**；返回权限错误或投放失败时，必须说「未能全员提醒（原因），已作为普通群消息发送」。
- 在群办公技能（[skills/builtin/dingtalk-office/SKILL.md](../skills/builtin/dingtalk-office/SKILL.md)）或新建 `group-notify` 技能里加约束：禁止把正文文字 `@所有人` 当作已触发提醒；禁止在未调用 `group_notify_all` 时声称已全员通知。
- 投递结果（card/text、success、errorMsg）回填给模型作为工具结果，模型据此组织回执。

---

## 4. 改动清单（按文件）

| # | 文件 | 改动 | 期 |
| --- | --- | --- | --- |
| 1 | [src/tools/groups/GroupWorkspaceToolProvider.ts](../src/tools/groups/GroupWorkspaceToolProvider.ts) | 新增 `group_notify_all` 工具（仅群聊、risk write、execute 登记待确认） | A |
| 2 | [src/dingtalk/CardStreamer.ts](../src/dingtalk/CardStreamer.ts) | `CardCreateInput.deliver.atAll?`；群投递模型 `{"@ALL":"@ALL"}` 分支 | A |
| 3 | [src/dingtalk/TextFallback.ts](../src/dingtalk/TextFallback.ts) | `TextFallbackInput.isAtAll?`；发送体 `at.isAtAll:true` 分支 | A |
| 4 | [src/index.ts](../src/index.ts) | 确认路由执行 `group_notify_all` 时把 `atAll`/`isAtAll` 透传到 streamer/兜底；新工具**不**加入自动放行白名单（[index.ts:1018-1024](../src/index.ts#L1018)） | A |
| 5 | [src/harness/ToolApprovalGate.ts](../src/harness/ToolApprovalGate.ts) | 复用 `PendingActionStore`；如需全员专用提示文案可扩展 `formatApprovalPrompt` | A |
| 6 | [src/config/DynamicConfigCenter.ts](../src/config/DynamicConfigCenter.ts) | 新增全员通知开关/冷却/配额配置项（见 §5） | B |
| 7 | [src/bystander/CooldownLimiter.ts](../src/bystander/CooldownLimiter.ts) | 复用（或实例化一个全员专用 limiter），key=conversationId | B |
| 8 | 审计存储（trace/audit store） | 新增全员通知审计记录 | B |
| 9 | [src/dingtalk/MessageParser.ts](../src/dingtalk/MessageParser.ts) + [src/types/core.ts](../src/types/core.ts) | （可选）解析入站 `isAdmin`，支持群管理员授权 | B |
| 10 | [skills/builtin/dingtalk-office/SKILL.md](../skills/builtin/dingtalk-office/SKILL.md) 或新技能 | 防虚假成功契约 + 全员通知使用约束 | A |
| 11 | [src/index.ts:3380-3419](../src/index.ts#L3380) + `group_schedule_manage` | （可选）定时全员播报，显式 `atAll` 参数 | C |

---

## 5. 配置项（建议）

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `GROUP_NOTIFY_ALL_ENABLED` | `false`（灰度）| 全员通知总开关，关闭时工具不暴露 |
| `GROUP_NOTIFY_ALL_COOLDOWN_SECONDS` | `60` | 同会话两次全员通知最小间隔 |
| `GROUP_NOTIFY_ALL_ALLOW_GROUP_ADMIN` | `false` | 是否允许本群群管理员（非机器人白名单）使用 |
| `GROUP_NOTIFY_ALL_DAILY_QUOTA` | `10` | 单群每日全员通知上限（可选） |

沿用现有 env 解析风格（`envEnabled`/数值解析，参见 [index.ts](../src/index.ts) 中 `ARTIFACT_DELIVERY_ENABLED` 等用法）。

---

## 6. 测试计划（本地，不发送真实群消息）

| 测试文件 | 用例 |
| --- | --- |
| `src/dingtalk/OpenApiCardApi.test.ts` | 群投递 `atAll:true` → 请求体 `imGroupOpenDeliverModel.atUserIds == {"@ALL":"@ALL"}`；`atAll:false` 仍只 @ 提问人；外部加密 id 不进入 atUserIds（对照现有 [OpenApiCardApi.test.ts:134-198](../src/dingtalk/OpenApiCardApi.test.ts#L134)） |
| `src/dingtalk/TextFallback.test.ts` | `isAtAll:true` → 发送体 `at.isAtAll:true`；缺省仍 `isAtAll:false`/无 at（对照现有 [TextFallback.test.ts:80-108](../src/dingtalk/TextFallback.test.ts#L80)） |
| `GroupWorkspaceToolProvider.test.ts` | 非群聊不暴露工具；非管理员调用被拒；管理员调用登记待确认而非直接发送 |
| `ToolApprovalGate`/确认路由测试 | 确认人≠发起人被拒；超时动作失效；取消不投递；确认后才投递一次 |
| `CooldownLimiter` 复用测试 | 冷却内第二次全员通知被拒；冷却结束放行 |
| 幂等测试 | 同一动作 id 重放只投递一次 |

命令：`pnpm typecheck && pnpm test`（Node 24，`/opt/homebrew/opt/node@24/bin` 在 PATH 上）。

---

## 7. 真机验收（上线前必做）

> 本地契约测试覆盖不到客户端渲染与钉钉权限，必须用企业应用凭据 + 已发布机器人 + 真实群完成一次验收。

1. 管理员在测试群 @ 机器人「通知所有人：明天9点开会」→ 机器人复述并要求「确认」。
2. 回复「确认」→ 群内出现**原生「@所有人」高亮 + 全员提醒**（卡片路径）；非管理员手机收到全员通知推送。
3. 卡片不可用时降级 markdown → **收到全员提醒但正文不高亮**（符合 §2.2 预期）。
4. 非管理员发起 → 被拒；冷却内重复发起 → 被拒；回复「取消」→ 不发送。
5. 故意制造投放权限错误 → 机器人如实说明「未能全员提醒」，不谎称成功。
6. 控制台/审计可查到该次全员通知记录。

---

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 全员强打扰被滥用/刷屏 | 管理员校验 + 二次确认 + 冷却 + 每日配额 + 审计 |
| 钉钉侧限制机器人 @所有人 权限 | 投放失败如实降级为普通群消息并说明；验收第 5 项覆盖 |
| 模型把文字 `@所有人` 当已通知 | §3.7 回答契约 + 技能约束 + 工具结果回填 |
| 他人代为确认 | 确认人必须等于发起人（§3.3） |
| 定时全员无人值守打扰 | C 期再做，显式 `atAll` + 创建时授权 + 配额 |
| 上线后发现问题 | `GROUP_NOTIFY_ALL_ENABLED=false` 一键关闭，工具不暴露，投递层 `atAll` 分支自然失活 |

---

## 9. 一句话合理性论证

原生全员通知 = **投递参数（`{"@ALL":"@ALL"}` / `isAtAll:true`）× 受控入口（管理员 + 确认）× 防滥用（冷却 + 幂等 + 配额）× 可追溯（审计）× 诚实回执（防虚假成功）**。本项目五项里「投递参数」只差一行、「受控入口/防滥用/可追溯」的底座（`PendingActionStore`、`isAdmin`、`CooldownLimiter`、trace 存储）全都已在仓库，缺的只是一个工具入口把它们串起来。因此 A 期 2～3 天即可让管理员真正「通知所有人」，且全程可灰度、可回滚、可审计。

---

## 10. 落地状态（2026-11-10，A/B 期已实现）

### 10.1 实际改动与设计差异

| 设计项 | 实际落地 |
| --- | --- |
| 卡片 `atAll` | [CardStreamer.ts](../src/dingtalk/CardStreamer.ts)：`CardStreamerOptions.atAll` → `CardCreateInput.deliver.atAll` → 群投递模型 `atUserIds:{"@ALL":"@ALL"}`（与单人提及互斥） |
| 文本兜底 `isAtAll` | [TextFallback.ts](../src/dingtalk/TextFallback.ts)：`isAtAll` 输入，**仅首个分片**携带 `at.isAtAll:true`，避免长文本分片重复触发全员提醒 |
| 新工具 | [GroupWorkspaceToolProvider.ts](../src/tools/groups/GroupWorkspaceToolProvider.ts) 新增 `group_notify_all`（risk=write，source=group-workspace），**仅功能开启且发起人是管理员时暴露**，比设计更强：非管理员的模型根本看不到该工具 |
| 权限/冷却/配额/审计服务 | 新文件 [GroupNotifyAllService.ts](../src/groups/GroupNotifyAllService.ts)：执行时二次验权、`CooldownLimiter` 冷却、上海自然日配额、`inFlight` 并发防重（同步检查阻塞双确认竞态）、成功才标记冷却；审计经 `configCenter.recordAudit`（新增 `GROUP_NOTIFY_ALL` 动作类型）+ 指标 `group_notify_all_total` |
| 确认 | 复用现有 `PendingActionStore` + 「确认/取消」中文口令；工具未加入 [index.ts](../src/index.ts) 的群工具自动放行白名单，必然走确认；确认后还原发起人身份执行 |
| 投递端口 | [index.ts](../src/index.ts) 在 `createStreamer` 之后注入 `groupNotifyAll.deliver`：合成 `scheduler` 群消息 + `atAll:true` 卡片投放；卡片失败回退 `runControl.messageById` 取原始消息 sessionWebhook 走 `isAtAll:true` 文本；双通道失败抛错，服务层如实回执 |
| 配置 | 按现有 env 风格：`GROUP_NOTIFY_ALL_ENABLED`（默认 false）、`GROUP_NOTIFY_ALL_COOLDOWN_SECONDS`（60）、`GROUP_NOTIFY_ALL_DAILY_QUOTA`（10），已写入 `.env.example` 与 README |
| 防虚假成功 | 三道：全局 `TOOL_GUIDANCE` 新增 @所有人契约（[ContextAssembler.ts](../src/memory/ContextAssembler.ts)）；工具描述内置约束；`isHallucinatedToolAction` 扩展识别「未调工具却声称已通知所有人/全员」（[ReActRunner.ts](../src/react/ReActRunner.ts)，仅在整轮无任何工具调用时触发，真实成功回执不受影响） |
| 群管理员身份解析（设计 B 期可选项） | **未实现**：入站 `isAdmin` 只在机器人发布后可靠携带且无法本地验证，本期授权范围限定机器人管理员白名单，已写入 README 已知边界 |
| 定时/主动全员（C 期） | 未实现，保持设计中的限制说明 |

### 10.2 验证证据

- `pnpm typecheck`（Node v24.22.2）通过。
- 新增/改动测试单跑：`OpenApiCardApi`（含 @ALL wire 契约、外部加密 id、单聊忽略 atAll）、`TextFallback`（首片提醒/多分片不重复/优先级）、`CardStreamer`（atAll 透传）、`GroupNotifyAllService`（12 例：开关/越权/空与超长/冷却/跨日配额/跨群隔离/失败不标记冷却/并发防重/端口未就绪/审计失败不阻塞）、`GroupWorkspaceToolProvider`（暴露条件/锁定本群/失败回执）、`ReActRunner`（拦截与真实回执不误伤）——5+1 个文件 95 例全部通过。
- 全量 `pnpm test`：**126 文件 / 1014 例全部通过**。
- **未验证（外部阻塞）**：真实钉钉群的全员提醒渲染与推送。需要管理员在测试群开启 `GROUP_NOTIFY_ALL_ENABLED=true` 后按 §7 真机验收；卡片投放权限、客户端高亮与兜底通道行为以真机为准。