# 外部技能兼容矩阵与导入 Runbook

状态：矩阵中 3 个技能为**实测**（已安装并逐字节核对），其余 14 个为**待实测**（仅有市场元数据，分级是推断）。
**2026-11-10 更新**：15 个包已全部安装并实测，13 个已按本 runbook 导入仓库（见第 7 节）；量化研究包因来源不明暂缓。
前置依赖：[skill-module-split-design.md](./skill-module-split-design.md) 的 P2 阶段必须先落地，否则导入的技能没有 module 归属，且会加剧目录清单溢出。

## 1. 本项目的执行能力边界（决定"能不能完整使用"）

全项目共 69 个工具（`src/tools/**/*ToolProvider.ts`）。与外部技能相关的关键事实：

| 能力 | 本项目现状 | 位置 |
| --- | --- | --- |
| 宿主机 shell | **没有** | 无 shell/bash 工具 |
| 代码执行 | `sandbox_analyze_and_aggregate`：JS 走 isolated-vm；python/bash 走 Docker，`--network none --read-only --memory 256m` | `src/tools/sandbox/IsolatedSandbox.ts:332`、`:149` |
| 装依赖 | **不可能**（沙箱 read-only + 无网络，`npm install` / `pip install` 都跑不了） | 同上 |
| 网络出口 | 只有 `web_fetch` / `web_search` 两个工具，沙箱内代码无网络 | `src/tools/web/` |
| 文件写 | 只有 `deliver_artifact` 产出交付物，不能改宿主任意文件 | `src/tools/artifacts/` |
| 文件读 | `workspace_read_file`（只读）+ `project_read/search/map/symbol` | `src/tools/workspace/`、`src/tools/projects/` |
| 钉钉 | 12 个原生 `dws_*` 工具（不是 CLI） | `src/tools/dws/DwsCliToolProvider.ts` |
| MCP | 支持，但只配了 1 个 `enterprise`（企业 AI 中台） | `config/mcp-servers.json`、`src/tools/mcp/` |
| 直连数据库 | **没有** SQL 工具（PG 只服务于自身存储） | `src/db/` |

推论：任何"教模型敲命令 / 跑脚本 / 装包 / 访问外部 API"的市场技能，在本项目里都只能降级成方法论文档，除非改走 MCP 连接器或给沙箱开网络白名单。

## 2. 三个实测样本（已安装到 `~/.qoder-cn/skills/`）

### 2.1 格式冲突实测

本项目 frontmatter 校验见 `src/skills/SkillRegistry.ts:228-276`，文件上限见 `:15`。

| 指标 | 上限 | production-code-audit | amap-lbs-skill | multi-strategy-quant-research-pro |
| --- | --- | --- | --- | --- |
| SKILL.md 字节 | 65536 | 15840 通过 | 13849 通过 | **73981 直接 loadError** |
| 正文字符 | 8000（`max_instruction_chars` 上限） | **15411 超限** | **8216 超限** | **38197 超限** |
| description 字符 | 160 | **202 超限** | 40 通过 | **480 超限** |
| `when_to_use` | 必填 ≤200 | **缺失** | **缺失** | **缺失** |
| `version` | 必填 semver | **缺失** | 有（2.0.0） | **缺失** |
| frontmatter 字段 | — | name, description | name, description, version, metadata | name, description |

**三个包无一能直接放进本项目被加载。** 最少要补 `when_to_use` + `version`；两个要重写 description；一个必须拆文件。

### 2.2 包结构与依赖声明实测

