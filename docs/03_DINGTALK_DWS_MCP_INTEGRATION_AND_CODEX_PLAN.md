# anthys｜03 外部接入、配置与 Codex 实施计划

实施补充（2026-10-18，接管进行中）：群事务生产入口为 /api/v1/groups/:id/cases 的 GET/POST/PATCH 与工作台页面，依赖当前会话、独立审核群合同及该合同明确列出的 case.read、case.create、case.update；case.owner_reported 为独立显式选择，缺省不启用。工作台卡片需本人明确共享，@ 来源需绑定本人的真实持久入站任务，不采信客户端提供的正文身份。代码升级和迁移不创建任何真实群委托或主动发送授权。

087/088 仅在64711合成环境增量应用。真实库此前确认仍为73，不能以测试准备器或源码版本推定真实升级。旧本人试验仍永久 CLOSED；企业业务数据库直连继续二期，经既有企业MCP的数据问答按最新调整纳入一期；平台 PostgreSQL、文件/分析和其他一期要求保留。组合 MCP 测试使用实际 SDK 的配置/发现/调用与合成 HTTP/原生 SSE，不使用真实企业密钥、模型费用或外发；真实部署/版本对应关系不据此认证。

版本：1.0.0　事实核实日期：2026-10-14　依赖：文档 01、02。所有接入必须形成真实适配器、测试 fixture、错误归一化与验证报告，不得用提示词代替。

## 1. 先区分已知事实与待企业提供的信息

### 1.1 已核实

- 智谱官方公开了 `glm-5.3-flash`，支持原生思考、Function Calling、流式和多模态输入；输出是文本，不能据此宣称自带语音通话或图像生成。[S01]
- 钉钉有官方 Node Stream SDK、应用机器人接收与发送能力、互动卡片和流式更新能力。[S04][S05][S06]
- 官方资料列出了机器人发送与卡片相关权限点；官方权限错误可能提供 `requiredScopes`，可用于诊断。[S07][S08]
- DWS 官方仓库提供用户授权、身份 profile 和命令发现等机制；命令与授权仍须针对实际安装版本验证。[S09][S10]
- 公司“已有 MCP 可查询代码与日志”是用户给定条件，不是本次已经读取或验证的系统。

### 1.2 当前没有、不得捏造的外部输入


| 归属           | 需要提供                                                      | 对开发的影响                                |
| ------------ | --------------------------------------------------------- | ------------------------------------- |
| 钉钉管理员        | 测试企业、corpId、clientId/secret、robotCode、应用可见范围、卡片模板、H5 域名配置 | 可先实现 mock；真实验收必须提供                    |
| DWS 管理员/试点用户 | CLI 开通、适用登录模式、用户/服务身份授权、允许的群与产品                           | 未提供时状态为 WAITING_AUTH/BLOCKED_EXTERNAL |
| 公司 MCP 维护人   | 地址、transport、认证、协议版本、工具 schema、资源授权、脱敏规则、限流               | 不猜工具名，不尝试未登记内网扫描                      |
| 数据部门         | 至少 3 个认证模板、数据接口/只读账号、金标数据与口径                              | 先用测试 fixture，不冒充真实统计                  |
| 模型管理员        | 官方 API key、商业使用/数据出域授权、可用模型与并发配额                          | 没有 key 不做真实模型验收                       |
| 运维/安全        | TLS 域名、secret 管理、备份位置、企业隐私/留存规则                           | 本地开发不阻塞，生产发布受阻                        |
| 搜索服务         | 允许使用的搜索提供商、凭据、外网出口                                        | 无提供商时不能声称实时联网搜索                       |


Codex 不应为这些未知值填“看起来像真的”默认值。应完成所有独立可开发内容，生成明确阻塞清单。需要人登录或批准的步骤由授权人完成，不能从代码中绕过。

## 2. 钉钉应用创建与配置



### 2.1 应用形态

创建企业内部应用 `anthys`，添加机器人能力，并配置 H5 微应用作为个人中心/管理入口。默认使用 Stream 接收消息和适用事件；HTTP 回调作为可选部署方式。Stream 降低消息接入的入站网络要求，但 H5/OAuth/成果下载仍需钉钉客户端可访问的 HTTPS 地址。[S05][S19]

`clientId` 对应应用凭据的 Client ID/AppKey；`robotCode` 从机器人配置读取，作为独立字段，不假定与 clientId 相同。内部用户 ID 与钉钉各种外部 ID 通过身份服务转换。

### 2.2 管理员操作顺序

1. 创建测试应用并限定可用范围为试点用户。
2. 添加机器人，选择 Stream 模式，配置机器人基本信息。
3. 按功能包申请最小权限，配置机器人单聊/群聊及需要的事件订阅。
4. 配置卡片模板及回调；创建可供测试的内部群。
5. 配置 H5 首页、OAuth/免登回调、可信域名与必要 IP 范围。
6. 发布应用版本；验证单聊、群 @、卡片回调和 H5 登录。
7. 独立开通 DWS CLI 并完成试点身份授权。
8. 在 anthys 能力中心运行非破坏检查，记录各能力状态。
9. 通过真实联调后逐步扩大应用可见范围，不首次就向全公司群发。

界面菜单名称可能变化，以实际控制台为准。不能把其他应用或 OpenClaw 快捷创建流程中的“自动获得权限”当作手动创建 anthys 已自动授权。[S08]

## 3. 权限中心：从“勾权限”变成可验证状态



### 3.1 首批权限映射种子

这是官方资料中可定位的权限点种子，不是包含所有 DWS/钉钉事项的通用权限包。每个具体 endpoint 仍须核对适用应用类型、授权模式及资源范围。[S07][S08][S20]


| 功能包         | 已核实的权限点/名称种子                                 | 验证方式                 |
| ----------- | -------------------------------------------- | -------------------- |
| 机器人消息       | `qyapi_robot_sendmsg`，企业内机器人发送消息             | 经同意向测试单聊/群发送，并核对外部结果 |
| 互动卡片        | `Card.Instance.Write`                        | 测试卡片创建、投放、回调         |
| AI 卡片流式更新   | `Card.Streaming.Write`                       | 更新测试实例并最终完成，不刷生产群    |
| 登录用户个人信息    | `Contact.User.Read`                          | 当前身份查询；不等于全企业通讯录     |
| 用户手机号       | `Contact.User.mobile`                        | 默认不申请，仅业务必要时单独授权     |
| 企业通讯录/部门    | 按真实目录 endpoint 的权限清单；不能用个人信息权限替代             | 测试部门、测试员工，验证可见范围     |
| 待办          | `Todo.Todo.Read`、`Todo.Todo.Write`           | 自己的测试待办创建/读回/清理      |
| 日程          | `Calendar.Event.Read`、`Calendar.Event.Write` | 指定测试日历读写             |
| 忙闲查询        | `Calendar.EventSchedule.Read`                | 使用允许查询的测试人员          |
| 文档/钉盘/AI 表格 | 由 endpoint 文档和 DWS 版本生成精确映射                  | 只访问专门测试文件/表          |
| 群资料/历史/管理   | 根据实际通道与登录身份逐操作核实                             | 区分成员列表、历史读取与管理权限     |
| 审批/报告/纪要/考勤 | 按企业所选产品逐操作核实                                 | 默认关闭敏感写入             |


模型不得自己编造 `Chat.All.Read` 等貌似合理但未核实的 scope。DWS 通过 CLI 产品授权或用户委托实现的能力，不强行填成某个自建应用的 scope。

### 3.2 PermissionManifest

Codex 在 P00/P02/P06 生成机器可读 `permission-manifest`。结构如下：

```json
{
  "schemaVersion": "1.0",
  "capabilityId": "dt.card.stream.update",
  "provider": "DINGTALK_API",
  "authMode": "APP",
  "applicationType": "ENTERPRISE_INTERNAL",
  "requiredScopes": ["Card.Streaming.Write"],
  "resourcePreconditions": ["authorized_card_instance", "app_is_published"],
  "officialDocRef": "S06",
  "verifiedAt": "2026-10-14",
  "liveVerification": "NOT_RUN",
  "probe": {"kind": "NON_DESTRUCTIVE_OR_CONSENTED_SANDBOX", "fixtureRequired": true}
}
```

manifest 只说明所需条件，不表示已获得授权。状态按 `(tenant, app, executionIdentity, capability, resourceScope, authEpoch)` 保存。A 可以读自己的日历不代表 B 可用，某文件成功不代表全库成功。

### 3.3 诊断流程

`配置存在 → 凭据可解析 → token/身份有效 → 应用发布/可见 → 权限/委托 → 资源前置条件 → 合法探测 → 业务结果核验`。

可以使用只读探测、官方授权信息和真实错误来识别缺口；本次没有核实一个能对所有应用类型完整列出一切授权的万能接口，因此不要虚构“获取全部已授权 scope”API。无法准确判断时返回 UNKNOWN，而不是推断全部开通。

统一诊断原因：

```text
MISSING_APP_SCOPE | USER_CONSENT_REQUIRED | CLI_NOT_ENABLED |
IDENTITY_MISMATCH | RESOURCE_DENIED | APP_NOT_PUBLISHED |
OUT_OF_VISIBLE_RANGE | TOKEN_EXPIRED | CAPABILITY_NOT_AVAILABLE |
RATE_LIMITED | NETWORK_ERROR | PROVIDER_ERROR | UNKNOWN
```

官方错误中的 `accessdenieddetail.requiredScopes` 经白名单解析后可以显示对应缺失权限，保留 requestId 便于排障；不能将所有 403 都归因于缺少 scope。[S07]

### 3.4 用户界面

示例：

```text
创建钉钉日程：需要补充授权
当前执行身份：员工甲（本企业）
已通过：身份有效、目标日历存在
缺少：个人委托未完成
下一步：[个人授权] [查看说明]
最近检查：2026-10-14 09:30 Asia/Shanghai
```

管理员看到应用权限补充指引；普通用户看到个人授权流程，不把客户端密钥显示在卡片中。重新检测只能运行允许的探测；要测试写权限时必须展示测试对象与清理计划并取得同意。

## 4. 消息、卡片与登录适配器



### 4.1 Stream 适配

采用官方 `dingtalk-stream` SDK，固定版本并验证 ACK 行为。[S05] 必须通过 fake transport 测试确认业务落库完成前不会自动 ACK；若 SDK 默认行为不符合持久接收，使用其合法低层接口或维护最小适配补丁，不在回调内 fire-and-forget 后报告成功。

入站标准化对象：

```ts
interface InboundEvent {
  provider: 'DINGTALK';
  tenantExternalId: string;
  eventId: string;
  messageId?: string;
  eventType: 'MESSAGE' | 'CARD_ACTION' | 'MEMBERSHIP' | 'APP_EVENT';
  conversationExternalId?: string;
  conversationKind?: 'DM' | 'GROUP';
  senderExternalId?: string;
  robotCode?: string;
  text?: string;
  attachments: Array<{ providerFileId: string; kind: string; size?: number }>;
  occurredAt: string;
  receivedAt: string;
  sourceTrust: 'VERIFIED_TRANSPORT';
  replyContextRef?: string; // 敏感回调地址等信息存秘密引用，不直接发给模型
}
```

