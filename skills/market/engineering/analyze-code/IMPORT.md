# 导入记录：analyze-code

| 字段 | 值 |
| --- | --- |
| 市场名称 | 代码分析 |
| canonicalName | diegosouzapw-analyze-code |
| 市场 id | official_ZNwrwxZu |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | diegosouzapw |
| 市场分类 | Code Review |
| 上游 source_url | https://github.com/majiayu000/claude-skill-registry-data |
| license | 未随包提供 |
| security_audit | 包内无审计报告；metadata.json 声明来自 GitHub 索引仓，正文无脚本与外部命令。 |
| importedAt | 2026-11-10 |
| 可用度分级 | B |
| 目标模块 | engineering |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 69 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 51 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 5 个
- risk=read，visibility=public，max_instruction_chars=4000
- 正文替换 3 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文超上限，按章节拆出 1 个 references 文件
- 未保留资源
- 未导入：metadata.json

## 阻塞点

- 上游靠派子代理（Task + consultant CLI）完成分析，本项目没有子代理机制，改为在主会话里按同一套准则执行

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
