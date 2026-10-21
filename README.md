# open_aider

需求、架构、接入和验收以 `docs/` 的四份基线为准。项目正在逐阶段实施；这不是已通过企业验收的成品。机器状态见 `config/stages.json`，外部阻塞见 `config/external-blockers.json`。报告中的合成 provider 结果不能作为 live 通过证据。

## 开发环境

使用 Node **24.21.0**、pnpm **10.34.7**、Docker。版本漂移会被应用拒绝；不要使用本机默认 Node 25。所有秘密仅从忽略提交的 `.secrets/` 读取，生成的是随机本地测试秘密。

```sh
pnpm install --frozen-lockfile
pnpm setup:dev
docker compose -f deploy/compose/compose.dev.yml up -d --wait postgres
pnpm db:migrate
pnpm db:seed:test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:prepare # 专用临时测试数据库，端口 53331，不读取 .env
pnpm test
pnpm test:e2e
pnpm dev
# 前端独立开发预览需要把 API 的 APP_ORIGIN 配置为 http://localhost:52331
# 另一个终端：前端开发预览，代理到 API
pnpm dev:web
# 另一个终端：持久队列/原生模型运行时
pnpm start:worker
# 已配置机器人身份与真实测试资产后，独立启动消息投递进程
pnpm start:notifier
```

API 使用 `127.0.0.1:52330`，数据库使用 `127.0.0.1:53330`；前端开发预览使用 `52331`。`/api/v1/health/live` 与 `/api/v1/health/ready` 分开检查。没有模型密钥时 worker 将真实记录 `WAITING_AUTH`，不会返回假模型回答。没有钉钉应用配置时 `start:ingress` 拒绝启动，不使用已有员工 CLI 登录替代机器人身份。已实现浏览器 OAuth、一次性 state、企业与目录身份匹配和任务工作台；真实 OAuth 仍需企业回调域名及已核验目录，已实现安全状态卡、750ms合并和会话确认的取消流程；真实模板与权限仍须验收。可先执行 pnpm tenant:register 建立本地租户命名空间，此操作不会创建用户、授予角色或验证平台授权。构建后的工作台由 API 在 52330 同源提供。

`oa_app`、`oa_runtime`、`oa_queue` 分离；迁移身份仅用于一次性迁移/测试种子。RLS 按租户与所有者约束私人行。pg-boss 结构属于显式迁移，队列运行时不执行升级。迁移只允许追加，不修改已经执行过的文件；回滚采取兼容旧代码或新修正迁移。

```sh
pnpm verify:requirements --baseline  # 仅校验 36 需求/130 用例目录完整，不能表示功能完成
pnpm verify:requirements             # 全量实现门禁，未完成时必须非零
pnpm run doctor --profile ENTERPRISE_DWS # 配置和真实数据库诊断；配置存在不等于已真实联调
pnpm verify:release --profile ENTERPRISE_DWS # 缺任何必需证据都拒绝发布
```

`.env.example` 是变量索引。真实凭据需通过受控 secret mount 提供；不要粘贴进代码、测试报告或聊天。企业测试资源、审批、外部写入和清理按文档 04 执行。生产部署、沙箱、全部办公能力和最终验收仍在后续阶段，开发镜像不能据此视为生产就绪。

现有 `.env` 可使用 `DINGTALK_APP_KEY/SECRET` 和 `AIDER_AI_DEFAULT_BASE_URL/API_KEY/MODEL`，项目会映射到规范名称；显式规范变量优先，secret mount 优先于明文变量。默认模型仍严格限定为 `glm-5.3-flash`。凭据存在仅表示已配置；真实验证和企业测试资产仍单独核验。

自动化测试只使用 `.data/test-environment/` 下独立生成的测试配置和专用临时 PG 实例，不加载仓库 `.env`，不继承企业 provider 凭据。测试入口默认拦截未声明网络目标，只允许测试数据库 53331 和浏览器测试服务 52339 的回环连接；这是 Node 进程保护，生产沙箱的网络隔离仍属 P13。浏览器使用本机 Chrome；OAuth 导航在测试内拦截，合成 OAuth 通过不计为企业联调。

卡片配置通过 `DINGTALK_CARD_TEMPLATE_FILE` 指向受控 JSON，必需字段为 `templateId`、`statusKey`、`taskUrlKey`、`cancelTokenKey`，后三者对应企业已审核模板的变量名。模板取消回调传入 `cardPrivateData.params.action=cancel` 和该卡的 `token`；服务器只返回当前用户私有的 `actionUrl`，实际停止须在 H5 登录并确认。审批通过独立的会话审批流程处理，不接受取消回调充当批准。缺模板或明确权限拒绝时保留文本投递；未知卡片发送不会自动重做。`FINALIZED_UNVERIFIED` 只表示平台接受最终更新，不表示已核验送达。T007 已由原生 SSE 解析器的100个分片驱动安全进度、750ms卡片合并和最终更新的本地协议链路验证；模型和钉钉 HTTP 使用明确替身，真实模板/平台送达仍待企业联调。

