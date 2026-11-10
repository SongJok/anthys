# 导入记录：production-code-audit

| 字段 | 值 |
| --- | --- |
| 市场名称 | 代码审计 |
| canonicalName | aiskillstore-production-code-audit |
| 市场 id | official_R7zSmfaa |
| 市场 version | 1.0.0 |
| 包内 version | 1.0.1 |
| publisher | aiskillstore |
| 市场分类 | Code Review |
| 上游 source_url | https://github.com/sickn33/antigravity-awesome-skills/tree/main/skills/production-code-audit |
| license | MIT |
| security_audit | 上游 skill-report.json：risk_level=low，is_blocked=false，safe_to_publish=true；53 条静态告警经上游判定全为误报（外部命令是 markdown 示例，网络地址是文档链接）。 |
| importedAt | 2026-11-10 |
| 可用度分级 | A |
| 目标模块 | engineering |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 58 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 42 字符（上限 200）
- version：取包内版本 1.0.1（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 5 个
- risk=read，visibility=public，max_instruction_chars=8000
- 正文未做替换
- 未删除章节
- 正文超上限，按章节拆出 2 个 references 文件
- 未保留资源
- 未导入：skill-report.json

## 阻塞点

- 无

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