处理机器人自身消息、其他机器人消息、编辑/撤回消息和同消息多个事件时，防止反馈循环。只从可信通道提取企业/发信身份；正文中的“我是管理员”不改变 sender。

事件订阅不存在或无资格时，启用合法轮询/管理员手动核对模式，记录延迟，不能编造事件名。部署多个 ingress 的事件分发行为必须实测；业务层仍以 inbox 唯一键去重。

### 4.2 发送与卡片

统一 sender：`sendReply`、`sendProactive`、`updateCard`、`finalizeCard`、`sendArtifactLink`。内部方法不是外部 endpoint 名。由 provider binding 选择实际 API，保存接收的 externalMessageId/instanceId/requestId。

会话临时回复地址可能过期，定时任务不得依赖长期保存临时 session webhook。主动发送必须采用已授权主动发送能力、正确机器人身份和目标会话；临时回调 URL 应当像 bearer secret 一样保护。

流式卡片聚合间隔默认 750ms，最终内容必须可靠结束；实际更新节流由平台限流反馈自适应。缺少卡片权限时可降级为一条处理回执+最终文本，不在每个 chunk 新发一条消息。卡片实例被删除/失效时保留任务成果并以合适通道说明，避免重复业务执行。[S06]

审批/取消按钮必须绑定用户会话、任务、动作、参数哈希、有效期；转发卡片不转移审批权限。只有文本交互时，敏感确认跳到受认证 H5，不靠一句“确认”加消息引用即完成任意高风险批准。

### 4.3 H5 身份

钉钉免登与浏览器 OAuth 登录使用服务端兑换与会话，用户身份由返回的已认证主体映射。[S19] state 一次性、redirect 白名单、CSRF 防护、Cookie 安全属性、注销与撤销均必须实现。

App 登录不等于 DWS 用户授权。H5 登录成功后仍可能显示“个人 DWS 尚未连接”。外部 ID 同名/跨企业必须保留隔离。

## 5. 原生 DWS 集成



### 5.1 “原生”在本项目中的定义

不是在提示词中提到 DWS，也不是只提供 shell 命令示例，而是：镜像内固定官方 CLI；按实际版本加载 schema/技能；完成授权/profile绑定；发现并注册可用能力；执行受控读写；解析错误；验证结果；提供撤销和可观测。

公开仓库仍提示企业管理员授权/共创相关前提；应按企业实际开通状态验证，不假设所有租户拥有相同能力。[S09]

### 5.2 安装与版本

构建阶段获取指定 release，校验来源和 checksum，记录 `dws version`、平台架构、release/hash；生产镜像不能启动时执行在线 install/upgrade。官方说明 Linux 二进制基于 glibc，因此 DWS runner 选 Debian 系，不能直接假定可在 Alpine/musl 运行。[S09]

P00 生成版本锁定记录：cliVersion、binarySha256、platform、schemaHash、skillBundleHash、license、verifiedAt。CLI 或 schema 变化触发增量安全审查和回归，不能用 `latest` 漂移。

### 5.3 身份隔离和无头授权

官方有无头设备登录与精确 profile 的能力；按锁定版本完成适配。[S09] 每个 `(tenantId, executionIdentityId)` 使用隔离 HOME/配置/凭据空间，目录 0700、文件 0600，加密持久化，只在 runner 使用时解密必要数据。不能仅隔离 `~/.dws` 而遗漏实际凭据存储位置；P06 要验证该版本全部配置/密钥路径。

每个调用固定精确 `corpId:userId` profile，不能用“当前默认账号”或模糊组织名字。身份绑定由官方返回信息确认；用户不得提交他人的 profile 字符串冒领身份。

无头流程：当前用户打开 H5 → 创建短期授权 session → runner 发起官方 device flow → 只向该用户显示验证入口/码 → 轮询有时限 → 校验实际登录 corp/user 与预期绑定 → 加密保存 → 清理临时状态。禁止收集用户密码，禁止把验证码发送到群，禁止将设备码解释成 access token。

DWS 的服务身份必须是企业批准且平台允许的真实身份。平台不支持所需非人身份模式时标记阻塞；不得批量注册假员工或借用领导账号规避。

### 5.4 命令发现与执行

可参考并在固定版本验证的发现/只读命令如下；它们不是授权成功证明：

```bash
dws version
dws schema aitable --compact
dws schema "aitable record query" --compact
dws contact user search --help
```

DWS 官方区分命令 help 与 schema，schema 发现不等于执行业务查询。[S09] 本项目 registry 保存逻辑能力与真实 CLI 参数绑定，不把旧命令索引当作永久 API。

执行器只允许：固定绝对路径二进制 + 审核命令叶子 + 强类型参数 → `spawn/execFile` 数组参数，`shell:false`。模型不接收裸 argv 控制权；禁用可覆盖 token/clientSecret/profile 的参数、任意文件输出路径、mock/debug、跨域 endpoint、动态升级命令。

```ts
interface DwsInvocation {
  capabilityBindingId: string;
  identityId: string;
  validatedArgs: Record<string, unknown>;
  approvalRef?: string;
  idempotencyKey: string;
  deadlineAt: string;
}
```

Runner 重新验证签名、短期任务委托和 identity；参数中的字符串不得作为新 flag 解释。使用固定 cwd、最小 env、输出字节上限、超时/中止、进程组清理。命令输出遇到交互要求时返回 NEEDS_AUTH/NEEDS_APPROVAL，不无限等 stdin。

`--yes` 仅在该命令正式支持且本系统已得到相应合法批准时由 runner 加入；不能跳过 DWS/平台要求保留的人类确认。`--dry-run` 只在命令支持时预览，不能默认所有命令支持或视为真实写入。

### 5.5 产品能力覆盖矩阵

下列是本项目要实现的适配面，不保证所有企业全部可用。具体命令名在锁定版本从 schema 获取。[S10][S11]


| 产品域     | 首批支持动作                      | 执行规则与结果核验                        |
| ------- | --------------------------- | -------------------------------- |
| 联系人/组织  | 查自己、搜人、搜部门、成员列表             | 范围最小化、同名澄清、敏感字段默认不取              |
| 群/消息    | 群资料/成员、授权历史/搜索、机器人发送、可选用户代发 | 明确身份；历史覆盖/截断；用户代发另授权             |
| 群管理     | 创建项目群、修改资料、按授权添加成员          | 预览与成员校验；移除/解散默认禁用                |
| 待办      | 列表/读取/创建/更新/完成              | 本地 task 与 externalTodoId 分开、读后验证 |
| 日历      | 查询、忙闲、候选、创建/更新/取消           | 时区/冲突/参与者检查，写前预览                 |
| 文档      | 搜索、读取、创建、受控编辑               | 版本/定位/权限确认，冲突不整篇覆盖               |
| 钉盘      | 列表、读取/下载、上传、目录内组织           | 文件 ACL；公开链接默认禁止                  |
| AI 表格   | 结构查询、记录读取/新增/更新、图表与报告       | 类型校验、资源版本、批量上限、读后验证              |
| 审批      | 流程/实例查询、草稿/提交               | 审批结论代签默认禁止                       |
| 报告      | 查询、生成草稿、经批准提交               | 不捏造个人工作内容                        |
| 会议纪要    | 查询、阅读、摘要、提取事务               | 只处理授权纪要，不默认录制会议                  |
| 考勤      | 本人记录或授权聚合                   | 不自动打卡、不做人事处分                     |
| DING/公告 | 受控提醒/发布                     | 配额、目标和权限独立；避免轰炸                  |
| 邮件/白板等  | 发现后按认证 binding 扩展           | 没有已验证 binding 时显示不可用             |


批量查询必须处理所有合法分页游标，或显式声明停止/截断；模型不能将第一页当全部。分页不能无限扫全公司，须同时服从任务范围、隐私和预算。

### 5.6 群历史增强模式

只有真实验证了历史/搜索能力、执行身份有权访问该群、群合同允许、成员告知完成后，才启用 `AUTHORIZED_HISTORY`。群摘要输入携带 source、from/to、cursor覆盖、gaps、truncated、observedAt。

P06/P10 必须测试：无授权群不可读；撤销个人授权立即阻止读取；用户 A 的 DWS 凭据不被 B 复用；非 @ 消息未覆盖时摘要会说明；命令存在但上游不开放时显示 BLOCKED_EXTERNAL。

### 5.7 凭据更新和撤销

刷新动作按身份加锁，避免多进程 refresh 竞争造成令牌失效。原始凭据不写 argv、不写普通 env dump、不进任务 payload；若官方 CLI 只支持某敏感配置方式，采用隔离 secret mount/最小进程环境并做日志测试，不擅自发明 CLI flags。

用户断开时吊销本系统委托并停止任务；若官方支持远端撤销则调用并核对，否则明确“本系统已移除访问，平台端授权需按指引撤销”。删除本地密钥不能冒称已撤销提供商全部授权。

## 6. 公司 MCP 接入



### 6.1 接入输入合同

```ts
interface CompanyMcpRegistration {
  name: string;
  transport: 'STREAMABLE_HTTP' | 'SSE_COMPAT' | 'STDIO_ISOLATED';
  endpointRef?: string;
  protocolVersions: string[];
  auth: {
    mode: 'OAUTH' | 'MTLS' | 'API_KEY';
    secretRef?: string;
    actorPropagation: 'UPSTREAM_ENFORCED' | 'SCOPED_PROXY';
  };
  allowedResources: string[];
  environments: Array<'TEST' | 'STAGING' | 'PRODUCTION'>;
  maxConcurrent: number;
  timeoutMs: number;
  ownerContact: string;
}
```

先 initialize/协商，再读取工具列表和实际 schema，生成 schemaHash。MCP 协议版以双方协商为准；不能盲目强制最新版本。远程认证按官方规范处理 issuer、audience、token 绑定及授权流程，禁止任意 token passthrough。[S12][S13]

### 6.2 语义能力绑定


| 本项目语义能力                  | 最低输入要求                                      | 最低结果要求                                          |
| ------------------------ | ------------------------------------------- | ----------------------------------------------- |
| `company.code.search`    | repo/service、keyword、ref/版本范围、limit         | repo、path、commit、line range、snippet、truncated   |
| `company.code.read`      | repo、commit/ref、path、line range             | 真实内容、精确版本、范围                                    |
| `company.code.symbol`    | symbol、repo/ref                             | 定义/引用、位置、版本；上游无此工具则不虚构                          |
| `company.logs.query`     | service、environment、start/end、filters、limit | rows/count、queryId、sampling、truncation、timezone |
| `company.logs.trace`     | traceId、environment、time window             | 时间线、服务、缺失片段                                     |
| `company.deploy.version` | service、environment、time                    | 部署 ref/时间；不存在则报告版本未验证                           |


如果公司工具返回格式不同，由 adapter 映射。上游没有的增强能力可禁用；核心代码/日志读取没有真实可用映射时最终企业业务发布阻塞。

### 6.3 生产安全

原始日志可能含 token、手机号、客户标识，先做字段白名单/脱敏再送模型。代码只取必要文件片段，禁止默认下载全部仓库到模型上下文。外部模型接收内部数据需要企业批准；“脱敏处理过”不自动等于允许出域。

