# 导入记录：frontend-dev

| 字段 | 值 |
| --- | --- |
| 市场名称 | 前端开发 |
| canonicalName | frontend-dev |
| 市场 id | 460ea0fa-6a89-4a84-932a-a7c6cc2b8517 |
| 市场 version | 0.1.1 |
| 包内 version | 0.1.1 |
| publisher | aliyun-1641957599603554 |
| 市场分类 | Coding |
| 上游 source_url | 未随包提供 |
| license | MIT |
| security_audit | 包内无审计报告；scripts/ 是调用 minimax 开放平台的 python 脚本，需要外部 API Key，本项目不执行。 |
| importedAt | 2026-11-10 |
| 可用度分级 | B |
| 目标模块 | engineering |
| 风险等级 | read |
| 可见性 | public |

## 转换改动

- description：重写为 49 字符（上限 160）
- when_to_use：上游全部缺失，按需补写为 42 字符（上限 200）
- version：取包内版本 0.1.1（市场版本 0.1.1）
- allowed_tools：按本项目真实工具名映射，共 5 个
- risk=read，visibility=public，max_instruction_chars=8000
- 正文替换 7 处（上游引用的不可用工具、缺失文件与商业定价内容）
- 未删除章节
- 正文超上限，按章节拆出 2 个 references 文件
- 保留资源：references/motion-recipes.md、references/troubleshooting.md、references/asset-prompt-guide.md
- 未导入：canvas-fonts/、scripts/、templates/、references/minimax-cli-reference.md、references/minimax-image-guide.md、references/minimax-music-guide.md、references/minimax-tts-guide.md、references/minimax-video-guide.md、references/minimax-voice-catalog.md

## 阻塞点

- 上游的 AI 素材生成脚本依赖 MINIMAX_API_KEY 与本地 python 环境，本项目没有 shell 也没有密钥，素材生成整章降级为素材需求清单
- 上游的 canvas-fonts/ 有 5.5 MB 字体与 4 个 p5.js 生成模板，本项目不能执行也不需要，已删除

## 来源说明

本文件由 `scripts/import-market-skill.ts` 生成，内容以该脚本的 CURATION 表为准。
市场安装凭证（installRef）不落盘。