运行时重试已持久保存到期时间与代次；worker 的发布循环负责恢复到期任务及失效租约。队列键包含代次，旧消息不能绕过新的等待期。SIGTERM 保存可恢复状态，SIGKILL 由租约恢复；在途外部动作未知时转人工核对。重试不重置模型轮数或工具账本，Retry-After 超出任务有效期时任务到期终止。

附件入口支持机器人 `text`、`picture`、`richText`、`file` 消息；单次最多 8 个附件、单文件最多 8 MiB。`FILE_STORE_ROOT` 指向加密文件卷（目录 0700、文件 0600），API 与 worker 必须共享该卷和同一密钥。`ATTACHMENT_DOWNLOAD_HOSTS` 必须填写管理员核验的精确 CDN 主机，逗号分隔，不接受通配符；未配置时记录需要配置，不会伪造下载成功。每个重定向和 DNS 地址都重新检查，连接固定到已检查的公网地址；应用 token 只用于钉钉官方地址换取下载 URL。

当前仅校验通过的惰性 UTF-8 文本、Markdown、CSV、JSON 可进入 READY。可执行内容、压缩文件、图片、PDF 和其他复杂格式保留 QUARANTINED，不会解压或发送给模型；完整二进制检查与隔离解析仍待 P09/P13。默认附件密级 CONFIDENTIAL。模型正文读取必须同时具有审核过的 `attachments.read_text@1.0.0` 绑定和当前用户针对该附件的显式外发授权；P04 管理授权界面尚未完成，不能以自动授权替代。工具每页最多 8192 个 UTF-16 单元，返回下一页位置和明确的截断状态。

附件缓存和原生会话日志均加密。每次缓存复用、后续模型请求、结果提交、消息投递和登录后下载都会重查当前权限、来源版本、有效期与密级。权限或资料版本改变时，当前会话停止使用旧资料并建立安全新会话；未到期的原始日志保持不变。新会话只保留重新授权通过的证据和动作记录。最终结果和投递继承所用附件的最高密级，并受当前接收范围上限约束。经审核的纯读取可在进程中断后恢复，新租约阻止旧回调覆盖结果；未知写入仍转人工核对。

机器人文字消息 `停止`、`停止任务`、`/stop` 进入确定性控制流程，不调用模型。只有当前已核验会话中属于发起人的任务可以被停止；多个候选时先展示任务编号，使用 `停止 <完整任务编号>` 选择。回执和取消在同一事务持久化，重复事件只有一份回执，不生成模型队列项。取消阻止后续工具领取及待发送结果；在途动作和 UNKNOWN 仍须核对，不能冒称已撤回。群中只发送安全的请求确认，私人候选和具体结果在工作台查看。

模型流进度仅持久化尝试编号、租约序号、单调分片序号及内容/工具分片计数，不保存正文、工具参数或推理。原生解析器把安全计数交给运行时，运行时合并到进度表，独立 notifier 从固定状态词表生成卡片文案。断流后保留 INTERRUPTED，并在受控重试中创建新尝试；旧尝试不能覆盖新序号。卡片最终更新仍仅标记 FINALIZED_UNVERIFIED，平台接受不等于送达核验；UNKNOWN 不自动重复发送。

卡片 429 的 Retry-After 支持秒数与 HTTP 日期，按完整截止时间等待，不截短超过60秒的等待；截止时间达到任务到期时间时抑制后续卡片更新，并保留任务记录。

上下文恢复已实现结构化 checkpoint。会话内容超过 48000 字节（保守输入估算的一部分）、日志到期或资料授权变化时，系统创建新 provider session，不复制原始 reasoning。checkpoint 保留原始用户目标、全部动作状态、当前重新核验的事实和明确的未决/省略项；动作参数、checkpoint 和日志均加密，账本不随会话重置。事实体积超限时完整省略并说明原因，不能截断后冒称完整。每个 run 最多 32 个会话，模型轮数和工具次数继续累计；全请求层级成本/时长预留和通用结论核验仍待 P03 后续实现。

UNKNOWN 或未核对的在途写入在恢复后转人工核对，不能自动重做；待审批动作保留并暂停；已批准动作通过原运行和加密参数恢复，当前权限或动作范围改变时重新审批。纯读取只有显式认证后才可重新领取。已验证写入通过原动作键复用结果；没有可靠来源的旧账本条目只保留状态，不能编造事实。未到期密文不可验证时暂停而非重置任务；到期日志在安全新会话提交时清理。

附件依赖按 run 和 provider session 保存，最终通知固定绑定产生它的原会话。新会话不再使用的旧资料仍保留审计记录；旧通知继续受原资料权限约束。错误的 run、所有者、任务或会话来源均拒绝；无法可靠绑定的历史待发通知被抑制，未知在途发送仍须核对。工作台只显示恢复原因及动作/证据/省略数量，不返回 checkpoint 密文或原始推理。任务列表按创建时间倒序，以 UUID 游标稳定分页。

