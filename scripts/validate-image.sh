#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
docker compose config --quiet
id="$(docker compose ps -q pi)"
[[ -n "$id" ]] || { echo 'Pi container is not running' >&2; exit 1; }
for ((attempt=0; attempt<180; attempt++)); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$id")"
  [[ "$health" != healthy ]] || break
  [[ "$health" != unhealthy ]] || { echo 'Pi health check failed' >&2; docker compose logs --tail 40 pi; exit 1; }
  sleep 1
done
[[ "$health" == healthy ]] || { echo 'Pi startup timed out' >&2; exit 1; }
docker compose exec -T pi node /usr/local/lib/pi-docker/verify-stock-runtime.mjs
docker compose exec -T pi pi --version
docker compose exec -T pi pi-web-ui --version
echo 'Image validation passed: one pinned stock SDK, unmodified Web UI, 32K catalogs/aliases, tool policy and six MCP catalogs.'