| 技能 | 文件数 | 体积 | 结构 | 依赖声明 |
| --- | --- | --- | --- | --- |
| production-code-audit | 2 | 32KB | `SKILL.md` + `skill-report.json` | 无（纯文档） |
| amap-lbs-skill | 8 | 56KB | `SKILL.md`、`index.js`、`package.json`、`config.example.json`、`scripts/{poi-search,route-planning,travel-planner}.js`、`_meta.json` | frontmatter `metadata.openclaw.requires`：env `AMAP_WEBSERVICE_KEY`、bins `node`、install `axios`；package.json deps `axios ^1.13.6`，license MIT |
| multi-strategy-quant-research-pro | 99 | 1120KB | `SKILL.md` + `scripts/` 下 15 个 Python 子包（archive/audit/backtest/cache/composers/core/data/factors/indicators/market_regime/portfolio/position/reports/...） | 无 frontmatter 声明；正文写明数据源是东方财富/腾讯/新浪公开接口，需网络 |

三个关键发现：

1. **`scripts/` 在本项目里既不能执行也读不到。** `SKIPPED_DIRS` 含 `scripts`（`src/skills/SkillRegistry.ts:19-25`），`listResources` 直接跳过（`:341`），所以 `skill_read` 看不到这些文件。amap 的 3 个 JS 和 quant 的 99 个 Python 文件如果原样 vendor 进来，就是一堆死重。
2. **provenance 载体三种形态，且市场元数据与包内不一致。** 见 2.3。
3. **上游自带风险声明。** production-code-audit 的 `skill-report.json` 里有 `risk_factors: [external_commands, network, env_access]` 和 `security_audit`，可以直接当导入的安全门用。

### 2.3 Provenance 实测：市场元数据 ≠ 包内真相

| 技能 | 市场列表 version | 包内 version | 上游来源 | license |
| --- | --- | --- | --- | --- |
| production-code-audit | 1.0.0 | `skill-report.json` 写 **1.0.1**，SKILL.md 无 version | `https://github.com/sickn33/antigravity-awesome-skills/tree/main/skills/production-code-audit`，author sickn33 | MIT |
| amap-lbs-skill | 1.0.0 | SKILL.md 写 **2.0.0**，`_meta.json` latest.version 写 **1.0.0** | `_meta.json`：owner duxiaohuidxh，commit `https://github.com/openclaw/skills/commit/086f8c60...` | package.json MIT |
| multi-strategy-quant-research-pro | 1.0.1 | SKILL.md 无 version，正文标题写 **v1.1.2** | **无 `_meta.json`、无 license 文件、无 source_url** | 未知 |

结论：导入时必须把"市场声称的版本"和"包内实际版本"都记下来，license 缺失的（如 quant）要单独标注风险，不能默认 MIT。

`security_audit` 实测值（production-code-audit）：`risk_level: low`、`is_blocked: false`、`safe_to_publish: true`，summary 说明 53 条静态告警全是误报（外部命令是 markdown 示例、网络 URL 是文档链接），本质是文档型技能。这条判定可以直接采信为 A 级依据。

## 3. 兼容矩阵

分级定义：

- **A 可直接用**：纯方法论，转换 frontmatter 后即可正常工作。
- **B 降级可用**：方法论有效，但正文里的命令/脚本/工具调用在本项目不可执行，需改写正文并显式声明边界。
- **C 需外部依赖**：必须先接 MCP 连接器、配 API 密钥或给沙箱开网络白名单，否则等于不可用。
- **D 不建议导入**：与本项目原生能力重叠冲突，或运行前提本项目完全不具备。

