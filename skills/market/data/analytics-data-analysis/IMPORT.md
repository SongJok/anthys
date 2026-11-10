# 导入记录：analytics-data-analysis

| 字段 | 值 |
| --- | --- |
| 市场名称 | 分析数据分析 |
| canonicalName | analytics-data-analysis |
| 市场 id | official36467869 |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | Mindrally |
| 市场分类 | Database & Analytics |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；正文为纯文本规范，无脚本。 |
| importedAt | 2026-11-10 |
| 可用度分级 | B |
| 目标模块 | data |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 72 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 59 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 4 个
- risk=read，visibility=public，max_instruction_chars=8000
- 正文未做替换
- 未删除章节
- 正文未超上限，未拆分
- 未保留资源
- 无丢弃文件

## 阻塞点

- 沙箱是 read-only 且无网络，装不了 pandas/matplotlib/seaborn，只有标准库可用

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
