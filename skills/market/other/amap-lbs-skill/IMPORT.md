# 导入记录：amap-lbs-skill

| 字段 | 值 |
| --- | --- |
| 市场名称 | 高德地图综合服务技能 |
| canonicalName | amap-lbs-skill |
| 市场 id | official_4S946Bk5 |
| 市场 version | 1.0.0 |
| 包内 version | 2.0.0 |
| publisher | duxiaohuidxh |
| 市场分类 | Database & Analytics |
| 上游 source_url | https://github.com/openclaw/skills/commit/086f8c60dcd8716890c49a7883a17c4f6fc88c72 |
| license | MIT |
| security_audit | 包内无审计报告；上游声明依赖 AMAP_WEBSERVICE_KEY、node 与 axios，通过脚本直连 restapi.amap.com。本项目改为走官方 MCP 节点。 |
| importedAt | 2026-11-10 |
| 可用度分级 | C |
| 目标模块 | other |
| 风险等级 | read |
| 可见性 | admin |

## 转换改动

- description：重写为 54 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 49 字符（上限 200）
- version：取包内版本 2.0.0（市场版本 1.0.0）
- allowed_tools：按本项目真实工具名映射，共 6 个
- risk=read，visibility=admin，max_instruction_chars=8000
- 正文替换 12 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文超上限，按章节拆出 1 个 references 文件
- 未保留资源
- 未导入：index.js、scripts/、package.json、config.example.json、_meta.json

## 阻塞点

- 需要管理员在控制台启用 `amap` MCP 节点并配置 `AMAP_WEB_KEY`（高德开放平台 Web 服务类型 Key），未启用时本技能不可用

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
