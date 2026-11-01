# 工程约定

## 语言与模块

- TypeScript + ESM，Node 24；相对导入必须带 `.js` 后缀。
- 严格类型检查：`pnpm typecheck`（服务端）与 `pnpm -C web-console build`（控制台含 tsc）。
- 新增配置优先走环境变量 + `DynamicConfigCenter`，需要热更新时暴露给控制台。

## 结构与模式

- 工具通过 `IToolProvider` 注册：`getTools(ctx)` 按当前用户与开关实时返回工具，执行结果区分普通文本与结构化输出。
- 外部依赖（钉钉、模型、MCP、DWS、搜索、GitHub）封装在独立客户端，Provider 只做参数校验、裁剪与格式化。
- 数据库访问集中在 `src/db/*Schema.ts` 与服务层；SQL 变更先改 Drizzle schema，再 `pnpm db:push`。
- 后台任务（自动同步、清理、旁听监听）带 `unref` 定时器并在关闭时清理。

## 安全与审计

- 工具输出视为不可信内容：限制长度、脱敏密钥、在上下文中标记来源。
- 管理端写操作必须经过鉴权并写入管理员审计；项目手册发布与人工条目变更单独审计。
- 不在日志、审计与手册中输出 token、密码或完整连接串；配置只展示变量名。
- 项目索引排除敏感文件；GitHub 客户端拒绝非 HTTPS、非白名单主机与重定向。

## 测试

- `pnpm test`（vitest run），测试文件与被测模块同目录，命名 `*.test.ts`。
- 时间、随机数、外部客户端尽量可注入，避免真实网络与真实数据库依赖。
- 提交前至少跑：`pnpm typecheck`、`pnpm test`；改控制台时再加 `pnpm -C web-console build`。

## 提交

- 小步提交，一个阶段一个可回滚的改动；提交信息用中文，格式 `feat|fix|docs|test: 摘要`。
- 不提交 `.env`、`.state/`、`dist/`、`node_modules/`。
