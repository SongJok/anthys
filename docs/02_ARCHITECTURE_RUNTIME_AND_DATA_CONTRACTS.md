# anthys｜02 技术架构、原生运行时与数据契约

实施补充（2026-10-18，群事务切片进行中）：087/088 增加 group_cases、不可变来源/变更/幂等请求记录及最小群成员投影。正文加密，tenant/group 与合同外键绑定；API 的真实会话、当前成员目录、独立委托、合同动作、合同版本、事项版本和安全停止开关均重新检查。管理员通过受限函数取得本群成员 ID/显示名，不扩大私人 DWS 目录 SELECT。合同暂停/撤销沿原群锁串行化；查询锁等待最多10秒、单条语句最多12秒，连接池耗尽返回受控503，原幂等键可在恢复后核对。中止的本地请求在提交前回滚；不声称撤回外部字节。

事务状态按第01文档8.3节持久流转。OWNER_REPORTED 是合同显式准许的自报；ADMIN_CONFIRMED 是独立管理员的人工作业确认，均不是自动外部验证。resourceRef 是事务所指资源的描述，不授予该资源读取/执行权限。现有群工具/企业来源隔离屏障保持，群自然语言工具、调度催办和增强来源继续作为未完成项。

组合代码/日志报告在实际引用两类当前证据时附加确定性版本未核实说明并保持部分结论；不把 scope/source revision 当部署版本，原来源撤销和物理发送前复核继续生效。

版本：1.0.0　日期：2026-10-14　依赖：文档 01 的 R01–R36。本文定义本项目内部契约；标为内部接口的路径不是钉钉或公司现有 API。

## 1. 技术基线和架构决策

### 1.1 基线

| 层 | 选型与约束 |
|---|---|
| 语言/运行时 | TypeScript strict、Node.js 24 LTS；锁定实际通过测试的补丁版本与镜像 digest。[S16] |
| 工程 | pnpm workspace，锁文件提交，ESM；禁止运行时在线更新依赖 |
| API | Fastify，Zod 输入/输出校验，生成 OpenAPI；不再引入第二套后端框架 |
| 前端 | React + Vite + TypeScript，H5 适配钉钉移动端/桌面端；同源 HttpOnly 会话 |
| 数据 | PostgreSQL 17 的受支持补丁版本；`pg` + Kysely；SQL 迁移显式编写并审查 |
| 队列 | pg-boss，使用独立 schema/数据库角色；业务 outbox 与事务分离边界明确。[S15] |
| 检索 | 首版 PG `pg_trgm` + 全文检索 + 中文查询词归一化；不假定英文分词适用于中文 |
| 模型 | 官方 HTTP Chat Completion 适配器，仅 `glm-5.3-flash`，保留厂商扩展字段 |
| 钉钉 | 官方 Node Stream SDK + 独立 OpenAPI 适配器；DWS 为独立受控执行服务 |
| MCP | 官方 TypeScript SDK，按企业现有协议版本协商；远程 Streamable HTTP 优先 |
| 文件 | 首发 FileStore 抽象：单节点加密卷实现；生产多副本使用私有 S3 兼容存储 |
| 分析 | 隔离 Node/TypeScript 作业；报表用确定性库，绝不在 API 进程运行模型代码 |
| 观测/测试 | OpenTelemetry、结构化脱敏日志、Vitest、Playwright、Testcontainers、k6 |

所有依赖的具体版本在 P00 固定，生成 SBOM、许可证与 CVE 报告。上述是项目选型，不是声称最新版本。PG 17 是兼容基线，不追逐当前大版本；需要换成其他大版本必须补做迁移与恢复测试。

### 1.2 关键 ADR

- ADR-01：模块化单体代码库、多进程部署，而非首版拆十几个微服务。
- ADR-02：模型选择下一步；确定性执行层控制身份、权限、风险、预算和副作用。
- ADR-03：本地业务状态与外部办公资源分开；外部资源 ID/版本是核验依据。
- ADR-04：机器人 OpenAPI 与 DWS 双通道，不把 DWS 当绕过应用授权的捷径。
- ADR-05：默认只读代码/日志 MCP + 认证数据模板；不默认开放生产写入/自由 SQL。
- ADR-06：持久队列采用 PG；首版不强制 Redis、Kafka、向量数据库。
- ADR-07：不承诺跨 PG 与钉钉的严格 exactly-once；实现幂等、核对与未知状态。
- ADR-08：大模型不可用时保留任务管理、取消、确定性提醒等能力，不偷偷换模型。
- ADR-09：安全边界是隔离进程/容器及网络策略，不是 Node `vm`、提示词或 TS 类型。

## 2. 部署组件

```text
钉钉单聊/群聊 ── Stream ──> ingress ──> inbox + outbox ──> PG 队列
钉钉 H5 / 浏览器 ── HTTPS ──> api/web                       │
                                                        worker
                                                         │
                          ┌──────────────────────────────┼──────────────┐
                      GLM Adapter                 Capability Gateway   Evidence/Artifacts
                                                         │
                         ┌─────────────┬─────────────────┼───────────────┐
                      钉钉OpenAPI   DWS Runner       公司MCP/Data     Search Broker
                                      │                                  │
                              独立用户凭据空间                    公网受控出口
                                                         │
                                                  Sandbox Broker
                                                         │
                                                隔离分析作业容器

scheduler ──> schedules/occurrences/outbox ──> worker
notifier  ──> delivery_outbox ──> 钉钉消息/卡片，结果回写审计
```

所有组件共享同一代码版本；每个进程使用最小数据库角色。`worker` 不持有 DWS 用户明文凭据、公司全权令牌或宿主 Docker socket。模型请求只能从经过脱敏和出域检查的 Model Adapter 发送。

### 2.1 目录

```text
anthys/
  apps/{api,web,ingress,worker,scheduler,notifier,dws-runner,sandbox-broker}/
  packages/
    contracts/              # Zod schemas、公共事件、错误、provider-tool mapping
    domain/                 # 任务、群事务、记忆、模板、审批状态机
    runtime/                # 原生模型循环、上下文、检查点、预算
    provider-glm/           # HTTP、SSE、opaque reasoning transcript
    policy/                 # RBAC/ABAC/资源/受众/风险判定
    dingtalk/               # Stream 标准化、OpenAPI、卡片、身份映射
    dws/                    # 发现、版本锁、binding、profile、错误归一化
    mcp/                    # transport、tool discovery、公司语义映射
    data/                   # 模板验证、MCP 数据适配、结果口径验证
    search/                 # 公网与企业检索、引用、SSRF 防护
    sandbox/                # 作业协议、配额、artifact scan
    storage/                # SQL repositories、FileStore、加密
    observability/          # 指标、trace、日志脱敏
    testkit/                # fake clock、mock MCP/GLM/钉钉、金标集
  db/migrations/
  config/{capabilities,policies,personas,skills,templates}/
  deploy/{compose,images,policies}/
  tests/{unit,integration,contract,e2e,security,load,chaos,live}/
  docs/                     # 本次四份文档
```

禁止业务模块自行创建外部 HTTP 客户端跳过 Gateway。用依赖边界检查约束：domain 无网络；runtime 仅依赖接口；外部请求只允许连接器包；反序列化后的模型输出不能直接拼接命令。

## 3. 身份和授权模型

### 3.1 Principal 与资源上下文

```ts
export type Risk = 'READ' | 'PERSONAL_WRITE' | 'SHARED_WRITE' | 'SENSITIVE' | 'FORBIDDEN';
export type AuthMode = 'APP' | 'USER_DELEGATED' | 'SERVICE_DELEGATED';
export interface Principal {
  tenantId: string;
  actorId: string;                 // 内部稳定用户/服务身份 UUID
  actorType: 'HUMAN' | 'SERVICE';
  roles: string[];                 // 服务端鉴定，不能采信客户端 role 字段
  authEpoch: number;               // 撤销/离职/策略变化递增
  membershipEpoch: number;
  sessionId?: string;
}
export interface ExecutionContext {
  principal: Principal;
  requesterId: string;             // 发起者，与执行身份分开
  executionIdentityId: string;
  conversationId?: string;
  taskId: string;
  runId: string;
  delegationId?: string;
  audience: Audience;
  policyVersion: string;
  correlationId: string;
}
export interface Audience {
  kind: 'PRIVATE_USER' | 'GROUP' | 'NAMED_USERS';
  targetId?: string;
  userIds?: string[];
  membershipVersion?: number;
  classificationCeiling: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
}
```

ExecutionContext 由入站身份、服务端会话和持久任务构造。外部请求只能提交资源选择，不能提交可信 Principal。定时任务保存委托引用而非“管理员=true”；每次执行重新解析当前主体。

### 3.2 准入公式

```text
CanExecute = 身份有效
          AND 企业应用/来源接入有效
          AND 操作所需平台权限满足
          AND 执行身份的用户委托满足（如需要）
          AND 资源 ACL 满足
          AND 企业/群/用户策略满足
          AND 任务委托/预算/有效期满足
          AND 当前风险审批满足

CanPublish = CanReadResult AND 全部目标受众可见或已存在合法群级共享授权
```

不能只验证请求者，再把请求者看到的所有信息发给全群。群受众不明确或有外部成员时，输出最小状态和私人详情入口。信息分类继承最敏感来源；模型总结不会自动降低密级。

### 3.3 三次再鉴权

1. 检索前：过滤可用能力、索引文档、记忆和数据范围。
2. 工具执行前：解析精确身份、资源、参数、审批与配额。
3. 对外发送/下载前：检查受众、成员变更、撤销、内容分类与泄露风险。

审批后的权限变化仍可阻止执行。用户离职、群合同撤销、DWS 断开：递增 `authEpoch`，取消/暂停关联任务，清除可撤销缓存，阻止后续发送。Webhook/组织事件丢失时用定期核对补偿；敏感执行不依赖过期正向缓存。

## 4. 能力与工具契约

### 4.1 描述与绑定分离

```ts
export interface CapabilityDescriptor {
  id: string;                    // 如 dt.todo.create，内部逻辑 ID
  version: string;
  description: string;
  provider: 'CORE' | 'DINGTALK_API' | 'DWS' | 'MCP' | 'DATA' | 'SEARCH' | 'SANDBOX';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  authModes: AuthMode[];
  risk: Risk;
  requiredPermissions: Array<{ code?: string; name: string; evidenceRef: string }>;
  supportsIdempotency: boolean;
  supportsDryRun: boolean;
  supportsVerify: boolean;
  state: 'UNCONFIGURED' | 'UNVERIFIED' | 'READY' | 'DEGRADED' | 'BLOCKED' | 'DISABLED';
  bindingRef: string;             // 绑定真实 endpoint/命令/tool name，不进入用户可编辑区域
}
export interface ToolResult<T = unknown> {
  status: 'OK' | 'PARTIAL' | 'EMPTY' | 'NEEDS_AUTH' | 'NEEDS_APPROVAL' |
          'DENIED' | 'RETRYABLE_ERROR' | 'PERMANENT_ERROR' | 'UNKNOWN';
  data?: T;
  evidenceIds: string[];
  completeness: 'COMPLETE' | 'TRUNCATED' | 'SAMPLED' | 'UNKNOWN';
  nextCursor?: string;
  coverage?: { from?: string; to?: string; source: string; gaps: string[] };
  externalRequestId?: string;
  externalResourceId?: string;
  verification?: { state: 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH'; method: string };
  remediation?: { kind: string; requiredScopes?: string[]; actionId?: string };
  retryAfterMs?: number;
}
```

模型可用工具名限制为稳定、兼容提供商的 ASCII 名称，例如 `cap_7f21d0`，从内部 ID+版本生成，并维护映射；不直接把带点的逻辑 ID 当作所有提供商都支持的 Function 名称。

工具描述、MCP annotations、DWS skill 均不是安全策略的权威来源。风险由审核后的 registry 指定；新发现的命令/工具默认 `UNVERIFIED`，不可自动开放。

### 4.2 默认元工具

- `capabilities.search`：只返回当前任务主体可发现的能力，不泄露未授权资源是否存在。
- `tasks.get/update`：操作本任务或明确授权任务；更改目标/受众可能需要重新同意。
- `memory.search/propose`：搜索隔离记忆；提议保存经过分类的新记忆。
- `artifacts.create`、`analysis.run`：创建本次任务成果或受控分析作业。

业务工具通过审核后的 registry 逐步暴露，默认每次模型调用最多 24 个相关工具；这是上下文策略，不是阉割模型能力。若需要更多，允许再次发现。不可暴露通用的 `shell(command)`、`http(url, headers)`、`sql(raw)` 给企业普通用户。

### 4.3 结果与引用

证据必须有来源身份、资源 ID、时间、版本、范围、提取方式与有效 ACL。代码引用含仓库/commit/path/行号；日志含服务/环境/时间窗/queryId/采样；统计含模板/指标/参数摘要/数据水位；文档含文件 ID/版本/章节。

工具返回 `EMPTY` 与权限拒绝完全不同；`PARTIAL` 不是“查全了”；exit code 0 也不是业务成功，必须解析业务状态并执行必要核验。

## 5. 模型原生运行时

### 5.1 请求协议

官方 Flash 模型文档支持原生思考、工具调用、流式和多模态输入；本项目使用其公开参数，不依赖不存在的关闭思考模式。[S01][S03]

默认模型配置：`model=glm-5.3-flash`、`thinking.type=enabled`、`thinking.clear_thinking=false`、`stream=true`、`tool_stream=true`。默认深度 `high`，困难任务可选 `max`，简单问题可选 `low`；必须在实际账户进行参数探测，不发送未经验证的档位。推理档位与模型不偷偷变更，记录配置版本。

### 5.2 正常执行流程

```text
接收并持久化输入
→ 解析可信身份与上下文
→ 授权过滤记忆/证据/工具
→ 调用原生 GLM
→ 组装完整 assistant message（包括 opaque reasoning 与 tool_calls）
→ 无工具调用：校验结论/引用/承诺，与持久动作账本对齐后交付
→ 有工具调用：参数 schema → 权限 → 风险 → 预算 → 审批/执行
→ 持久化工具结果与证据 → 按 tool_call_id 返回模型
→ 模型继续/重规划/请求必要澄清/交付
```

不为每条消息强制执行意图分类模型、Planner 模型、Critic 模型三次串行调用。遇到普通闲聊可以直接回答；复杂目标用同一模型自主调用工具。检验由确定性规则和必要时模型复核组合，但模型复核不能替代外部成功记录。

### 5.3 关键伪代码

```ts
async function advanceRun(runId: string): Promise<void> {
  const lease = await leases.acquire(runId);
  if (!lease) return;
  try {
    while (await runs.canAdvance(runId, lease.fence)) {
      const ctx = await contexts.rebuildAuthorized(runId);
      await budgets.reserveModelTurn(ctx);
      const turn = await glm.collectCompleteTurn(ctx, await tools.forContext(ctx));
      await journal.commitCompleteAssistantTurn(ctx, turn, lease.fence);
      if (turn.toolCalls.length === 0) {
        await finalizer.verifyAndStageDelivery(ctx, turn.content);
        return;
      }
      // 独立且已认证只读调用允许有限并行；写操作按依赖顺序执行。
      for (const batch of await planner.safeBatches(ctx, turn.toolCalls)) {
        const results = await executor.executeAuthorizedBatch(ctx, batch, lease);
        await journal.commitToolResults(ctx, results, lease.fence);
      }
      await checkpoints.persist(runId, lease.fence);
    }
  } finally {
    await leases.release(lease);
  }
}
```

这里所有 await 接口必须真实实现取消、预算、身份变化和数据库 fence 检查。伪代码不意味着允许无期限 while 循环。

### 5.4 SSE 与工具调用

必须按增量解析 SSE，不假定一个网络 chunk 就是一条事件。处理 UTF-8 跨块、空行、注释、JSON 分片、多个 choices 的允许策略、tool call index/ID、finish reason、usage 和连接断开。

在工具参数完整、JSON 解析/schema/权限通过之前不能执行任何副作用；禁止在流式参数到一半时先执行。保留 assistant 原始 tool_calls 顺序，每个调用结果恰好关联对应 tool_call_id。一个调用失败也要以结构化结果回传，不能遗漏导致协议历史不闭合。

读工具最大并行默认 4，写工具默认串行。工具声称 readOnly 但有实际副作用的，按更高风险处理并阻断。

### 5.5 原生 reasoning 的正确处理

厂商 preserved-thinking 要求相关 `reasoning_content` 按协议保持原序、原文回传，不能把前端总结替换成原始推理字段。[S02]

项目实现：原始 provider message 作为 opaque 加密 journal，访问仅限受控 runtime；默认 24 小时 TTL，可由企业缩短。日志、trace、卡片、管理后台均不暴露该字段。用户可以看到动作与依据摘要，不是底层原始推理。

上下文压缩不得把未完成的 assistant tool_calls 与 tool 结果拆散；也不得改写后伪称仍在保留原始思考。压缩或权限变化时：结束可闭合片段 → 保存安全任务状态/已核验证据/未决事项 → 开启新的 provider session，使用新的事实摘要和原始用户目标，不捏造 reasoning_content。历史密文过期后的恢复也是新 session，不要求永久保存推理。

### 5.6 预算和循环停止

默认单次交互预算：最多 16 模型轮、24 工具调用、240 秒活动执行时间、输入上下文 64K token 目标、单轮输出上限 8K token、只读并行 4。困难授权长任务可提升到 64 轮、120 工具、30 分钟活动执行时间；审批等待不占活动时间，但有绝对到期日。

