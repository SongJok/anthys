# 数据库版本与维护进程就绪契约

当前发布要求 `packages/storage/src/required-migrations.json` 中的 001–068
迁移名称及 SHA-256 完整匹配。契约哈希为
`d978a59bea0867995aa90284f27f7beb2c1eb0e582e5c7001e02fa82894aa621`。
运行时读取固定的 `public.schema_migrations`，拒绝缺失、错哈希、替代条目及
未经当前发布契约确认的未来条目；临时表/search_path 不能代替该权威表。
这是当前版本的精确集合策略，不能把“至少有一条迁移”解释为就绪。

构建先执行 `schema:check`；SQL 文件或迁移集合与发布契约不一致时构建失败。
经审查修改迁移集合后，开发者使用 `schema:refresh` 更新版本工件。
这两个命令只读写源码工件，不连接数据库，不执行 SQL。运行时使用随编译包
发布的 JSON，不依赖镜像内存在 SQL 源文件，也没有自动迁移或环境变量绕过。
旧应用遇到未来迁移会拒绝就绪；部署前必须明确审查应用/迁移兼容及发布顺序。

API 的 liveness 保持只表示事件循环可响应。schema 不匹配或查询失败时，
readiness 返回 503 和通用 `database/schema` 依赖信息；不公开迁移或私有内容。
该检查不认证队列、所有配置、外部能力或完整生产运行状态，这些仍属后续验收。

维护进程先验证 schema，再检查一次性试验禁用规则，最后完成首次清理周期。
三个步骤成功后才发布 READY；每个后续周期在清理前再次验证 schema，漂移或查询失败即停止。任一操作失败立即发布 FAILED，记录固定操作名、
0 起始 scopeIndex、`SHA256(tenantId + ':' + actorId)` 前 16 位 scopeRef 及允许列表
中的 SQLSTATE/固定原因码。原始异常消息、堆栈、SQL、主体 UUID 和私有正文不进入
CLI 日志。不能把未知异常的任意 code/message 当作安全日志。

失败后仍可完成同轮中独立的显式主体/清理操作，随后关闭数据库并以退出码 1
结束；不会继续下一轮或重新宣告 READY。scope 文件最多 10000 项，每次数据库
操作沿用已有的 20 秒 statement timeout/5 秒 lock timeout；整个周期没有另设
总时限。生产监督、退避及告警仍需单独验收。

正常停机等待在途操作结束。失败不能被停机覆盖成成功或 STOPPED。维护模块导入
等待启动门并以固定安全原因拒绝，不改宿主退出码；实际 CLI 捕获该拒绝并退出 1。
原一次性单聊 ARMED/CLOSED/缺失/变化 profile 的禁维护及零企业初始化断言保留。

私有记忆维护支持已存在的离职/停用主体及停用租户，只处理其显式同意过期或
保留账本下的精确修复，不恢复私有读取或业务权限。USER persona 仍要求保留的
privacy state/generation 和匹配账本。整库备份导致账本/状态丢失、独立删除日志
重放、实际备份保留期、180 天元数据清理、物理抹除及生产迁移/部署仍未完成。
schema 就绪不证明这些数据恢复与删除要求已完成。

历史就绪修复没有新增 SQL；当前 P04 增加066权限管理迁移，001–065保持原样。只在隔离的
`127.0.0.1:53331/open_aider_test` 验证：迁移元数据反例均为事务内改动并回滚；
维护错误只针对新建合成主体，用既有事务内恢复故障工具复现，不修改用户库权限。
没有运行真实企业服务或启用单聊试验。

```sh
pnpm schema:check
pnpm typecheck
pnpm lint
pnpm build
node scripts/run-tests.mjs vitest run tests/integration/schema-readiness.test.ts tests/integration/maintenance-health.test.ts tests/unit/maintenance-supervisor.test.ts tests/unit/schema-contract-build.test.ts tests/integration/one-shot-startup.test.ts tests/integration/inactive-private-maintenance.test.ts tests/integration/identity.test.ts --maxWorkers=2
```

使用锁定 Node 24.21.0/pnpm 10.34.7。执行命令、有效业务红例、夹具失败、启动回归、
最终源码/编译工件绑定及未完成验收范围见 `reports/schema-maintenance-candidate.json`。
局部测试不与历史重叠用例相加，也不冒充本候选全量或企业版通过。

067 补齐 Action 类型化角色权限及角色新增/移动的快照失效。草稿正例曾因 SQL 别名遮蔽被拒绝；只重建专用可丢弃合成库后验证修正版本，未改已交付001–066或企业库。


068 修复迁移登记表的应用写权限。001–067 字节保持不变；068 仅撤销
`oa_app/oa_runtime` 对 `public.schema_migrations` 的 INSERT/UPDATE/DELETE。
PG17 同时撤销这些角色对应的直接列权限；不扩大到其他角色、其他表或角色密码。
已有 SELECT 保留。新建的 `oa_schema_ledger_read_only()` 是 SECURITY INVOKER、
固定 pg_catalog 搜索路径的元数据谓词，PUBLIC 不得执行，仅 app/runtime 可执行。
若其他角色的继承权限、PUBLIC 或 SET ROLE 路径仍允许表级/列级写入，068 以 42501 拒绝，
整文件事务回滚，由管理员审阅现存授权来源；不自动撤销其他角色或关闭 RLS。

当前就绪检查在同一 SQL 快照核对精确迁移集合及上述有效权限。schema67、函数缺失、
列授权、PUBLIC、所有者或非继承 SET ROLE 的写权限回退都会使 API 返回 503。此检查不对可信数据库
管理员作出的对象替换提供完整目录证明，也不代替恢复演练、数据转换和部署验收。

实际权限测试使用独立53331合成库，保留原断言和失败历史。原始红例是应用角色可
实际 INSERT 且旧就绪检查忽略写权限；草稿中误认为直接列授权会在表级 REVOKE 后
保留的夹具已更正为其他角色上的继承列授权，原拒绝/回滚断言保留。私有旧测试源码
快照使用 `.snapshot` 后缀，防止被当作当前测试收集。完整结果以
`reports/ledger-authority-candidate.json` 为准；冻结067演练及其权限缺陷记录不改写为068通过。

PostgreSQL17官方契约：
https://www.postgresql.org/docs/17/sql-revoke.html 、
https://www.postgresql.org/docs/17/functions-info.html 。

所有者即使自行撤销普通DML仍可重新GRANT，故谓词明确拒绝app/runtime可通过USAGE、SET或ADMIN OPTION到达的登记表owner；同时拒绝可ADMIN再授权的其他写角色。不自动改owner或成员关系。来源：https://www.postgresql.org/docs/17/ddl-priv.html 。
