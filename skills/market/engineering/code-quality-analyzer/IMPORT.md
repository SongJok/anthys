# 导入记录：code-quality-analyzer

| 字段 | 值 |
| --- | --- |
| 市场名称 | 代码质量分析器 |
| canonicalName | code-quality-analyzer |
| 市场 id | official_c3Oss0lm |
| 市场 version | 1.0.0 |
| 包内 version | 1.0.0 |
| publisher | a1ucard2q |
| 市场分类 | Code Review |
| 上游 source_url | https://github.com/openclaw/skills/commit/f49cca9fe594a14cd64cda04d3fb3d90e9ff8413 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；正文为纯文本方法论，无脚本与外部调用。 |
| importedAt | 2026-11-10 |
| 可用度分级 | B |
| 目标模块 | engineering |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 47 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 46 字符（上限 200）
- version：取包内版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 4 个
- risk=read，visibility=public，max_instruction_chars=4000
- 正文替换 2 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 删除章节：定价
- 正文未超上限，未拆分
- 未保留资源
- 未导入：_meta.json

## 阻塞点

- 上游是按次收费的商业服务（USDC 定价），已删除全部定价内容，改为免费的方法论
- 本项目没有 shell，eslint 等静态检查器不能直接运行

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
