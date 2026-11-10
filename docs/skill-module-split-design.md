# 技能模块拆分设计（Skill Module Split）

状态：P2-a ~ P2-f 已实现并合入本地测试；C-1 ~ C-3 基础设施已实现并实机验证；P3-A ~ P3-C 已导入 13 个市场技能（P3-D 量化研究因来源不明待决）。
配套文档：[skill-market-import-matrix.md](./skill-market-import-matrix.md)（外部技能兼容矩阵与导入 runbook）。

> 本文第 1、2 节描述的是**改造前**的现状，作为立项依据保留；第 3 节起是落地方案，与代码一致。行号会随重构漂移，以符号名为准。

## 1. 为什么要拆模块

### 1.1 目录清单已经溢出，这是最硬的理由（改造前）

技能清单是拼进 system prompt 的，预算写死在 `src/skills/SkillService.ts:27-30`：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `DEFAULT_CATALOG_LIMIT` | 20 | 最多列 20 个技能 |
| `OVERFLOW_CATALOG_LIMIT` | 12 | 候选超过 limit 时反而只列 12 个 |
| `DEFAULT_CATALOG_MAX_CHARS` | 1200 | 整个"## 可用技能"段的字符预算 |
| `DEFAULT_ENTRY_MAX_CHARS` | 80 | 单条技能行截断到 80 字符 |

渲染逻辑在 `src/skills/SkillService.ts:280-323`：每条是 `- {name}：{description}。适用：{whenToUse}`，截到 80 字符，超预算就 `break`。`catalogLimit` 由 `SKILL_CATALOG_LIMIT` 驱动（`.env.example:293` 当前设为 30，代码默认 20），经 `src/index.ts:668` 注入。

当前 21 个技能的实算：`ranked.length = 21 ≤ 30`，不触发 overflow，`target = 21`；但 80 字符/条 + 1 换行，1200 预算只够约 14 条，循环在 `budget` 耗尽处 `break`。**所以现在已经有约 7 个技能在 system prompt 里不存在**，只能靠 `skill_search` 碰运气。

导入 17 个外部技能后变成 38 个：`ranked.length = 38 > 30` → `target = min(OVERFLOW_CATALOG_LIMIT=12, 30) = 12`，只尝试渲染 12 条，**约 26 个技能完全不可见**。技能越多，可见的反而越少——这是 `OVERFLOW_CATALOG_LIMIT` 的反向激励。

结论：不引入模块这一层，加技能就是在降低技能命中率。模块的价值不是"好看"，是让清单可以**两级渲染**——用一行模块摘要换掉 N 行技能明细。

### 1.2 次要理由

- 外部技能需要能整模块启停/替换/升级，扁平目录做不到批量治理。
- 控制台目前只有 source 筛选（`web-console/src/pages/SkillsPage.tsx:89,111`），38 个技能平铺不可维护。
- 路由打分（`src/skills/SkillRouter.ts:61`）目前只吃自由文本 tags，没有"这个请求属于哪个领域"的粗粒度信号。

## 2. 现状约束（改造前，改造必须尊重的事实）

| 事实 | 位置 |
| --- | --- |
| 扫描只认"根目录下一层 = 一个技能"，不支持嵌套 | `src/skills/SkillRegistry.ts:390-411` |
| `scripts`、`node_modules`、`__pycache__` 等目录被跳过，不进 resources，`skill_read` 读不到 | `src/skills/SkillRegistry.ts:19-25`、`:341` |
| SKILL.md 整文件上限 65536 字节，超了直接 `loadError` | `src/skills/SkillRegistry.ts:15`、`:478-482` |
| frontmatter 必填 `name`/`description`(≤160)/`version`(semver)/`when_to_use`(≤200)，可选 `tags`/`allowed_tools`/`risk`/`visibility`/`max_instruction_chars`(1000-8000) | `src/skills/SkillRegistry.ts:228-276` |
| 单次注入正文上限 `max_instruction_chars`，超了截断并生成大纲 | `src/skills/SkillService.ts:353-370`、`:118-146` |
| `SkillSource` 是三元枚举 `builtin \| local \| plugin`，硬编码排序 | `src/types/skills-plugins-projects.ts:10`、`src/skills/SkillRegistry.ts:414-418` |
| `skills` 表无 module 列，`source` 是 `varchar(16)` | `src/db/skillSchema.ts:18-36` |
| 扫描根在启动时构造：builtin/local 两根 + 已启用插件的 `getSkillRoots()` | `src/index.ts:646-666`、`src/plugins/PluginService.ts:435-473` |
| 目录来自环境变量 `SKILLS_BUILTIN_DIR` / `SKILLS_LOCAL_DIR` | `src/index.ts:557-564`、`.env.example:284-303` |
| 只有 `source === 'local'` 的技能可以在控制台编辑 | `src/skills/LocalSkillManager.ts:264-269` |
| tags 已被路由器当搜索关键词，改成分类语义会破坏现有打分 | `src/skills/SkillRouter.ts:61` |