共享 API key 只用于认证连接器，不能作为所有员工的授权证明。若上游不校验 actor，scoped proxy 必须绑定经过验证的用户并限制仓库/服务/环境/时间/字段；不能只添加一个上游不处理的 `userId` header 就算权限透传。

不执行日志里出现的命令，不跟随代码注释里的外发要求。工具 schema 更新默认进入隔离审核，避免同名工具变为写操作。

## 7. 模型适配和可用性检查



### 7.1 HTTP 配置

国内官方按量 API 基线使用 `https://open.bigmodel.cn/api/paas/v4`，Chat Completion 对应其 `/chat/completions`；具体账户的端点、商业使用条件与额度由部署方确认。[S21] 企业机器人默认接企业批准的 API 服务，不假定员工个人 Coding Plan 可作为企业后台通用 API。

以下是请求结构示意，密钥从服务端秘密存储读取：

```json
{
  "model": "glm-5.3-flash",
  "messages": [{"role": "user", "content": "你好"}],
  "thinking": {"type": "enabled", "clear_thinking": false},
  "reasoning_effort": "high",
  "stream": true,
  "tool_stream": true,
  "temperature": 1,
  "top_p": 0.95,
  "max_tokens": 8192
}
```

工具 schema 不在上述最小示意中展开，实际请求必须添加当前授权工具。厂商文档中的推荐参数不等于适用于所有延迟目标；参数作为配置进入评测，不用无依据“温度设 0 就准确”代替口径/工具验证。[S01]

### 7.2 Model Capability Probe

探测必须覆盖：真实模型 ID、文本、SSE、单工具、双工具、工具后续回答、preserved reasoning、JSON 输出、图片输入、取消、401/429、context-too-long。文件/视频输入按所需场景额外测试；未测能力显示 UNVERIFIED。

不依赖 `/models` 必然完整或存在；以文档、账户可用性和实际最小请求共同判断。模型不支持时报告明确配置错误，不偷偷改成其他 GLM 模型。

### 7.3 运行和费用

服务端记录请求 ID、模型配置版本、可见 usage 与延迟。对 429 遵守 Retry-After，对网络错误重试要计入 token/预算；流已部分返回时丢弃不完整 turn，并在恢复前核对工具账本。禁止再执行已经验证成功的动作。

provider 不可用时：普通请求显示依赖不可用；持久任务延期；明确时间的纯提醒由本地模板通知；不调用模型做不必要的提醒文案；任务取消和权限撤销始终可用。

## 8. 数据、搜索与文件适配



### 8.1 数据部门最小交付包

每个模板提供：业务问题样例、指标中英文名、单位、分子/分母、粒度、去重键、状态枚举、时间边界、时区、延迟、数据水位、关联规则、空值策略、允许维度/筛选、角色与行范围、执行协议、超时/限流、金标输入输出、owner与版本。

首批建议选 3 个便于核验的内部模板：日指标趋势、按维度排名、异常率/成功率。名称仅是建议，实际用公司指标替换。每个至少 5 组金标案例，包括边界、空数据、权限过滤、截断和数据延迟。

接入 UI 支持 JSON 上传与校验、参数试跑、结果核对、发布审批、回滚。密钥不写在模板内，只引用受控 connection。

### 8.2 SearchProvider

统一 `search(query, filters)` 和 `fetchAuthorizedPage(resultRef)`；搜索 API 的真实 URL/key 由管理员注册。返回 title、url、snippet、publishedAt/updatedAt（存在时）、retrievedAt、sourceType。打开页面受网络策略约束；过期、不支持日期或无结果时明确显示。

企业搜索不能以公网 fallback 发送原始内部 query。可经策略允许用脱敏的通用技术关键词联网，且不附上源代码和客户数据。

### 8.3 附件与成果

钉钉附件 ID 先通过已认证官方 API 获取内容/授权下载入口，不认为聊天中出现的任何 URL 都可信。[S22] 下载必须限流、验大小、验 MIME、解压限制、去路径穿越、恶意扫描。

本项目提供确定性的生成适配器：CSV/JSON/Markdown、XLSX、DOCX、HTML/PDF。各库在 P00 锁版本，不在运行时安装。输出经过数字/引用/结构/渲染验证后再发送；部分失败时允许交付成功格式，但必须标注其余格式失败。

## 9. 配置合同

所有变量是本项目变量，不是声称上游软件原生支持同名环境变量。秘密优先 `_FILE`，读取后不能出现在健康页或异常堆栈。

```dotenv
APP_NAME=anthys
APP_ENV=development
APP_ORIGIN=https://anthys.example.invalid
RELEASE_PROFILE=BASE
DEFAULT_TIMEZONE=Asia/Shanghai
DEFAULT_LOCALE=zh-CN

DATABASE_URL_FILE=/run/secrets/database_url
QUEUE_DATABASE_URL_FILE=/run/secrets/queue_database_url
APP_MASTER_KEY_FILE=/run/secrets/app_master_key
SESSION_SECRET_FILE=/run/secrets/session_secret

DINGTALK_CORP_ID=
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET_FILE=/run/secrets/dingtalk_client_secret
DINGTALK_ROBOT_CODE=
DINGTALK_INGRESS_MODE=stream
DINGTALK_CARD_TEMPLATE_ID=

GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-5.3-flash
GLM_API_KEY_FILE=/run/secrets/glm_api_key
GLM_REASONING_EFFORT=high
GLM_MAX_OUTPUT_TOKENS=8192

DWS_ENABLED=false
DWS_BINARY_PATH=/opt/dws/dws
DWS_VERSION_LOCK_FILE=/app/config/dws-version-lock.json
DWS_RUNNER_URL=http://dws-runner:8091
DWS_RUNNER_AUTH_KEY_FILE=/run/secrets/dws_runner_auth_key

SANDBOX_ENABLED=false
SANDBOX_BROKER_URL=http://sandbox-broker:8092
SANDBOX_BROKER_AUTH_KEY_FILE=/run/secrets/sandbox_broker_auth_key
FILESTORE_DRIVER=local
FILESTORE_ROOT=/var/lib/anthys/artifacts
MCP_REGISTRY_FILE=/app/config/mcp-connections.json
SEARCH_REGISTRY_FILE=/app/config/search-connections.json
MOCK_PROVIDERS=false
LIVE_TEST_ENABLED=false
```

`.invalid` 是不可用占位域名，生产校验必须拒绝。开发可替换为 localhost；生产有 HTTPS、公开/企业客户端可达性、禁止默认 secret、禁止 MOCK_PROVIDERS 的强校验。DWS/Sandbox 未启用不影响基本开发启动，但对应最终剖面门禁必须要求开启并实测。

### 9.1 租户配置

企业默认时区、工作日历、保留期、群主动消息限额、模型预算、允许出域数据分类、允许连接器、禁用能力、审批规则、数据范围等存版本化租户配置。配置变更记录操作人、前后差异、原因和生效时间。

### 9.2 仓库必须实现的脚本

