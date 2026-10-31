#!/usr/bin/env bash
# 创建 PostgreSQL 角色与库，并启用 pgvector 扩展
# 用法：sudo bash deploy/init-database.sh
# 密码来源优先级：命令行第一个参数 > DB_PASSWORD 环境变量 > 随机生成并打印
set -euo pipefail

DB_NAME="${DB_NAME:-dingtalk_agent}"
DB_USER="${DB_USER:-anthys}"
DB_PASSWORD="${1:-${DB_PASSWORD:-}}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m!!\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

if [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  GENERATED=1
fi

psql_super() { $SUDO -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

log "确保角色 ${DB_USER} 存在"
psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || psql_super -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"

if [ -n "${GENERATED:-}" ]; then
  log "已生成随机数据库密码，请写入 .env 的 DATABASE_URL："
  printf 'postgres://%s:%s@127.0.0.1:5432/%s\n' "$DB_USER" "$DB_PASSWORD" "$DB_NAME"
fi

log "确保数据库 ${DB_NAME} 存在"
psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || psql_super -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER} ENCODING 'UTF8'"

log "启用 pgvector 扩展"
psql_super -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"

log "确认扩展已就绪"
psql_super -d "$DB_NAME" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector'"

log "完成。DATABASE_URL 形如：postgres://${DB_USER}:<密码>@127.0.0.1:5432/${DB_NAME}"