| 技能（市场名） | canonicalName | 目标模块 | 级别 | 依据 | 阻塞点 / 需要的改造 |
| --- | --- | --- | --- | --- | --- |
| 多策略量化研究 | multi-strategy-quant-research-pro | finance | **C（实测）** | 73981B 超限；99 个 Python 文件；数据源需网络 | 必须拆 SKILL.md 到 references；沙箱无网络 → 拉不到行情；SQLite 档案库在 read-only 沙箱写不了。真要可用只能走 MCP 或开网络白名单 |
| 同花顺问财股票数据获取 | — | finance | **不可得** | 官方市场搜 `问财`/`同花顺`/`股票` 均 0 条 | 见第 5 节待决项 |
| 代码审计 | production-code-audit | code | **A（实测）** | 纯文档，上游 security_audit low/is_blocked=false | 仅需补 when_to_use/version、description 压到 160、正文 15411 字需按 8000 截断+大纲 |
| 代码分析 | diegosouzapw-analyze-code | code | A/B 待实测 | 描述为"顾问代理深度分析" | 若正文要求派子代理（Task/Agent），本项目无此能力 → 降 B |
| 漏洞BUG | athola-bug-review | code | A/B 待实测 | "系统化漏洞狩猎 + 证据链" | 证据链若依赖 grep/git 命令 → 改用 project_search/project_history |
| 提示词优化 | melodic-software-analyze-prompt | code | A 待实测 | 七级框架分析提示词，纯方法论 | 大概率无外部依赖 |
| 代码质量分析器 | code-quality-analyzer | code | **B/C 待实测** | 描述提到"团队订阅服务" | 若需外部服务/密钥 → C；静态检查若需 eslint 等 CLI → 沙箱无网络装不了 |
| 前端开发 | frontend-dev（aliyun）或 frontend-agent | code | B 待实测 | 需要 npm/dev server/浏览器 | 本项目无宿主执行 → 只能当代码评审与方案指导 |
| 调试测试 | boisenoise-superpowers-systematic-debugging | testing | A 待实测 | 系统化调试方法论 | 正文若要求"跑测试看输出"，需改成让模型用 sandbox 或请用户提供日志 |
| 调试助手 | boisenoise-superpowers-community-systematic-debugging | testing | A 待实测 | 四阶段根因调查框架 | 同上 |
| 自动化测试 | automation-testing | testing | B 待实测 | 测试框架搭建 + CI/CD 集成 | 无宿主执行、无 CI 权限 → 只能产出测试代码文本，靠 deliver_artifact 交付 |
| 浏览器测试 | carmandale-test-browser | testing | **C 待实测** | 需要真实浏览器/Playwright | 本项目无浏览器工具；要可用必须在 `config/mcp-servers.json` 加 browser MCP |
| 需求自动生成测试用例 | auto-gen-testcase-from-req（LAUFLO） | testing | B 待实测 | 输出"可由 auto-test-from-testcase 直接执行"的用例 | 配套执行技能本项目没有 → 只能产出用例文档，需改写去掉"直接执行"承诺 |
| Android测试 | diegosouzapw-android-unit-test | testing | **D 待实测** | JUnit/Espresso 需 adb、模拟器、gradle | 运行前提完全不具备，且钉钉机器人场景无 Android 工程上下文 |
| 分析数据分析 | analytics-data-analysis | database | B 待实测 | Python/Jupyter/现代数据工具 | 沙箱有 python 但 read-only+无网络：能算不能存、不能装 pandas/matplotlib。需确认用的是标准库 |
| SQL数据库优化 | aiskillstore-database-optimizer | database | A 待实测 | 查询优化/索引/执行计划方法论 | 本项目无 SQL 直连工具 → 只能基于用户贴的 SQL 与执行计划做分析，不能自己查库 |
| 钉钉 dws 技能 | dingtalk-dws | dingtalk | **D（判断）** | 教模型敲 `dws` CLI | 本项目已有 12 个原生 `dws_*` 工具且无宿主 shell；导入会产生指令冲突（技能让敲命令，实际只能调工具）。建议不导入，或降为 `visibility: admin` 的参考文档 |
| 高德地图综合服务技能 | amap-lbs-skill | other | **C（实测）** | 需 `AMAP_WEBSERVICE_KEY` + node + axios + 网络 | 沙箱无网络无法 npm install → 3 个 scripts 全废。真要可用：在 `config/mcp-servers.json` 加高德官方 MCP，或加一个受控 HTTP 工具 |

统计：A 级 6~7 个，B 级 5 个，C 级 3 个，D 级 2 个，不可得 1 个。**"完整使用"只有 A 级能做到**；C 级必须先做基础设施改造；D 级建议放弃。

