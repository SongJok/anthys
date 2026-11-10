# 导入记录：test-browser

| 字段 | 值 |
| --- | --- |
| 市场名称 | 浏览器测试 |
| canonicalName | carmandale-test-browser |
| 市场 id | official_dwc0n2ND |
| 市场 version | 1.0.0 |
| 包内 version | 未随包提供 |
| publisher | carmandale |
| 市场分类 | Security & Testing |
| 上游 source_url | 未随包提供 |
| license | 未随包提供 |
| security_audit | 包内无审计报告；上游正文依赖 agent-browser CLI 与 npm 全局安装，本项目不执行。 |
| importedAt | 2026-11-10 |
| 可用度分级 | C |
| 目标模块 | testing |
| 风险等级 | read |
| 可见性 | admin |

## 转换改动

- description：重写为 61 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 42 字符（上限 200）
- version：取市场版本 1.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 15 个
- risk=read，visibility=admin，max_instruction_chars=8000
- 正文替换 15 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文超上限，按章节拆出 1 个 references 文件
- 未保留资源
- 无丢弃文件

## 阻塞点

- 需要管理员在本地启用 `playwright` MCP 节点；该节点只装在开发机，ECS 上不安装不启用
- 上游依赖 `agent-browser` CLI 与 bash，本项目没有 shell，已改为 Playwright MCP 工具

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