这是成本与资源限制，不是模型上下文能力上限。token 估算采用已核验 tokenizer 或保守字节估计并保留安全余量；以提供商 usage 校正成本，未知收费记录为 UNKNOWN，不能按零记账。

停止条件：目标满足；用户取消；权限失效；预算不足；重复失败/相同工具参数循环；无新证据；需要关键澄清；任务到期。三次同参数且无新增信息时触发无进展保护。监控任务每次启动短 run，而不是无限常驻模型对话。

实现约束（2026-10-15，P03 仍在进行）：迁移027–030累计活动时间并持久保存模型请求预留。活动时间由PG触发器计算，最多计到原lease到期，审批/重试等待不计入活动时长；旧run无法证明的历史用量标记 `LEGACY_UNKNOWN`，不得从零重置后继续执行。严格的版本1运行预算绑定lease，取消、恢复、审批不得扩大原预算。

模型请求对实际原生JSON（含工具schema和opaque字段）按UTF-8字节、协议开销和25%余量估算；企业/当前全部部门/用户按策略时区每日记账，任务跨run累计。各层token、金额和并发预留在同一事务完成；固定锁顺序为run→请求→企业→部门排序→用户→任务。多run维护逐run提交，避免跨run结算死锁。发出前复核原文hash、当日、部门、权限、来源和停止开关。币种固定；金额使用48位十进制计算，向上取整到12位小数。

`PREPARED` 且未发出的请求可释放；已进入 `DISPATCHING` 后断流、取消或进程失联，收费/token保持 `UNKNOWN` 并占用原额度，只有可信未发送证明可以释放。迟到的有效usage可结算原请求，不能使已取消任务复活。已批准费率加usage只能证明按该费率计算，不能冒充供应商账单核验；未确认费率、缓存收费规则或缺失usage继续保留相应正数预留。超出预留的usage冻结后续企业模型请求并要求核对，不默默超额结算。未计量的当日旧账阻止新请求，迁移不伪造期初零余额。

### 5.7 状态

```text
Task: OPEN | ACTIVE | PAUSED | COMPLETED | CANCELLED | EXPIRED
Run: QUEUED | RUNNING | WAITING_USER | WAITING_AUTH | WAITING_APPROVAL |
     RETRY_SCHEDULED | VERIFYING | SUCCEEDED | PARTIAL | FAILED | CANCELLED | EXPIRED
Action: PREPARED | APPROVAL_REQUIRED | APPROVED | EXECUTING |
        VERIFIED | APPLIED_UNVERIFIED | FAILED | UNKNOWN | CANCELLED
Delivery: PENDING | SENDING | SENT | FAILED | UNKNOWN | SUPPRESSED
```

`APPLIED_UNVERIFIED` 表示提供商接受但无法读后确认；UI 显示“已提交，尚未验证”，不能展示绿色“已完成”。`UNKNOWN` 表示可能产生了副作用，不能直接重试。Run 成功但投递失败时保存成果并显示投递失败，用户可以从任务页获取，不能重新做一遍业务写入。

## 6. 会话、记忆和上下文隔离

### 6.1 多维上下文键

```text
conversation = tenant + channel + externalConversationId
runtime_context = tenant + conversation + topic/task + requester + audienceHash + authEpoch
```

群内共享的是经过群受众授权的事实与事务，不是 A 员工的私人记忆和 raw reasoning。B 接续 A 的任务时，必须通过任务共享授权；若 execution identity、ACL 或受众变化，创建新的安全 session，不能复用 A 的委托历史。

### 6.2 记忆类型

| 类型 | 内容 | 保存原则 |
|---|---|---|
| Preference | 称呼、格式、工作时间、常用时区 | 明确偏好或确认后保存，个人隔离 |
| Episodic | 已完成任务与核验证据摘要 | 含来源/有效期，避免复述敏感明细 |
| Procedural | 认证工作流程/数据模板选择经验 | 需审核，不从网页指令直接升级为技能 |
| Group | 本群公开决议、职责、事务关系 | 群合同授权，不能流入他群 |
| Working | 当前 run 的临时参数和工具结果 | 最短必要保留，任务结束后清理 |

记忆字段至少包含 owner/scope、source、confidence、valid_from/valid_to、created_by、supersedes、sensitivity、consent_basis。有效性优先于相似度。检索先 ACL 后相关性；向量检索扩展也必须相同。

“记住”产生可见确认与条目 ID；“忘记”触发主库、索引、缓存、摘要及可撤销引用的删除/失效。备份按保留策略过期，审计保留不含内容的删除凭证，不能声称立即从所有历史备份物理抹除。

默认：原始会话 30 天、文件/分析中间数据 7 天、推理密文 24 小时、审计元数据 180 天；均为项目可配置政策，非法律结论。更长留存需由企业确定用途与审批。

## 7. PostgreSQL 数据模型

### 7.1 通用规范

业务表均有 `tenant_id uuid NOT NULL`、`id uuid NOT NULL`、`created_at/updated_at timestamptz`、`version bigint`。联合唯一键/外键必须包含 tenant_id，防止跨租户引用。所有外部字符串 ID 使用 text，不强转数值、不从用户名生成 ID。

金额用 numeric/整数最小货币单位，Decimal 库计算，不用 JS 浮点凑账。查询时间使用 UTC timestamptz，另存 IANA zone 和原始业务日期。业务 JSONB 必须由版本化 schema 校验。

### 7.2 关键表字段与约束

| 表 | 关键字段 | 必须的约束/索引 |
|---|---|---|
| tenants | corp_id, name, status, policy_version, timezone | corp_id 唯一 |
| users | external_user_id, union_id, open_dingtalk_id, status, auth_epoch | tenant+external_user_id 唯一，身份别名单独表 |
| departments / memberships | dept_id, user_id, valid_from/to, source_version | 有效成员唯一；离职/转部门更新授权版本 |
| roles / role_bindings | role_id, subject_id, scope_kind/id | 不允许跨租户绑定 |
| identities | kind, provider, external_subject, owner_id, status | tenant+provider+external_subject 唯一 |
| credentials | identity_id, secret_ref/ciphertext, key_version, expires_at | 不允许日志序列化；独立列权限 |
| delegations | owner_id, identity_id, scopes, resources, expiry, revoked_at | 缩小权限，不允许隐式扩大 |
| connections | provider, endpoint_ref, status, verified_at, metadata | endpoint 经管理员注册与网络校验 |
| capability_bindings | logical_id, version, provider_binding, schema_hash, risk | tenant+logical_id+version 唯一 |
| capability_checks | binding_id, identity_id, resource_hash, auth_epoch, result | 诊断具有资源/身份维度与 TTL |
| conversations | channel, external_id, kind, classification | tenant+channel+external_id 唯一 |
| conversation_members | conversation_id, user_id, valid_from/to | 群成员快照版本化 |
| messages | conversation_id, sender_id, external_message_id, body_ref | tenant+provider+external_message_id 在相应命名空间唯一 |
| event_inbox | source, event_key, payload_cipher_ref, state | tenant+source+event_key 唯一 |
| tasks | requester_id, goal, status, audience, delegation_id, expires_at | status/owner/time 索引 |
| runs | task_id, status, context_ref, budget, lease_owner/until, fence | tenant+task_id+created_at 索引 |
| run_steps | run_id, seq, kind, state, input_hash, result_ref | tenant+run_id+seq 唯一 |
| provider_journals | run_id, seq, ciphertext_ref, key_version, expires_at | runtime 专属读；不参与普通全文索引 |
| tool_actions | run_id, logical_action_key, args_hash, state, provider_id | tenant+logical_action_key 唯一 |
| approvals | action_id, approver_id, args_hash, state, expires_at | 单次消费；拒绝自审批的风险动作 |
| evidence | source, locator, source_version, observed_at, acl_ref, body_ref | 来源/任务索引，不裸放全量日志 |
| memories | scope_kind/id, owner_id, source_id, content_ref, valid_to | ACL 优先检索；supersedes 防止旧事实复活 |
| group_contracts | conversation_id, version_no, scope, identity_id, active | 每群只允许一个生效版本 |
| group_cases | conversation_id, source_refs, owner_id, due_at, state | 近似候选可合并，不能只凭标题唯一 |
| schedules | owner_id, rule, timezone, next_due_at, misfire, state | state+next_due_at 部分索引 |
| schedule_occurrences | schedule_id, revision, scheduled_at, task_id | tenant+schedule_id+revision+scheduled_at 唯一 |
| watches | schedule_id, predicate_version, last_value, last_notified_hash | 条件与通知状态原子更新；通知终态含 CONFIRMED/APPLIED_UNVERIFIED/FAILED/UNKNOWN，仅 UNKNOWN 阻塞后续 |
| condition_watch_sources | watch_id, scope_id/version, template/metric/window | 所有者RLS不可变绑定；绑定后只读，scope版本或来源修订变化即失效 |
| data_templates | key, semantic_version, status, definition, signature | tenant+key+version 唯一，不覆盖旧版本 |
| data_executions | template_id, params_hash, query_id, watermark, status | 可追踪执行，明细另存受保护文件 |
| artifacts | owner, task_id, storage_key, mime, hash, acl_ref, expires_at | 文件与 ACL 同步、下载再鉴权 |
| outbox | kind, aggregate_id, payload_ref, dedup_key, published_at | tenant+dedup_key 唯一 |
| deliveries | target, action_id, message_id, args_hash, state, next_at | 对外写入与投递状态分开 |
| quota_ledger | subject, period, reservation, used, provider_usage | 事务预留、结算、取消释放 |
| audit_events | actor, action, resource, result, trace_id, previous_hash | append-only 角色；哈希链不等于绝对不可篡改 |

需要增加 `source_cursor`、`policy_decisions`、`artifact_acl` 等辅助表可以迁移实现，不能用一个无约束 JSON 表存全部业务。

### 7.3 核心 SQL 示例

以下示例展示约束；Codex 必须生成完整迁移、外键、角色与回滚策略，不能只复制片段即算完成。

