# 导入记录：systematic-debugging

| 字段 | 值 |
| --- | --- |
| 市场名称 | 调试测试 |
| canonicalName | boisenoise-superpowers-systematic-debugging |
| 市场 id | official_Gpok7ZP9 |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | boisenoise |
| 市场分类 | Security & Testing |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；正文为纯文本方法论。市场上另有 12 个同名变体（body 差异不到 5%），只导入本包一个。 |
| importedAt | 2026-11-10 |
| 可用度分级 | A |
| 目标模块 | testing |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 60 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 45 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 4 个
- risk=read，visibility=public，max_instruction_chars=8000
- 正文替换 5 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文超上限，按章节拆出 1 个 references 文件
- 保留资源：references/root-cause-tracing.md、references/defense-in-depth.md、references/condition-based-waiting.md
- 未导入：CREATION-LOG.md、condition-based-waiting-example.ts、find-polluter.sh、test-academic.md、test-pressure-1.md、test-pressure-2.md、test-pressure-3.md

## 阻塞点

- 无

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
