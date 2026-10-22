# 权限要求、本人诊断与撤销契约（P04 局部实现）

完整 P00–P14 与 ENTERPRISE_DWS 验收继续有效。此组件不安装平台授权、不启用外部能力、不发消息、不进行真实 DWS/MCP 联调；一次性单聊控制仍优先且未开启真实试验。企业版验收仍未通过。

## 配置与迁移

新增 066 保存不可修改的版本化要求、单调前进的当前版本、本人诊断缓存和不可修改的本人撤销审计。已经应用的 001–065 不变。`schema:refresh` 生成当前 66 个文件的名字及原始内容 hash；应用就绪必须精确匹配该集合。

`config/permission-manifest.json` 是尚未联调的权限参考目录，不是可安装清单。安装输入的唯一执行契约是 `packages/gateway/src/permissions.ts` 的严格 `permissionManifestSchema`：schemaVersion、capabilityId、capabilityVersion、manifestVersion、bindingHash、inputSchemaHash、description、provider、risk、authMode、applicationRef、requiredScopes、resourcePreconditions、officialDocRefs、reviewReference 全部必填；未知字段拒绝。两个 hash 必须来自已审核的绑定及实际注册的输入 schema，不能使用占位值授予权限。描述是供用户识别功能的说明，不得包含凭据或业务正文。

```sh
# 只核对文件格式：不加载 .env，不连接数据库，不表示审核或安装成功。
pnpm permissions:install TENANT_UUID /absolute/path/reviewed-manifest.json --check
# 显式使用 oa_migrator；先完成正常迁移。安装只保存要求，不能创建资源授权或标记能力 READY。
pnpm permissions:install TENANT_UUID /absolute/path/reviewed-manifest.json
```

只有 `oa_migrator` 可通过安装器增加版本；同版本不同内容冲突，旧版本不能回退当前指针。同内容重试保持同一记录。应用与运行角色仅可读，不能直接修改角色、角色绑定、资源授权或新表；066 补上了先前运行角色的角色写入缺口。无生产配置、数据库或真实授权在本次工作中被更改。

## 页面和接口

登录后打开 `/permissions`。GET `/api/v1/permissions` 仅返回本人角色与资源授权，每类最多 50 条，以各自 UUID 游标继续。POST `/api/v1/permissions/resources/:id/diagnostic` 接受严格 `{capabilityVersion,refresh}`；POST `/api/v1/permissions/roles/:id/withdraw` 与 `/resources/:id/withdraw` 接受严格 `{version}`。所有操作均受现有会话、租户、本人和 CSRF/Origin 检查约束；结果标 `private, no-store`。直接页面地址也验证当前会话。页面撤销需要明确确认。

诊断使用真实数据库当前状态和服务器实际注册元信息，核对绑定、要求、授权及 DWS 本地身份、委托期限和模型外发同意。不会读取业务资源、凭据字段或调用工具。缓存为 30 秒；键绑定租户、本人、应用、身份、资源/受众/分类/期限、能力版本、要求/绑定 hash 与版本、authEpoch、政策版本及 DWS 授权/凭据版本。命中前重新读取当前状态并验证会话；等待写入缓存跨过授权期限时重新计算。缓存不被 Gateway 当作执行依据。

`localState=MATCHED` 仅表示这些本地条件匹配；平台始终 `UNKNOWN / NO_CERTIFIED_PROBE / live=false`，`executionAuthority=false`。本地拒绝不意味着已探测平台。缺少实际注册、未审核绑定、错用户/企业、失效委托或资源均保持阻塞。格式不符、伪造执行权或越界缓存结果拒绝返回。

本人撤销仅减少自己的权限：精确 id/version CAS、串行化并发请求、同事务追加脱敏 hash 链审计、清缓存并递增 authEpoch。全部旧本人会话和旧执行租约失效，页面清除已显示资料并要求重新登录；其他用户不受影响。它不是定向任务取消功能，也不会撤销平台端凭据。重新登录后重复撤销不重复记审计。后续已增加租户管理员的 PRIVATE_USER 本地资源授权 API 组件和 115 本地角色分配组件，见下文；委托签发/轮换、恢复窗口内重派、完整生命周期和平台端撤销尚未完成。

## 实际验证与限制

仅在 127.0.0.1:64711 的新增合成记录上操作；测试网络守卫移除企业凭据。原角色越权写入反例在修前 4 项失败，066 后被真实 PostgreSQL 拒绝。真实数据库测试包括缓存依赖变化、到期锁等待、20 次并发撤销、分页、跨用户/租户、CSRF、旧 Gateway 租约拒绝；Chrome 桌面/手机验证本人页面和撤销流程。命令、失败历史、源码指纹、完整脱敏输出及最终结果见 `reports/p04-permissions-candidate.json` 和 `reports/checks/p04-permissions-*.json`。

已注册能力的完整 CapabilityDescriptor 与输出 Schema 约束已经实现；诊断缓存的本人128份上限、共享持久限速和过期分批维护也已实现。它们不代表新增提供者已获审核或平台授权。仍缺上游认证只读探测与核对、NOT_APPLIED 证明及新批准后的明确重试、完整10000组合 Gateway 授权矩阵和角色/委托全生命周期。现有 `chat` 的公司主体/资源只读契约和真实企业验收继续标 `BLOCKED_EXTERNAL`。不得用局部测试替换 T036 或任意 LIVE 验收项。