## 4. 工具名映射表（转换 `allowed_tools` 用）

| 市场技能里的工具 | 本项目对应 | 备注 |
| --- | --- | --- |
| Bash / shell / run_command | 无 | 只能 `sandbox_analyze_and_aggregate`，且无网络、只读 |
| Read / Grep / Glob | `project_read`、`project_search`、`project_map`、`project_symbol`、`workspace_read_file` | 只读，限项目仓库与工作区 |
| Write / Edit / MultiEdit | 无 | 产出物走 `deliver_artifact` |
| WebFetch / WebSearch | `web_fetch`、`web_search` | 可直接映射 |
| Task / Agent / subagent | 无 | 本项目无子代理机制 |
| NotebookEdit / jupyter | 无 | 沙箱能跑 python 但不能持久化 notebook |
| MCP 工具 | `mcp__<server>__<tool>` | 需先在 `config/mcp-servers.json` 注册，密钥走 `.env` 的 `${VAR}` |
| `dws xxx` CLI | `dws_aitable`、`dws_doc_manage`、`dws_doc_search_and_read`、`dws_calendar_manage`、`dws_calendar_cancel`、`dws_todo_manage`、`dws_minutes`、`dws_report_read`、`dws_report_submit`、`dws_approval_manage`、`dws_contact_manage`、`dws_org_and_schedule` | 禁止在技能正文里让模型敲 CLI |

转换时 `allowed_tools` 里出现映射不到的工具，一律**删除**并在 `IMPORT.md` 记录删了什么，不要保留幻觉工具名。

## 5. 待你决策的事项

1. **同花顺问财**：官方能力市场没有。三个选项——(a) 用社区源 `openstockdata/stock-data-skill` 或 `gracefullight/stock-checker` 替代（非官方，需自行审计）；(b) 找问财/iFinD 的 MCP 或 API 自己接；(c) 本轮放弃，finance 模块只留量化研究。
2. **钉钉 dws 技能**：建议不导入（与 12 个原生 `dws_*` 工具冲突）。若你坚持要，我会做成 `visibility: admin` 且正文改写成"工具对照表"而非 CLI 说明。
3. **Android 测试**：建议放弃（D 级，运行前提不具备）。
4. **C 级技能的基础设施**：是否要为高德接官方 MCP、为浏览器测试接 browser MCP、为量化研究开沙箱网络白名单？这三项都是独立的基础设施改动，不属于"导入技能"本身。不开的话，C 级技能导入后就是摆设，我会在正文显式写明不可用边界，不假装能用。
5. **已安装的 3 个技能**：`install_extension` 没有对应卸载接口，它们现在常驻你的 Qoder 用户目录并在本会话已激活。要保留还是你手动去 Qoder 设置里删？
6. **license 缺失**：quant 包无 license 文件、无上游 URL。是否接受"来源不明"的技能进仓库？我的建议是不接受，先联系发布者或换替代。

## 6. 导入 Runbook

### 6.1 前置

- P2（模块机制）已合入，`skills/market/` 根已在 `src/index.ts:646-666` 注册，`SKILLS_MARKET_DIR` 已进 `.env.example`。
- 本地跑通 `pnpm test` 与 `pnpm typecheck` 作为基线。

### 6.2 单个技能导入步骤

1. **搜索并立即安装。** `search_extensions` 返回的 `installRef` 有效期约 1 小时，但实测签发到过期只给了约 90 秒（03:27:14 签发 → 03:28:36 过期），**必须搜完立刻装**，过期就重新搜。
2. **安装**：`install_extension({ installRef })`，落在 `~/.qoder-cn/skills/<slug>/`。逐个确认，不批量静默安装。
3. **审计**（安全门，任一命中则拒绝导入）：
   - `skill-report.json` 里 `security_audit.is_blocked === true` 或 `safe_to_publish === false`
   - `risk_factors` 含 `external_commands`/`network`/`env_access` 时，逐条核对 `risk_factor_evidence` 指向的行，确认是文档示例还是真调用
   - 正文含硬编码密钥、内网地址、可疑下载源
   - 无 license 且无上游 URL（如 quant）→ 需你单独批准
