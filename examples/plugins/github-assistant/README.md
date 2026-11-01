# GitHub 项目助手（示例声明式插件）

这是一个**纯声明式**插件示例：只包含技能 Markdown、资源与 MCP 配置，不包含任何可执行代码。

## 内容

- `plugin.json`：清单，声明两个技能与一个 GitHub MCP 服务。
- `skills/repo-review/`：仓库 / PR 评审流程与检查清单。
- `skills/github-project-scan/`：公开项目调研与选型流程。

## 安装

1. 在 `.env` 中配置只读 GitHub Token：

   ```text
   GITHUB_TOKEN=ghp_xxxxxxxx
   PLUGIN_ALLOWED_COMMANDS=npx,uvx,node,python3,docker
   ```

2. 将本目录打成 zip（或直接指定目录）：

   ```bash
   cd examples/plugins
   zip -r github-assistant.zip github-assistant
   ```

3. 在管理控制台的「插件」页上传安装并启用。
   安装前控制台会展示将要执行的本地命令：
   `npx -y @modelcontextprotocol/server-github@0.6.2`。

4. 安装后确认：
   - 插件状态为“已启用”；
   - 两个技能出现在技能列表，来源为 `plugin`；
   - MCP 服务 ID 为
     `plugin-com-example-github-assistant-github`；
   - 工具名以
     `mcp__plugin-com-example-github-assistant-github__` 开头。

## 安全说明

- 清单中 `permissions.filesystem` 为 `none`，插件不读写工作区文件。
- 网络声明仅作审计展示，不改变宿主网络权限。
- `GITHUB_TOKEN` 只从进程环境读取，不写入数据库，也不会出现在管理 API 返回值中。
- stdio 命令必须位于 `PLUGIN_ALLOWED_COMMANDS` 白名单；执行时使用 argv 数组，不经过 shell。
- 生产环境建议固定版本并预装依赖，避免每次通过 `npx` 下载。