## 3. 方案：目录分层 + module 字段（双真相，目录优先）

### 3.1 目录结构

```
skills/
  builtin/                    # source=builtin，随仓库发布，控制台只读
    office/<name>/SKILL.md
    engineering/<name>/SKILL.md
    ...
  market/                     # source=market（新增根），外部导入，可整目录替换
    finance/<name>/SKILL.md
    code/<name>/SKILL.md
    ...
  local/                      # source=local，控制台可编辑，保持扁平不分模块
    <name>/SKILL.md
plugins/<id>/skills/<name>/   # source=plugin，保持扁平，模块由插件自身承担
```

module 命名规则：`^[a-z][a-z0-9-]{1,31}$`（`SKILL_MODULE_PATTERN`）。保留字 `builtin`、`market`、`local`、`plugin` 不可用作 module 名，避免与 source 混淆；非法或保留字的目录会被跳过并记 warn，不会静默吞掉技能。默认模块 `other`。**模块名不得与其下任一技能同名**（见 §4）。

### 3.2 扫描器改造（`src/skills/SkillRegistry.ts`）

在 `scan()` 的目录收集处（`:390-411`）加一层判定，**最多下探一层**，不做无限递归：

```
对 root 的每个直接子目录 D：
  D/SKILL.md 存在            → D 是技能目录（老式扁平），module = D 内 frontmatter.module ?? 'other'
  D/SKILL.md 不存在          → D 是模块目录，遍历 D 的子目录 E：
                               E/SKILL.md 存在 → E 是技能目录，module = D 的名字
                               否则跳过并记 warn
```

- `SkillScanRoot` 增加可选 `modules?: boolean`，只对 `builtin` 和 `market` 根开启，`local` 与 `plugin` 根保持旧行为，把改动面关在两个根里。
- 沿用 `resolveInside()`（`:311-321`）做符号链接逃逸校验，模块层和技能层都要过。
- 技能 `id` 规则不变（`builtin:<name>` / `market:<name>` / `plugin:<id>:<name>`），**module 不进 id**，这样模块重命名不会让 DB 里的启用状态失效。
- `markNameConflicts()`（`:426-441`）跨模块同名仍然报冲突——技能名在全局必须唯一，否则 `use_skill` 无法按名字定位。

### 3.3 字段与存储

- frontmatter 增加可选 `module`（`validateFrontmatter`，`:228-276`）。**目录名与 frontmatter 冲突时以目录名为准**，并写 `loadError` 之外的 warning，避免出现两处真相。
- `SkillDefinition` / `SkillFrontmatter` / `SkillAdminView` / `SkillCatalogEntry` 增加 `module: string`（`src/types/skills-plugins-projects.ts`）。
- `skills` 表增加 `module: varchar('module', { length: 32 }).notNull().default('other')` + `skills_module_idx (module, enabled)` 索引（`src/db/skillSchema.ts`）。项目没有提交 migration 文件，走 `pnpm db:push`（`drizzle.config.ts` 里 `strict: false`）；旧行按 default 落 `other`，`SkillService.reload()` 扫描后按真实目录纠正，`SkillStore.sync()` 的 `onConflictDoUpdate` 必须覆盖 `module`，否则技能会停在旧分组里。
- `SkillSource` 枚举增加 `'market'`，同步 `SkillRegistry` 的排序表（builtin 0 / market 1 / local 2 / plugin 3）；排序再按 `module`、`name` 二级排，保证同模块技能连续。

### 3.4 路由（`src/skills/SkillRouter.ts`）

- `MODULE_ALIASES` 给已落地的 5 个 builtin 模块登记中文别名（office/engineering/data/meta/general），query 命中别名给该模块下**所有**技能加 `MODULE_ALIAS_BONUS = 2`。导入市场技能后又补了 `testing`/`finance`/`other` 三个别名。
- **一个模块只加一次分**，否则"数据分析"同时命中"数据"和"分析"会把整组顶到最前。
- **tags 的现有关键词打分逻辑不动**，module 是新增的独立信号，避免回归；`projectId` 命中 tags 加分的既有行为保留。
- 未登记别名的模块（如导入后的 `finance`）不参与加分——**导入市场技能时必须按同样格式补上新模块的别名**，否则新模块只能靠单个技能的 tags 被搜到。