```sql
CREATE TABLE event_inbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  source text NOT NULL,
  event_key text NOT NULL,
  payload_cipher_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('RECEIVED','ENQUEUED','PROCESSED','DEAD')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, event_key)
);
CREATE TABLE schedule_occurrences (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  revision bigint NOT NULL,
  scheduled_at timestamptz NOT NULL,
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, schedule_id, revision, scheduled_at)
);
ALTER TABLE event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_inbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

数据库超级用户/BYPASSRLS 会绕过 RLS，表所有者默认也有特殊行为，必须分离运行角色与迁移角色并显式 FORCE。[S14] 上例只演示租户隔离，不是个人/群 ACL 的完整实现；个人/群表必须增加 actor、membership 和 resource ACL 策略或专用受限查询接口，并做 DB 级负面测试。

每个请求在短事务内调用 `set_config('app.tenant_id', tenant, true)` 和 actor 等上下文；事务结束即清除，禁止连接池泄漏上次身份。GUC 不是防恶意 SQL 的万能权限机制：所有 SQL 由可信 repository 构造，运行角色无 DDL 权限，分析工具绝不能连接平台数据库。

### 7.4 索引与维护

messages/run_steps/audit 按企业与时间索引，增长后采用时间分区；上线分区前验证父子 RLS 和唯一约束。队列表与业务表分别做 vacuum/retention，禁止把唯一幂等键清理早于外部重试/任务最长生命周期。

大文件不存 DB bytea；PG 存元数据、ACL、哈希与加密存储引用。队列 payload 不含令牌、模型推理或全量日志。

## 8. 幂等、租约、审批与副作用

### 8.1 入站与队列

Stream/HTTP 入站先验证来源，再将 inbox+业务 outbox 在一个 PG 事务提交，然后 ACK。库不可用时不返回假成功；依上游协议失败/重连。event_key 使用可信提供商事件 ID，若上游缺少 ID 必须组合稳定消息命名空间和类型，不得仅以正文哈希去重不同用户相同内容。

outbox publisher 可以重复向 pg-boss 发布；worker 必须用逻辑任务/动作唯一键去重，不能依赖队列宣称的单次投递保证外部副作用。

### 8.2 运行租约

默认 lease 30 秒，10 秒续租，每次重领增加 fence。旧 worker 失去 lease 后不得推进数据库或启动新工具。外部 API 不理解 fence，因此仍须单个 Action 的状态机、provider idempotency 或核对机制，不能只加 DB 锁就声称绝不重复发送。

### 8.3 写操作协议

`prepare → canonicalize args → permission/risk → approval/delegation → claim action → execute → verify → stage delivery`。

审批哈希包含工具版本、完整CapabilityDescriptor摘要、执行身份、资源、参数、受众、有效期和策略版本。任一字段修改就使原审批失效。审批按钮采用服务端认证用户 + 短期签名 nonce，绑定 tenant/action/hash；不能把按钮内 userId 当作审批人。

写动作的version2 scope必须包含64位十六进制字符串descriptorHash；旧v2缺失、畸形或类型错误的证明与旧v1写记录均要求人工复核，不能填入当前元数据后继续审批或生成另一个写申请。单次调用固定声明值和回调身份，在准备事务前后、物理派发、提供者返回、验证及保留结果边界复核。准备期间漂移回滚claim/审批消费/工具预留；派发前漂移不产生效果；执行中漂移保留UNKNOWN且不自动重试，不能因风险被改称READ而把不确定写当成可重试读。回调身份固定只证明同次调用未换实现；跨部署实现变化仍须按原版本/绑定审核规则处理。

同一run/能力/版本已经记录的写意图不能在后续调用改称READ而绕过其历史状态。新请求在派发前拒绝，原APPROVAL_REQUIRED、UNKNOWN或VERIFIED状态保持不变；不同能力的合法只读调用仍可执行。独立认证只读对账的可选私聊组件见下段；真实提供者适配、新批准后的明确重试仍未完成，人工NOT_APPLIED和普通EMPTY都不能充当未执行证明。

适配器声明并实测副作用策略：

| 类型 | 重试原则 |
|---|---|
| 上游支持幂等键 | 使用稳定 action key；先核实该 API 的真实字段，不能随便加 header |
| 可查询唯一资源 | 超时先按操作账本/外部 ID/可识别标记核对；确认未执行才重试 |
| 不支持幂等且不可核对 | 超时进入 UNKNOWN，停止自动重试，通知授权人员人工确认 |

“dry-run 成功”只代表预览成功，不代表写权限或业务写入成功。误操作补偿是新的有权限动作，不能无授权自动撤回他人内容。

## 9. 定时调度实现

scheduler 每 5 秒按到期索引获取记录，以行锁/SKIP LOCKED 领取。业务事务中插入唯一 occurrence + 任务 + outbox，并推进 next_due；事务失败必须整体回滚。多个 scheduler 可运行，依唯一键保证一次时间点只生成一个逻辑 occurrence。

`rule` 包含：kind ONCE/RRULE/INTERVAL、tz、local start、UTC start、end/count、businessCalendarVersion、DST policy、misfire。默认：重复时刻仅运行一次（选较早偏移）；不存在时刻跳过该次，并在未来预览中标注。需要“顺延到下一个有效时刻”时必须显式配置。禁止把上海时区硬编码给所有用户。

错过策略：
- 提醒：补发最近一次且在 1 小时宽限内，否则标记 MISSED。
- 报表：合并最近一次，携带完整应统计时间窗，不能按机器当前时间随意改口径。
- 监控：只检查当前状态，不对停机期间虚构观测。
- 高风险写任务：不自动补执行，回到确认状态。

编辑 schedule 增加 revision，撤销未执行旧 occurrence；执行前核对 revision 和 revoked 状态。取消不得只删 UI 行。为每企业分配并发槽和 rate limit，避免一个群的轮询耗尽全部模型额度。

## 10. 数据模板契约

### 10.1 示例：内部规范，不是公司现有 API

```json
{
  "schemaVersion": "1.0",
  "key": "payments.success_rate_daily",
  "version": "1.0.0",
  "status": "DRAFT",
  "ownerRole": "DATA_STEWARD",
  "metric": {
    "name": "支付成功率",
    "grain": ["business_date", "channel"],
    "numerator": "去重后成功的支付尝试数",
    "denominator": "去重后全部有效支付尝试数",
    "dedupKey": ["payment_attempt_id"],
    "dedupScope": "WITHIN_AUTHORIZED_TIME_WINDOW",
    "validRecordRule": {"field": "is_valid", "operator": "eq", "value": true},
    "dedupOrder": [
      {"field": "event_time", "direction": "DESC"},
      {"field": "event_id", "direction": "DESC"}
    ],
    "processingOrder": [
      "server_authorized_scope", "time_window", "validity",
      "dedup", "channel_filter", "aggregate"
    ],
    "nullPolicy": "missing_status_is_unknown_not_success",
    "zeroDenominator": "NULL",
    "timezone": "Asia/Shanghai",
    "timeField": "event_time",
    "interval": "[start,end)",
    "watermarkRequired": true
  },
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["start", "end"],
    "properties": {
      "start": {"type": "string", "format": "date-time"},
      "end": {"type": "string", "format": "date-time"},
      "channel": {"type": "string", "enum": ["app", "web"]}
    }
  },
  "execution": {
    "kind": "MCP_DATA_TOOL",
    "bindingRef": "payments-analytics",
    "operation": "success-rate",
    "timeoutMs": 30000,
    "maxRows": 10000,
    "maxBytes": 10485760,
    "maxWindowDays": 31
  },
  "authorization": {
    "allowedRoles": ["PAYMENTS_ANALYST"],
    "rowScope": "SERVER_INJECTED",
    "outputClassification": "CONFIDENTIAL",
    "groupSharing": "EXPLICIT_RESOURCE_GRANT"
  },
  "quality": {
    "assertions": ["numerator <= denominator", "0 <= rate <= 1"],
    "freshnessMaxMinutes": 60,
    "goldenCasesRef": "testkit/payments-success-rate"
  }
}
```

发布流程：DRAFT → VALIDATED → APPROVED → PUBLISHED → DEPRECATED/REVOKED。禁止就地覆盖发布版本。可信数据范围由服务端注入，用户提供 tenantId/deptId 不能覆盖安全筛选条件。

本示例的去重语义固定为：先执行服务端授权范围、右开时间窗和有效事件过滤，再在该范围内按 attempt 取 `event_time DESC, event_id DESC` 的第一条；最后执行渠道过滤和聚合。它不是“截至今天的最终支付状态”，也不是“全历史先去重再归属下单日”。上述字段是演示数据合同，实际模板必须由数据负责人确认并绑定真实字段；改变去重范围、优先级或业务时钟必须发布新版本并更新金标。

### 10.2 查询执行

数据查询统一经公司 MCP 的认证数据工具执行，与企业代码、日志查询同属 MCP 接入面，但使用独立审核配置：`COMPANY_DATA_MCP_CONFIG_FILE`、固定 server 名与版本、固定工具名、输入 schema hash、token 文件权限 0600、有限超时/响应大小和逐调用身份。本项目不直连企业业务数据库，不内置 HTTP Gateway 或只读数据库适配器作为旁路；平台 PostgreSQL 只保存任务、模板、执行审计与证据元数据。

模板的 SQL/operation 由数据部门在上游维护并经审核；本项目只发送白名单参数（时间窗、维度枚举等），不发送用户提供的 tenantId/deptId 或原始 SQL，安全行范围由上游按身份注入并在响应中回显。上游若以 SQL 模板执行，其 AST/只读/函数白名单/成本与超时控制属于上游数据服务的责任边界，本项目在合同中要求并核验其回执，不能凭本项目字符串检查宣称 SQL 安全。

未知上游 operation 或模板版本不匹配时拒绝执行，不开放模型自由 SQL。模板中断言用受限表达式解释器，不用 eval。

返回：queryId、templateVersion、columns（含类型/单位）、rows 或 artifactRef、rowCount、truncated、watermark、elapsedMs、grain、appliedScope摘要。只把必要聚合结果送模型；数字超过 JS 安全整数时保留字符串/Decimal。

### 10.3 跨模板与分析

禁止把不同粒度结果直接 join 导致指标膨胀；按已声明 join cardinality、去重键和合并规则处理。百分比计算使用总分子/总分母，不平均每日百分比；空值不等于零；同比要验证日期基准/闰年/时区；数据延迟必须影响结论置信标记。

对付费/生产查询，先预留预算与并发，再执行，超时之后核实服务端 query 状态，必要时调用经认证的 cancel。达到 maxRows 时标记截断，不把截断集合用于总体结论。

## 11. 分析沙箱和成果

### 11.1 沙箱作业

```ts
interface SandboxJob {
  tenantId: string;
  taskId: string;
  language: 'typescript' | 'javascript';
  codeArtifactId: string;
  inputArtifactIds: string[];
  network: 'NONE';
  limits: { cpuMillis: number; memoryMb: number; wallMs: number; outputBytes: number };
  allowedOutputTypes: string[];
}
```

默认 1 CPU、512 MiB、60 秒 wall time、20 MiB 输出、只读依赖包、非 root、只读根目录、tmpfs 工作目录、cap_drop ALL、no-new-privileges、seccomp/AppArmor、无网络。高负载需管理员提高配额。

Broker 是独立受限服务：只接受固定镜像 digest 与结构化 Job，签名请求，禁止任意镜像/挂载/设备/宿主路径。主应用不挂 Docker socket。生产可用独立 rootless runtime 或受管理隔离执行集群；即便 broker 拥有容器管理权，也不能与业务 API 共进程共凭据。

当前仓库同时提供可复用 broker 库和独立 HTTP 服务 `apps/sandbox-broker`：签名/主体/镜像/时间窗校验、PG持久nonce与一次性状态、artifact resolver、所有者配额、持久取消和输出哈希/扩展名/MIME复核；xlsx/docx 不再按文件内字符串判定，而是经有界 ZIP 检查（条目数、展开字节与压缩比上限，拒绝路径穿越/重复/加密条目，核对本地头与 CRC）。ACL通过可注入接口复核，并已提供 `PgSandboxAuthorizer`：在所有者RLS作用域内重查租户/用户状态、用户与任务双authEpoch、任务归属/状态/取消/过期、运行归属/任务绑定/非终态。独立服务只使用 Node `http`，通过HMAC-SHA256服务密钥认证，主体来自已认证请求头而不是签名作业内容；提供 `POST /v1/sandbox/jobs`、作业读取/取消和制品登记接口，未认证、重放、过期、越权或超限请求在执行前拒绝。服务通过 Compose 的 `sandbox` profile 部署（dev/prod），配置与Ed25519公钥以只读secret挂载，工作区与制品使用独立命名卷；只有broker容器挂载宿主Docker socket，API/worker不挂载，且broker不持有DingTalk/GLM/DWS/公司MCP凭据。镜像由 `deploy/setup-sandbox-broker.mjs` 生成并按digest固定；宿主可改用独立rootless runtime或受管理隔离执行集群，但不能与业务API共进程共凭据。执行容器写入稳定所有者/作业标签，重启时可按活跃作业集合清理同一所有者的孤儿容器而不影响其他broker或活跃作业。准入记录持久化broker所有者；启动恢复通过SECURITY DEFINER函数仅把同一broker遗留的RESERVED/RUNNING结算为FAILED/SANDBOX_JOB_INTERRUPTED，其他broker及终态记录不受影响，且必须在接受新提交前调用；孤儿工作目录在启动和每5分钟按所有者前缀清扫。另提供 `PgSandboxArtifactConnector`：代码/输入/输出字节存放于加密文件存储，PostgreSQL 只保存所有者范围元数据与 SHA-256；每次解析重新核对长度与哈希，输出仅在broker复核后写入，其他所有者被RLS隐藏。应用侧提供 `SandboxBrokerClient`：以共享服务密钥签名制品上传、作业提交、状态查询与取消，拒绝重定向、超限或畸形响应，并在返回制品登记前核对byteSize/SHA-256；不对结果不确定的提交自动重试，去重由broker的nonce/作业唯一约束决定。`SandboxProducer` 在登记任何字节前验证主体与完整封闭作业（限额、输出类型、代码大小），随后上传代码/输入、以默认30秒且不超过60秒的有效期签名一个信封并仅提交一次；提交结果不明时同样不自动重发。broker在执行期间按可配置的有界间隔重查实时授权，撤销或复查失败会中止执行并以REJECTED/AUTHORIZATION_REVOKED或FAILED/AUTHORIZATION_RECHECK_FAILED结束、不持久化输出；尚未实现调用该生产者的业务能力与作业队列、推送式授权撤销或授权缓存、受信代码/输入登记API、CPU/内存加权预算及文件系统配额；输出目录仍由宿主轮询限额。上传附件中的归档文件只隔离、不展开，因此不存在解压写出路径；T097/T098仍为NOT_RUN。

DWS Runner 与分析沙箱分开：前者需要受控出网和身份凭据，后者绝不获得 DWS/MCP/模型密钥。任意生成代码不能调用 credential broker。

### 11.2 成果安全与验证

文件生成器固定版本。CSV/XLSX 防公式注入；用户文本不是公式，公式节点由 schema 显式标记并只允许受控函数。HTML 清理脚本、外链和事件属性。PDF 渲染器不访问任意公网/内网；图片输入经过大小/格式验证。

Artifact 元数据包括 hash、mime、size、creator、runId、inputEvidenceIds、classification、acl、version、expiresAt。下载通过短期令牌 + 会话授权；不允许仅凭随机路径永久访问。

结果检查至少含可打开、非空、关键数值一致、来源齐全；报告视觉检查对分页/截断/宽表溢出使用渲染测试。不能仅凭文件扩展名判定成功。

## 12. 内部 API 与事件

所有 API 位于 `/api/v1`，使用统一 envelope。除公开健康探针、认证回调外，均要求会话或服务认证。浏览器 Cookie 开启 Secure/HttpOnly/SameSite，写请求做 CSRF 防护；OAuth state 一次性使用，校验 origin/redirect 白名单。

```ts
interface ApiError {
  code: string;
  message: string;                   // 可安全展示，不回显秘密
  correlationId: string;
  details?: Record<string, unknown>;  // 经过字段白名单
}
```

| 内部路由 | 语义与约束 |
|---|---|
| POST `/auth/dingtalk/exchange` | 服务端兑换可信临时码；不接受客户端自行声明管理员 |
| GET `/me` | 当前身份、时区、可用能力摘要 |
| GET/PATCH `/me/persona` | 个人人设，ETag/If-Match 防覆盖 |
| GET/POST/DELETE `/me/memories[/:id]` | 查询/显式保存/删除，严格 owner ACL |
| POST `/tasks` | 目标创建，Idempotency-Key，返回 202+taskId |
| GET `/tasks/:id` | 任务状态、可见证据、验证结果 |
| POST `/tasks/:id/messages` | 接续任务，身份/受众变化重验 |
| POST `/tasks/:id/cancel` | 持久取消标记与尽力中止，返回当前外部动作状态 |
| GET `/tasks/:id/events` | SSE，Last-Event-ID 续传，不含原始推理/秘密 |
| GET/POST/PATCH `/schedules[/:id]` | 创建/修改/预览规则，修改需 If-Match |
| POST `/schedules/:id/pause` | 原子撤销未执行 occurrence |
| GET/PUT `/groups/:id/contract` | 当前群管理员授权，版本化与预览 |
| GET/POST/PATCH `/groups/:id/cases[/:caseId]` | 群事务列表、登记、状态变更 |
| GET `/capabilities` | 按主体过滤能力与状态 |
| POST `/capabilities/:id/check` | 只读/非破坏探测，不能用批量写测权限 |
| POST `/connections/dws/device-flow` | 为当前用户创建一次性 DWS 授权会话 |
| GET `/connections/dws/device-flow/:id` | 仅归属用户可查看进度，不回传 refresh token |
| DELETE `/connections/:id` | 撤销关联授权、密钥引用、任务暂停 |
| GET/POST `/approvals/:id/decision` | 查询/批准/拒绝，校验真实审批人和参数哈希 |
| GET/POST `/data/templates` | 权限过滤查询/创建草稿 |
| POST `/data/templates/:id/publish` | 数据负责人审核，金标测试通过 |
| POST `/artifacts/:id/download-ticket` | 下载时重新检查当前 ACL |
| GET `/admin/audit` | 受控元数据检索、脱敏、导出单独授权 |
| GET `/health/live`、`/health/ready` | 存活与依赖就绪分开，不暴露配置明文 |

所有列表 cursor 分页，默认 50、最大 200；过滤值白名单。服务返回 401/403/404 时避免向无权人泄露资源存在性；写冲突返回 409，限额返回 429，真实外部阻塞返回可解释业务状态而非伪 200 成功。

事件至少包含 `eventId, tenantId, taskId, runId, seq, type, timestamp, safePayload`。事件类型：`task.accepted`、`run.started`、`capability.discovered`、`tool.started`、`tool.completed`、`auth.required`、`approval.required`、`evidence.added`、`artifact.created`、`run.verifying`、`run.paused`、`run.completed`、`run.failed`、`delivery.updated`。只表达外部可观察动作，不暴露原始推理。

## 13. 安全与可靠性默认值

外部文档/日志/代码/文件/工具描述都可能含提示注入；内容不改变权限、收件人或系统规则。MCP 的规范与安全建议明确要求实现者落实授权和防护，协议本身不是权限系统。[S12][S13]

公共网页获取单独 egress：阻止 loopback、私网、link-local、云元数据、DNS rebinding、重定向越界；每跳校验解析结果、端口、协议和响应大小。公司 MCP 的内网访问通过管理员登记的独立 allowlist，不能为了允许 MCP 就把公网抓取器的私网限制全部关闭。

新技能只接受管理员安装的版本包，校验来源/hash/许可，声明网络、文件、数据与副作用权限；不得在生产让模型自行 npm install/curl | sh。技能更新必须过 contract regression，tool poisoning 视为供应链风险。

密码/密钥使用信封加密，主密钥来自外部 secret mount/KMS，不入 PG 同表、不入 git。key_version 支持轮换；日志脱敏覆盖 headers、argv、环境变量、错误堆栈、SSE 与附件链接。

## 14. 可观测性

至少采集：入站量/ACK耗时、重复事件数、队列年龄、运行活跃/等待/失败、模型首响应/总时延/token/预算、工具耗时与错误、权限拒绝原因分类、DWS授权过期、MCP可用性、schedule lag、UNKNOWN动作、投递失败、DB连接/锁/慢查询、沙箱超限与清理失败。

禁止 userId、群名、query 文本等高基数敏感标签进入公共 metrics。Trace 以 opaque taskId/runId 关联；默认不包含消息正文。租户审计与平台运维日志权限分开。

## 15. 来源

| ID | 官方/项目维护者来源 |
|---|---|
| S01 | `https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash` |
| S02 | `https://docs.z.ai/guides/capabilities/thinking-mode` |
| S03 | `https://docs.z.ai/api-reference/llm/chat-completion`；国内端点按文档 03 核实 |
| S12 | `https://modelcontextprotocol.io/specification/2026-07-28` |
| S13 | `https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices` |
| S14 | `https://www.postgresql.org/docs/current/ddl-rowsecurity.html` |
| S15 | `https://github.com/timgit/pg-boss` |
| S16 | `https://nodejs.org/en/about/previous-releases` |


## 16. 已实施的结构化最终结果基础（2026-10-15）

迁移031新增owner/RLS约束的`run_finalizations`；投递通过复合外键绑定同一run、owner和session的校验记录。加密记录绑定原草稿、工具来源、输出hash、租户策略、身份epoch、受众和期限。模型无工具的最终turn也必须经过Gateway/RuntimeStore统一校验，无可选绕行；被拒草稿保留加密原件，最多两次修复反馈在同一事务持久化，并继续消耗原任务预算，进程重启不重置次数。

可执行schema见`packages/runtime/src/final-plan.ts`：版本1的VALUE/QUOTE/STATUS/ACTION/LIMITATION分别绑定原生tool call或当前checkpoint动作。VALUE需要JSON Pointer及精确expected；QUOTE仅输出来源引用；COMPLETE不能由截断/采样/未知范围证明；写动作VERIFIED需要真实读回，READ不能冒充写。REPORT自由叙述当前整体拒绝，不能删除矛盾文案后假装校验通过；CLARIFICATION仍待实现。正常问答与语义目标判定不以关键词规则代替。

模型再次读取、最终落库、工作台读结果和投递前共用当前执行依据核对。历史密文不改写；失效事实从新会话上下文省略并说明原因。工作台结果响应使用private/no-store；主体/任务失效在来源回调前拒绝。源回调目前只在隔离测试与已实现CORE/附件能力中验证；后续MCP/DWS需要有界、按用户资源的真实契约，不能从本地成功推定线上能力已认证。


## 17. P05固定版本代码适配基础（2026-10-15）

迁移032的`company_code_scopes`由管理/迁移角色独立安装，tenant+owner RLS强制隔离，运行角色仅SELECT。scope绑定connector、精确40位commit、允许路径、来源revision、工具schema hash、只读/用户资源审核引用、分类、出模型域许可和期限。更新自动增加version；缺少scope或egress许可时拒绝读取。普通用户或模型不能自授此记录。Gateway的资源grant和受众/分类上限仍须另外满足。

`packages/company`将内部company.code.search/read映射为真实已发现工具名chat的message参数，message内容是本项目另行定义的严格代理契约CHECK/SEARCH/READ，不是已发现的公司chat功能，更不是靠自然语言要求“只读”就得到保证。上游必须独立按已认证调用主体的tenant/actor与资源权限执行；只有经独立审核的proxy可启用。fixture服务有独立权限源，包含本地误授权另一actor后仍被上游拒绝的实际协议用例。

连接器绑定端点/允许origin、server版本、审核配置和凭据指纹；输入/输出schema变化阻止调用。每次操作先完整分页发现，限制重复游标/名称、并发、期限、响应字节和行数；不订阅GET服务器推送，不提供sampling/elicitation，不复用conversationId，不暴露工具原始说明给模型。来源正文先脱敏再保留为加密工具证据，保留明确的untrustedContent标记；最终语义防注入仍需后续全量评测。

引用检查包括repo/commit/path/行范围/片段hash、当前scope/revision与请求nonce。最终入库、模型再次读取、工作台结果和投递分别重验。已派发的读取超时保存CERTIFIED_READ/PREPARED且不保留无确认正文，可安全再读；写入不经过此适配器。READ返回EMPTY记录为VERIFIED查询回执，不再误记为业务失败。

### P06 精确身份与撤销组件（2026-10-15）