下列是要求 Codex 创建的项目脚本，不是本次已经存在的可执行程序：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm db:migrate
pnpm db:seed:test
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:e2e
pnpm test:security
pnpm test:chaos
pnpm test:load
pnpm test:live
pnpm verify:requirements
pnpm verify:release
pnpm run doctor
```

实施决议（2026-10-14，P00 实测）：锁定的 pnpm 10.34.7 自带 `doctor` 命令，`pnpm doctor` 不会调用项目同名脚本。项目诊断统一使用 `pnpm run doctor [--profile ENTERPRISE_DWS]`，避免把包管理器诊断当作企业接入验证。其余项目脚本保持上述命名。

`doctor` 输出配置、模型、钉钉、DWS、MCP、数据、搜索、存储、队列的状态，秘密脱敏，不能“捕获全部异常然后打印成功”。`verify:release` 在必需 live 项 NOT_RUN/SKIP/BLOCKED 时返回非零。

## 10. Codex 分阶段开发计划



### 10.1 执行方法

按阶段构建纵向可运行切片，而不是先生成所有空目录。每阶段结束必须有代码、测试、可重复命令、状态和依赖清单。不得把下个阶段的功能临时伪装为已实现；不得为通过测试移除断言或降低安全要求。

默认一个主执行流即可，不强制某种 `/goal` 命令或特定 Codex UI；把每阶段目标作为任务描述。可并行实现没有依赖冲突的前端/测试，但共享 contracts 和 DB migration 必须单点协调。

### 10.2 阶段表


| 阶段            | 依赖          | 目标和主要产物                                           | 完成证据                             |
| ------------- | ----------- | ------------------------------------------------- | -------------------------------- |
| P00 基线核实与工程   | 无           | workspace、版本锁、外部 source/binding快照、威胁模型、CI、空项目健康检查 | 安装/构建/类型检查；无浮动生产版本；未知外部项清单       |
| P01 身份与 PG    | P00         | migrations、RLS、用户/组织映射、session、角色、secret封装        | 双租户/双用户隔离和连接池身份测试                |
| P02 钉钉纵向接入    | P01         | Stream→inbox→worker→机器人回复、H5、卡片/文本降级              | 重复消息只有一个逻辑任务；真实测试单聊/群 @          |
| P03 GLM 原生运行时 | P02         | SSE、tool calling、journal、上下文、预算、取消与 checkpoint    | 多工具/中断/重启/原生协议契约测试               |
| P04 能力与权限中心   | P03         | registry、Gateway、permission manifest、诊断、审批与动作账本   | 无权限不执行；参数改动审批失效；UNKNOWN不盲重试      |
| P05 公司 MCP    | P04         | 发现/认证、代码/日志绑定、证据、版本核对、脱敏                          | fixture全测；真实代码+日志+权限负例           |
| P06 DWS 原生    | P04         | 固定CLI、device flow、profile隔离、schema注册、读写/撤销/错误     | 双身份真实验证；核心办公资源读写与清理              |
| P07 人设记忆与工作指导 | P03,P04     | 三级人设、scope记忆、纠错/删除、工作计划                           | 人设不扩权；群/个人记忆串漏为零                 |
| P08 定时与条件任务   | P04,P07     | schedule/occurrence、TZ、misfire、持久监控、通知            | 双scheduler、DST、取消/离职/重启测试        |
| P09 数据统计与成果   | P04,P05     | 模板发布、参数与口径、gateway、隔离分析、各格式输出                     | 金标统计/权限过滤/公式注入/沙箱测试              |
| P10 群事务自主工作   | P06,P07,P08 | 群合同、模式、事务、催办、覆盖度、升级、撤销                            | mention-only与history分开验收；噪音/受众测试 |
| P11 办公闭环与搜索   | P06,P09,P10 | 待办/日历/文档/表格完整体验、办公扩展、公网/企业搜索                      | 写前授权/写后验证；信息来源与新旧冲突测试            |
| P12 管理与全链路 UI | P04–P11     | 所有后台页面、移动端卡片流程、任务/审计/预算体验                         | Playwright、无权限直接URL、卡片转发测试       |
| P13 加固与运维     | P12         | 镜像、secret、隔离、监控、备份、负载/故障/恢复                       | 安全扫描、容器无socket、压力与灾备报告           |
| P14 企业验收与交付   | P13         | 真实租户剖面、必需能力签字、上线/回滚、培训                            | 文档04的门禁；无未解释失败和虚假通过              |




### 10.3 每阶段需要写出的验收材料

状态为 `NOT_STARTED / IN_PROGRESS / IMPLEMENTED / TESTED / LIVE_VERIFIED / BLOCKED_EXTERNAL`，不能只用一个 done 布尔值。

阶段记录包含 commit、修改模块、R编号、测试ID、测试命令/结果、外部版本、真实/模拟标记、已知风险、下一阶段输入。记录可为机器 JSON 产物，不再新增一堆重复产品文档。

### 10.4 第一条 Codex 总任务提示

以下内容可以连同四份文件交给 Codex：

```text
从空仓库开发独立项目 anthys。docs/ 中四份文档是产品、架构、接入和验收基线。
使用 TypeScript 为主、Node.js 24 LTS、PostgreSQL、Docker；唯一默认大模型是 glm-5.3-flash。
实现原生思考与工具调用运行时，不用固定问答流程冒充自主 Agent。
先阅读全部文档，建立 R01-R36 与测试ID、代码模块的映射，再依 P00-P14 实施。
优先完成可运行纵向切片；每阶段自行运行测试、修复、提交可审查结果后继续。
对钉钉、DWS、MCP 和模型协议查阅官方资料并固定版本；不虚构 API、权限点或公司工具名。
没有企业凭据时，完成适配器和 mock/contract 测试，明确 BLOCKED_EXTERNAL，不能伪造真实测试。
所有工具执行都通过 Gateway，按用户/资源/群受众再鉴权；禁止共享管理员DWS身份。
默认只读代码和日志、认证数据模板；禁止任意生产SQL、任意shell和未经批准的高风险写入。
实现任务持久化、幂等、UNKNOWN副作用核对、取消、恢复、定时、群事务、记忆、审计和预算。
最终交付源码、迁移、测试、锁文件、Docker部署、doctor、发布核验及真实测试报告。
不能以空实现、TODO、写死成功、仅有UI、仅mock或降低验收阈值宣布完成。
发现文档互相矛盾时采用更严格的安全/真实性要求，并在现有四文档内记录决议。
需要授权人登录/审批或生产凭据时停止该外部动作，但继续所有不依赖它的开发和测试。
启动新的端口：64700 pg端口改为：64710
```



### 10.5 单阶段执行模板

P03预算运行配置（2026-10-15）：worker通过 `BUDGET_POLICY_FILE` 读取管理员已批准的JSON；`pnpm budget:check --file /absolute/path/policy.json` 仅做离线校验，不调用模型、不确认账单、不更改数据库。缺失/无效策略时模型请求停止，控制面取消仍可用。项目不提供伪造的生产价格；`.data/test-environment/budget-policy.json` 仅由隔离测试准备器生成，`SYNTHETIC_TEST` 在生产/普通开发环境被拒绝。

策略字段以 `packages/runtime/src/budget-policy.ts` 为可执行契约：`schemaVersion:1`、唯一策略 `id`、`model:glm-5.3-flash`、`currency:CNY|USD`、`environment:PRODUCTION`、`approved:true`、批准引用 `approvalReference`、未来 `validUntil`、IANA `dayZone`、输入/输出上限；正数 `ceiling.inputPerMillion/outputPerMillion` 是企业批准的预留上界；`pricing` 可为null，否则含费率、来源引用和有效起止时间；`limits.tenant/department/user/task` 各含十进制字符串 `tokens/money` 和整数 `concurrent`。金额不能使用JSON浮点数。上界、币种和额度必须由企业提供；只有配置文件的审批标记不代表外部验收通过。

当前挂载策略首次注册后以hash固定；配置改动不自动覆盖旧策略，版本不一致停止派发。完整的管理审批、版本轮换与费用核对界面仍属于后续权限中心/管理阶段。本轮不以数据库手工清零或删除旧账解除生产预算阻塞。测试准备器的 `--fresh` 仅重建固定 `anthys-test` 临时PG容器，不操作64710开发库。

```text
执行 Pxx：<阶段名称>。
先检查依赖阶段和当前代码事实，明确本阶段 R 编号与测试 ID。
实现端到端功能及错误/权限/恢复分支，不只写接口或示例。
完成后运行对应测试、build、typecheck 和 verify:requirements。
输出代码变更、实际测试结果、尚未完成项和外部阻塞；不要把计划当成实现。
```



## 11. 模块完成清单


| 模块  | 最容易被省略但必须实现的部分                                          |
| --- | ------------------------------------------------------- |
| 钉钉  | 持久 ACK、主动发送、临时 webhook过期、卡片回调鉴权、附件真实下载                  |
| GLM | reasoning字段保留、SSE工具参数分片、tool_call_id闭环、partial stream取消 |
| DWS | 精确profile、全凭据目录隔离、无头授权、版本/命令漂移、撤销与refresh竞争             |
| MCP | 上游资源授权、schema变更、输出大小、采样/截断、生产版本关联                       |
| 数据  | 口径/粒度/时间/水位、参数绑定、测试金标、结果受众、明细导出权限                       |
| 定时  | 持久化、重复时区时刻、错过处理、并发调度、取消与权限失效                            |
| 群事务 | 管理员合同、可见范围声明、成员变化、有限催办、真实完成核验                           |
| 记忆  | 个人与群隔离、明示删除、过期、纠错、授权变化重建上下文                             |
| 成果  | 内容验证、下载授权、过期、公式注入、敏感卡片不可撤回的边界                           |
| 运维  | 备份恢复、角色权限、非root、无socket、密钥轮换、审计与unknown告警               |




## 12. 官方来源与核实范围

以下来源核实于 2026-10-14。部分钉钉页面是动态渲染，公开检索可确认的内容有限，因此完整请求/响应字段必须在 P00 用当日官方页面、SDK及测试租户补齐，并保存快照。本文未编造缺失字段，也未进行你的企业账号真实调用。


| ID  | 来源/用途                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Flash 模型卡：`https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash`                                                                                         |
| S02 | 保留式思考：`https://docs.z.ai/guides/capabilities/thinking-mode`                                                                                                    |
| S03 | 模型参数：`https://docs.z.ai/api-reference/llm/chat-completion`                                                                                                     |
| S04 | 机器人接收边界：`https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/`                                                                        |
| S05 | 官方 Node Stream SDK：`https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs`                                                                               |
| S06 | 流式卡片：`https://open.dingtalk.com/document/development/typewriter-effect-streaming-ai-card`；`https://open.dingtalk.com/document/development/api-streamingupdate` |
| S07 | 权限缺失诊断：`https://open-dingtalk.github.io/developerpedia/docs/develop/best-practices/permission-deny/`                                                           |
| S08 | 机器人/卡片权限种子：`https://open.dingtalk.com/document/development/install-openclaw-locally`                                                                           |
| S09 | DWS官方安装、授权、schema：`https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli`                                                                                 |
| S10 | DWS命令索引：`https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/docs/command-index.md`                                                           |
| S11 | DWS群聊技能：`https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-chat/SKILL.md`                                             |
| S12 | MCP规范：`https://modelcontextprotocol.io/specification/2026-07-28`                                                                                               |
| S13 | MCP安全：`https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices`                                                             |
| S19 | H5免登：`https://open.dingtalk.com/document/orgapp-server/enterprise-internal-application-logon-free`                                                             |
| S20 | 官方权限映射与办公scope参考：`https://open.dingtalk.com/document/development/permission-pointp-mapping-document`；`https://github.com/open-dingtalk/dingtalk-mcp`           |
| S21 | 智谱国内HTTP接口：`https://docs.bigmodel.cn/api-reference/模型-api/对话补全`                                                                                                |
| S22 | 机器人接收文件下载：`https://open.dingtalk.com/document/development/download-the-file-content-of-the-robot-receiving-message`                                            |




### 10.6 P03结构化最终结果切片的复现边界（2026-10-15）

在已准备的隔离测试环境中执行`node --import tsx scripts/test-environment.ts`检查迁移001–031，执行`pnpm test:coverage`、`pnpm lint`、`pnpm typecheck`、`pnpm build`和`pnpm test:e2e`。使用`scripts/record-check.mjs`记录精确命令、退出码与前后源码hash；完整命令和真实结果见`reports/checks/p03-finalization-*.json`及候选报告。测试限定64711临时PG和64702浏览器服务，不能加载企业.env或继承供应商凭据。

新增031和最终结果校验不需要企业凭据。当前真实企业资料仍BLOCKED_EXTERNAL：已发现chat工具不等于已确认其只读、按用户资源鉴权、版本化代码/日志及引用契约。选择chat作为入口仅确定适配方向；本切片没有执行MCP业务工具、真实钉钉消息、付费模型或生产部署。生产预算仍需企业批准策略。

结构化最终结果基础完成后，继续补齐一般问答/有效澄清/语义目标核验与P04余项，并推进不依赖外部凭据的P05/P06适配与contract链路。不能将本切片标为整个P03或ENTERPRISE_DWS通过。


### 10.7 P05代码切片的启用与复现（2026-10-15）

默认不设置`COMPANY_MCP_CONFIG_FILE`，现有AIDER_AI_DD_CHAT_MCP和MCP token不会自动启用代码READ能力。配置schema见`packages/company/src/configuration.ts`，契约hash与官方资料见`config/company-code-contract.json`。显式配置需要STREAMABLE_HTTP、精确HTTPS endpoint/allowedOrigin、固定server.name/version、contractHash、reviewed:true、真实只读与按用户资源审核引用、API_KEY的0600 tokenFile及有界timeoutMs/maxConcurrent；配置标记本身不是外部认证证据。迁移角色还须安装独立审核scope、对应capability binding及资源grant。worker、API结果读回和notifier共用此适配逻辑；缺配置时不连接企业MCP。

新软件测试执行`pnpm test:prepare`核对001–032、`node scripts/run-tests.mjs vitest run tests/integration/company.test.ts tests/unit/company.test.ts`、完整`pnpm test:coverage`、`pnpm lint`、`pnpm typecheck`、`pnpm build`及`pnpm test:e2e`，真实命令/退出码/source hash见`reports/checks/p05-company-*.json`。fixtures采用SDK内存传输及HTTP响应替身；原生GLM SSE也为进程内替身，PG和Chrome为真实本地执行。没有调用现有企业chat业务、真实钉钉消息或付费模型。

P05仍为IN_PROGRESS：company.logs/query、部署版本关联、更多认证/传输方式、schema变更后审核恢复生命周期、全量关键分支及真实T082尚未验收。现有chat只有message/conversationId/images说明；不得把本项目代理message契约描述成现有服务器已支持。

### P06 固定CLI组件与下一步输入（2026-10-15）

当前工程锁为v1.0.61（官方源码50eb73a0906c5911c5c25f9c7106b6ead4f14f62），来自P00安装实测，不宣称用户指定或最新版。config/dws/lock.json锁定官方归档、实际二进制和contact +me叶子schema。runtime-lock修正了原先把npm JS包装器hash记作二进制hash的问题，保留旧值来源。auth login/status/profile list在此版本无可用schema，已分别只查询一次准确叶子help；此版本auth status没有--readonly，不杜撰该参数。