### 3.5 目录清单两级渲染（核心收益）

改造 `buildCatalog()`（`src/skills/SkillService.ts:280-323`）：

```
## 可用技能
当任务匹配时，先调用 use_skill 加载完整步骤；不要凭名称猜测内容。

- finance（1）：multi-strategy-quant-research
- code（6）：production-code-audit, analyze-code, bug-review, prompt-optimizer, code-quality-analyzer, frontend-dev
- testing（6）：systematic-debugging, debug-assistant, automation-testing, ...
...
### 本次可能相关
- production-code-audit：逐行审计代码库并给出生产级改造项。适用：要求"上生产/审计/企业级质量"时
- sql-database-optimizer：查询计划、索引与 N+1 诊断方法。适用：慢查询、索引、执行计划
```

规则（已实现）：
- 第一级只列 `- module（真实数量）：技能名, …+N`。每行宽度**自适应**：`clamp(60, 160, floor(摘要预算 / 模块数))`，模块少时给足宽度、模块多时收窄。技能名按 router 分数依次取，逐级降档 `8 → 5 → 3 → 2 → 1` 直到整行放得下；**只按整名截断**，切一半的名字会被模型直接拿去 `use_skill` 然后报"技能不存在"。每行只留一个名字仍放不下时，才按预算丢掉排在后面的模块。
- 括号里的数量取**模块真实规模**（router 返回的全部匹配），不是被 `catalogLimit` 截断后的数量；点名只点进入 `catalogLimit` 的那些，避免出现"（4）其实有 5 个"。
- 第二级只对 router top-K（`catalogDetailLimit`，默认 4，且不超过 `catalogLimit`）展开完整明细行，保留 80 字符截断。
- 预算分配是**明细优先、摘要吃剩余**：先扣掉表头与兜底提示，明细最多占剩余的 60%，用不完的额度全部回流给模块摘要。新增 `SKILL_CATALOG_MAX_CHARS`（默认 1600，clamp 到 300–6000），经 `ExtensionsConfig.skillCatalogMaxChars` 注入。
- 兜底提示：`- 其余技能可用 skill_search 检索，或直接 use_skill 加载上面列出的技能名。`
- `OVERFLOW_CATALOG_LIMIT` 这个"越多越缩水"的反向逻辑已删除。
- `truncated` 只在两种情况为真：有模块行被预算丢掉，或有技能被 `catalogLimit` 切掉。`SkillPreviewEntry.injected` 进一步区分"候选"与"真的写进提示词"。

实测（`skills/builtin` 真实 21 个技能）：改造前约 7 个技能在 prompt 里不可见；改造后 777 字符、**21 个全部点名**、`truncated: false`。构造 36 个技能 / 10 个模块的场景：1083 字符、10 个模块行全部保留、30/36 点名，`truncated: true` 准确反映 `SKILL_CATALOG_LIMIT=30` 切掉的 6 个。

### 3.6 API 与控制台

- `GET /skills` 增加 `?module=` 过滤，可与 `source`/`enabled`/`query` 叠加。
- 新增 `GET /skills/modules` → `{ ok, modules: [{ module, total, enabled, sources }], total }`。**必须注册在 `/skills/:id` 之前**，否则 `modules` 会被当成技能 ID。
- `SkillAdminPort` 增加 `listModules()`，`src/index.ts` 的适配器转发到 `SkillService.listModules()`。
- `SkillsPage.tsx` 在 source 筛选旁增加模块筛选，技能表改成按模块 `Collapse` 分组；分组头显示 `已启用 N/M`，**计数取服务端汇总而不是当前筛选结果**，避免把"筛出来的"当成"已启用的"。展开状态只在模块集合变化时重置，否则每次启停技能都会把用户手动折叠的分组弹开。
- 预览抽屉区分三个数：命中数、候选数、**实际写进提示词数**（`injected`），并提示被预算挤掉的技能只能靠 `skill_search` 找到。
- `web-console/` 是独立的 Vite 项目，有自己的 `src/types.ts`，**不被根目录 `pnpm typecheck` 覆盖**，改完必须另跑 `cd web-console && npx tsc --noEmit`。

## 4. 现有 21 个 builtin 技能的模块划分