迁移033新增dws_authorization_epochs、dws_identities和run_dws_dependencies，tenant/owner RLS及应用角色列权限限制凭据可见性。外层Vault AAD绑定tenant/owner/identity；CLI的文件DEK与密文一起保存不被当成独立强加密。每次操作使用独立0700目录/0600文件，显式设置HOME、DWS_CONFIG_DIR、DWS_KEYCHAIN_DIR/dws-cli、XDG和临时目录；不借用用户机器的默认profile或系统钥匙串。生产runner类要求Linux tmpfs，但生产独立服务/网络边界尚未落地，配置入口保持关闭。

授权开始获取generation，完成时锁定并核对generation与实际corp/user；断开先提交generation递增及凭据失效，再停止关联任务/投递，避免运行锁和身份锁死锁。旧授权任务不得重连；刷新只更新credential_version，权限变化增加authorization_version。执行前后核对版本、身份与授权期限。模型读证据、最终结果、HTTP正文和通知交付均重新验证当前来源。平台侧撤销未执行，UI说明本地断开的范围。

固定二进制以spawn数组参数调用，模型无argv/profile/token控制。独立IPC监督进程管理整个多命令会话、超时、输出上限及进程组；父进程SIGKILL测试覆盖临时凭据和孙进程清理。统一结果叶子的失败JSON来自stdout，旧命令stderr兼容单独处理；非零退出不能凭成功载荷变成OK。确认要求识别正式subtype字段。可重试只读的NEEDS_AUTH回执保持PREPARED，授权后可重新读取。

当前API/worker/notifier的进程内组件仅用于隔离测试。必须继续实现独立runner、签名短期任务委托、网络白名单和专属秘密挂载，满足本文原有进程边界后才能启用生产业务。文档ACL、授权管理/续期和device flow仍为待实现功能。

### P06 文档来源与片段证明（2026-10-15）

迁移034的dws_document_scopes仅由迁移/管理角色安装，运行角色只有owner/RLS过滤的SELECT。scope同时绑定二进制、叶子schema、项目契约hash、独立payload映射审核引用、源资源授权审核、分类、模型出域和期限；更新递增version。普通用户不能通过本地grant自授这些记录。

固定CLI的doc +fetch仅有正式CLI-owned doc.content.v1外壳，content仍是未发布返回schema的上游数据。映射必须有独立审核引用及node/revision/text/type JSON Pointer；未发布覆盖字段可明确设为null并返回UNKNOWN，不能从外层complete推断。直接node分支会原样回显输入，故只接受审核的稳定ID，并另核对正文中的资源ID和类型；不把canonicalId字段名当URL解析证明。

source绑定owner身份、authorizationVersion、scopeVersion、profileHash、node、revision、片段projectionHash。原始全文摘要封装为Vault加密证明，AAD包含tenant/owner和全部来源元数据；模型不获原文摘要或可枚举的短秘密片段hash。全文识别已知敏感span后按Unicode位置遮蔽再截取；关键词仅在遮蔽文本上匹配。原始来源即使只改变被遮蔽值且revision不变，旧证明也失效。模式遮蔽不是完整DLP认证。

Gateway执行、证据保留、上下文、最终落库、HTTP和发送前均按当前owner重新读取正文并比较来源证明；部分/空返回也在执行出口复核。投递测试区分第一次来源检查与最后发送前检查。范围明确为ONE_DOCUMENT_VERSION，局部选择、字节上限和未消费的上游continuation显式返回限制，不能证明全库覆盖。独立服务/短期签名委托/强制网络边界仍待实现。

### 页面生命周期与读取期限补充（2026-10-15）

文档scope和grant期限使用clock_timestamp()复核，避免在长事务内以事务开始时刻now()错误延长授权。已显示结果在页面隐藏、恢复、focus、freeze/resume、pagehide/pageshow时立即清除并合并当前任务的重验请求；可见页面超过60秒执行间隔时，在首个可执行动画帧清除并重验，不逐帧调用CLI。请求序号及任务意图版本阻止旧GET和创建/取消动作的延迟回调重新打开已失效视图。退出开始即失效，退出失败仍保留隐藏状态；这不证明浏览器合成器或内存已清除。

### R09/P07 版本与上下文计划（尚未实现）

计划personas按tenant/scopeKind/scopeId保存，使用GLOBAL/GROUP/USER明确作用域与tenant/RLS约束。修订保留版本、编辑者、来源和审计；服务端校验ETag/If-Match，冲突不覆盖新版本。企业管理员不能凭控制台权限编辑无权群或读取私人偏好。编辑自然语言入口必须映射固定参数和同一权限检查，不能将人设文本解释成权限声明。

字段覆盖基于明确schema：未设置继承上层；清除覆盖恢复上层/内置默认；企业政策中的锁定约束独立存储且不得被下层覆盖。角色/语气/输出模板是风格或流程偏好，安全与授权>企业政策>群合同/个人偏好>当前指令>人设风格的原顺序不变。新运行读取当前获准版本并记录有效版本快照/hash；运行中编辑从下一运行生效，显式重启才重建上下文。崩溃恢复保留原快照，但主体/作用域/资源授权撤销立即失效，不因旧版本而继续使用私人资料。版本审计不等于管理员获得正文权限。

### P03 问答接纳、澄清与恢复实现（2026-10-15）

迁移035–038增加run_narrative_reviews、run_user_messages、dingtalk_clarification_replies和clarification_control_responses，tenant/owner RLS及运行角色写入限制。原生review请求tools为空，沿用实际payload估算、token/金额/并发预留、活动时间、取消和UNKNOWN核算；review工具调用或异常协议不能进入Gateway执行。接纳证明绑定原目标、scope、会话/fence、策略/authEpoch、受众、期限、审查提示版本、模型请求账本及payload hash，原始reasoning不进入审查输入或界面。

普通问答接纳不授予来源权限。存在tool/tool_call/attachment时当前自由回答和澄清路径拒绝；企业结果继续使用原结构化来源证明。已接纳澄清问题和认证回答按角色/来源ID形成有序dialogue，答案独立Vault密文保存；上下文到期重建时恢复这些数据，不把未接纳草稿当事实。旧hash-only记录标LEGACY_UNAVAILABLE，不编造原文；密文、来源证明或当前授权失效会阻止派发/显示/投递。

GET任务返回当前clarification_review_id；POST /tasks/:id/messages要求owner会话、CSRF、Idempotency-Key和当前问题ID。同key不同文本冲突；重投返回原generation；答复在同一事务封存、使旧问题失效、清除旧结果、抑制旧投递并写RUN outbox，不扩大预算。钉钉“补充 短码：回答”经受信任Stream身份/原会话解析，inbox、续接、source event及回执原子提交。后续投递采用最新可信回复事件，保留原入站幂等映射。短码仅是目标索引，不是授权；碰撞拒绝，两用户/两个会话不复用。

拒绝回执是固定安全文字，独立control_kind=CLARIFICATION_REPLY、PARTIAL运行和零模型预算，无RUN队列。显示/发送前核对固定文案hash、当前身份/策略/受众和精确PG期限；时间戳在数据库复制，保留微秒。群只展示固定拒绝，不发私聊问题、答复或任何任务标识。原目标还绑定运行guard、HTTP与最终投递，目标变化不会把旧答案重新认证为新任务答案。

### 2026-10-15 P03 SOURCE_CHOICE 与异步核实契约

迁移039增加run_source_choices和source_choice_replies，以及SOURCE_REPLY事务outbox/独立队列。SOURCE_CHOICE final plan仅包含当前tool call或checkpoint ACTION引用；text和claims为空、outcome=CLARIFICATION。注册READ适配器提供版本化投影，服务器从实际已核验回执生成2–10个唯一选项、下一READ能力绑定及精确参数，并披露返回项数和覆盖度。公司代码适配器按固定repo/commit/path/行号投影；不是新增上游MCP工具名或对任意chat输出的信任。

加密问题证明绑定原lease/goal/budget、会话/fence、最终证明ID、提案/输出/投影hash、来源账本和投影版本。SOURCE_CHOICE最终证明必须有sourceChoiceId；HTTP及物理投递同时检查当前问题指针、未回答、无待核实选择和当前来源。普通旧最终证明继续兼容。用户答复只接受一个有界序号，按tenant/owner、原私聊、当前问题、期限、CSRF和幂等键保存；返回PENDING_SOURCE_CHECK而不是已续接。重复原生回调不生成第二个选择或核实任务。

后台核实领取真实run租约，计入原累计活动时间，受任务期限/取消和原模型/工具剩余配额约束。检索来源与目标READ都执行当前鉴权，外部CHECK返回后再次查本地授权；成功才在同一事务写入AUTHENTICATED_SOURCE_SELECTION数据、回答标记、新一代RUN outbox。下一工具被限制为所选READ和精确参数；准备、实际派发、结果保留、后续模型请求、上下文重建、HTTP和发送均保留先前选择的来源依赖。目标READ权限仍在不能抵消检索来源撤权。

迁移040将后台固定拒绝回执绑定origin_task_id；原任务取消或过期后不能用新回执绕过停止。核实中取消允许在第一个外部CHECK期间提交；无待发送成功宣告。持久化恢复独立处理PENDING和已落库REJECTED的遗留指针，保留预算/累计时间并隔离旧worker_generation；不交给普通RUN恢复重复执行。旧journal到期后重建接受过的问题、原选项顺序、问题ID及序号；不重写旧reasoning，不把用户选择当成资源授权。

### 2026-10-15 P03 群受众证明与异步补充

迁移041–043引入owner/RLS只读的dws_group_scopes及group_directory_bindings、不可修改的加密run_group_audiences、受限列权限的group_clarification_messages，以及群授权/目录变更时单调递增的版本。撤销后重新授予相同值不能复活旧证明。API角色仅能读取答复状态，不能读answer_ref；运行角色不能安装群scope或目录映射。

固定v1.0.61的chat +chat-members-list提供CLI-owned im.group-members.v1投影，却不证明同企业或完整原始人数。正式源码显示投影可丢弃不能解析的行和企业信息；因此另需独立审核的chat +conversation-info字段映射，覆盖所有人/机器人及每次成员变化的revision。执行info/list/info，核对计数与前后修订一致；没有默认生产映射。名单中的稳定open ID必须唯一映射到当前ACTIVE主体及authEpoch，所有机器人必须在审核的允许列表内；名字、昵称和个人资料不入模型。完整受众证明仍不替代逐成员资源ACL。

证明绑定tenant/owner/run/task、原目标/预算、策略/authEpoch、精确任务期限、DWS身份及authorizationVersion、scope/目录/成员/来源摘要。模型派发、恢复、最终落库、HTTP和零evidence普通回答的物理发送前仍重新观察当前受众。GROUP企业工具、tool ledger/附件上下文与企业证据拒绝，避免私有资料借普通回答路径外发。

原生短码答复只在同actor/原群/当前问题内接纳；H5须显式shareWithGroup。inbox事务只封存本地当前证明绑定的待核实答复，返回PENDING_GROUP_CHECK，抑制旧提问投递；无外部读取、无模型续接。GROUP_REPLY独立队列领取原run租约，使用专门的有限授权连接池，避免重复回调占满业务池后嵌套读取身份死锁。外部观察期间不锁task/run，取消可及时提交；观察后再核对原权限/预算，成功才原子保存认证答复和下一代RUN。崩溃及关闭恢复区分PENDING/REJECTED、保留累计活动时间、隔离旧worker_generation，不重置预算。


## 2026-10-15 P07 人设设置与运行快照组件进展（IN_PROGRESS）

本节更新此前仅有规划的状态；不改变原需求优先级、130项验收状态或企业门槛。P07与R09现为IN_PROGRESS，不能由本组件测试推断整阶段完成。

已实现GLOBAL/GROUP/USER真实版本、加密字段、字段继承与null清除、企业锁定政策、ETag并发与幂等回执。工作台按当前会话和对应范围授权展示编辑、有效来源及历史；企业管理员身份不赋予私人偏好或所有群的访问权。群运行只使用GLOBAL+当前GROUP，私聊只使用GLOBAL+当前USER。

新运行冻结加密人设快照及精确来源版本；普通设置修改不替换已有运行的版本。重试与会话恢复使用原快照、原目标和原预算。模型、工具、最终结果读取及实际发送前核验当前身份、企业规则、来源与群受众；快照损坏或撤销后拒绝继续使用。未配置服务的库调用显式冻结BUILTIN_ONLY并审计；旧记录标记LEGACY_NONE，两者不能在后续恢复中自动套用最新偏好。生产入口均接入服务，完整生产部署尚未验收。

钉钉SDK入站支持明确范围的设置指令与有限自然表达，复用同一真实授权/政策/CAS写入器；不伪造H5会话。实际加密inbox须匹配当前租户、机器人、发送人及会话。范围不明的“切换为SRE”只询问范围、不保存；用户须重述完整请求，例如“把我的助理切换为SRE”或“把本群助理切换为PMO”。仅回复“个人/本群”的上下文续答尚未实现。回执与版本同事务持久化，零模型预算、无RUN队列；回执不包含偏好正文，发送前再次核验。自称管理员、角色定位文字及未知权限字段不能授予权限。

仍未完成：scope长期记忆、显式记住/忘记、纠错/过期及派生数据清除和备份边界；个人偏好完整删除/隐私擦除；完整GroupContract与群记忆；任意自然表达的设置理解、仅范围回答续接；任务页快照版本说明；有证据的完整工作计划/业务目标核验；SRE告警、BI认证统计及PMO调度/催办的依赖能力与各自授权。无真实模型语义评测、真实钉钉外发或企业联调PASS。
数据库迁移044保存人设不可变版本与受控政策；045绑定run/persona/source/owner并冻结无配置模式；046保存原生设置的不可变控制回执。API不直接读取历史密文；运行快照来源hash基于密文，不暴露私人偏好的可枚举明文hash。所有层与政策由同一SQL语句读取，避免并发生成从未同时存在的组合。企业政策字段须与锁定字段精确一致，否则拒绝使用。

工作台后台轮询对同一任务最多保留一个在途读取；一次慢响应不能被每秒新轮询编号持续作废。用户主动换任务、退出、页面挂起/恢复仍递增原意图与序列，拒绝旧响应；不缓存或绕过服务端当前来源核验。此处仅调整浏览器请求调度，未修改后端授权、预算或恢复实现。


## P07 后续两切片契约（开发中，未验收）

先实现A：原生无范围人设请求形成加密待确认提案，绑定原始patch、租户/发起者、原会话与频道、候选scope及基础ETag、身份/授权版本和固定有效期。仅原人原会话可只答“个人／本群／企业”，重新鉴权并按原版本CAS；个人只在单聊、本群只在原群；多提案不猜。明确“取消人设设置”只取消本人当前会话待确认项。重复事件不延长有效期或重复应用，提交前后崩溃重投必须幂等。默认有效期600秒，测试可用服务端受控短有效期验证真实时钟边界。关闭后清除待确认密文，仅留审计元数据；回执不包含私人偏好正文。契约见config/persona-scope-dialogue-contract.json。

A的必要证据：真实SDK无范围请求→scope-only回答→持久保存→原生新运行实际使用；跨人/群/频道/租户、过期/取消、多提案、并发H5修改、撤权再授、来源或密文损坏、重复/并发决策及SIGKILL均无误写，零模型设置回执与真实版本一致。A独立稳定候选之后继续B，不重跑未变切片，也不将原企业门槛标为通过。

B为个人明确Preference记忆生命周期与删除屏障，保存与真实运行依赖删除同步实现和验收，不能以仅存储CRUD宣称完成。必须沿真实来源关联清除/失效原文、索引缓存、快照、journal、checkpoint/摘要、最终结果、待投递及相关入站副本；旧恢复/重放不可复活，且不误删无关任务或共享企业内容。另补USER人设完整隐私删除，null清覆盖不等于擦除历史。备份、已外发内容的边界须如实说明。未应用的记忆结构草稿仅本地保留，不是已交付代码或迁移。原R10的其他记忆类型、GroupContract和P00–P14全部目标仍保留，A/B不是替代基线的缩小产品目标。

此前首次群澄清超时的确切因果仍未完全追溯；已证实并修复的轮询竞态不能被说成其唯一根因。真实付费、外发和部署未因这些本地切片获得授权。

### P07 提案关联边界修正（开发中）

真实隔离SDK回调/数据库反例已复现：P1关闭、P2成为唯一待确认项后，P1阶段创建但尚未送达的另一条“个人”（不同msgId）会被错误应用到P2。仅事件幂等、当前单一提案、时间戳和到达顺序均不能证明原答复意图。当前未取得可验证的钉钉原消息关联字段契约，不把这个缺口标成真实平台联调通过。

安全实现改为：裸“个人／本群／企业”只生成不含原偏好正文的CONFIRM_REQUIRED提示，不修改人设；用户核对原请求后回复“确认人设 <完整提案UUID> <范围>”，仅可提交该编号、本人、原会话仍有效的提案，重新核验原patch/ETag/权限。旧编号、跨会话编号和迟到裸范围均不能提交下一提案；没有自动退回“当前最新项”。多提案不猜。047/048已应用迁移保持不变，049增加确认回执类型。

A的原始纯scope-only一步保存体验仍未完成，安全确认候选不是等价完成；P07及原P00–P14目标、130项验收和企业门槛不变。B仍须同步实现真实个人Preference使用、删除屏障与派生存储清除，不能只交CRUD。上述测试均为本地合成提供方、真实PostgreSQL，不是钉钉/模型/企业真实联调。


