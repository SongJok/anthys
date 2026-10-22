#!/bin/sh
# One-command development stack: generate local secret files (0600, gitignored)
# then build and wait for postgres, migrate and the API health check. When the
# sandbox profile is requested, also prepare the broker key/config material and
# the digest-pinned analysis runtime image.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
node deploy/setup-dev-secrets.mjs
for arg in "$@"; do
  case "$arg" in
    sandbox|--profile=sandbox) node deploy/setup-sandbox-broker.mjs --build; break ;;
  esac
done
# Compose resolves .env relative to the compose file, not the repository root.
# Pass the root file explicitly when present so non-secret DingTalk/GLM settings
# are interpolated; setup-dev-secrets.mjs already imported the two secrets.
if [ -f .env ]; then
  exec docker compose --env-file .env -f deploy/compose/compose.dev.yml up -d --build --wait "$@"
fi
exec docker compose -f deploy/compose/compose.dev.yml up -d --build --wait "$@"