离线CLI元数据、合成CLI进程测试及Linux network-none镜像探测的证据分别记录，均非真实授权/业务联调。构建使用固定Linux glibc二进制和非root用户；不在启动时下载升级。后续独立runner须挂载0700 tmpfs并强制受控出网。DWS_ENABLED默认关闭；在独立服务边界完成前即使提供配置也拒绝生产启用。

真实联调最小输入与审批目标：专用已发布测试机器人及H5 HTTPS域名、允许单聊与@群的明确测试用户/群；两位本人独立DWS授权及专用文档/钉盘ACL；公司chat代理按认证actor进行只读资源鉴权的审核契约和允许仓库/服务/环境；模型数据出域范围与明确预算/费率上界；真人验收责任人。已获批准的连接探测和源码推送保持有效；上述业务动作本轮未发起。

P06组件不满足整阶段交付。下一步按原架构实现独立runner与device flow，再扩展文档ACL/只读查询、受控办公写入和读回；同时保留P03一般问答与有效澄清、P05日志等未完成项。

本组件复现命令（Node/pnpm使用runtime-lock版本，测试准备器仅操作独立64711库）：

```sh
pnpm test:prepare
node scripts/run-tests.mjs vitest run tests/integration/dws.test.ts tests/unit/dws.test.ts
pnpm typecheck
pnpm lint
pnpm build
node scripts/run-tests.mjs playwright test
node scripts/prepare-dws-release.mjs --platform linux-arm64 --output /private/tmp/anthys-dws-release-context-arm64 --archive /opt/homebrew/lib/node_modules/dingtalk-workspace-cli/assets/dws-linux-arm64.tar.gz --checksums /opt/homebrew/lib/node_modules/dingtalk-workspace-cli/assets/checksums.txt
docker build --platform linux/arm64 --build-context dws_release=/private/tmp/anthys-dws-release-context-arm64 -f deploy/images/dws.Dockerfile -t anthys:p06-dws .
node scripts/verify-dws-image.mjs anthys:p06-dws
pnpm verify:requirements
pnpm verify:release --profile ENTERPRISE_DWS
```

准备脚本的output必须是新的空路径；无本地归档时可省略archive/checksums，从锁定官方HTTPS release获取并校验（本轮只验证本地官方归档路径）。amd64需选择对应平台与归档；本轮实际镜像架构为arm64。完整需求和企业发布核验应继续非零退出，不能用此复现列表暗示验收已通过。

### P06 文档固定契约与配置限制（2026-10-15）

在关闭生产DWS入口的同时，继续实现不依赖企业输入的文档协议与ACL组件；这不表示独立runner已完成。config/dws/doc-fetch.schema.json来自空HOME、拒绝网络及个人文件访问的固定v1.0.61官方二进制。+fetch与+inspect均没有published result schema；未通过Help/样例杜撰返回契约。固定源码审查记录在config/dws/document-contract.json，opaque payload只接受企业另行审核的JSON Pointer映射，不存在自动猜字段或默认生产映射。

管理员需提供专用测试adoc稳定node、真实正文中的资源/版本/文本/类型及覆盖字段契约、payload审核引用、每位试用者的独立授权与资源ACL、分类和模型出域许可。scope由独立管理角色安装，普通grant仍须另有当前权限。未提供返回覆盖字段时只能UNKNOWN；有continuation未消费时明确TRUNCATED，不编造+fetch分页参数。真实读写/授权/消息发送本轮未执行。

复现组件测试：node scripts/run-tests.mjs vitest run tests/integration/dws-document.test.ts tests/unit/dws-document.test.ts。身份公共路径回归保留tests/integration/dws.test.ts；Linux镜像离线probe新增doc +fetch schema校验，仅执行version/schema，不执行正文业务。原P06候选和许可证换行映射证据保留原始提交来源，不覆盖。

### 当前文档候选与后续顺序（2026-10-15）

reports/p06-doc-candidate.json绑定代码0f6242b0ce70317ecc7ed4d81f562d2c14c8040e及当前文档镜像。278项后端全量结果保留原检查点；之后只有报告列明的UI改动及clock_timestamp期限修正，精确还原见reports/p06-doc-backend-delta.json。最终29项受影响后端用例与30项完整浏览器用例独立记录，不相加或改写成同次全量运行。许可证换行映射采用新的候选证据，原P06身份候选/镜像及证明不覆盖。

完成当前缓存/页面失效闭环后，继续P03一般问答、有效澄清和目标核验，再按原依赖推进P07人设/记忆及其他缺口。P06独立runner/device flow、P05日志关联等软件未完成项仍保留，不因外部BLOCKED而结束总目标。P11/P12的文档读取/页面失效组件在P06已有重叠工作，完整办公闭环/管理与全链路UI阶段尚未开始。

R09/P07规划交付：personas版本迁移与审计、GLOBAL/GROUP/USER编辑服务及GET/PATCH/ETag接口、管理与个人页面、自然语言/钉钉设置的同权入口、运行版本快照/恢复与撤销、默认角色模板。SRE依赖P05当前有权代码/日志，BI依赖P09认证统计，PMO待办/定时及群催办依赖P08/P10各自授权契约；只装人设模板不得启动这些业务。实施时补齐对应迁移、真实本地测试、执行记录与依赖状态。该规划记录时只有计划；最新实施状态见本文后续P07进展。

P06兼容评估待办：当前获准工程锁继续使用v1.0.61。协调任务另提及v1.0.62，本项目尚未独立核实其发布或兼容性；未来须单独比较二进制来源、身份/密钥路径、精确叶子schema、错误/confirmation契约及受影响测试，再决定是否变更锁。与独立runner和真实device flow一起保留为未完成项；不自动升级，不以新版本名改写旧候选和历史验收。

### P03 普通问答与澄清候选复现（2026-10-15）

本组件使用原生GlmProvider，增加同模型的独立review请求，并复用原预算/停止/恢复路径；无真实模型收费请求。H5和原单聊明确短码续接均实现，拒绝回执由本地规则生成而不是假模型成功。source-grounded业务自由叙述、工具后/群澄清、无短码自动话题关联及真实模型质量评测仍未完成。P03保持IN_PROGRESS，当时P07仍只有规划；最新状态见后续P07进展。

复现：pnpm test:prepare；node scripts/run-tests.mjs vitest run tests/integration/narrative-review.test.ts tests/unit/narrative-review.test.ts tests/unit/clarification-command.test.ts tests/integration/finalization.test.ts tests/unit/final-plan.test.ts；pnpm typecheck；pnpm lint；pnpm build；node scripts/run-tests.mjs playwright test tests/e2e/narrative.spec.ts。候选收口运行一次稳定代码下的完整后端覆盖与浏览器回归；Docker镜像仅构建并在network-none中离线核对DWS version/schema，不启动应用或真实授权。记录全部失败、各自源码hash及原始命令，不重复无变化的全量结果。

### 2026-10-15 P03 工具后来源选择实施范围

本次增加SOURCE_CHOICE最终计划、公司代码只读投影、H5/原生短码选择、SOURCE_REPLY持久队列与核实worker、039–040迁移、预算/取消/恢复/当前来源守卫及桌面手机选择界面。按原预算核实后才产生下一代模型任务，先核实再读取；没有真实企业调用、收费模型评测或实际消息发送。

复现组件：`node scripts/run-tests.mjs vitest run tests/unit/source-choice.test.ts tests/integration/source-choice.test.ts`；`pnpm typecheck`；`pnpm lint`；`pnpm build`；`node scripts/run-tests.mjs playwright test tests/e2e/source-choice.spec.ts`。worker原有配置自动创建额外的source-reply队列并恢复遗留核实租约；不需共享DWS身份或新增企业凭据。完整回归、迁移结果、覆盖率、镜像和离线探测分别保存在候选报告及原始命令记录中。

P03仍未完整交付：此处是私聊固定版本代码候选的工具后澄清；群澄清、自动话题关联、业务自由叙述语义与目标完成度、真实模型质量评测仍待实现。P05/P06真实资源合同与企业授权阻塞保留，P07–P14不提前完成。继续按依赖顺序推进群澄清，再进入P07；不降低文档04验收门槛。

### 2026-10-15 P03 群澄清组件复现与接入限制

新增群受众服务、MENTION_ONLY原群普通问题/回答、显式群可见H5确认、GROUP_REPLY队列与恢复、041–043迁移。两个真实固定CLI叶子schema及官方源码审计保存于config/dws/group-members-contract.json；获取schema只在network-none离线容器执行，不是企业群读取。独立审核的群info计数/修订映射、目录权威来源、机器人允许列表、当前个人DWS授权及元数据资源grant均为必要配置；普通用户不能自授，生产无猜测字段默认值。独立runner仍未完成，生产DWS入口继续拒绝DWS_RUNNER_SERVICE_REQUIRED。

复现：`pnpm test:prepare`；`node scripts/run-tests.mjs vitest run tests/unit/group-members.test.ts tests/integration/dws-group-members.test.ts tests/integration/group-clarification.test.ts tests/integration/gateway.test.ts`；`pnpm typecheck`；`pnpm lint`；`pnpm build`；`node scripts/run-tests.mjs playwright test tests/e2e/group.spec.ts`。真实结果与失败历史见reports/checks/p03-group-*，精确候选见reports/p03-group-candidate.json。合成独立CLI、SSE及发送替身不标LIVE，不调用收费模型或真实群业务。

当前可运行范围是原发起人的无企业资料普通群澄清。逐成员资源共享/共享路径、多人安全接管、完整群合同、自动话题关联、企业自由叙述与目标核验、真实模型评测仍是软件缺口；企业真实返回契约和授权属于BLOCKED_EXTERNAL。继续原阶段依赖及P07等实现，不把组件收口当作P03或总目标完成。


## 2026-10-15 P07 人设设置与运行快照组件进展（IN_PROGRESS）

本节更新此前仅有规划的状态；不改变原需求优先级、130项验收状态或企业门槛。P07与R09现为IN_PROGRESS，不能由本组件测试推断整阶段完成。

已实现GLOBAL/GROUP/USER真实版本、加密字段、字段继承与null清除、企业锁定政策、ETag并发与幂等回执。工作台按当前会话和对应范围授权展示编辑、有效来源及历史；企业管理员身份不赋予私人偏好或所有群的访问权。群运行只使用GLOBAL+当前GROUP，私聊只使用GLOBAL+当前USER。

新运行冻结加密人设快照及精确来源版本；普通设置修改不替换已有运行的版本。重试与会话恢复使用原快照、原目标和原预算。模型、工具、最终结果读取及实际发送前核验当前身份、企业规则、来源与群受众；快照损坏或撤销后拒绝继续使用。未配置服务的库调用显式冻结BUILTIN_ONLY并审计；旧记录标记LEGACY_NONE，两者不能在后续恢复中自动套用最新偏好。生产入口均接入服务，完整生产部署尚未验收。