## 2026-10-16 P07 个人 Preference 与 USER 人设隐私删除组件（IN_PROGRESS）

已实现明确保存/版本纠正/忘记的个人 Preference，实际 H5 session/CSRF、ETag 和幂等校验；原生钉钉 DM 控制入口来自加密 Stream inbox，使用真实 SDK 回调去重路径，本地替身不构成钉钉 LIVE。其他用户、租户管理员和群请求不能读取私人条目；群运行在检索前排除私人记忆。默认有效期90天、最大365天。模型使用另需 PRIVATE_MEMORY_MODEL_POLICY_FILE 批准的分类/条数/字节规则，缺省关闭；固定运行快照不自动采用后续版本，零条目截断也携带截断边界。

USER 人设隐私删除为独立操作：H5 DELETE /api/v1/me/persona，或经当前 DM 验证的“擦除我的人设及历史”。清除本人历史设置及请求正文、原生来源/范围提案和实际关联运行副本；保留 GLOBAL/GROUP、其他用户、独立记忆及无关运行。写入空的单调版本标记，阻止旧请求重放；再次明确保存可产生新版本，旧删除请求重试不擦除新内容。

迁移050–058仅在隔离合成 PostgreSQL 127.0.0.1:64711/anthys_test 应用并保留原文。053首次执行失败的空对象和别名问题分别由054/055修复；失败事务回滚、SDK无成功ACK。恢复测试保留删除账本，真实恢复选定旧内容/任务/租约；最初使用 pg Date 的试验损失微秒，旧租约失配导致的通过不作为屏障证据。修正为 PostgreSQL JSON 保留精度后复现迟到journal写回，057增加运行获取及每次guarded写的账本否决，058加强保留依赖和恢复状态修复。失败、修复和重跑记录保留于 reports/checks/history/，以 reports/p07-memory-candidate.json 的检查点和范围为准。

独立 start:maintenance 仅需要内部数据库/key及明确 WORKER_SCOPE_FILE，处理活跃主体的有界过期及保留账本下的修复，不调用模型/钉钉/DWS。当前不能认证已离职主体清理、删除账本本身回滚的整库备份恢复、独立删除日志重放、实际备份保留期及180天审计元数据清理。已外发字节不能撤回；逻辑擦除不等于 PostgreSQL/WAL 物理抹零。

仍未验收完整派生存储图：工具动作输入/结果、来源选择及回复、outbox、checkpoint等每个存储的可追踪正文植入/单独恢复，需要进一步用真实运行路径和明确标记的存储故障注入验证，不能由空表断言推断通过。全部组件为本地合成提供方/真实 PostgreSQL/Chrome 数据流验证；没有新增付费模型、真实消息、业务DWS或企业 LIVE PASS。完整R10其他类型/群记忆、GroupContract、任意自然设置、任务快照说明、工作计划及P02–P06软件缺口和P08–P14继续保留。P07未完成，ENTERPRISE_DWS及原130项验收状态和门槛不变。


P07本地完整后端检查点：reports/checks/p07-memory-backend-full.json 记录56文件/505测试PASS，源码指纹5b9dd64a2efe1929cb5db831c2d65e3d67e2ae2bb223664e5838135260c85bd4；原配置覆盖门槛PASS，branches87.04%/lines98.37%/statements90.90%/functions96.64%，store90.52%。这不是企业关键路径覆盖PASS：memory native receipt74.66%、commands80%、inbox76.92%、runtime81.53%、service80.85%；persona service87.16%、runtime86%等不足90%。完整图恢复矩阵及企业覆盖缺口继续保留。后续仅需求映射/四文档证据说明的源码差异通过逐文件manifest连接，不把不同指纹称作同源全量重跑。


完整Chrome套件首次50用例为48PASS/2FAIL：scope确认测试与原人设编辑测试共享身份，前者已保存版本1而后者要求初始版本0。未修改生产逻辑或版本断言，scope测试改用独立合成身份后，50用例完整重跑PASS，桌面/手机历史擦除及响应丢失重试均在其中。该测试夹具变更列入后端检查点至最终源码差异；不同指纹的检查点通过manifest连接，不推断为同源全量重跑。记录见reports/checks/p07-memory-browser-full.json及其不可变history。


## 2026-10-16 P02/P03/P07 后续修正与证据检查点（阶段仍未完成）

本次迁移059补齐实际来源选择回复的原生入站副本与SOURCE_REPLY outbox清理；迁移060使仅返回布尔值、严格绑定tenant/owner的删除否决在主体离职后仍有效，私人表RLS仍拒绝离职主体读取。Gateway在工具返回落库前获取共享删除屏障并检查该否决：恢复旧EXECUTING动作也不能重新写入已删除私人正文；普通租约失效/离职且未发生删除的UNKNOWN结果仍保守记录。只在127.0.0.1:64711隔离合成数据库应用迁移，没有执行开发库或企业数据清理。

原生来源选择、checkpoint、工具动作、回复、outbox与投递等实际数据流接受逐行旧记录恢复测试，使用明确标记的故障注入，并保留同字面值的无关动作/企业源/其他主体。该子矩阵通过不等于完整删除图通过：普通run_user_messages与narrative review逐存储恢复、真实checkpoint时的父run.context_ref、已开始物理发送的边界、离职主体维护、独立整库备份删除日志重放及180天元数据清理仍需实现和验证。

重试调度默认使用数据库clock_timestamp作为一个tick的时间依据，避免主机时钟偏移抢占有效租约或搁置已过期租约。独立正负两分钟偏移测试修前2FAIL/修后通过。较早252项回归中的finalization强制终止恢复用例失败记录保留；该用例在后续完整运行通过，但历史失败原因未获证明，不能用时钟修正倒推其根因。

钉钉Sender增加官方回调示例中的固定HTTPS主机/robot/sendBySession路径，同时保留/robot/send及主机、userinfo、端口、有效期、禁止跳转检查；无效URL返回受控失败。依据为https://open-dingtalk.github.io/developerpedia/docs/learn/bot/message/。16项注入fetch的离线契约与8项真实隔离PG投递测试通过，T119保留20并发仅一次注入物理请求断言；不含真实消息或平台联调PASS。

完整后端检查点reports/checks/current-foundations-regression.json：59文件/531测试PASS，源码42c7f2f402e323f6ceae4f53dc7460b3002ec4aeed6550541ba36b17a324b95c；原配置覆盖门槛PASS（branches87.03%、lines98.43%、statements90.91%、functions96.64%），Gateway90.59%、retry100%。memory service80.85%、sender72.22%等仍低于企业关键路径90%，不能升级为企业覆盖通过。该源码build通过。四文档/契约/映射说明更新通过逐文件差异manifest连接；未将较早50项Chrome或旧镜像当成本源码重跑结果。

详细交付与失败历史见reports/current-foundations-candidate.json。P02/P03/P07继续IN_PROGRESS，其他阶段及原P00–P14全目标、130项验收和ENTERPRISE_DWS门槛保留；124项NOT_RUN、6项BLOCKED_EXTERNAL、0项企业PASS，能力启用列表为空。没有新增模型收费请求、真实外发、DWS业务执行、凭据配置或部署。


## 2026-10-16 删除恢复补充与可选原会话出站限制（局部验证）

P07新增4项真实隔离PostgreSQL验证：PRIVATE Preference与USER人设各经原生SSE提问、独立review、可信原生澄清回复、checkpoint重建，再分别恢复普通run_user_messages、run_narrative_reviews、checkpoint、原生回复入站及投递旧记录；实际保存的回复正文可追踪，review_ref明确只含哈希/判定。恢复记录不能取新租约、再次请求模型或投递，已知删除维护重新清理各条记录。另在精确保留微秒的有效租约/task元数据下测试父run恢复。当前生产context_ref没有正文写入/读取者，不能把其NULL算为清除PASS；测试将真实私有journal密文植入该旧字段作为明确标记的可信恢复故障，删除否决使guard回调在读取前停止，维护清除旧字段。该测试不认证整库删除账本回滚，也不完成完整R10/P07。详情见reports/p07-erasure-dialogue-candidate.json。

P02/P04新增可选DINGTALK_REPLY_ONLY=true配置（严格true/false，默认false）：通知器使用同一Sender模式，跳过CardCoordinator；sendProactive在令牌兑换前返回FAILED/PROACTIVE_REPLY_ONLY_MODE，直接token调用也拒绝。原生事件有效sessionWebhook仍按既有身份/受众/来源/URL/到期/禁止跳转检查回复；缺失/过期私聊地址经既有投递路径得到明确FAILED，0令牌/0HTTP请求，不自动重试。已发请求丢失响应保持UNKNOWN，重复处理不再发。该模式限制本通知器的出站路径，不是员工、入站、模型、其他业务能力或费用授权。

本地37项定向检查（Sender契约21、投递11、配置5）及typecheck/lint通过；所有provider fetch为显式注入替身、数据库仅127.0.0.1:64711新合成记录，没有真实令牌/消息/模型调用。默认false的原主动投递回执契约仍通过。精确检查点和后续元数据差异见reports/reply-only-candidate.json。没有重新执行先前531全后端或50 Chrome，不将其声称为新源码全量结果。当前模式未写入真实.env、未启动应用、未配置员工/租户/预算/凭据/持久权限，也未部署。

P00–P14原目标保留。P02/P03/P07仍IN_PROGRESS，ENTERPRISE_DWS仍FAIL，原130项验收状态不变。真实测试员工/租户映射、企业已批准预算、平台授权与真实交互验收尚未具备证据；旧局部探测或本次无网测试不能代替。


## 2026-10-16 P07 在途投递恢复修正（局部验证，阶段仍进行中）

实际原生运行生成私人依赖的投递后，以注入fetch将Sender停在请求已派发的位置，删除Preference或USER人设，再单独恢复原SENDING投递（同一attempt及非空密文）。活动/DEPARTED主体分别测试接受回执和响应丢失。修前合法夹具8项均复现正文残留；普通离职但未发生删除的对照通过。初次5项离职夹具错误使用未定义的INACTIVE状态，不作隐私缺陷证据；其余活动反例和后续合法反例分开保留。

DeliveryGateway现在在迟到回执落库前获取共享owner删除屏障，绑定本次实际读取正文时的source_run_id，调用已有仅返回布尔且tenant/owner受限的060删除否决。已知删除时清除恢复的正文，SENDING保持保守UNKNOWN，不把接受回执当作已核验送达，不自动重发；不含正文的提供方ID可保留供后续核对。普通离职/租约损失且没有删除仍按原规则记录已派发结果。没有在网络调用期间持有删除锁，已发出的外部字节无法撤回。

53项定向检查通过（在途及既有图17、普通澄清4、投递11、Sender契约21）并通过typecheck/lint。它们使用真实127.0.0.1:64711新合成记录、原生SDK/SSE数据流及注入fetch，不构成真实钉钉/公司MCP/模型联调。无新数据库结构变化，复用已应用且不可改写的050–060迁移；本次修正只改变迟到投递记账路径。完整回归、产物与失败记录的准确源码绑定见reports/p07-erasure-send-candidate.json，不将此前531或50页面检查点当作当前同源重跑。

完整R10/P07仍未验收：独立整库删除日志重放/备份保留、离职主体维护、180天元数据清理、其他记忆类型/群合同、企业关键覆盖与原P00–P14全部剩余需求。原130项验收与ENTERPRISE_DWS门槛保持不变；无新增真实模型请求、消息、配置启用、授权或部署。


## 2026-10-16 P07 离职主体维护补强（局部验证，阶段仍进行中）

新增065将维护清理放在严格tenant/owner绑定、仅返回状态/计数的数据库函数中。离职用户或停用租户的已知删除恢复副本，以及已同意有效期到期的个人Preference，仍可按原删除凭证/当前修订和数据库墙钟清理；私人表RLS、H5读写/保存、模型及外部工具权限不因此恢复。内部purge/dirty函数不授予运行角色直接执行权。更早root恢复时按保留凭证恢复deleted_version，不能降低删除版本或复活内容。

后台沿原有依赖ID清除正文，不以文本匹配删除；保留后续有效人设版本、未到期条目、其他主体/租户、共享企业来源、无关任务和费用/UNKNOWN账本。到期产生内容已移除的内部随机请求键，避免用户选择旧expiry键阻止政策清理；范围仍有界且两worker串行，不因清理重新执行模型、钉钉或MCP。

复现修前7个真实业务断言失败、3个活跃对照通过；修后定向回归通过，另验证原生运行实际正文恢复、表/函数权限、批次上限、后续版本保留、真实SIGKILL提交前后原子性及独立维护进程。均仅127.0.0.1:64711合成数据、注入SSE/发送器与本地测试MCP，不是企业LIVE。完整最终源码、命令、失败历史和验证范围以reports/p07-inactive-maintenance-candidate.json为准。

原050–064迁移保持原样。独立整库删除日志重放/备份保留、180天元数据处理、其他记忆种类/群合同、完整工作指导、企业关键覆盖及P00–P14剩余要求继续保留。P07与ENTERPRISE_DWS未完成；没有启用真实试验、企业清理、付费请求、消息或部署。


### 2026-10-16 P06 独立签名只读通道组件

新增独立执行器入口、Unix socket 签名请求/响应与固定身份核验/个人资料读取协议；租户、身份快照、能力版本、受众、参数、期限和进程实例绑定，拒绝重放及时间回拨。只读通道的范围、启动/测试命令和限制见 config/dws/signed-runner-contract.md，真实执行证据见 reports/p06-signed-runner-candidate.json。

此为离线软件组件：不连接现有生产应用、不启用试验、不读取企业数据。配置入口继续拒绝 DWS_RUNNER_SERVICE_REQUIRED。当前任务/授权/资源撤销的独立委托生命周期、强制受控出网、device flow 及其余 DWS 操作仍未完成；合成子进程与 Linux network-none 协议验证不能计为企业业务联调。无新持久化表，001–065 迁移保持不变。P06、P00–P14 与 ENTERPRISE_DWS 验收状态不因此改为完成。


### 2026-10-16 数据库版本与私有维护健康修复

就绪检查绑定当前001–065迁移名称/哈希精确集合及随编译包发布的版本契约；不自动迁移。维护进程先验证schema和试验禁用门，首次成功周期后才READY；失败即时记录脱敏操作/范围索引/摘要/固定原因，同轮收尾后退出1，停机不覆盖失败。原单聊启动拒绝与零外部初始化断言保留。当前私有生命周期契约已消除旧active-only描述，明确离职/停用主体清理仍要求保留账本及persona状态；整库备份/独立日志重放、180天元数据清理、物理删除与生产部署仍未完成。范围与命令见config/database-readiness-contract.md，真实结果及各候选绑定见reports/schema-maintenance-candidate.json。只做隔离本地验证，不表示P00–P14或ENTERPRISE_DWS完成。


### P04 权限要求、诊断与自助撤销（2026-10-16）

新增不可修改的066，保存 permission_manifests、单调当前指针、本人诊断缓存及不可修改的撤销审计。oa_app/oa_runtime 无直接写权限；066 额外撤去运行角色对 roles/role_bindings 的写权限。显式迁移管理员安装严格版本清单，不能设置绑定 READY 或创建资源授权；旧版本回退/同版本改内容拒绝，重复同内容幂等。编译就绪清单现在精确包含001–066，早前已应用迁移原样保留。

诊断在真实数据库读取当前租户/本人/资源/受众/分类/期限、authEpoch/政策、要求与绑定hash/版本、DWS本人身份/委托/外发同意，以及服务器实际注册元信息。30秒缓存按全部依赖快照隔离，命中前重新核对，等待缓存写锁跨过期限重新计算。返回结构明确 executionAuthority=false 和平台 UNKNOWN/NO_CERTIFIED_PROBE/live=false；不读取业务正文、credential/provider_binding 或调用远端。Gateway 不读取该缓存授予执行。

SECURITY DEFINER 仅以当前tenant/actor与当前会话执行本人精确id/version撤销；安全search_path、当前主体检查、RLS、只读列投影、并发串行、不可修改审计和authEpoch递增均保留。HTTP沿用会话/Origin/CSRF且private,no-store，直接页面地址也验证会话。撤销使该用户全部旧会话/旧租约失效，其他用户不受影响；不是定向任务取消或平台端凭据撤销。完整契约、命令和局限见 config/permission-center-contract.md。


### P04 T036 实际派发验收入口（2026-10-16）

T036入口为每组新建独立合成主体、资源和真实任务租约，使用当前RLS、绑定、资源委托与真实Gateway。源提供者在本地64702独立按当前主体查询64711的资源所有权；获准读取生成持久审计，获准写入生成真实数据库记录，并独立回读。写入审批经过现有会话/CSRF/nonce API，不直接伪造APPROVED行。独立参考函数不导入生产authorize/Gateway/SQL助手。拒绝同时核对HTTP请求与持久化副作用为零。只创建合成记录，无真实企业提供者、模型、消息或DWS。

### P04 Action 角色上下文契约（2026-10-16）

067_typed_action_role_authority.sql 新增 oa_control_action_authority(subject,role,actionId)，从 tenant 约束下的 tool_actions→runs→tasks 和冻结受众读取上下文。审批可见性、候选人、状态、请求/决定、Gateway 消费/派发复核、UNKNOWN 页与核对沿同一函数。旧无类型函数只接受 TENANT/CAPABILITY/CONNECTOR/RESOURCE。AFTER INSERT 触发器只对实际新增绑定递增 auth_epoch；原 UPDATE/DELETE 版本与失效规则保留，并补齐绑定移动的新接收人。001–066 保持原样；随包 schema 精确集合更新为 001–067，不自动迁移生产。


