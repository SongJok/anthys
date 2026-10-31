#!/usr/bin/env bash
# 在全新 ECS 上安装运行依赖：Node 24、pnpm、构建工具链、PostgreSQL 16 + pgvector
# 用法：sudo bash deploy/install-system-deps.sh
set -euo pipefail

NODE_MAJOR=24
PG_MAJOR=16
APP_USER="${APP_USER:-anthys}"
INSTALL_DOCKER="${INSTALL_DOCKER:-1}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m!!\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# ---------- 发行版识别 ----------
if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-}"; OS_VERSION="${VERSION_ID:-}"; fi
OS_ID="${OS_ID:-unknown}"
case "$OS_ID" in
  debian|ubuntu) FAMILY=debian ;;
  alinux|centos|rhel|rocky) FAMILY=rhel ;;
  *) die "不支持的发行版 ${OS_ID}（支持 debian/ubuntu 与 alinux/centos/rhel/rocky）" ;;
esac
log "系统：${OS_ID} ${OS_VERSION:-}（${FAMILY}）"

# ---------- 通用构建工具链 ----------
if [ "$FAMILY" = debian ]; then
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update
  $SUDO apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg git build-essential python3 pkg-config sudo rsync
else
  $SUDO dnf install -y curl ca-certificates git gcc gcc-c++ make python3 pkgconf-pkg-config sudo rsync
fi

# ---------- Node.js 24 ----------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
  log "安装 Node.js ${NODE_MAJOR}"
  if [ "$FAMILY" = debian ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
    $SUDO dnf install -y nodejs
  fi
else
  log "Node.js 已满足要求：$(node -v)"
fi

# ---------- pnpm ----------
if ! command -v pnpm >/dev/null 2>&1; then
  log "安装 pnpm"
  $SUDO npm install -g pnpm@10
fi
log "node=$(node -v) pnpm=$(pnpm --version)"

# ---------- PostgreSQL 16 ----------
if ! command -v psql >/dev/null 2>&1 || [ "$(psql --version | grep -oE '[0-9]+' | head -1)" -lt "$PG_MAJOR" ]; then
  log "安装 PostgreSQL ${PG_MAJOR}"
  if [ "$FAMILY" = debian ]; then
    if ! apt-cache show "postgresql-${PG_MAJOR}" >/dev/null 2>&1; then
      $SUDO apt-get install -y curl gnupg
      $SUDO install -d /usr/share/postgresql-common/pgdg
      curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | $SUDO gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
      echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
        | $SUDO tee /etc/apt/sources.list.d/pgdg.list >/dev/null
      $SUDO apt-get update
    fi
    $SUDO apt-get install -y "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" "postgresql-server-dev-${PG_MAJOR}"
  else
    RHEL_MAJOR="$(. /etc/os-release && echo "${VERSION_ID%%.*}")"
    $SUDO dnf install -y "https://download.postgresql.org/pub/repos/yum/repos/pgdg-redhat-release-latest.noarch.rpm"
    $SUDO dnf --disablerepo=pgdg-redhat-release -y install "postgresql-${PG_MAJOR}" "postgresql-server-devel-${PG_MAJOR}"
    log "已启用 PGDG 仓库（RHEL ${RHEL_MAJOR}）"
  fi
fi
log "psql=$(psql --version)"

# ---------- pgvector ----------
install_pgvector() {
  log "编译安装 pgvector"
  rm -rf /tmp/pgvector
  git clone --depth 1 --branch v0.8.0 https://github.com/pgvector/pgvector.git /tmp/pgvector
  make -C /tmp/pgvector
  $SUDO make -C /tmp/pgvector install
  rm -rf /tmp/pgvector
}

if [ "$FAMILY" = debian ]; then
  if apt-cache show "postgresql-${PG_MAJOR}-pgvector" >/dev/null 2>&1; then
    log "安装 pgvector（apt 包）"
    $SUDO apt-get install -y "postgresql-${PG_MAJOR}-pgvector"
  else
    install_pgvector
  fi
else
  if $SUDO dnf list --installed "postgresql-${PG_MAJOR}-pgvector" >/dev/null 2>&1; then
    log "pgvector 已安装"
  else
    $SUDO dnf install -y "postgresql-${PG_MAJOR}-pgvector" || install_pgvector
  fi
fi

# ---------- 启动 PostgreSQL ----------
log "启动 PostgreSQL"
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl enable --now "postgresql-${PG_MAJOR}" 2>/dev/null \
    || $SUDO systemctl enable --now postgresql
else
  $SUDO service postgresql start
fi

# ---------- Docker（沙盒非 JS 运行时需要） ----------
if [ "$INSTALL_DOCKER" = "1" ] && ! command -v docker >/dev/null 2>&1; then
  log "安装 Docker（沙盒 python/bash 模式需要）"
  if [ "$FAMILY" = debian ]; then
    $SUDO apt-get install -y docker.io || {
      $SUDO install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
      $SUDO apt-get update && $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io
    }
  else
    $SUDO dnf install -y docker || die "请手动安装 Docker"
  fi
  $SUDO systemctl enable --now docker
fi

# ---------- 运行账号 ----------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "创建运行账号 ${APP_USER}"
  $SUDO useradd -m -s /bin/bash "$APP_USER"
fi

log "完成。版本核对："
printf '  node    %s\n' "$(node -v)"
printf '  pnpm    %s\n' "$(pnpm --version)"
printf '  psql    %s\n' "$(psql --version)"
command -v docker >/dev/null 2>&1 && printf '  docker  %s\n' "$(docker --version)" || printf '  docker  未安装（沙盒仅 JS 可用）\n'
