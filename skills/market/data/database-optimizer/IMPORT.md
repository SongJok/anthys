# 导入记录：database-optimizer

| 字段 | 值 |
| --- | --- |
| 市场名称 | SQL数据库优化 |
| canonicalName | aiskillstore-database-optimizer |
| 市场 id | official_gQLDuHsX |
| 市场 version | 1.0.0 |
| 包内 version | 1.0.1 |
| publisher | aiskillstore |
| 市场分类 | Database & Analytics |
| 上游 source_url | https://github.com/sickn33/antigravity-awesome-skills/tree/main/skills/database-optimizer |
| license | MIT |
| security_audit | 上游 skill-report.json：risk_level=safe，is_blocked=false，safe_to_publish=true；纯提示词，无可执行代码、网络或文件访问。 |
| importedAt | 2026-11-10 |
| 可用度分级 | A |
| 目标模块 | data |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 60 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 45 字符（上限 200）
- version：取包内版本 1.0.1（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 3 个
- risk=read，visibility=public，max_instruction_chars=8000
- 正文替换 1 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文超上限，按章节拆出 1 个 references 文件
- 未保留资源
- 未导入：skill-report.json

## 阻塞点

- 无

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