钉钉SDK入站支持明确范围的设置指令与有限自然表达，复用同一真实授权/政策/CAS写入器；不伪造H5会话。实际加密inbox须匹配当前租户、机器人、发送人及会话。范围不明的“切换为SRE”只询问范围、不保存；用户须重述完整请求，例如“把我的助理切换为SRE”或“把本群助理切换为PMO”。仅回复“个人/本群”的上下文续答尚未实现。回执与版本同事务持久化，零模型预算、无RUN队列；回执不包含偏好正文，发送前再次核验。自称管理员、角色定位文字及未知权限字段不能授予权限。

仍未完成：scope长期记忆、显式记住/忘记、纠错/过期及派生数据清除和备份边界；个人偏好完整删除/隐私擦除；完整GroupContract与群记忆；任意自然表达的设置理解、仅范围回答续接；任务页快照版本说明；有证据的完整工作计划/业务目标核验；SRE告警、BI认证统计及PMO调度/催办的依赖能力与各自授权。无真实模型语义评测、真实钉钉外发或企业联调PASS。
执行：`pnpm test:prepare`（独立64711，不加--fresh），`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test:coverage`、`pnpm test:e2e`。定向测试见tests/integration/personas.test.ts、persona-runtime.test.ts、persona-group.test.ts、persona-native.test.ts及tests/e2e/personas.spec.ts。原生例子：`/persona personal view`、`/persona personal set {"tone":"DIRECT"}`、`/persona group set {"role":"PMO_COORDINATOR"}`；JSON null清除覆盖。个人只在单聊，本群只在对应群，global仍需当前企业管理授权。

本机完整后端覆盖检查采用`node scripts/run-tests.mjs vitest run --coverage --maxWorkers=2`，与Chrome全套串行；保留原断言、全部超时与覆盖门槛。后端452项冻结检查点至最终UI修复的逐文件差异见reports/p07-persona-backend-to-final-delta.json；不得将检查点说成最终源码重新执行。


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


### P04 权限中心组件进度（2026-10-16）

继续按10.4执行，不缩减P00–P14。一次性单聊控制已交付局部代码/反例回归，真实试验未开启。本轮补齐P04一段闭环：审核版本清单→本人当前元信息→依赖隔离的本地诊断→确认撤销→旧会话/租约拒绝→审计。新增066只应用专用64711合成库，001–065未修改。安装器的 --check 不加载.env/连接数据库；实际安装需要明确迁移管理员且不授予业务/平台权限。执行命令见 config/permission-center-contract.md，最终源码与失败历史见 reports/p04-permissions-candidate.json。

P04仍IN_PROGRESS：完整CapabilityDescriptor及output schema、角色分配/委托全生命周期、认证上游只读探测/核对、NOT_APPLIED证明和显式批准重试、10000个实际Gateway授权组合均未完成。公司chat的主体/资源只读契约和生产DWS入口继续BLOCKED_EXTERNAL。缓存与本地CONNECTED均不得提升任何LIVE验收状态。


### P04 T036 实际派发验收入口（2026-10-16）

P04继续补T036实际Gateway组合验收。执行入口：node scripts/run-tests.mjs vitest run tests/security/gateway-matrix.test.ts tests/security/policy.test.ts tests/integration/controls.test.ts --maxWorkers=1。固定seed=20261016、10000组、4个内部执行槽；每组独立主体/资源/租约，覆盖跨主体/租户、状态/epoch、绑定/版本/hash/风险、委托失效/范围、受众、源所有权、期限、取消、工具额度、停止、严格参数和真实审批。最终结果、失败历史、实际命令及适用范围以reports/gateway-matrix-candidate.json为准。无模式缩减或模拟企业成功；P04完整角色/委托管理、核对重试及P00–P14其他缺口仍须完成。

### P04 角色作用域修复进展（2026-10-16）

修前真实 API/Gateway/PostgreSQL 负例中，GROUP/USER/TASK 与资源同名可各产生一条物理写入；新授予角色未使旧会话/租约失效。保留修前 6 FAIL/5 PASS、首次修复的 SQL 群别名歧义及旧夹具过期假设。已改为持久 Action 的类型化角色上下文及角色 INSERT/移动失效规则。夹具以当前会话/身份版本重新建立合法前置条件，未改业务断言。修后 15 新用例与审批/权限中心/schema 回归合计 70 PASS。全量及最终候选事实以 reports/typed-role-authority-candidate.json 为准。P04 未全部完成。

GitHub main 31ca 的 CI run38885031070 存在 38 个失败。Linux arm64 合成双核覆盖率五用例对照出现 2 个 PARTIAL 断言失败及 5 次 DWS 总操作超时；同用例四核对照 5 PASS/0 超时。原 CI 对应项为 WAITING_AUTH/用例超时，未证明同因或修复；其余原失败仍需解释。详见 reports/ci388850-diagnostic.json，不据此修改原超时、断言、安全验证或企业验收状态。


### 迁移登记权威修复候选068（2026-10-16）

冻结067的备份/恢复演练保留在 reports/upgrade-rehearsal/，不作为新候选通过证据。
源067允许app/runtime改写登记表；新增068版本化撤销其三类DML，并增加元数据谓词。
就绪检查同时检查精确001–068合同及通过表/列/继承/SET ROLE获得的有效写权限。
旧文件001–067不修改，既有SELECT/角色密码/RLS不改变，无法收紧的其他角色授权
使当前迁移事务失败而不是自动扩大撤权。范围、实际执行命令、失败历史和候选绑定
见 config/database-readiness-contract.md 与 reports/ledger-authority-candidate.json。
只应用专用合成64711；目标64710未升级、未开启单聊或外部能力。P00–P14目标不缩减，
P04完整管理/核对、其余软件与ENTERPRISE_DWS门槛继续保留。


### 2026-10-18 本人单聊离线联调入口

在锁定 Node24.21.0/pnpm10.34.7、已准备的独立合成测试库中，pnpm test:self-dm 运行桌面和手机 T001。该入口使用受防护的本地64702/64711、真实 PostgreSQL/pg-boss、固定 SDK 回调、原生 GLM SSE 替身及回复发送替身；不会建立真实 SDK 连接、调用收费模型或向钉钉外发。新场景同时登记在现有完整 E2E 服务中，没有通过排除测试取得通过。CI 显式安装固定 Playwright 所需 Chromium 并执行本入口，随后继续原完整需求门禁。

实际本人试验仍要求新的明确批准、准确候选绑定、新预算和独立试验输入。旧窗口和 START 不恢复，正式 profile 不替代单次试验限制；不要从回调值生成身份授权。具体数据范围、费用、期限、停止与复核方式以 reports/self-dm-closure-20261018/CHECKLIST.md 为准。企业业务数据库连接与查询仍属二期；项目自身 PostgreSQL 是一期设施。

### 2026-10-18 P04 管理员资源政策组件复现

已实现`/api/v1/permissions/admin/resources`列表/创建及`/:id/renew`、`/:id/revoke`、`/:id/regrant`，写请求须有正常CSRF和UUID幂等键。只注册本地私有资源政策，不调用外部提供方；当前注册元数据必须与独立清单匹配。生产连接器状态、外部授权与业务审批继续独立生效。新接口不接收role/profile/credential或callback授权声明。

受影响验证入口：`node scripts/run-tests.mjs vitest run tests/integration/permission-administration.test.ts tests/unit/capability-descriptor.test.ts tests/unit/capability-output.test.ts tests/integration/permission-center.test.ts tests/integration/gateway.test.ts tests/integration/capability-output.test.ts tests/unit/test-isolation.test.ts tests/integration/checkpoint.test.ts tests/integration/finalization.test.ts tests/integration/source-choice.test.ts`。测试仅使用已准备的合成库、受控提供方与实际API注入；准确源码/CI状态由后续检查点绑定，不能用709的历史CI替代新代码。

仍须完成管理员角色/委托生命周期、对应非技术管理UI、群合同政策和认证对账等原阶段缺口；此组件不把P04或全量需求标为完成。真实库迁移/权限变更与真实模型、外发、部署仍禁止。

### P04 本人私聊只读核对接入边界（2026-10-18）

可选CertifiedReadBacks通过现有认证ControlPlane兑换同一核对会话；生产默认不注入，不加载凭据或发送上游请求。新提供者必须另行审核真实终态操作账本、独立审核人认证和“不再迟到接受”的否定证明语义，并绑定准确读写契约；不得将普通Capability.verify、readOnly提示、EMPTY或自报NOT_APPLIED装配成认证核对。当前仅受控PostgreSQL夹具验证组件，下一步仍须补明确本人重试/新批准状态机、真实适配及群授权边界；不代表P04、P05或P06完成。

### 2026-10-18 日常问答缓存计费切片

依据智普官方[上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache)契约，隐式缓存命中通过`usage.prompt_tokens_details.cached_tokens`报告。仅在管理员审批的`pricing.cache`显式配置输入费率及零存储费、普通报价有效且计数完备时结算；未配置仍UNKNOWN，不填自动折扣、不调用模型探价、不改持久预算配置。报价来源/有效期覆盖缓存收费的审核仍由操作者负责，应用结算不是供应商账单核验。

最小源码范围为budget-policy/model-budget；复用原schema83/额度桶和账本，不新增迁移。新增隔离验证覆盖混合/全部缓存、并发一次结算、旧策略hash不变、零存储报价限制、缺失/恶意计数、过期/未知报价、冲突用量、取消后迟到冻结报价及真实原生SSE替身的生成/审核到单次最终投递。f6真实试验仍CLOSED且不重启。本批之后按任务关联单聊、群@隔离、人设及文档/MCP依赖推进，企业业务数据库仍二期。

### 2026-10-18 日常单聊明确任务关联

在原钉钉单聊使用最终/提问消息中的真实任务编号与当前问题短码，格式为`继续任务 <完整UUID> <8位问题短码>：回答`。只有仍等待该问题、当前有权且尚未过期的原任务可接纳；随后原运行保留目标和累计预算。该命令是确定性入站控制，沿既有身份、去重、原会话和replyInTransaction路径，不给模型猜任务或重开已结束任务。标准群入口不启用此新格式。

最小源码范围clarification.ts及原解析/叙述集成测试；既有原短码、正式/试验准入、来源选择和群澄清要回归。不同任务的问题不能因短码相同而猜选；完整任务编号也不能绕过当前问题短码。原提问渲染保持不变，避免破坏既有密文/证明。没有新增真实模型、SDK、钉钉外发、生产配置或schema操作。

### 2026-10-18 日常单聊费用状态链路

新增本人账本元数据→现有GET任务API→独立费用说明组件。此前MODEL_USAGE_UNAVAILABLE只写quota_ledger.failure_code，单纯budgetReasons字典不能使其显示；本切片按实际账本状态与白名单原因显示，不伪造run.last_error，不改变任务成功/失败。应用角色原有列权限与RLS足够，无迁移或GRANT。任务详情仍不返回提供方或报价正文，也不混算币种金额。

