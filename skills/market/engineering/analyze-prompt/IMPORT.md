# 导入记录：analyze-prompt

| 字段 | 值 |
| --- | --- |
| 市场名称 | 提示词优化 |
| canonicalName | melodic-software-analyze-prompt |
| 市场 id | official_4YGFW2Fg |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | melodic-software |
| 市场分类 | Code Review |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；正文为纯提示词，无脚本、无网络调用、无外部命令。 |
| importedAt | 2026-11-10 |
| 可用度分级 | A |
| 目标模块 | engineering |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 52 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 47 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 3 个
- risk=read，visibility=public，max_instruction_chars=4000
- 正文替换 4 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文未超上限，未拆分
- 未保留资源
- 无丢弃文件

## 阻塞点

- 无

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
