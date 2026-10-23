#!/bin/sh
# T129 empty-environment delivery oracle.
#
# The oracle extracts the committed tree (git archive, so no working-tree state,
# .env, .secrets, node_modules, dist or .data can leak in) into a temporary
# directory, runs the real delivery script deploy/dev-up.sh against a fresh
# Compose project on alternate host ports, asserts live/ready and the full
# migration count, runs the delivery script a second time to prove repeatability,
# records measured results and tears the stack down.
#
# It never reads the developer .env or .secrets and never contacts GLM, DingTalk,
# DWS or company MCP providers. Requires docker, docker compose, git, tar, curl
# and node (the same host tools deploy/dev-up.sh already assumes).
#
# Usage: deploy/verify-delivery.sh
# Optional: ANTHYS_VERIFY_API_PORT (default 64800), ANTHYS_VERIFY_PG_PORT (default 64810)
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/anthys-delivery.XXXXXX")
project="anthys-delivery-$(date +%s)-$$"
api_port=${ANTHYS_VERIFY_API_PORT:-64800}
pg_port=${ANTHYS_VERIFY_PG_PORT:-64810}
image="anthys-app:delivery-$(date -u +%Y%m%d%H%M%S)-$$"
report="$repo_dir/reports/t129-delivery-latest.json"
compose_file=deploy/compose/compose.dev.yml
commit=$(git -C "$repo_dir" rev-parse HEAD)
node_version=$(node --version)
docker_version=$(docker version --format '{{.Server.Version}}')
compose_version=$(docker compose version --short)

run_isolated() {
  ( cd "$work_dir" && env -i \
      PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
      DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}" \
      DOCKER_HOST="${DOCKER_HOST:-}" DOCKER_CONTEXT="${DOCKER_CONTEXT:-}" \
      ANTHYS_COMPOSE_PROJECT="$project" \
      ANTHYS_API_PORT="$api_port" ANTHYS_PG_PORT="$pg_port" \
      ANTHYS_APP_IMAGE="$image" APP_ORIGIN="http://localhost:$api_port" \
      "$@" )
}

compose_cmd() {
  run_isolated docker compose -p "$project" -f "$compose_file" "$@"
}

cleanup() {
  status=$?
  compose_cmd down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
  exit $status
}
trap cleanup EXIT INT TERM

fail() {
  echo "T129_FAIL $*" >&2
  exit 1
}

echo "T129_STEP extract commit $commit"
git -C "$repo_dir" archive --format=tar "$commit" | tar -x -C "$work_dir"
for absent in .env .secrets .data node_modules dist; do
  [ ! -e "$work_dir/$absent" ] || fail "empty environment contains $absent"
done

echo "T129_STEP first delivery run"
first_start=$(date +%s)
run_isolated ./deploy/dev-up.sh
first_seconds=$(( $(date +%s) - first_start ))

live=$(curl -fsS "http://127.0.0.1:$api_port/api/v1/health/live") || fail "live endpoint unreachable"
ready=$(curl -fsS "http://127.0.0.1:$api_port/api/v1/health/ready") || fail "ready endpoint unreachable"
case "$live" in *'"status":"ALIVE"'*) ;; *) fail "live status unexpected: $live" ;; esac
case "$ready" in *'"status":"READY"'*) ;; *) fail "ready status unexpected: $ready" ;; esac
live_status=ALIVE
ready_status=READY

migrations=$(compose_cmd exec -T postgres psql -U oa_migrator -d anthys -Atc "SELECT count(*) FROM schema_migrations") || fail "migration count query failed"
[ "$migrations" = "116" ] || fail "expected 116 migrations, got $migrations"
services=$(compose_cmd ps --status running --services | LC_ALL=C sort | tr '\n' ' ')
case "$services" in *api*) ;; *) fail "api is not running: $services" ;; esac
case "$services" in *postgres*) ;; *) fail "postgres is not running: $services" ;; esac
case "$services" in *worker*) ;; *) fail "worker is not running: $services" ;; esac

echo "T129_STEP second delivery run (repeatability)"
repeat_start=$(date +%s)
run_isolated ./deploy/dev-up.sh
repeat_seconds=$(( $(date +%s) - repeat_start ))
repeat_ready=$(curl -fsS "http://127.0.0.1:$api_port/api/v1/health/ready") || fail "ready unreachable after repeat"
case "$repeat_ready" in *'"status":"READY"'*) ;; *) fail "repeat status unexpected: $repeat_ready" ;; esac
repeat_ready_status=READY
migrations_repeat=$(compose_cmd exec -T postgres psql -U oa_migrator -d anthys -Atc "SELECT count(*) FROM schema_migrations") || fail "repeat migration count failed"
[ "$migrations_repeat" = "116" ] || fail "repeat expected 116 migrations, got $migrations_repeat"

mkdir -p "$repo_dir/reports"
cat > "$report" <<EOF
{
  "schemaVersion": 1,
  "testId": "T129",
  "layer": "E2E",
  "status": "PASS",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$commit",
  "environment": {
    "platform": "$(uname -s)",
    "arch": "$(uname -m)",
    "node": "$node_version",
    "dockerServer": "$docker_version",
    "dockerCompose": "$compose_version",
    "composeProject": "$project",
    "apiPort": $api_port,
    "postgresPort": $pg_port,
    "image": "$image",
    "modelCalls": 0,
    "providerCredentials": "none: the tree is a git archive with no .env/.secrets; setup-dev-secrets.mjs generated fresh random local secrets and empty GLM/DingTalk secret files"
  },
  "steps": {
    "cleanExtract": "git archive $commit extracted to a temporary directory; asserted no .env, .secrets, .data, node_modules or dist",
    "firstDeliveryRun": {"command": "./deploy/dev-up.sh", "seconds": $first_seconds, "exitCode": 0},
    "health": {"live": "$live_status", "ready": "$ready_status"},
    "migrations": {"applied": $migrations, "expected": 116},
    "runningServices": "$services",
    "repeatDeliveryRun": {"command": "./deploy/dev-up.sh", "seconds": $repeat_seconds, "exitCode": 0, "ready": "$repeat_ready_status", "migrations": $migrations_repeat},
    "teardown": "docker compose down -v --remove-orphans and removal of the temporary image and directory"
  },
  "disclosure": "This proves a repeatable local empty-environment install, migrate, build and start from the committed tree on an isolated Compose project and alternate ports. Docker layer caches and package registries may speed the build; the run used no developer .env, .secrets, volumes or provider credentials. It is not a production release, not a second physical host, and does not verify any live GLM, DingTalk, DWS or company MCP capability."
}
EOF

echo "T129_MEASUREMENTS $(tr -d '\n' < "$report")"
echo "T129_PASS first=${first_seconds}s repeat=${repeat_seconds}s migrations=$migrations project=$project"