P04 已接入会话审批与动作账本。工作台可查看自己的动作、选择当前符合资源或连接器范围的审批人；审批人在“待我审批”中先核对安全预览与接收范围，再批准或拒绝。批准绑定动作参数摘要、实际操作接收范围、精确到期时间、权限/策略版本、审批资格与当前登录会话，短时一次性凭证只供指定审批人使用。批准仅表示允许执行；系统重新排队原运行，领取时再次检查全部权限与预算，结果读回核验后才标记 VERIFIED。过期且未使用的批准可以重新申请，历史记录保留。

API 的控制面需要 `RUNTIME_DATABASE_URL` 与 `APP_MASTER_KEY`；缺少时控制接口真实返回 503。审批角色为 `ACTION_APPROVER`，停止和人工核对角色为 `SECURITY_OPERATOR`，由企业受控身份管理配置 `role_bindings`，不能通过自助申请授予自己。支持 TENANT、CAPABILITY、CONNECTOR 和资源范围；CONNECTOR 对应登记的具体连接器 ID，不能以 MCP/DWS 家族名冒充。角色撤销使用 `revoked_at`，同步提升权限版本并注销旧会话。角色管理界面及完整委托生命周期仍待 P04 后续交付。

停止接口为 `POST /api/v1/controls/kill-switches`，需要登录、CSRF 和当前安全操作资格，参数包含 scopeKind（TENANT/CONNECTOR/GROUP/USER/TASK）、scopeId、mode（ALL/WRITES）、enabled、reason，以及可选 expiresAt（最多24小时）。每个签发人的开关分别持久化；其关闭操作不会清除他人的开关。模型请求、工具、卡片和投递会检查开关；P08 尚未实现的调度器后续必须接入相同检查。已发出的外部请求仍须核对。

UNKNOWN 人工核对使用 `POST /api/v1/actions/:id/reconciliation-sessions` 获取绑定当前安全操作人会话的一次性凭证，再调用 `POST /api/v1/reconciliations/:id/attestation` 提交 nonce、argsHash、claim（APPLIED/NOT_APPLIED/INCONCLUSIVE）和 evidence。核对人必须与任务发起人不同。证据加密保存，审计只存摘要；人工声明 APPLIED 只能转 APPLIED_UNVERIFIED，NOT_APPLIED/INCONCLUSIVE 仍保留 UNKNOWN，均不自动重试、不标记 VERIFIED。连接器的只读核对器、获证实未执行后的显式重试流程仍待交付。已实现安全控制台的人工声明界面，尚未实现连接器自动读回核对。

新增本地回归入口：

```sh
pnpm test:prepare
node scripts/run-tests.mjs vitest run tests/integration/controls.test.ts
pnpm test:coverage
pnpm test:e2e
```

这些测试使用真实隔离 PostgreSQL、真实会话审批 HTTP 接口和真实 Chrome；模型、钉钉和 MCP 传输使用明确的合成测试接口。测试通过不代表企业审批、平台送达或真实业务读写验收通过。P04 权限诊断中心、10,000 组 Gateway 组合、P03 分层预算与通用结论核验，以及 P05–P14 仍需继续完成。

具有当前 `SECURITY_OPERATOR` 资格的用户可从工作台进入 `/controls` 安全控制台。直接访问页面和控制台数据接口都会重查会话与角色；未登录返回401，无资格返回403。只列出当前授权范围的开关和非本人 UNKNOWN 动作，未知动作列表支持游标分页且不返回私人参数、结果正文或证据密文。停止开关按范围类型精确鉴权，群权限不会因为编号同名而变成用户或任务权限。用户只能关闭本人签发的开关，其他管理员的开关继续独立生效。

安全控制台提供加密人工依据与三种声明：声明已发生只变为 APPLIED_UNVERIFIED；未发现执行或无法判断均继续保留 UNKNOWN，不代表已经证明未执行，不触发自动重试。已经 UNKNOWN 的写入也会阻止同一运行中的其他新写入；明确只读的诊断仍可使用。并发恢复测试通过真实 HTTP 批准、20 个原运行消息和旧代次消息争抢租约，真实隔离 PG 副作用仍只有一次。连接器的认证只读核对器、可证明未执行的终局证据和新批准后的显式重试仍需后续实现。


人设组件已接入工作台“助理偏好”及原生设置指令：`把我的助理切换为SRE`、`把本群助理语气改为正式`、`/persona personal set {"tone":"DIRECT"}`。范围不明时不保存，需重述完整请求；个人设置只在单聊，企业/群设置仍按实际角色授权。新任务冻结新版本，已有任务保留原快照；普通修改与撤销分别处理。P07仍IN_PROGRESS，长期记忆、隐私删除和完整业务工作指导尚未完成。迁移044–046及定向/完整证据见四份基线的P07进展和reports/p07-persona-candidate.json；组件PASS不等于企业版验收PASS。