### 2026-10-18 单聊任务回执与审计追加契约

普通纯文本 DM 的 inbox、任务、RUN outbox、TASK_RECEIPT outbox 标记及 message.accepted 审计在同一事务提交后才允许 SDK ACK。TASK_RECEIPT 仅含内部 task/run/sourceEvent 编号及接纳时的身份、策略版本，不包含原始消息或回调地址；RunQueue 不把它当成模型任务。一次性 TRIAL 不创建这个标记。

DeliveryGateway 在当前生命周期允许时领取回执标记，重新检查任务、运行、DM、身份和策略；过时标记只被消费并记 SUPPRESSED。实际回执使用加密 deliveries 和 message.received run_steps 证明，绑定固定服务端文本、内容哈希、原事件和版本。发送前复用当前身份、受众、原回调及停止门，并校验该证明；任务仍 OPEN 只允许这种经过证明的固定回执，不能借此发送任意未核验结果。最终结果已就绪时抑制迟到回执。

audit_events 保存固定动作、状态、内部资源编号和 trace 编号，不保存正文、URL、凭据、模型内部推理或供应商错误正文。按租户/员工在业务事务末尾串行追加哈希链，时间戳保持严格追加顺序；投递终态观察幂等。业务事务回滚时审计也回滚。既有 RLS 及运行角色不可 UPDATE/DELETE 的约束保留；这不替代独立审计锚定、备份恢复或完整 R34 验收。无新增迁移，schema73 契约保持。

### 2026-10-18 权限诊断缓存容量组件（未在真实库启用）

迁移074在原有诊断函数中沿用撤销路径的员工级事务锁，先重新核对会话，再删除该员工的过期缓存，并保留最新127份旧快照，为当前计算预留一份；提交后每位员工最多128份。缓存仍只有元信息，`executionAuthority=false`；输出前的会话、授权到期与DWS到期复核、租户/本人隔离不变。该组件不增加权限、不认证外部资源。

仅隔离测试库64711应用了074。真实项目库64710仍为73；新候选要求74，因此不得沿用此前73版本的就绪结果启动新候选。真实库升级须在后续获准的维护步骤执行，本轮没有迁移、重置或修改真实数据。诊断请求限速与闲置员工的周期清理仍待实现，不据此宣布完整P04通过。

### 2026-10-18 权限诊断持久限速组件（未在真实库启用）

迁移075为每个租户/员工保存一个固定60秒计数窗口，最多120次成功诊断（包含缓存命中和强制刷新）。同一员工的所有会话和API实例共享计数；采用既有员工级事务锁，重新登录不能清零。超限返回HTTP429与固定错误码，界面提示稍后重试，不自动请求；失效会话不占用计数。应用和运行角色都不能直接读写计数表。限速结果不扩大任何资源权限。

仅合成测试库升级至75。真实库仍未操作，仍为73，新候选需75；之前73版本的真实联调清单不能直接用于此候选。周期维护闲置缓存/过期计数元数据尚待接入。

### 2026-10-18 权限诊断闲置清理组件（未在真实库启用）

迁移076提供仅运行角色可调用的限定范围清理函数：每次最多删除128份已过期诊断，删除该员工超过一天的旧限速窗口，返回计数及是否还有剩余；活跃窗口不清零。沿用已配置的维护进程租户/员工范围，停用或离职员工也可清理；不创建用户会话、不修改授权。员工锁被诊断或撤销占用时立即跳过，下周期继续。现有维护进程新增此必需依赖；清理失败进入FAILED并停止后续周期，日志只有固定错误码和显式计数。试验模式原有维护禁令保留。

合成库已应用至76；真实库仍为73且未运行新维护过程。已完成原先缓存容量、限速、闲置清理这组软件缺口，不等于完整权限管理生命周期、对账、T036矩阵或企业验收已完成。

### 2026-10-18 P04 管理员本地私有资源政策（组件，未在真实库启用）

API新增管理员资源列表及CREATE/RENEW/REVOKE/REGRANT。后台每次核验真实session、当前TENANT_ADMIN/TENANT/本租户绑定及有效期，不信任客户端角色、回调身份或人设。目标是同租户活跃员工的精确内部ID；当前组件只管理PRIVATE_USER政策，GROUP授权必须另有已认证群合同/受众，不借此接口登记。该组件不创建角色/个人DWS授权、不批准业务写入、不授予来源/模型出域权，也不开放员工私聊正文。

受管理grant冻结能力版本、绑定摘要、独立清单ID及既有完整CapabilityDescriptor摘要。独立清单认证模式须属于当前实际描述的authModes。工具列表、执行、物理调度前、来源选择、历史/checkpoint和最终来源复验都使用一致的政策可用性检查；描述、输入/输出、风险、提供方或清单改变后须明确重审。此前由特权配置安装的legacy grant保留原校验，不能以此新接口绕过其来源检查；明确REGRANT后纳入新绑定。

按稳定顺序锁定管理员和目标的权限事务锁，再锁session/角色/身份，兼容员工自行撤销；等待后重查会话及到期条件。写入使用版本CAS、按管理员/请求ID绑定规范化输入的不可变回执，目标员工审计链同事务追加。旧回执重放返回当时结果并另列currentVersion/currentState，不把旧撤销快照假称当前状态。REVOKE/REGRANT递增目标auth_epoch并清诊断缓存；本人撤销会让当前会话失效并清cookie，不自动复活旧任务或重置预算。

077–083只应用于合成库64711。078把PostgreSQL不支持的{0,511}正则重复界限改为同字符集+单独512字符限制；后续迁移补齐完整描述和认证模式，旧登记文件未改写。真实库仍未操作，最后只读观察为73；本组件候选需要83，不能使用旧版本就绪记录启动。完整管理员角色/委托、群治理、管理UI和企业验收仍待后续工作，不提高原R状态。

082在既有租户/本人RLS上叠加限制性SELECT政策，受管理行只对声明`OA_MANAGED_GRANT_V1`的事务上下文可见；新Database.scope固定设置本地标识，提交/回滚后不保留。未声明的旧读取路径只见原legacy行，不能因忽略新列而使用新授权。标识仅是代码协议准入条件，不赋予租户、本人、管理或执行权限；完整描述/来源/审批校验仍必须通过。

083明确本组件仅供未进入受限试验/本人FORMAL历史的DEFAULT管理上下文。声明试验/正式profile或存在共享试验/正式记录时，管理列表和写入均拒绝；该批准不包含租户政策管理。受限租户的单独管理准入仍待后续设计/批准，不能延续旧试验窗口或借默认进程绕过。

### 2026-10-18 P04 独立只读核对组件（未启用真实提供者）

`CertifiedReadBacks` 只接受代码内审核注册的终态操作账本协议，绑定写能力版本、binding、完整Descriptor，以及独立READ声明/输入输出Schema/绑定。无通用工具调用、配置文件或HTTP自助注册入口。当前实际能力没有已审核的终态账本适配器，生产ControlPlane未注入此服务；默认拒绝 `CERTIFIED_READ_BACK_UNAVAILABLE`，不发起上游请求。

经现有登录/CSRF的 `POST /api/v1/reconciliations/:id/read-back` 兑换原核对nonce：必须为当前独立安全审核人、原会话/角色版本、当前本人私聊及本人操作受众、未到期/停止的任务和WAITING_USER的UNKNOWN动作。审核人的独立读授权与原执行人的当前写资源授权分别在各自RLS范围核验；不会向适配器传入原参数正文、原执行人Principal或凭据。配置表继续仅SELECT，核对前、派发前、返回后复核当前权限与绑定。已发出的只读请求无法追溯撤回，适配器仍必须独立认证审核人。

REQUESTED原子兑换为VERIFYING后，固定10秒读取绑定原actionKey/完整scope hash/主体/资源/版本的终态证明。普通EMPTY、待定、非终态、错绑、过旧/未来记录、异常和超时均INCONCLUSIVE。NOT_APPLIED只能来自已经独立审核其“终态拒绝以后不能迟到接受”语义的提供者操作账本，不能据普通资源不存在推断；当前只有隔离夹具实现此协议，未宣称任何现有供应商支持。证明和审核摘要加密保存，审计只存状态/摘要；失权或漂移后不能认证证据。

核对case可为VERIFIED_APPLIED/VERIFIED_NOT_APPLIED，原ToolAction仍UNKNOWN、run仍WAITING_USER，所有返回retryAllowed=false。不重建缺失ToolResult、不恢复模型/发送、不消费新批准、不放宽原时限；明确本人重试、新批准、真实提供者及群闭环继续待开发。

### 2026-10-18 缓存差异费率的预留与结算

管理员报价可选择携带`pricing.cache:{inputPerMillion:<十进制字符串>,storagePerMillionTokenHour:"0"}`；该对象与普通报价共用来源、币种和有效期，字段缺失不补默认报价，原策略序列化及hash不变。非零或不明存储费不支持；真实使用必须先审核报价确实覆盖本次请求的缓存收费，不从公开价格自动启用。缓存输入价必须不高于普通输入价，普通输入价仍受原ceiling约束，预留逻辑不变。

结算使用原请求冻结的policy_snapshot和提供方`usage.prompt_tokens_details.cached_tokens`：金额为`((prompt_tokens-cached_tokens)*普通输入价+cached_tokens*缓存输入价+completion_tokens*输出价)/1000000`，Decimal合并后仅向上舍入一次至12位。token用量仍为全部prompt+completion，不扣缓存token。启用差异费率时缓存计数缺失不默认为0；负数、非整数、超过输入、总量矛盾继续UNKNOWN。并发重投只结算一次，报价变化不改旧请求，冲突用量冻结后续请求；迟到结算不复活取消的任务。无缓存报价的旧请求仍保持原保守行为，不能套用新报价消除旧UNKNOWN。

### 2026-10-18 完整任务引用仍绑定当前问题

clarificationCommand新增`继续任务 UUID 短码：正文`选择器；UUID严格校验，问题短码仍与当前未答复且未过期的narrative review/source choice绑定。acceptClarification在原tenant/owner RLS、原可信conversation、WAITING_USER/ACTIVE任务、期限、取消和lifecycle判定上再增加精确task_id条件，随后仍交原replyInTransaction重新核验当前身份/政策/受众/来源并沿原幂等键提交。新格式仅原私聊；群仍使用既有群澄清契约。

单凭task_id不会选“最新问题”，不完整/错配/迟到编号不产生模型RUN，仅持久化既有确定性拒绝回执。旧短码及其歧义拒绝逻辑保留，已持久化提问的renderClarification和输出hash不变，避免新版本使旧问题证明失效。无需新迁移，不改变原额度或续期任何任务/试验。

### 2026-10-18 本人运行的只读计量摘要

TaskStore.get在原任务/运行RLS内按当前tenant、owner与已选run IDs追加一次只读聚合，返回`model_accounting:{status,requestCount,heldReservation,legacyUnmetered,reasons,providerInvoiceVerified:false}`。status为NONE/PENDING/UNKNOWN/RECORDED；UNKNOWN优先于PENDING，未识别组合与旧计量版本保守UNKNOWN。requestCount是账本请求记录数，包含预派发或已释放记录，不冒充物理模型调用次数。heldReservation仅说明账本中的正预留标记，不是供应商扣费证明。

只选应用账户已有列权限的计量状态/预留字段；不返回provider_usage、policy_snapshot、payload hash、原始错误文本或跨币种金额总和。原因只映射固定枚举，零预留旧账仍保持未核实。读取不改账本/任务状态、不补费用、不释放UNKNOWN。工作台校验摘要形状，缺失或不支持的格式显示暂不可用，不回退为零费用；任务正文仍沿原当前来源权限核验。

### 2026-10-18 显式预算窗口转换的存储与准入契约

新增084迁移仅定义budget_policy_transitions不可变历史及oa_budget_transition_authorize(request, policy, formal)；不写任何激活行。request为严格版本1，绑定转换UUID、tenant/owner、原CLOSED trial摘要、预期当前策略摘要/版本、新策略摘要、新正式profile摘要和独立预算审阅引用。函数限oa_migrator，按原试验行及预算当前投影行串行锁定，兼容029的FOR SHARE；当前预算摘要/版本不符、blocked、尚有AUTHORIZED正式授权、窗口非有限或身份不符即整笔拒绝。新策略除有效窗口/审批引用及同费率报价窗口/来源引用外必须与当前策略一致，不重建bucket或写任何ledger/allocation。

当前投影budget_policies更新前，旧行完整快照和新文档写入不可变转换记录；与精确新正式profile授权处于同一事务，失败一并回滚。069原18字段/身份/会话/服务/期限/受众/能力校验全部保留；新增例外只允许该不可变转换记录所绑定的同一profile摘要/authorizationId/owner/原trial摘要，不凭任意新hash授权。正式记录固定新预算摘要，RuntimeStore.prepareModel读可信FORMAL状态中的该摘要；TRIAL仍固定原试验摘要。原trial、旧授权、旧任务、原报价快照保持原义。

完全相同转换编号及文档可幂等返回，但当前策略版本、身份epoch、ACTIVE状态、正式授权撤销/到期和预算有效性必须仍匹配；失败不能恢复授权。旧AUTHORIZATION必须显式撤销，转换不代做撤销。CLI默认仅离线plan，精确request hash和review引用同时确认后才允许显式authorize；不会写profile或启动服务。

### 2026-10-18 群合同来源、修订及运行屏障

085 新增 group_contract_delegations、group_contracts、group_contract_revisions、group_contract_requests。应用不能直接写这些表，runtime 仅通过窄 SECURITY DEFINER 入口更新；完整合同使用现有 Vault 按租户/合同/修订加密，历史修订和幂等请求不可改删。委托由 oa_migrator 显式审核入口建立，固定角色/目录/服务身份/群范围的当前证明、租户政策和版本；重复批准仍校验来源，撤销不能复活。迁移本身不创建任何实际委托。

GroupContracts 先验证真实会话和当前委托，再校验正文绑定、有限期限、币种和额度上限。API 提供 GET/POST /api/v1/group-contracts 及 POST /:id/state，变更要求原 Origin、CSRF、UUID 幂等键与期望版本；并发只提交一个修订。暂停/撤销不等运行中服务用户行锁，但仍校验当前委托和会话。

GroupAudience 将合同版本/摘要并入原受众证明，重新确认管理员仍在实际受众；目录审核变化使旧委托失效。watchTrial 保留原试验/正式运行判定，另通过独立 MVCC 连接观察群合同变化，期限使用本地单调计时硬停止。GROUP/LIFETIME 金额桶使用稳定群标识，跨修订保留 used/reserved 和 UNKNOWN；结算仍使用原请求快照。该合同不授予借用其他用户私人 DWS 身份的能力。真实库维持 schema73，085 仅为隔离测试及候选迁移。

管理员资源界面复用既有 permission-administration API，不新增授权入口。当前 TENANT_ADMIN 角色只决定入口展示，后端仍独立核验；前端固定一次确认的 UUID 幂等键、目标及期望版本，核验回执版本恰为期望版本加一，区分逻辑重放与当前记录状态。会话/CSRF/可见性变化丢弃迟到响应，未知结果无自动重试。

### 2026-10-18 日志范围、不可变查询与共同启动接线

086 仅新增 company_log_scopes 定义，采用 FORCE RLS 和 tenant/owner 隔离，runtime 仅 SELECT，应用和 runtime 均不能安装或修改授权。范围固定连接摘要、服务/环境、来源/工具合同版本、时间窗、单次窗口/行数、字段、等级、出域及脱敏审核引用和期限；修改推进版本。真实库仍未升级，合成库增量至86，全新安装待准确候选 CI。

独立 COMPANY_LOGS_MCP_CONFIG_FILE 要求私有0600文件及令牌、精确 HTTPS origin/server/contract 和只读、主体资源、字段脱敏审核；不继承 COMPANY_MCP_CONFIG_FILE 或 AIDER_AI 凭据。API、worker、notifier 使用同一 configureCompanyLogs；FORMAL 必须精确 id/version/bindingHash 批准，未匹配时初始化前关闭。原代码合同摘要不变。

MCP QUERY 返回绑定 nonce/tenant/actor/scope/version/sourceRevision 的严格日志快照；queryId、查询参数、观察时间、保留期限、时区、行及计数/采样/截断共同计算不可变 snapshotHash。缓存/事实/渲染/发送前 CHECK 同时验证当前权限和仍保留的 queryId+摘要，再复核本地版本。单次最多100行、24小时窗口、10分钟快照期限，并受较小审核范围和原任务预算限制。字段白名单与本地脱敏是额外防线，不能替代提供方认证或企业出域批准。

输出合同保持非转换和深相等校验；新增固定日志引用仅作用于 company.logs.query，保留原能力输出及已有最终答案摘要。UNKNOWN 投递仍不能再次认领。群合同界面的真实 flow→本地API/PG验证 CAS/幂等/CSRF/异主体和暂停后待发送抑制；route mock 另验证界面，不替代后台证明。

### 2026-10-18 私人提醒运行契约