| 模块 | 技能 | 数 |
| --- | --- | --- |
| `office` 办公协作 | dingtalk-office, meeting-notes, office-docs, work-report, presentation-brief | 5 |
| `engineering` 研发工程 | code-reading, repo-review, github-project-scan, incident-triage, project-onboarding, project-docs | 6 |
| `data` 数据洞察 | data-analysis, data-insight, attachment-analysis, research-brief, enterprise-lens | 5 |
| `meta` 元能力 | skill-author, plugin-author, handbook-maintainer | 3 |
| `general` 通用兜底 | everyday-chat, link-reader | 2 |

合计 21，与仓库现状一致（`skills/builtin/<module>/<name>/SKILL.md`）。

数据组模块名取 `data` 而不是 `data-insight`：组内已经有一个同名技能，`skills/builtin/data-insight/data-insight/` 这种路径既难读也让 `git mv` 直接报"无法将目录移动到自身"。规则是**模块名不得与其下任一技能同名**。

`other` 模块预留给外部杂项（如高德地图），自研技能不落 `other`，这样 `other` 里出现东西就意味着"没人认领"，是个有用的信号。

迁移方式：`git mv skills/builtin/<name> skills/builtin/<module>/<name>`，frontmatter 不加 `module`（目录已经是真相），21 个技能内容零改动。迁移后必须跑 `pnpm test` 并启动一次确认 `skill_search` 能命中全部 21 个。技能 id 仍是 `builtin:<name>`，不含模块，所以 `skills` 表里 23 行的 `enabled` 状态不会因迁移丢失。

注意：`handbook-maintainer` 是 `visibility: admin`，迁移不要动它的可见性。

## 5. 实施阶段

| 阶段 | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| P2-a | `SkillRegistry` 两级扫描 + `modules` 开关 + 单测 | 老式扁平根仍按原行为加载；模块根正确解析；目录名与 frontmatter 冲突以目录为准并 warn；非法/保留字目录跳过；`references/` 资源仍被收集 | 已完成，13 个用例 |
| P2-b | types/frontmatter/DB 列/`SkillSource` 加 `market` | `pnpm typecheck` 通过；`pnpm db:push` 加列与索引成功；`sync()` 覆盖 module | 已完成 |
| P2-c | `git mv` 迁移 21 个技能到 5 个模块 | 扫描到 21 个、零 loadError、id 仍是 `builtin:<name>`；模块计数 data 5 / engineering 6 / general 2 / meta 3 / office 5 | 已完成 |
| P2-d | 目录清单两级渲染 + 删 `OVERFLOW_CATALOG_LIMIT` + 预算可配 | 真实 21 个技能全部点名且 `truncated: false`；36 技能 / 10 模块场景下模块行全保留、`truncated` 只反映 `catalogLimit` 的切分 | 已完成，4 个用例 |
| P2-e | Router 模块别名加分 | 别名命中时整组上浮、未命中模块得 0 分被过滤；未登记别名的模块不加分；原有关键词打分回归不破 | 已完成，2 个用例 |
| P2-f | API `?module=` + `GET /skills/modules` + 控制台分组筛选 | 分组头启用数取服务端汇总，停用后 total 不变、enabled 减一；重载后仍按 DB 停用状态计数；`/skills/modules` 不被 `/skills/:id` 吃掉 | 已完成，3 个路由用例 + 3 个汇总用例 |

全量验收：`pnpm typecheck` 通过，`pnpm test` **127 文件 / 1033 用例全绿**，`cd web-console && npx tsc --noEmit` 通过。

P2 全部完成后才进 P3（外部技能导入），因为导入依赖 `market` 根和 module 字段。

### P3 阶段

| 阶段 | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| P3-A | 导入 A 级市场技能（8 个） | `analyze-prompt`、`analyze-code`、`bug-review`、`code-quality-analyzer`、`production-code-audit`、`systematic-debugging`、`database-optimizer`、`auto-gen-testcase-from-req` 落到 `skills/market/engineering|data|testing/`；全部零 loadError | 已完成 |
| P3-B | 导入 B 级市场技能（3 个） | `frontend-dev`、`automation-testing`、`analytics-data-analysis`；正文已按本项目无 shell、无依赖安装的事实改写 | 已完成 |
| P3-C | 导入 C 级市场技能（2 个） | `amap-lbs-skill`（改走 `mcp__amap__*`）、`test-browser`（改走 `mcp__playwright__browser_*`）；两者 `visibility: admin` | 已完成 |
| P3-D | 导入量化研究技能 | 包内无 license、无上游来源地址，来源不明，**暂不导入** | 待决（见矩阵文档第 5 节第 6 条） |

导入由一次性工具 `scripts/import-market-skill.ts` 完成：内容以脚本里的 CURATION 表为唯一真相，改内容改表再重跑，不改生成结果。转换规则（frontmatter 重写、`allowed_tools` 映射、正文替换、章节拆分）见 [skill-market-import-matrix.md](./skill-market-import-matrix.md) 第 6 节。

