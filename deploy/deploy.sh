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

[ -d "$APP_PATH/.git" ] || die "未找到 $APP_PATH/.git，请先完成首次克隆：sudo -u $APP_USER git clone <repo> $APP_PATH"

log "拉取代码（${BRANCH}）"
$SUDO -u "$APP_USER" git -C "$APP_PATH" fetch --all --tags
$SUDO -u "$APP_USER" git -C "$APP_PATH" checkout "$BRANCH"
$SUDO -u "$APP_USER" git -C "$APP_PATH" pull --ff-only origin "$BRANCH"

log "安装依赖"
# 不能加 --prod：启动脚本用的 tsx 在 devDependencies 里
$SUDO -u "$APP_USER" pnpm -C "$APP_PATH" install --frozen-lockfile
$SUDO -u "$APP_USER" pnpm -C "$APP_PATH/web-console" install --frozen-lockfile

log "准备运行时目录"
$SUDO -u "$APP_USER" mkdir -p "$APP_PATH/.workspace" "$APP_PATH/.state/dws-profiles"
$SUDO chmod 700 "$APP_PATH/.state/dws-profiles"

log "构建（控制台静态资源 + 服务端）"
$SUDO -u "$APP_USER" pnpm -C "$APP_PATH" build

if [ "$SKIP_DB_PUSH" != "1" ]; then
  log "同步数据库表结构"
  $SUDO -u "$APP_USER" pnpm -C "$APP_PATH" run db:push
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