089–091新增owner强制RLS的schedules、occurrences、幂等请求、不可变版本history与原生设置回执。计划正文/规则加密，执行身份以owner+当前auth_epoch/policy重核，目标固定本人；原生来源与加密inbox关联。API `/api/v1/schedules`、`/:id`、`/preview`及`/:id/pause|resume|cancel`；PATCH完整text/rule，变更需If-Match、CSRF和Idempotency-Key。

scheduler按5秒tick、owner范围due索引及SKIP LOCKED，在同事务生成唯一(schedule,revision,UTC) occurrence+task+SCHEDULE outbox并推进规则。任务在确定性执行前保持非模型可领取状态；暂停/改版/取消撤销旧occurrence、关闭旧outbox、取消待执行任务并抑制PENDING投递。下一到期为空但最后发生点未执行时仍ACTIVE；本地执行后COMPLETED只表示规则结束。执行与物理发送前重核revision、身份、策略、内容/授权证据，UNKNOWN不重试。提醒只取最近错过一次且在一小时内，否则MISSED；不补发停机期间每个提醒。报表/监控与高风险写的独立misfire执行仍待完成。新迁移只在隔离64711库验证；真实schema升级须另批。

### 2026-10-19 原生群事项来源与投递证明

092仅新增task control_kind GROUP_CASE、以实际owned GROUP/MENTION_ONLY task/run为依据的独立native authority/member函数及owner私有不可变group_case_responses；不绕过H5 session检查。普通RUN队列复用零模型/工具预算的确定性分支；原goal与加密inbox全文保持相同。当前合同/委托/来源身份和新鲜完整群受众在执行前后及旧结果读取、最终两次发送检查复核。CASE正文/版本与LIST当前投影变化都会拒绝旧回执。一般GROUP企业工具及证据屏障保持。

同事务保存事项、请求、审计、受保护投影、run结果与delivery；取消或SQL超时后不保留半次mutation。UNKNOWN不重发，不因此再次登记或调用模型。物理发送与远端名单观察不原子，不能宣称撤回已经发出的字节。API最终读者与独立notifier同样配置群事项校验器。092只在本地64711合成库验证，真实库未升级。


### 群事项模型读的受限证据路径（2026-10-19）

093新增真实普通群@任务的只读case.read authority；092的确定性写入authority保持原样，不借GROUP_CASE控制运行的零证据通道执行模型汇总。固定能力通过私有工厂对象身份认证，普通CORE/相同ID/相同bindingHash不能自行取得群例外。工具结果加密持久保存于既有动作账本，绑定原事件、语义任务租约、输入窗口/游标、能力合同、当前合同/受众和精确事项投影；恢复时仍用当前fence验证真实租约，并重算同一语义来源。

发现、读取前后、缓存/重读、history、checkpoint的facts/actions/omitted/unexecutedCalls、模型派发、最终引用、HTTP和发送复用窄认证与当前投影检查。非白名单无data错误、悬空调用、重复call ID和额外身份参数不能借上下文恢复带入模型。认证失败回执只允许固定安全envelope。局部SQL瞬态失败保持CERTIFIED_LOCAL_READ/PREPARED以便安全重读；UNKNOWN不自动重做。

REPORT正文必须严格空串，事实由引用渲染；所有证据均为当前认证case读且非空时，既有两次物理发送前复核才允许群正文。一般群企业工具/证据和附件仍拒绝。模型投影刻意排除scope全目录，H5原接口保持。093仅应用隔离64711；真实库未升级。独立来源授权撤销、增强来源与其余未交付能力仍不是本切片的完成声明。


### 群事项当前名单授权（094）
094新增封闭H5 observer元数据与观察名单目录投影。GroupCaseRoster在实际B/C会话事务内核对合同/委托/角色/身份/绑定/授权/kill，独立有界凭据池只为已审服务A执行群名单读；读写前后观察和目录摘要变化即回滚事项/变更/回执。GroupAudience.currentMembers为原生候选与回执复核提供同一当前集合，不再调用旧整目录投影。
ACTIVE合同put统一先取group-contract advisory，再进入保留全部原验证的v85体，旧体和整目录投影撤掉runtime直接执行权，避免反向等待。093/094已应用文件保持不可变，当前精确清单94/hash=cdcb2dc3c98c2ccada2407db219d4ac752ce3ddf9adeb39af1d68a03deb2d0e7；仅合成64711已升级，真实库未迁移。

群事项UI复用现有from/until UTC半开API（最多31×24小时），本地墙钟输入拒绝无效日历与DST不存在时间，重复墙钟选较早时刻并提示核对UTC；分页沿已读coverage，不因编辑条件恢复旧数据。服务端当前名单/合同验证保持独立。

### SCHEDULED_CONTRACT管理与观察基础（2026-10-19）

迁移095新增群提醒独立审核授权、计划、occurrence、notification、notification-cases与管理员请求账本，强制RLS及最小EXECUTE权限。安装/撤销只允许migrator精确审核文档；运行身份不能自签授权。审核文档绑定当前合同版本/哈希、委托、服务主体epoch/authorizationVersion、scope及期限。管理员B保持当前真实session；服务身份A只观察审核群，不继承A的私人资料权限。

READ_GROUP_REMINDER_AUDIENCE使用独立SCHEDULED_CONTRACT协议叶子，固定已审核schedule/profile/authorization/contract，并将revision/generation/occurrence/fence/notification/originHash/PLAN或SEND纳入签名。它只是只读观察，SEND字样不是发送授权。运行调用从真实持久occurrence重建来源，校验密封规则实际发生时间、当前版本与期限，再独立观察完整平台名单并与有效目录交集；无H5或原生事件伪造。缺少精确策略时失败关闭，旧签名叶子的binding计算不变。

计划管理在同群合同锁内进行当前管理员、会话与前后名单复核，写入与revision/generation失效原子化。精确重放在计算新发生时间之前查持久账本；暂停/取消仅返回真实控制字段，不依赖正文解密，PENDING可抑制而SENDING/UNKNOWN保留。跨服务身份的群配额观察函数已含全部旧未决记录，但尚无领取/原子预留/物理发送实现，不能据此声称T111执行链成立。

095目前只在专属、已清理的合成临时库验证；共享合成库仍94，真实库未操作。后续受控部署必须另行批准备份、精确迁移和回滚。

### 统一企业 MCP 长问答的运行约束（2026-10-19 用户调整）

企业代码/日志/数据问答统一经实际发现的 MCP 问答工具进入；不假设独立业务接口或未发现的 submit/status/result/cancel 协议。1–20 分钟是用户确认的处理时间范围，不自动修改既有 240 秒预算或批准费用。持久请求必须绑定租户、主体、任务、逻辑请求、精确参数摘要、连接/配置版本、期限与派发状态；快速回执和进度只反映可观察事实。

长调用在业务事务外等待，不能长时间占用取消/续租所需锁。网络派发前记录 attempt；断线、取消、本地超时或重启后若无远端核对/幂等证明，保留 UNKNOWN，禁止经 CERTIFIED_READ/PREPARED 自动重新提问。本地停止不等于远端取消；有实际协商的恢复句柄时只恢复同一请求。预算、并发、未知费用与未决请求持久化，不能因进程重启或 finally 释放本地槽而退款或遗忘。通用问答来源与独立认证代码/日志事实分别表达。

### 群提醒与成果功能包实施边界（2026-10-19）

096群提醒执行与097任务成果已进入源码；共享合成库保持94，仅独有nonce临时库升级验证，真实库未访问。成果固定task/run/epoch/session/result hash、当前最终来源oracle、核对后本地取消/擦除复核、短期单次会话票据及有界密文清理。未决发布清理必须先持锁CAS确认失败，不能先读旧状态再unlink；既有门槛/默认外发拒绝保留。完整持久企业长任务仍待接入。

### 企业问答持久等待实现（源码098，2026-10-19）

`company_agent_requests`按租户与owner强制RLS，绑定原task/run/action/attempt、provider session、主体epoch、受众、精确message摘要、连接/schema/scope/budget版本与独立绝对期限。正文沿用原tool action的加密input，不在状态列表重复保存。入队原子地将run置WAITING_EXTERNAL并释放模型活动时间；后台worker续独立30秒租期，SDK发现/控制各有短界限，业务等待最多20分钟；跨租期等待不持PG长事务。

已提交派发标记后，取消、断线、失租与结果不明均保守UNKNOWN，不自动重新提问、退款或推断远端已停。已保存回复可恢复原action与唯一续跑outbox/generation；模型收到原tool_call_id的未核验文本。内部DEFERRED不进入模型ToolResult协议。累计额度按稳定budget identity串行，未确认占位按稳定物理endpoint摘要跨connector别名保留；预算锁与上游锁分别有序。停止开关写入经098专用排他触发器，与派发/来源检查的共享屏障形成明确顺序；未增加修改停止开关的权限。私有policy深冻结，返回handle不改变捕获授权。

API仅返回本地状态元数据并沿用原CSRF取消接口。结果读回、最终答复和notifier须重核同一当前私有范围，UNKNOWN/UNVERIFIED不能升级为完整事实证明。098仅在自有schema-only nonce测试库使用；共享合成源仍94，真实库此前73未访问或升级。

### 2026-10-19：群企业问答的后台受众上下文

098请求账本复用原task/run/action/attempt/session、受众与persona引用。后台名单读取从真实行装配不含模型worker/fence的 `GroupAudienceContext`，再独立核对真实request ID、worker、request fence、lease、WAITING_EXTERNAL、任务/身份/租户/生命周期/期限与已保存proof。不伪造RUNNING lease；签名服务继续核对原生task/run精确delegation，不借H5事务或提醒purpose。

工具发现后可在单独最多12秒的阶段观察真实名单，随后原两秒本地派发门仍需当前proof/目录、精确合同、双grant与预算；短暂预检只绑定同request/worker/fence并在派发时消耗，重启后重新观察。MCP等待期间后台独立持有watchTrial观察器，响应后再次核对名单；撤销/取消/状态不明保守保留UNKNOWN，不自动重问。同步RuntimeStore.guard在生命周期/user/run锁之前取得同键群合同共享屏障；合同变更使用排他屏障。最终恢复使用原工具调用并沿已有finalization及独立发送前复核，不授予额外群投递权限。

群试点策略另钉独立审核的membershipHash与directoryHash，并与已验证原任务受众proof精确比较；scope/grant的版本号不能替代本次初始成员与目录快照的共享审核。新增字段不自动安装或修改任何真实授权。

### 今日已登记群事务窗口（2026-10-19）

原生“汇总今日事项”/“列出今日事项”按已审核合同的IANA时区及可信任务接收时刻固定本地日，服务端计算登记半开区间；回执保留时区、锚点、窗口、分页和“不覆盖全部群聊”。复用当前合同/名单与发送复核，不新增授权或主动发送。相同请求不因跨日改换查询；实际PG的23/25小时DST、重复回调与暂停后零发送已验证。固定短语以外日期语义、全成员原生参与、升级/增强来源与完整R14/R15仍未完成。实现1bcca15及25项定向验证见reports/group-case-today-20261019；不是真实企业/外发或新候选CI验收。

### 分析作业签名契约基础（2026-10-19，R21未完成）

新增独立结构化TS/JS分析作业契约与Ed25519签验：固定镜像摘要、租户/主体/authEpoch/任务/运行/作业/输入引用、正文摘要、短nonce与最长60秒信封分别绑定；仅NONE网络、限额只可收窄，业务请求不接受镜像、路径、挂载或凭据。仅是后续独立broker复用组件，签名不是ACL或持久防重放；尚无实际作业执行、取消/超时销毁、成果接线或R21/T097/T098验收。纯本机22项辅助验证及整合检查见reports/analysis-job-contract-20261019；新增.test已登记正式发现，旧测试/门槛保留。

### 群合同互斥与验收判定补充（2026-10-19）

群运行本地事务统一先取规范tenant UUID的合同独占锁，再取owner/run行锁，避免与092/093授权函数的共享到独占升级环；后台企业请求的合同共享屏障使用同一规范键。实际PG已分别复现共享升级和大小写键分裂的40P01；最终四链56项零跳过、类型/lint/build通过，来源及旧失败绑定2445807与reports/group-contract-lock-upgrade-20261019。合同锁不跨企业持久等待，不新增授权或声称容量达标。

原生成员事务新增独立NATIVE_GROUP_CASE签名叶契约，仅明确区分真实requester与审核serviceOwner及EXECUTION/只读RESULT_VERIFICATION；旧H5/企业问答/定时协议保持严格隔离。31项纯测试及主整合登记不等于SQL权限、动态租约、名单和结果发送已接通，完整成员参与仍待完成。需求扫描同时区分实际查询的正常缺失回退与函数只有undefined返回的占位，不以文件白名单或改状态消除需求缺项；旧CI113项中的字体表查找误报须与真实36项需求/76项场景缺口分开记录。完整一期与真实试点未完成。

### 群MCP原生HTTPS隔离验证补充（2026-10-19）

本机真实TLS、生产默认global fetch及实际MCP SDK已串起可信群@、签名Unixsocket名单、独立PostgreSQL持久WAITING_EXTERNAL、工具发现/调用、证据核对与单次受保护合成投递。18项零跳过及同源类型/lint/build通过绑定e5fd460和reports/company-agent-native-https-group-20261019；保留辅助首轮证书集合表示判定失败。延迟超过2秒的返回证明初始化期限不截断工具等待，不等于真实20分钟验收。版本/契约漂移零业务调用，在途取消保持UNKNOWN/UNCONFIRMED，结果继续UNVERIFIED，不把价格/计算规则补成已核实事实。

TLS测试只在当前隔离进程临时添加合成CA并恢复实际证书信任锚集合，关闭连接并删除临时私钥目录；原网络/证书验证不放宽。模型流、企业内容和最终投递接收端均为合成替身，未访问真实企业、未收费、未钉钉外发/升级真实库/部署。已将新增测试登记正式入口162文件，原测试和门槛保留；新提交CI仍需独立核对，完整一期仍未完成。

### 原生成员群事务接线补充（2026-10-19，验收绑定见独立报告）

新增独立run_native_case_audiences与nativeCaseAudience引用，分别绑定真实发起成员及审核服务凭据所有者；原run_group_audiences/run_dws_dependencies所有者外键保留。只有明确安装独立NATIVE_GROUP_CASE签名政策后，DEFAULT模式下的可信本群GROUP_CASE任务进入该链；未配置保留原服务身份路径，普通模型/企业问答不借用新凭据。SQL099执行观察要求真实RUNNING worker/fence/lease；结果复核要求同worker/fence的持久SUCCEEDED、已绑定受众和回执且仅case.read。固定截止取task/合同/scope/委托/身份有效期最小值，名单、完整目录及原消息AAD在前后分别核对。

群事务复用现有登记/精确来源去重/分派/状态/独立管理员人工确认及今日事项，不按相似标题合并不同资源；负责人声明保留UNVERIFIED待确认或合同明确允许的OWNER_REPORTED。合同监视器仅对实际GROUP_CASE走专用MVCC成员观察，普通群模型/企业问答的服务所有者治理不变；观察本身不授执行/发送权。执行仍持合同屏障并在最后发送前复核，取消/超时回滚和不可知结果不重投。实现与历史失败、最终实际noncePG/签名socket/合成投递证据以reports/native-group-participation-20261019为准，独立静态审查见reports/native-case-member-review-20261019。

源码schema契约新增至099仅为专属空白nonce数据库验证，不升级共享94或真实73；旧73→98静态迁移评审不自动涵盖099。现有trial/formal租户限制保留，已CLOSED试验不重开，真实群试点仍需独立明确授权、限定迁移与恢复验证。此切片不完成全部R14/R15、主动催办升级/历史来源或整期验收；真实费用/企业数据/钉钉外发/部署尚未执行。

### schema100独立正式群准入契约（2026-10-19）

100仅在空白nonce库验证，不安装真实授权或改写CLOSED。formal v1字段顺序/指纹保持；v2新增群目标及问题/合同/资源等审核摘要。migrator新授权仍检查原墓碑、身份、原预算或已审核预算转换，以及当前合同、有效scope、只读binding和本人/群双重资源grant。既有083/085资源管理限制不移除，既有UNKNOWN不清除。

旧12参数oa_lifecycle_admit公开包装明确拒绝GROUP批准，私有v71原体撤销应用角色执行；新14参数入口增加可信问题hash与解析的NONE/STOP类型。新formal_admissions的channel/input_hash/control_kind与原不可变元数据同等保护。延迟约束要求实际同事务的任务/run/inbox/MENTION_ONLY会话绑定，检查goal摘要、普通maxTurns≤4或STOP的0模型/0工具，并拒绝v2批准搭配旧NULL channel回执。重复消息只ACK，第二个普通问题不再准入；不会据用户自报建立任务证据。

此契约不替代执行时的合同/成员/权限/取消/发送复核，也不证明动态GROUP_MENTION名单、企业MCP、付费模型与真实平台组合已通。签名名单传输使用独立目的叶；主统一接身份、SQL和运行时，辅助只交付独立DWS传输，禁止借用H5或伪造run。

### GROUP_MENTION宿主权威与schema101（2026-10-20）

身份层在每次签名调用前后从实际SQL重建同一权威，分别核验执行租约、后台request持有者/fence和最终化历史来源，不将三种阶段混用。历史lease须逐项匹配本run/current provider session已持久化的加密最终化计划；传入一个同fence的伪造worker不能通过。固定截止取task、合同、scope、身份及后台请求/预算有效期最小值，不能靠续租延长。