最小范围为tasks/store、工作台独立组件/消费类型，以及原预算和叙述浏览器用例。验证实际app角色API、旧账零预留、未知优先级、跨owner隔离及桌面/手机中“答案完成而费用待核对”并存。没有新的真实GLM/SDK/钉钉发送、持久预算或真实库操作。持续日常单聊的后续明确依赖是经审批的预算版本转换：当前ensurePolicy拒绝hash变化，formal_authorize仍要求原试验预算hash；不得手工覆盖旧账、放宽该判断或沿用过期窗口来绕过。应单独设计保留累计/UNKNOWN暴露的显式转换，在隔离环境验证后再提真实批准。

### 2026-10-18 日常窗口转换的有界实现

本切片只解决“ensurePolicy固定当前hash、069正式授权绑定原trial hash、prepareModel仍取原trial hash”导致新审阅日常预算无法准入这一数据流。配置新增budget-transition指纹合同，脚本scripts/budget-transition.ts提供plan/authorize，084以不可变旧策略快照+CAS当前投影+精确新正式授权原子提交；运行时FORMAL选择可信状态返回的新预算摘要，不改旧试验或结算算法。原有身份/权限、期限、nonce/版本、撤销、预算和输出保护保留。

先仅支持同容量/同费率窗口转换，不把通用提额、计费修复、自动续期或启用服务拉入此批。相关测试在原lifecycle/model-budget/one-shot及CLI范围内增量验证，迁移仅合成64711；未操作真实schema73。与辅助read-back控制台入口分工独立，主统一审阅合并；真实预算/profile/权限/模型/钉钉/部署仍需单独具体批准。

### 2026-10-18 群合同治理的开发边界

本批推进 P10 的可信委托和持久化停止屏障，不将纯合同模型的 ELIGIBLE 当成授权。新增 scripts/group-contract-delegation.ts，默认 plan 仅读取 0600 私有审核文档并输出指纹；approve/revoke 另需精确摘要及审核引用，且仅在显式数据库操作中使用 oa_migrator。开发验收不运行这些真实批准操作，不修改真实角色、委托、凭据或服务配置。

先以真实隔离 PostgreSQL/API 和原生 SSE 替身验证当前来源、版本竞争、预算、暂停/到期及投递屏障，再整合管理员已有受管资源续期/撤销界面。后续群事务、计划调度、增强来源、自然语言管理入口及专用服务执行协议仍需分别开发和验收；企业业务数据库保持二期。原已关闭本人试验不续期、不重开。

权限管理辅助提交在主分支审核整合，仅接已有资源管理 API。scripts/test-permission-admin.mjs 为独立 network-guard 入口，加载真实 Permissions 组件及全拦截 route mock，严格检查 9 个流程测试和 30 个浏览器用例均执行且零跳过；通过原 test:self-dm 包入口接入现有 CI，保留原 2 个单聊及 7+19 控制台验证，不修改工作流权限。

### 2026-10-18 P05 日志链路与 P10 合同停止入口的接线边界

新日志代理合同及摘要见 config/company-logs-contract.json，源码 log-contracts/log-client/logs/log-configuration/log-result-contract/log-citation。它是需独立认证的 anthys scoped-proxy 合同，不是当前企业 chat 的已发现能力。默认没有日志连接；0600 显式配置、准确正式能力绑定、迁移角色审核安装的本人范围和资源 grant、上游当前 ACL/不可变查询证明均满足后才可读取。禁止用回调正文、API key 或应用角色自授数据权限。

本批通过实际 SDK 的 InMemory 及 Streamable HTTP 替身运行查询，原生 GLM 流替身读取已审核日志、保留 queryId/窗口/采样截断、拒绝注入扩权，生成一次安全回复。三个进程共同初始化并分别关闭代码/日志连接；原 code contractHash 不变。T075/T077 建立真实软件场景对应，R19 保持 IN_PROGRESS；T076 部署版本未验证、真实 T082、trace 增强及更多认证/传输/重新审核生命周期仍未验收。

群合同界面辅助提交8ae6afd由主审阅整合为94fb41a，稳定调用已有GET与状态POST，只暂停/撤销。新增 scripts/test-group-contract-admin.mjs 严格执行9个flow+40个真实组件浏览器用例，接入既有 test:self-dm 末尾；原2DM、7/19读回、9/30资源管理全部保留。主另以真实本地API/合成PG证明状态持久化及发送屏障。未重启旧试验、未调用真实MCP/付费模型/钉钉或部署。

### 2026-10-18 P08 私人提醒接线进展

新增`start:scheduler`确定性私人提醒入口，按受控worker-scope读取当前主体并检查完整schema；旧试验/正式受限生命周期不因此新增定时授权。H5与原生单聊共用持久计划、当前主体/版本检查；自然语言解析只接受可确定语法，未知或歧义请求澄清。配置回执和到期提醒均不调用GLM，长期到期消息走当前本人主动通道，不能复用过期sessionWebhook。源码接线不构成服务已部署、企业主动发送获批或真实投递PASS。P08与后续群催办、监控等依赖保持未完成。

### 2026-10-19 原生群事项执行接线

可信SDK回调按严格事项命令标为GROUP_CASE，在既有模型worker取租约并冻结GroupAudience后走确定性本地事务分支。DWS仍只承担既有独立审核的群受众观察；resourceRef仅为事项描述，不授予对应企业资源查询权。所有一般GROUP企业证据/工具仍默认拒绝。主负责统一runtime/存储/迁移/集成，辅助只交付纯解析器和只读审查。真实DWS/MCP企业查询、钉钉外发、部署或真实schema升级均仍须具体批准。


### 本群事项模型读的生产注册（2026-10-19，未部署）

worker、API finalReader与notifier在DEFAULT生命周期、实际GroupCases与GroupAudience配置齐全后分别注册固定group.case.list。TRIAL/FORMAL未因此扩大能力，旧本人试验仍CLOSED。模型工具不接收CLI/SQL/任意群或用户选择器；唯一数据源为当前群已登记事项。登记项的resourceRef仍不是企业读取授权。

原生SSE模型替身、SDK回调形状、DWS合成进程和真实隔离PG用于验证发现/调用/证据/最终正文与独立读者/发送器；不是企业MCP/DWS业务查询、真实模型、真实钉钉外发或部署验收。主会话统一核心接线，辅助仅做只读根因审阅。准确候选与执行状态在reports/group-case-model-read-20261019绑定，不沿用旧候选CI。


### H5群名单独立签名叶
READ_GROUP_CASE_ROSTER使用H5_SESSION与dws.group.case-roster.v1，保留所有旧native delegation/schema及真实@来源校验；不编造task/run。SIGNED_GROUP_READ_V1可明确安装caseRosterPolicies，固定tenant/A/identity/auth version/scope/群/profile/binary schemas/contractId/delegationId/动作子集/期限，实际B/C session与合同version/document hash逐请求签入并绑定结果。挑战、短TTL、签名、实例、重放与状态校验沿用封闭RPC。
runner只证明观察数据绑定；真实session/合同/成员与当前授权由API前后复核。策略缺失时拒绝，不接受浏览器策略或由名单结果授予业务权限。此源码和合成验证不表示真实reader策略已安装、企业联调或部署已完成。

辅助界面增量b0c6bfeddde3dc1cd34b1bc334aed3db766e8bda经主审查整合为1a9502e。主将窗口浏览器用例移入tests/browser，移除条件skip，直接纳入既有group-cases.config.ts和test:self-dm正式CI入口；真实API/合成PG执行结果待本候选记录，不以17项离线结果代替。

### 群提醒审核管理与独立观察接线（2026-10-19）

默认生命周期API接入GroupReminders与现有当前名单护栏，/groups页面使用真实GET/POST/PATCH管理接口。旧试验及受限正式生命周期不因此获得群提醒权限。group-reminder-authorization脚本的plan只输出审核摘要；approve/revoke需要0600私有文件、精确profile哈希、review引用、migrator与完整schema。本批只在测试夹具中安装合成授权，未运行真实安装或修改真实配置。

SIGNED_GROUP_READ_V1显式支持独立scheduledGroupPolicies；策略固定具体计划与主动授权。客户端、runner配置、签名协议、真实私有socket与合成CLI已经覆盖该只读叶子。生产策略/平台资格未核实，不能借旧群@策略、旧单聊试验、H5session或人设替代。

本批尚不接入scheduler/notifier的群催办执行；generic GROUP proactive仍默认拒绝。下一步由核心主线统一实现到期领取、真实事项数据流、原子配额、证据与物理发送二次复核；T111/P08/P10及其余一期不改完成。独立辅助只实现packages/artifacts及对应测试，核心存储/运行时/迁移/集成由主负责。

### 最新企业底座接入顺序（2026-10-19 用户调整）

复用现有 `.env` MCP 连接和实际问答工具；公司完整企业 AI 底座可处理代码、日志和数据问题，响应可能 1–20 分钟。不得因没有独立代码/日志端点而要求直连企业系统。历史关于“企业数据库连接与查询二期”的措辞，按最新明确调整解释为业务数据库直连二期；经该 MCP 的企业数据问答纳入一期。上游认证、取消、恢复、费用和结果来源协议仍须按实际暴露能力验证，不能靠提示词 JSON 建立可信证明。

执行顺序：稳定群提醒/成果组件与下载权限 → MCP 持久长任务及合成故障验证 → 新批准的真实钉钉单聊 → 指定群内 @ 企业问答与成果交付 → 四文档剩余一期需求。两路独立 worktree；主负责核心运行时/存储/迁移/集成，辅助负责明确独占的界面模块。当前发现和只读评审不计为真实问答验收，旧 CLOSED 试验不复用，真实付费/外发/库升级/权限变更仍按具体授权执行。

### 群提醒与成果功能包实施边界（2026-10-19）

本包群提醒源码在根仓5b04296，成果API与运行/维护接线在d54309b；实现与隔离证据见reports/group-reminder-execution-20261019及reports/task-result-artifacts-20261019。群提醒采用独立明确审核的有限操作入口，不接默认主动发送。成果实际任务工作台已调用真实本地API/PG，不以辅助的合成fetch验证替代该证明。真实付费/企业查询/投递/迁移/部署仍须具体批准，统一MCP长任务继续下一包。

### 企业问答生产接线与有限私有试点（2026-10-19）

`agent-configuration.ts`仅在显式 `COMPANY_AGENT_PILOT_POLICY_FILE` 存在且私有0600、非最终符号链接、格式/大小有效时注册能力；默认断开，启动注册零HTTP调用。policy只引用既有 `AIDER_AI_DD_MCP` 或 `AIDER_AI_DD_CHAT_MCP` 与 `AIDER_AI_DD_MCP_TOKEN` 的审核摘要，不引入替代业务端点或token文件。每次实际连接重新比对server/tool/input schema，原始HTTP字节/块/期限在SDK解析前受限，禁止无依据重连、会话复用或远端取消声明。

worker、API结果来源读回及notifier已接入同一注册逻辑；只有worker显式调度后台请求，API状态GET不入队、不问企业。worker scope须匹配policy主体；TRIAL不进入新接线，FORMAL另需精确capability binding授权，旧CLOSED试验不恢复。配置文件或凭据摘要漂移时拒绝新派发并撤回在途本地等待。没有安装真实policy、修改真实凭据/权限、启动真实试点或部署。指定群接线仍须复用MENTION_ONLY合同与当前名单/发送屏障单独实现验收，本批有限私有policy不放开群监听或主动外发。