实测：扫描 `skills/builtin` + `skills/market` 共 **34 个技能、0 个 loadError、0 条警告**；模块分布 builtin 5 个 + market 4 个（engineering 6 / testing 4 / data 2 / other 1）。新模块 `testing` / `finance` / `other` 已补进 `MODULE_ALIASES`。

`db:push` 的一个已知副作用：它会顺带 drop/recreate 由 `pnpm db:extend` 单独建的 `project_chunks_embedding_idx`（hnsw）与 `project_chunks_trgm_idx`（gin）。本次已核对两个索引重建后定义一致、14818 行 `project_chunks` 全部保留。**部署到 ECS 时 `db:push` 之后必须补跑 `db:extend`。**

## 6. C 类基础设施（外部技能导入的前置依赖）

P3 要导入的技能里有三类必须先有基础设施，否则装进去也跑不起来。三项都已实现并实机验证。

| 编号 | 内容 | 落地方式 | 验收 |
| --- | --- | --- | --- |
| C-1 | 高德地图官方远程 MCP | `config/mcp-servers.json` 预置 `amap` 节点（`https://mcp.amap.com/mcp?key=${AMAP_WEB_KEY}`，streamable-http），默认 `enabled: false`；`.env` 只放 Key | 控制台显示「停用」而非假「已生效」；Key 缺失时不带假 Key 发起请求；**实机**：API/审计日志中 query 里的密钥被掩码、`${VAR}` 占位符保留原文、提交掩码回写不会覆盖真实密钥 |
| C-2 | 受控行情取数 + 沙箱数据注入 | 新增 `src/tools/market/MarketDataToolProvider.ts`，工具 `market_data_fetch`；只允许两个固定白名单行情主机，地址由代码拼装 | **实机**：`600519.SH`/`000001.SZ`/`00700.HK`/`AAPL.US` 四个市场均取到报价；500 根日线自动落盘并由 `sandbox_analyze_and_aggregate` 用 `datasetKeys` 读回算出 MA20，全程沙盒无网络 |
| C-3 | 浏览器测试 MCP（仅本地） | `config/mcp-servers.json` 预置 `playwright` 节点（stdio，`npx -y @playwright/mcp@0.0.85`），默认 `enabled: false` | **实机**：25 个 `mcp__playwright__browser_*` 工具；`example.com` 导航成功；`127.0.0.1:8787` 被 `--blocked-origins` 拦成 `ERR_BLOCKED_BY_CLIENT`；**ECS 上不安装、不启用** |

三条护栏（不可放宽）：

- **沙盒始终 `--network none`**。行情出网只能走 `market_data_fetch` 这一个带白名单的出口，数据再通过 `datasetKeys` 注入沙盒；不允许给沙盒开网。
- **密钥只在 `.env`**。MCP 节点一律用 `${VAR}` 引用；节点地址里以 query 形式携带的密钥（`key` / `ak` / `token` 等）在控制台、API 响应与审计日志中一律掩码，纯占位符保留原文以便定位缺失变量。
- **控制台区分默认配置与真实生效状态**。`amap` / `playwright` 因为缺 Key 或仅限本地，默认停用，控制台如实显示「停用」，不显示成「已生效」。

C-2 的开关是 `MARKET_DATA_ENABLED`（默认开启），关掉后整个工具源不挂载。

## 7. 风险与取舍

- **两级扫描是本次唯一的破坏性改动**。用 `modules` 开关把影响关在 builtin/market 两个根，local 和 plugin 根行为不变，出问题可以只关掉开关回退。
- **module 不进技能 id**，所以后续调整模块划分不会丢启用状态；代价是控制台改模块归属需要真的移动目录（builtin/market 不可在控制台编辑，只能改仓库）。这是刻意的：外部技能的归属应该由仓库决定，不由运行时决定。
- **`skills` 表加列**走 `pnpm db:push`（项目不提交 migration 文件，`strict: false`）。部署目标是自建 PG 16，push 后补跑 `db:extend` 恢复 hnsw/trgm 索引。
- **清单预算提到 1600 字符**会增加每轮 prompt 开销。实测真实 21 个技能只用 777 字符（比改造前的 1200 预算更省，且可见技能从约 14 个变成 21 个）；如果后续实测 token 压力过大，优先砍明细级 K 值（`catalogDetailLimit`），不要砍模块级。
- 本设计不引入多租户/多机器人维度，与既有范围约定一致。