角色审批作用域采用持久 Action 上下文：RESOURCE 匹配资源、TASK 匹配所属任务、USER 匹配请求者、GROUP 匹配真实执行/操作群；存在另一个群时拒绝单群角色审批。CAPABILITY/CONNECTOR/TENANT 继续按各自命名空间匹配。审批可见性、合格审批人、请求、预览、决定、Gateway 消费和派发前复核、UNKNOWN 控制台及核对都使用相同数据库函数。旧无类型上下文函数不推断 TASK/USER/GROUP。

067 的成功角色 INSERT 使接收人 auth_epoch 递增，旧会话/任务租约失效；ON CONFLICT DO NOTHING 不递增。移动角色同时使原接收人和新接收人失效，保留绑定 version 递增。115 在此之上提供受限角色分配、续期与撤销；仍不提供企业委托签发/轮换、GROUP 治理、平台角色同步或真实平台授权，P04 完整生命周期仍待交付。

## 后续已实现组件与剩余对账边界

074–076仅增加本地诊断缓存边界、共享限速及运行角色的元数据维护，不扩大执行授权。077–083增加 `/api/v1/permissions/admin/resources` 的新授、续期、撤销及显式重授：当前数据库租户管理员会话、精确目标、版本CAS、完整Descriptor/独立manifest/认证模式绑定、不可变幂等回执与本人审计。旧reader不能读取managed授权；试验/正式profile或对应持久记录不能借此取得租户管理权限。资源组件本身不包含GROUP治理、角色分配或委托；角色分配由115独立组件提供。两者都不授予供应商授权、模型出域或写审批。

115 增加本地角色绑定管理（2026-10-22）：`/api/v1/permissions/admin/roles` 的列表、分配、续期与撤销仅服务当前数据库 `TENANT_ADMIN/TENANT` 会话。可分配角色限于 `TENANT_ADMIN`、`ACTION_APPROVER`、`SECURITY_OPERATOR`；范围限于 `TENANT/CAPABILITY/CONNECTOR/RESOURCE/TASK/USER`，`GROUP` 仍由群合同流程治理。分配与续期必须提供不超过 366 天的到期时间；TASK/USER/CAPABILITY 范围核对当前本地记录，资源/连接器范围使用有界标识。续期/撤销要求受管绑定、精确 version CAS 和审核引用；撤销拒绝移除最后一个有效企业管理员。每次成功写入追加同一员工 hash 链事件并保存不可改的幂等回执；本人操作按既有规则递增 auth_epoch、清诊断缓存并使当前会话需要重新登录，回执重放另列 currentVersion/currentState，不把历史回执当当前状态。页面仅展示元数据，平台权限始终标为尚未核实；系统不签发/轮换企业委托、不同步平台角色、不治理群成员，也不恢复任务或执行动作。

这些组件的准确实现及证据见 `reports/permission-administration-20261018`、`reports/permission-role-administration-20261022.json` 和 `reports/self-dm-closure-20261018/permission-{cache-bounds,rate-limit,cache-maintenance}.json`。c7d042f对应CI的1286项、受控单聊2项和管理策略分支95%已确认通过；完整需求仍FAIL126，依赖审计跳过，不构成整体P04/R08验收或真实操作批准。后续源码增量另行绑定验证。

目前 `ControlPlane.beginReconciliation/attestReconciliation` 仍只有当前安全角色及会话绑定的人工声明：APPLIED最多成为APPLIED_UNVERIFIED，人工NOT_APPLIED继续保持UNKNOWN，所有结果均 `retryAllowed=false`。已有 `Capability.verify` 仅用于写入返回OK后的验证，不能当成UNKNOWN无回执时的未执行证明。认证只读对账必须独立审核并绑定能力/参数/资源/身份/权限及当前版本，经过真实读取取得证明；缺失、异常或不完整读取保持INCONCLUSIVE，不能据空结果或人工文字解锁重试。

2026-10-18写审批补强：新scope绑定完整Descriptor摘要；旧v2无合格摘要的记录不自动采用当前声明，也不能另生成写申请。单次调用固定声明/回调，准备、派发和结果边界重验；发生过效果但声明漂移时保持UNKNOWN。后续同一run/能力/版本的已记录写意图不能改称READ来绕过历史，新请求拒绝且原状态不变；独立只读能力不受影响。该改动无新迁移，不补写旧记录，不改变本人试验工具禁令或旧窗口。源码与分步失败/回归证据见 `reports/approval-descriptor-20261018/local.json`；完整main集成CI尚待绑定，不据局部通过标记R08/P04完成。

2026-10-18新增可选 `CertifiedReadBacks` 私聊组件和认证read-back入口：独立审核人需要自己的READ资源授权，原执行人当前写授权也必须保留；绑定完整写契约与审核过的终态操作账本。当前生产没有注册/启用任何真实适配器，默认拒绝且不发请求。受控测试读取真实隔离PostgreSQL终态夹具；EMPTY/错绑/撤销/超时均不认证，核对case证据加密。原Action仍UNKNOWN，run不恢复，retryAllowed始终false；新批准/明确本人重试、真实只读探测、群与完整P04仍未完成。T117对应实际失响应写入/独立核对/不重试测试，不将局部证据标为LIVE或完整可靠性验收。
