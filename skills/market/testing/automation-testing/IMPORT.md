# 导入记录：automation-testing

| 字段 | 值 |
| --- | --- |
| 市场名称 | 自动化测试 |
| canonicalName | automation-testing |
| 市场 id | official_JCQg8JQf |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | naodeng |
| 市场分类 | Security & Testing |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；包内只有 SKILL.md，无脚本。 |
| importedAt | 2026-11-10 |
| 可用度分级 | B |
| 目标模块 | testing |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 57 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 48 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 4 个
- risk=read，visibility=public，max_instruction_chars=4000
- 正文替换 5 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文未超上限，未拆分
- 未保留资源
- 无丢弃文件

## 阻塞点

- 上游引用的 prompts/automation-testing.md、output-formats.md、references/、scripts/ 都没有随包提供，已把主提示词内联进正文

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