101只新增oa_group_mention_contract(group,scope,version)窄元数据观察函数，验证tenant、真实serviceOwner、scope/version/群、现行question.answer合同及私有委托live状态，只返回合同五项元数据。私有委托表SELECT及live函数EXECUTE仍不给runtime，不用放宽ACL修复。群current/currentWaiting复用调用者guard事务的client读取凭据与权威；issue初检事务提交后独立观察，不与持久企业等待共持长事务。后台CompanyAgentWorker默认真实UUID，保留显式字符串worker调用兼容，新叶依旧严格校验UUID。101仅新建nonce库验证，共享94和真实73不升级。

有限迁移计划复用storage/schema.ts已验证契约和ledger matcher，要求捕获账本为完整精确前缀，目标repo契约与当前CLI一致、全部SQL未漂移，并显式给出from/to；无隐式latest或执行选项。输出区间/hash及源/目标fingerprint只绑定离线数据，未来执行器仍须现场重查和单独批准，不将计划当迁移授权。

T033精确发送时序补验（2026-10-20）：复用CLOSED新正式群授权、动态签名名单和实际合成HTTPS/MCP企业问答链。初始受私有及显式GROUP资源授权的INTERNAL企业结果通过首次生产发送来源复核后，完整名单和独立人数均新增未映射的合成外部成员；最终复核须持久化SUPPRESSED、物理发送0次、旧结果不可读且重放不重复查询或发送，UNKNOWN及CLOSED保留。场景实现映射新增company-agent-group.test.ts，完整/真实状态仍NOT_RUN；这不证明CONFIDENTIAL/RESTRICTED共享、真实企业名单或外发。旧普通澄清T033全部断言保留，因新入站SQL100依赖改用独立schema101 nonce，未升级共享94。执行结果及首次fixture失败保留在reports/t033-enterprise-timing-20261020。

运维恢复前置切片（2026-10-20，R34/T124仍未完成）：新增显式私有profile的只读restore-verification capture/compare入口，不加载.env；绑定oa_migrator、明确database/system_identifier、PG17与精确迁移前缀hash。独立repeatable-read逐行表内容摘要保留重复行、数组下界和raw JSON，核对数据库内列/表ACL、RLS/策略、视图安全选项、函数/触发器、继承/分区、序列及非secret全局角色属性。实际独立nonce的pg_dump→私有AES-GCM归档→完整认证staging→全新nonce pg_restore已有联合路径；hash MATCH不授权恢复调度/通知，必须单独核对恢复点后撤销/删除账本、CLOSED与UNKNOWN外部状态。参数预算限制接收结果量/总时限，非PG服务器或JS堆硬限；大对象、外表、订阅及未支持用户range/aggregate拒绝。组件8GiB为技术限制；FileStore整卷、WAL/PITR/KMS、保留策略、生产RPO≤15分/RTO≤60分与真实恢复仍缺验收。未访问/升级真实73或共享94，未启动worker/notifier/模型/钉钉。最终执行记录待绑定reports/postgres-restore-verification-20261020，不能以此完成一期或T124。

真实试点只读就绪入口（2026-10-20）：company-agent-pilot-readiness默认为私有profile的plan，不读连接凭据或访问数据库；inspect要求精确profile hash/review-ref，只在专用read-only repeatable-read事务核对schema前缀、指定corp/参与者、同owner及历史subject的永久CLOSED、DWS元数据布尔/版本、owner范围待对账动作和现有群绑定数量。不查询token/密文/业务正文，不解密/刷新凭据、不调用DWS/MCP/模型/消息或执行迁移，返回hash/计数且始终pilotAuthorized=false。群绑定数量不代表已解析给定数字群号或当前名单。兼容字段静态来自≤073，实际源码验证使用nonce101，真实73未核对；真实inspect仍需该目标的明确只读批准。见reports/pilot-read-only-readiness-20261020；不因此重开旧授权、完成试点或一期。


2026-10-20 群企业问答与恢复前置补验：CompanyAgentWorker 内名单观察与续租现串行，避免 FORMAL 生命周期行锁的自身竞争；独立100ms撤权监视、签名3秒/观察12秒/租约30秒/业务绝对deadline、claim/fence和发送前复核均保留。旧代码在真实signed名单返回后、原观察事务内2200ms暂停的反例确实落UNKNOWN；修复后正常续跑及取消仍UNKNOWN分别验证。精确旧5a1e CI39353980419为2417通过1失败，后续浏览器/完整需求/审计未执行；原日志不足以唯一归因，不能称旧候选通过。见reports/formal-group-renewal-repair-20261020。

复用归档与FileStore组件，新增实际自建nonce101数据库和文件根同时销毁、独立新位置恢复演练；PG内容/ACL/RLS等hash MATCH，恢复app/runtime就绪，原成果字节/单次下载/owner拒绝均经生产服务验证，CLOSED run实际acquire拒绝且outbox/delivery/UNKNOWN action不变。仅本地前置，不自动恢复外发；生产驱动、备份后撤权/擦除/外部状态对账、WAL/PITR/KMS/保留策略和生产RPO/RTO仍未完成，R34/T124未完成。见reports/operations-joint-disaster-recovery-20261020。

此前真实就绪inspect的具体一次批准已执行并消耗：明确本地目标只读事务确认schema73、指定主体登记且旧试验CLOSED匹配，项目DWS身份MISSING。只存私有脱敏回执，未读取业务正文/密文/凭据、未调用MCP/模型/DWS业务/消息，未改数据/预算/配置或部署。数字群号仍不等于已解析的canonical CID或当前名单；下一真实操作需新的具体范围批准。准确回执reports/pilot-read-only-readiness-20261020/APPROVED-READ-RESULT.json覆盖较早“未核对真实73”的历史描述，不授权升级或试点。完整一期与完整需求门槛仍未通过。


2026-10-20 单步迁移前置（R34/T124仍未完成）：新增独立 `scripts/bounded-migration-step.ts plan|apply`；默认plan不读连接凭据、不连接数据库。apply只能消费一个精确相邻迁移、完整仓库SQL/契约hash、私有连接文件hash、明确loopback目标/system identifier、审核引用与短时窗口，单连接单事务执行；原应用启动不接入该入口。预检及提交前检查账本权限、停机快照、CLOSED/UNKNOWN/撤权与角色成员关系摘要，要求全局RLS可见性，保持原权限且不自动修复漂移。取消/超时或提交前检查失败回滚；COMMIT回执不明为UNKNOWN，禁止自动重试/继续迁移/逆向SQL/恢复外发。

维护停止、备份、密钥恢复、语义审核及外部状态对账引用只是操作方声明，入口不把这些声明认证为完成证据，也不代替具体真实操作批准。停机查询是瞬时观察，不保证其他进程随后无法重连；真实执行仍须独立维护控制及经验证备份恢复。仅独有nonce94上实际逐步095–101安装及失败场景验证，不宣称实测真实73或所有074–094步骤。真实73、共享合成94、旧CLOSED、权限/凭据/预算及服务配置均未改动。证据见reports/bounded-migration-step-20261020；生产备份驱动、备份后撤权/擦除/外部状态对账、WAL/PITR/KMS及RPO/RTO、真实试点仍缺验收。


2026-10-20 企业问答MCP默认选择按用户明确变更使用 `.env` 的 `AIDER_AI_DD_CHAT_MCP`：审核pin省略endpointKey时规范化为该键；历史显式 `AIDER_AI_DD_MCP` pin保留精确选择。默认键缺失时返回不含值的明确配置错误，不回退到另一个服务；无审核policy仍保持未接入。服务、工具与schema/hash、token绑定和原权限/窗口/取消/UNKNOWN机制不变，不读取或修改现场私有policy、不发起真实调用。实际SDK与本地TLS合成上游回归见reports/company-agent-default-chat-20261020。该默认不代表真实MCP已发现或试点获准。


### 原生私人工具草稿实际接线（2026-10-20）

R22 新增正常 DEFAULT 运行模式的 artifacts.create 实际 Gateway/worker 接线，复用八格式渲染与既有 H5 鉴权下载。TOOL_DRAFT 始终 UNVERIFIED；渲染、格式检查与下载均不证明事实、外部来源或动作完成。真实任务/租约/持久 action 绑定加密来源快照，覆盖上下文、人设、个人记忆、附件与其他工具证据；查询、票据和最终字节释放重核当前来源。SQL102仅在独立 nonce 库安装，取消/隐私擦除同事务清除新增证据副本，之后受限清理文件；UNKNOWN保留可能已发布文件，重复不重新生成。TRIAL/FORMAL及群聊不继承此私人能力，无新授权、外发、迁移或部署。

实际本地 API/PG、原生模型流替身及桌面/手机页面已覆盖原有结果与私人草稿下载、源撤销、取消、隐私擦除和不明提交。T100 复用实际 CSV/ExcelJS 字节回读防公式证据；T102 绑定实际转发后拒绝和原权限撤销场景。T101 的完整文档打开/视觉验收、审核 Unicode 字体、上传输入/分析与其余 R22 仍未完成；测试目录映射不将 NOT_RUN 变成真实验收。准确源码指纹、执行结果和失败记录见 reports/native-artifact-host-20261020/HANDOFF.md；当前批次的新提交 CI 须单独核对。


### 群升级持久来源与发送契约（2026-10-20，schema103隔离实现）

103_group_case_escalations.sql保存不可变principal/session/epoch、事项及payload版本、合同hash/version、source/context/intent/preview摘要与密封proof；请求幂等账本绑定operation与原请求。PREPARED→QUEUED→CLAIMED只领取一次；开始前可CANCELLED，CLAIMED仅到SUPPRESSED/APPLIED_UNVERIFIED/FAILED/UNKNOWN，在途取消转UNKNOWN；不明或已领取不回到可领取状态。原CLOSED/formal租户屏障保留，本切片不提供真实试点资源bootstrap。

预览60秒；新的运行profile限单target、120秒窗口、1次通知、0模型、无@all/私信，精确schema和proposal/preview/contract pin。有限runner最多30秒，短事务锁1秒/语句2秒及独立连接3秒边界，取消后不得待锁释放再提交claim。stage创建独立GROUP_ESCALATION、0model/tool且BUILTIN_ONLY run，默认notifier排除；发送oracle核对原H5会话及当前合同、来源、名单、task/run/body/outbox并在冷token后再次核验。没有模型或人设借此扩权。

升级预留计入原提醒usage/send_usage；新升级另限同事项24小时/同群小时的严格上限，全部owner/合同版本和未决状态计数，取消不退款。只读DELIVERY_STATUS仅原会话最小元数据，UNVERIFIED/physicalDeliveryVerified=false，源撤销后不回显旧preview/正文或provider ID。接口与实际隔离证据见reports/group-case-escalation-core-20261020；真实schema73与共享94未迁移。

### 有限私人企业试点持久边界（增量104）

`finite_private_pilots`绑定实际CLOSED lineage、精确formal文档、原DM、问题及企业/模型配置摘要。稳定pilotKey为SHA256(`FINITE_PRIVATE_ENTERPRISE_PILOT_V1:`+lower(tenantId)+`:`+lower(actorId)+`:`+sourceTrialProfileHash+`:`+questionHash)，不含profile/formal/budget/request/session ID。注册主体不自动降级为普通无限formal；持久计数和dispatch墓碑禁止删除、回退、替换或因取消/NOT_SENT退款。现有货币/token预留与UNKNOWN继续独立保留，模型task生命周期货币硬限必须不超过声明CNY额度。

实际14参数准入追加精确问题和单次约束，12参数旧入口对已登记有限主体拒绝缺失hash的准入；延迟约束核原event/inbox/task/run。模型quota_ledger真正进入DISPATCHING时、企业请求真正进入DISPATCHING时分别原子扣永久slot，正式授权/lease/权限/来源屏障继续有效。sender两个机器人POST出口在最后来源复核后原子取得一次MESSAGE slot；最终必须属于原run终态SUCCEEDED/PARTIAL且原企业请求确实RESPONSE_RECEIVED，澄清/选源不冒充终态。提供方接受仍APPLIED_UNVERIFIED，物理送达/阅读不宣称已验证。

STOP先在一事务提交永久veto，再用独立事务复用原task取消；不跨pilot锁持有task/run锁。第二步失败不ACK，veto仍阻止出口。企业completion仅可凭未被替换/恢复的同worker/fence做收尾；失去租约/截止或当前来源的答复只能丢弃并记UNKNOWN，不能保留正文或重新派发。其他load/renew/beforeDispatch仍需活租约。104只安装结构，真实库73/共享合成94未升级。


2026-10-20 原生备份执行切片（R34/T124仍未完成）：新增独立 `scripts/project-backup.ts plan|backup`（`pnpm operations:backup plan --profile <私有配置绝对路径>`）；plan仅读取私有审核profile并输出摘要，既不读连接/密钥也不连接数据库。backup入口固定现有项目目标并核对精确profile/review/时间窗，使用受审本机PG17客户端、只读held snapshot、独立前后完整inventory、分离密钥的PG/FileStore加密归档，最后才写独占并同步的set回执。总时限覆盖私有输入读取；取消等待直属子进程与归档清理，回执身份来自创建FD，关闭或清理无法确认时明确COMMIT_UNCERTAIN，不覆盖、重试或自动恢复服务。原生恢复内部入口完整认证归档后仅作用于独立预建空库，核目标OID/系统身份并使用一次single-transaction pg_restore及完整inventory比较；它尚未接完生产恢复profile/CLI、恢复点后撤权/删除及外部状态对账。ACL比较将NULL规范化为PG有效默认ACL，保留完整grantor/grantee/权限选项、列ACL及RLS漂移检测。隔离合成schema73 nonce与本机17.11已有实际备份/恢复验证；这不证明真实项目备份、独立集群、WAL/PITR/KMS或生产RPO/RTO完成。真实73和共享合成94均未升级，真实MCP/模型/投递/部署没有新增执行。准确源码指纹及最终批次证据见 `reports/project-backup-driver-20261020/`。


2026-10-20 恢复命令接线补充（R34/T124仍未完成）：`scripts/project-restore.ts plan|restore` / `pnpm operations:restore` 已复用原生认证恢复与FileStore恢复组件。审核配置固定set回执SHA、源schema/集群/数据库与备份profile摘要、两个归档及分离密钥、全新预建目标库OID/集群/连接文件hash、独立文件恢复目录、工具摘要和有限时间窗。私有回执严格解析并交叉绑定，实际FileStore认证回执匹配后才进入PG完整认证，再连接目标；拒绝真实项目/共享测试库/源库作为恢复目标，不创建库或全局角色。任一阶段失败不会重试或覆盖已恢复目标，密文文件保留隔离以便明确核对；取消/超时由总时长与绝对validUntil共同截断，已提交结果不伪称撤回。成功输出`RESTORED_SET_RECONCILIATION_REQUIRED`且禁止恢复服务/外发，应用主密钥恢复仍未验证。隔离验收覆盖真实CLI在销毁自有源库/文件后的同一合成集群新库恢复、错目标/混档、重复、权限配置拒绝、实际文件读取超时与目标连接后取消，执行结果以本批报告为准；这不等于独立集群、恢复后撤权/删除对账或生产RPO/RTO完成。源码和准确执行记录见 `reports/project-restore-command-20261020/`。


## 2026-10-20 恢复后安全差异检测（局部实现）

新增 compareRecoverySafety(current,restored)，复用 validatePostgresInventory/comparePostgresInventories，保留原比较返回契约。所有表/序列按(schema,name)比较，重复键拒绝；migrationCount 也参与 schema 门槛。NO_DIFFERENCE_OBSERVED 仅为输入摘要无差异，DIFFERENCE_REQUIRES_RECONCILIATION 为需核对；added 表示恢复侧独有，missing 表示 current 侧独有。current 是调用方标签而非可信新鲜性证明，externalDispatchResumeAuthorized/currentAuthorityFreshnessVerified/safetyFactsReplayed 恒 false，revocationAndExternalStateReconciliationRequired 恒 true。

2026-10-20 有界迁移执行合同补充：planBoundedMigrationStep(raw, signal?)传播取消并对104份SQL/契约准备累计单调预算，plan允许过去/未来执行窗作检查，不读连接或授予执行。apply复用一次lifetime而非为准备/连接/事务重置预算，截止取maxDuration与validUntil剩余较小值，PG超时使用剩余额度；本次Socket由执行器独占。工作结束前停止后续SQL，清理最多另1秒确认end/close，UNCONFIRMED及末尾overrun独立于COMMIT知识，CLI不得将其当成功。CLI必须先读取有界私有profile才能得知其预算，读后复核取消；已开始的本机文件系统操作仍须settlement后检查，未承诺OS系统调用硬实时中断。本地连接关闭不证明外部业务结果或恢复授权，CLOSED/UNKNOWN及撤销摘要保护未减。

2026-10-20 独立恢复测试契约：固定PG镜像、随机自有容器name/label/full ID；network=none、无host bind/端口、只读根，数据tmpfs为noexec，仅私有runtime子挂载exec，实际读mountinfo复核。通过docker exec stdin写入且重核hash，不挂载工作区/.env/.secrets。内部仍用原test-network-guard与127.0.0.1:64711，端口相同但网络命名空间与PG系统均独立；原护栏未放宽。官方Node24.21.0双架构归档与提取bin均固定SHA，缓存私有并再验证ELF/架构/字节，SHA校验不冒称发行签名验证；test:prepare只增加公共运行时准备，应用运行时不接入新容器。
