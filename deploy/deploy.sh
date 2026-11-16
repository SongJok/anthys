#!/usr/bin/env bash
# 幂等部署：拉代码 → 装依赖 → 构建 → 同步表结构 → 重启 → 健康检查
# 用法：sudo bash deploy/deploy.sh
# 环境变量：APP_USER APP_DIR BRANCH SERVICE SKIP_DB_PUSH ADMIN_PORT
set -euo pipefail

APP_USER="${APP_USER:-anthys}"
APP_DIR="${APP_DIR:-/opt/anthys}"
APP_PATH="${APP_DIR}/app"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-dingtalk-agent}"
ADMIN_PORT="${ADMIN_PORT:-8787}"
SKIP_DB_PUSH="${SKIP_DB_PUSH:-0}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m!!\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# 以应用用户执行命令。root 下 SUDO 为空，直接写 "$SUDO -u" 会把 -u 当成命令名，
# 因此按是否 root 分别走 runuser / sudo。
as_app() {
  if [ -n "$SUDO" ]; then
    sudo -u "$APP_USER" "$@"
  else
    runuser -u "$APP_USER" -- "$@"
  fi
}

[ -d "$APP_PATH/.git" ] || die "未找到 $APP_PATH/.git，请先完成首次克隆：sudo -u $APP_USER git clone <repo> $APP_PATH"

log "拉取代码（${BRANCH}）"
as_app git -C "$APP_PATH" fetch --all --tags
as_app git -C "$APP_PATH" checkout "$BRANCH"
as_app git -C "$APP_PATH" pull --ff-only origin "$BRANCH"

log "安装依赖"
# db:push / db:extend / build 需要 drizzle-kit、tsx、typescript 等 devDependencies
as_app pnpm -C "$APP_PATH" install --frozen-lockfile
as_app pnpm -C "$APP_PATH/web-console" install --frozen-lockfile

log "准备运行时目录"
as_app mkdir -p "$APP_PATH/.workspace" "$APP_PATH/.state/dws-profiles"
$SUDO chmod 700 "$APP_PATH/.state/dws-profiles"

log "构建（控制台静态资源 + 服务端 dist/index.js）"
as_app pnpm -C "$APP_PATH" build

if [ "$SKIP_DB_PUSH" != "1" ]; then
  log "同步数据库表结构"
  as_app pnpm -C "$APP_PATH" run db:push
  log "补齐扩展索引与约束迁移（pgvector HNSW / pg_trgm / tsvector / pending_actions）"
  as_app pnpm -C "$APP_PATH" run db:extend
fi

log "重启服务"
$SUDO systemctl restart "$SERVICE"

log "健康检查"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${ADMIN_PORT}/health" >/dev/null 2>&1; then
    log "健康检查通过：http://127.0.0.1:${ADMIN_PORT}/health"
    $SUDO systemctl --no-pager --full status "$SERVICE" | head -n 12 || true
    exit 0
  fi
  sleep 2
done

$SUDO journalctl -u "$SERVICE" -n 60 --no-pager || true
die "健康检查失败"