4. **转换**：写 `scripts/import-market-skill.ts`（一次性工具，不进运行时），做 frontmatter 重写：
   - `name`：包内 name，须匹配 `^[a-z][a-z0-9-]{1,63}$`；与现有 21 个技能名冲突时加模块前缀
   - `description`：压到 ≤160 字符，保留"做什么"，删营销语与排除条款（排除条款挪进正文）
   - `when_to_use`：从正文 "When to Use" 段提炼 ≤200 字符（市场包全部缺失，必须人工写）
   - `version`：包内优先，缺失则用市场 version，两者不一致时取包内并在 IMPORT.md 记录
   - `tags`：市场 tags 去掉 `origin:*`，追加 `origin:qoder-market`
   - `allowed_tools`：按第 4 节映射表转换，映射不到就删
   - `risk`：默认 `read`；会产出交付物的设 `write`
   - `visibility`：需密钥或 C 级的设 `admin`，避免普通用户在群里触发一个跑不通的技能
   - `max_instruction_chars`：正文 >4000 一律设 8000
5. **体积治理**：SKILL.md 整文件必须 ≤65536 字节。超限的按章节切到 `references/*.md`，主文件保留定位/边界/入口/合规声明，正文用大纲引导模型 `skill_read` 分页读（`src/skills/SkillService.ts:118-146` 已有大纲生成）。
6. **脚本处理**：不要放在 `scripts/`（会被 `SKIPPED_DIRS` 吞掉，`src/skills/SkillRegistry.ts:19-25`）。二选一：
   - 删掉（推荐用于 C/D 级，反正跑不了，留着是死重和审计负担）
   - 移到 `references/upstream-impl/` 作为只读参考，并在正文明确"这些代码在本项目不可执行"
   - 同时删掉 `package.json`、`config.example.json` 这类会误导模型以为能 `npm install` 的文件
7. **落盘**：`skills/market/<module>/<name>/SKILL.md` + `IMPORT.md`。
8. **`IMPORT.md` 必记字段**：canonicalName、市场 id、市场 version、包内 version、publisher/owner、上游 source_url、license、security_audit 结论、importedAt、转换改动摘要（description 压缩前后、补写的 when_to_use、删掉的 allowed_tools、删掉/移动的文件）、可用度分级与阻塞点。`installRef` 是一次性凭证，**不落盘**。
9. **验证**：
   - `pnpm typecheck && pnpm test`
   - 启动后 `skill_search` 能搜到该技能，`use_skill` 能加载且不报 loadError
   - 控制台确认模块分组、enabled 状态、visibility 与预期一致（区分默认值和真实生效值）
   - 真实对话冒烟：给一个该技能应当命中的请求，确认模型走了 `use_skill` 而不是瞎猜
10. **提交**：按文件范围提交，一个模块一个 commit，不混其他改动。

### 6.3 批量顺序建议

1. 先做 A 级（production-code-audit 起，纯文档、风险最低），把 `import-market-skill.ts` 和 IMPORT.md 模板跑通。
2. 再逐个安装并实测 B 级，修正分级（B/C 的边界只有装完才知道）。
3. C 级等基础设施决策（第 5 节第 4 项）之后再动。
4. D 级不做。

### 6.4 回滚

- 单个技能：`git rm -r skills/market/<module>/<name>`，`POST /skills/reload` 即可，DB 里对应行由 `SkillService.reload()`（`:198-247`）清理。
- 整个模块：删模块目录，同上。
- 因为 module 不进技能 id，删模块不会污染其他技能的启用状态。
- Qoder 用户目录里已安装的那份不受项目回滚影响，需要在 Qoder 设置里单独处理。

