# 导入记录：auto-gen-testcase-from-req

| 字段 | 值 |
| --- | --- |
| 市场名称 | 需求自动生成测试用例 |
| canonicalName | auto-gen-testcase-from-req |
| 市场 id | 8bd5d119-6f50-433c-ba23-d952d011bd51 |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | LAUFLO |
| 市场分类 | Security & Testing |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；正文为方法论，三个 references 为纯文档。 |
| importedAt | 2026-11-28 |
| 可用度分级 | B |
| 目标模块 | testing |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：本地重写为 78 字符（上限 160）
- when_to_use：本地重写为 80 字符（上限 200）
- version：市场来源 1.0.0；本地升级为 2.2.0
- allowed_tools：按本项目真实工具名映射，共 14 个
- risk=read，visibility=public，max_instruction_chars=8000
- 保留本地升级正文（skills/market/testing/auto-gen-testcase-from-req/SKILL.md），防止重跑导入脚本被上游包覆盖
- 保留资源：references/test-methods.md、references/testcase-splitting-rules.md、references/output-example.md、references/business-evidence.md
- 未导入：agents/openai.yaml

## 阻塞点

- 上游承诺"可由 auto-test-from-testcase 直接执行"，该配套技能不在本项目，输出改为纯用例文档

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