### 2026-10-19：MENTION_ONLY 群长任务配置与集成边界

既有 `COMPANY_AGENT_PILOT_POLICY_FILE` 私有0600文件按明确kind区分私有主体与群提及策略。群注册工厂要求当前GroupAudience，冻结实际回调并以私有对象身份认证；复制company.agent.ask的ID、binding或回调不取得群工具资格。worker、API结果读取与notifier均复用该策略与当前env摘要，API/notifier不执行后台poll。未配置或FORMAL未批准仍默认断开，不据env钥匙自动接入。

群scope/合同/独立共享审核、本人及群资源grant、模型预算与模型出域、精确原生签名delegation须分别有效。每次新的task/run均须满足对应签名scope；不得借旧试验、旧任务或case/reminder许可。执行顺序仍为隔离真实PG/SDK/签名socket/原生模型流/合成投递验证，再以明确候选、接收方、费用上限、时限、备份回滚和停止条件申请真实批准。真实schema73未被本批升级；共享合成库94不承载95–98迁移，自有nonce库才安装。

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

### 正式群试点接管边界（2026-10-19，继续执行）

主负责formal v2/schema100、可信准入、配置目标绑定及集成；辅助独立worktree交付GROUP_MENTION名单传输（ecec1ad，尚待主窄整合）及100只读审查（5ddd846）。该叶固定审核主体/合同/scope，显式EXECUTION、WAITING_EXTERNAL、RESULT_VERIFICATION，真实worker/fence、持久请求claim与结果来源由主前后核验。一个安装政策可服务新任务，签名不授企业或发送权限。既有NATIVE_GROUP_CASE、H5_SESSION及旧固定run叶保留。

继续项是动态叶的身份/群受众接线、共享真实guard事务以避免formal锁自等待、CLOSED租户的具体已审核资源准备和完整合成PG/TLS/投递联合验证；随后提出限定目标与费用的真实执行方案。仅收集到试点群和参与者不表示批准执行，群号也不作为canonical conversationId。本次不安装配置、不产生费用、不查询企业或群外发。

### 主辅整合续接（2026-10-20）

辅助ecec传输已窄整合7b48552，主补identity/GroupAudience/101观察函数与真实PG/TLS组合；辅助静态审28c133另行记录默认worker UUID及混配路由回归，主修正后统一验收。辅助a713浏览器修复已窄整合033d035：显式拥有响应body读取并在导航前await，清理请求listener，保留全部原业务断言、零重试和原超时；主在schema101再验两视口。核心文件始终由主统一修改，辅助仅独立DWS/单浏览器测试/审查报告。

精确旧493CI覆盖率162文件2280项及原门槛通过，但mobile浏览器失管Promise读取失败，requirements/audit被跳过。新候选需敏感扫描、非强推与准确CI，不能重跑旧候选或用覆盖率通过宣称全部需求完成。下一继续CLOSED资源准备、真实具体批准与剩余一期能力；旧单聊授权不重用。

真实升级准备新增scripts/bounded-migration-plan.ts（辅助cf332b9→主eb8abdc），仅离线读取显式账本和仓库文件。先独立批准并取得真实只读账本，再审核精确有限区间、加密PG/FileStore/密钥恢复及停派发条件；未做这些步骤不能运行旧全量migrate入口。辅助下一仅开发独立私有归档加解密组件，主负责实际PG/存储/限定执行和恢复对账；不借新组件宣称T124或RPO/RTO通过。

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


### 显式群升级接线与有限执行（2026-10-20）

新增实际H5会话/CSRF的POST /api/v1/groups/:id/case-escalations/preview、GET /:proposalId、POST /:proposalId/confirm及/cancel；UI从当前事项卡片传真实group/case/version/contract，不由用户手填权限或目标。所有响应private,no-store；当前名单policy必须额外明确case.escalate，旧三动作policy hash/权限不变。实际签名H5 roster运输复用service owner专用身份观察，不伪造管理员native lease。

有限入口scripts/group-escalation-runtime.ts的plan只读取明确私有profile，不加载.env、不连库/启动服务；run-once另要求相同profileHash/reviewReference，精确schema/current target及SIGNED_GROUP。profile不是授权安装器，不注册默认scheduler/notifier。SDK/签名UDS/合成CLI→实际PG→来源/发送oracle→真实DingTalkSender的合成接收端已串通：正常一次、UNKNOWN不再领取、冷OAuth后合同暂停零物理请求；不代表企业DWS或钉钉现场联调。

真实试点按本人原DM→指定群@两独立阶段准备，阶段1成功后才另批阶段2；DM私有企业路径无需群DWS，不以群名单缺口整体阻塞DM。现DWS连接仅查询/断开，authorizationEntryAvailable=false；内部enroll不是用户登录入口，不能编授权URL或借个人profile填库。旧CLOSED不重开。精确CI/真实维护恢复/新grant与formal、全消息与真实模型请求硬计数/费用/窗口及群专用Linux DWS仍须闭合；审批材料见reports/real-pilot-approval-pack-20261020。

### 有限本人DM安装与运行接线（2026-10-20增量）

`packages/config/src/finite-private-pilot.ts`提供严格私有profile与稳定pilotKey。`scripts/finite-private-pilot.ts plan --profile <600/700私有文件> --formal-profile <600/700私有文件> --manifest-id <已审核清单ID> --descriptor-hash <完整运行时能力摘要>`仅读两个明确文件，不加载.env/连接数据库。planHash绑定两个文档、不可变当前权限清单ID、完整CapabilityDescriptor摘要和精确schema；权限清单自身的descriptor_hash与完整能力摘要是两种合同，不混用。

`install`另需精确`--expected-plan-hash`和匹配`--review-ref`，之后才读取migrator配置；一事务复用原formal转换并安装一个当前清单/绑定锁定的PRIVATE_USER READ企业grant和有限registry，不改预算、不启动服务、不发送消息。此入口是生产代码，不构成执行批准；当前安装只接受固定CNY0的用户声明企业费用模式，原企业policy的UNKNOWN模式保持兼容，历史UNKNOWN不清除。原formal profile格式不扩字段，服务仍沿用精确原formal attestation，新增有限约束从数据库持久主体派生，删除环境变量不能跳过。

正式测试发现入口登记profile、CLI、发送器及实际PG链路；合成验证覆盖原生GLM HTTP、真实MCP SDK和真实DingTalkSender的fetch替身，真实企业/模型/外发/部署仍未执行。真实运行还须最终提交/CI、实际备份恢复、73起点逐项批准升级、精确新授权/预算和全部物理消息/时限批准；原10分钟只读批准已消费，不重复使用。


2026-10-20 原生备份执行切片（R34/T124仍未完成）：新增独立 `scripts/project-backup.ts plan|backup`（`pnpm operations:backup plan --profile <私有配置绝对路径>`）；plan仅读取私有审核profile并输出摘要，既不读连接/密钥也不连接数据库。backup入口固定现有项目目标并核对精确profile/review/时间窗，使用受审本机PG17客户端、只读held snapshot、独立前后完整inventory、分离密钥的PG/FileStore加密归档，最后才写独占并同步的set回执。总时限覆盖私有输入读取；取消等待直属子进程与归档清理，回执身份来自创建FD，关闭或清理无法确认时明确COMMIT_UNCERTAIN，不覆盖、重试或自动恢复服务。原生恢复内部入口完整认证归档后仅作用于独立预建空库，核目标OID/系统身份并使用一次single-transaction pg_restore及完整inventory比较；它尚未接完生产恢复profile/CLI、恢复点后撤权/删除及外部状态对账。ACL比较将NULL规范化为PG有效默认ACL，保留完整grantor/grantee/权限选项、列ACL及RLS漂移检测。隔离合成schema73 nonce与本机17.11已有实际备份/恢复验证；这不证明真实项目备份、独立集群、WAL/PITR/KMS或生产RPO/RTO完成。真实73和共享合成94均未升级，真实MCP/模型/投递/部署没有新增执行。准确源码指纹及最终批次证据见 `reports/project-backup-driver-20261020/`。


2026-10-20 恢复命令接线补充（R34/T124仍未完成）：`scripts/project-restore.ts plan|restore` / `pnpm operations:restore` 已复用原生认证恢复与FileStore恢复组件。审核配置固定set回执SHA、源schema/集群/数据库与备份profile摘要、两个归档及分离密钥、全新预建目标库OID/集群/连接文件hash、独立文件恢复目录、工具摘要和有限时间窗。私有回执严格解析并交叉绑定，实际FileStore认证回执匹配后才进入PG完整认证，再连接目标；拒绝真实项目/共享测试库/源库作为恢复目标，不创建库或全局角色。任一阶段失败不会重试或覆盖已恢复目标，密文文件保留隔离以便明确核对；取消/超时由总时长与绝对validUntil共同截断，已提交结果不伪称撤回。成功输出`RESTORED_SET_RECONCILIATION_REQUIRED`且禁止恢复服务/外发，应用主密钥恢复仍未验证。隔离验收覆盖真实CLI在销毁自有源库/文件后的同一合成集群新库恢复、错目标/混档、重复、权限配置拒绝、实际文件读取超时与目标连接后取消，执行结果以本批报告为准；这不等于独立集群、恢复后撤权/删除对账或生产RPO/RTO完成。源码和准确执行记录见 `reports/project-restore-command-20261020/`。


## 2026-10-20 恢复后安全差异检测（局部实现）

运维入口 operations:verify-restore 新增 compare-safety --current <私有盘点文件> --restored <私有盘点文件>，只读取两个受权限及大小约束的本地文件；不连接数据库、MCP、模型或钉钉，不执行合并/授权/重启。主路负责整库实际恢复场景与正式测试登记，辅助在独立 worktree 实现比较器/CLI 并窄整合。真实单聊/群试点仍须各自就绪及具体批准；本次差异结果不能替代它们。

2026-10-20 真实试点升级前置继续收口：主独占bounded-migration执行器/CLI/PG集成，辅助仅新增准备阶段真实读取回归（da124d0→52ab3e7）；接口及文件边界见reports/bounded-migration-lifetime-integration-20261020。取消、累计预算、审批窗和结束确认已接入现有单步入口，不另建自动迁移器或启动服务。全仓SQLhash、前驱账本、当前身份/全局RLS、停机、CLOSED/UNKNOWN/撤销和实际事务复核均保留。辅助单测与主自有nonce PG共同验证，不代表真实项目库备份、升级、模型/MCP或钉钉操作已获准。新批准确CI仍需闭环，旧只读批准不重用，旧CLOSED试验不重开。

2026-10-20 运维前置两路交付：辅助仅新增prepare-linux-node-runtime.mjs、类型声明、离线单测及独立报告；主路负责test:prepare接线、实际生产restore/verification bundle、独立PG容器、合成应用密钥核验与统一发现登记。未知create回执不能成为可信ID；所有清理须精确身份复核，失败/超时不虚报销毁，后续source清理和密钥归零仍执行。此验收不读或升级真实73/共享合成94，不使用已经消费的一次只读批准，不新增企业MCP/GLM/钉钉操作或部署；真实试点仍需具体批准。
