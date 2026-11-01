# 运维手册

## 部署目标

阿里云 ECS 单机：裸机 systemd 常驻 + Nginx 反向代理 + 同机自建 PostgreSQL 16（pgvector、pg_trgm），不使用 Docker 或 RDS。

## 首次部署

1. `sudo bash deploy/install-system-deps.sh`：Node 24、pnpm、构建工具链、PostgreSQL 16 + pgvector。
2. `sudo bash deploy/init-database.sh`：创建角色与库、启用 `vector` 扩展，输出 `DATABASE_URL`。
3. 克隆代码到 `/opt/anthys/app`，复制 `deploy/.env.production.example` 为 `.env` 并填写凭据。
4. `pnpm install`（含 devDependencies，启动依赖 `tsx`）与 `pnpm -C web-console install`。
5. `pnpm db:push` 建表；需要时执行 `pnpm db:extend` 补充扩展对象。
6. `pnpm build` 构建控制台并编译服务端；安装 `deploy/dingtalk-agent.service` 后 `systemctl enable --now dingtalk-agent`。
7. 安装 `deploy/nginx.conf`，`nginx -t && systemctl reload nginx`。

后续升级执行 `sudo bash deploy/deploy.sh`（幂等：拉代码 → 装依赖 → 构建 → 建表 → 重启 → 健康检查）。

## 运行与自检

- 健康检查：`GET /health` 返回 `{"ok":true}`。
- 控制台默认监听 `8787`，Nginx 只应放行受控来源 IP。
- 启动日志出现 `dingtalk agent is ready` 表示 Stream 已连接。
- 管理 API 前缀 `/api/v1/admin`，需要 `ADMIN_API_TOKEN`；未设置时仅应在受控网络使用。

## 配置与数据

- 运行期配置以数据库为准，重启后自动恢复；环境变量提供初始默认值。
- 数据库不可用时进程启动失败，先确认连接、建表与扩展已就绪。
- 日志输出到标准流，由 systemd/journald 收集；用 `journalctl -u dingtalk-agent` 查看。

## 常见故障

| 现象 | 排查方向 |
| --- | --- |
| 启动即退出 | 按日志补齐 `.env` 必需变量；确认依赖未用 `--prod` 安装 |
| 访问 `/` 404 | 未执行 `pnpm build`，控制台静态资源缺失 |
| 控制台 401 | `ADMIN_API_TOKEN` 与控制台填写的 Token 不一致 |
| MCP 连接失败 | 网络/证书/请求头令牌；用控制台「测试」查看具体错误 |
| MCP 在线但工具为 0 | 节点未暴露工具或连接尚未完成 |
| 群里不主动回复 | 检查群策略、冷却、置信度与防抢答窗口 |
| 卡片停在处理中 | 模板需为 AI 卡片且含 `content` 变量；查看 `streamingUpdate failed` |
| DWS 登录态过期 | 员工重新提问触发设备码授权，或单聊 `/dws-login` |
| DWS 缺权限 | 按管理员收到的权限点通知开通后，员工重新 `/dws-login` |

## 安全

- `.env` 权限 600，归运行用户所有；不要提交密钥。
- 控制台与数据库只监听受控来源；机器人 Stream 是出站长连接，无需公网入站端口。
- 写操作默认需要确认；审计轨迹记录工具调用与管理员变更。