## 7. 导入结果（2026-11-10）

15 个市场包已全部安装并逐包实测，最终导入 **13 个**，落在 `skills/market/<module>/<name>/`。

| 模块 | 技能 | 分级 | 落地方式 |
| --- | --- | --- | --- |
| engineering | analyze-prompt | A | 补 `when_to_use`，删除上游指向的三个不存在文件/命令 |
| engineering | analyze-code | B | 去掉子代理（Task + consultant CLI），改为主会话用 `project_*` 工具 |
| engineering | bug-review | B | 删掉 6 个不存在的插件依赖与 TodoWrite 流程，静态分析器改为交给用户执行 |
| engineering | code-quality-analyzer | B | 删掉 USDC 定价与"团队订阅"商业内容，只留方法论 |
| engineering | production-code-audit | A | 正文超上限，按章节拆 2 个 references |
| engineering | frontend-dev | B | 删 5.5 MB 字体、4 个素材脚本与 p5.js 模板，素材章节降级为需求清单 |
| testing | systematic-debugging | A | 删掉 `superpowers:*` 引用，补 3 个 references |
| testing | automation-testing | B | 上游 4 个引用文件全部缺失，主准则内联进正文 |
| testing | auto-gen-testcase-from-req | B | 去掉"可由 auto-test-from-testcase 直接执行"的承诺 |
| testing | test-browser | C | `agent-browser` CLI 全部换成 `mcp__playwright__browser_*`，`visibility: admin` |
| data | database-optimizer | A | 上游缺失的 `resources/implementation-playbook.md` 已在正文说明 |
| data | analytics-data-analysis | B | 说明沙箱无网络、装不了 pandas，标准库可用 |
| other | amap-lbs-skill | C | `node + axios` 脚本换成 `mcp__amap__*`，`visibility: admin` |

每个技能的 `IMPORT.md` 记录了市场 id、canonicalName、市场与包内两个版本、publisher、上游 source_url、license、security_audit 结论、importedAt、转换改动摘要与阻塞点。**安装凭证 installRef 不落盘。**

### 7.1 实测结论

- **扫描零错误**：`skills/builtin` + `skills/market` 共 34 个技能，0 个 `loadError`、0 条警告。
- **模块分布**：builtin 5 个模块 21 个技能 + market 4 个模块 13 个技能（engineering 6 / testing 4 / data 2 / other 1）。
- **新模块别名**：`testing` / `finance` / `other` 已补进 `MODULE_ALIASES`，否则这些模块只能靠单个技能的 tags 被搜到。
- **路由抽检**：`生成测试用例` → `auto-gen-testcase-from-req` 14 分居首；`sql 慢查询怎么优化` → `database-optimizer` 12 分居首；`北京南站附近酒店` → `amap-lbs-skill` 8 分居首。
- **体积**：全部 SKILL.md ≤ 65536 字节；超 8000 字符的按章节拆到 `references/`，主文件保留标题、适配说明与索引。

### 7.2 仍未落地的四项

1. **量化研究包（multi-strategy-quant-research-pro）**：包内无 license 文件、无上游 URL，正文版本（v1.1.2）与市场版本（1.0.1）也不一致。来源不明，按第 5 节第 6 条的建议**暂不导入**；需要先联系发布者或换可审计的替代源。
2. **同花顺问财**：官方市场没有该技能，仍未导入。
3. **钉钉 dws 技能**：D 级，与本项目 12 个原生 `dws_*` 工具冲突，未导入。
4. **Android 测试**：D 级，运行前提（adb/模拟器/gradle）不具备，未导入。

另：15 个市场包仍安装在 `~/.qoder-cn/skills/`（`install_extension` 没有卸载接口），需要时在 Qoder 设置里手动移除；项目仓库里的副本与之无关，回滚仓库不影响用户目录。
