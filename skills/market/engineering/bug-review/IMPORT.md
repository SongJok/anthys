# 导入记录：bug-review

| 字段 | 值 |
| --- | --- |
| 市场名称 | 漏洞BUG |
| canonicalName | athola-bug-review |
| 市场 id | official_mPfA6ebJ |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | athola |
| 市场分类 | Code Review |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；正文提到 cargo clippy / ruff / golangci-lint / eslint 等静态分析器命令，属于文档示例，本项目不执行。 |
| importedAt | 2026-11-10 |
| 可用度分级 | B |
| 目标模块 | engineering |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 60 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 42 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 4 个
- risk=read，visibility=public，max_instruction_chars=8000
- 正文替换 11 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 删除章节：Troubleshooting
- 正文未超上限，未拆分
- 保留资源：references/defect-documentation.md、references/fix-preparation.md、references/language-detection.md
- 无丢弃文件

## 阻塞点

- 上游声明的 defect-tracker / fix-generator / verification-runner / pensive:shared / imbue:* 依赖在本项目都不存在，已删除
- 本项目没有 shell，静态分析器与测试命令只能交给用户执行

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
