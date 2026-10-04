#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 scripts/migrate-stock-settings.py "$ROOT" --check
bash -n scripts/container-entrypoint.sh
python3 -m json.tool config/mcp.json >/dev/null

# Build successfully before changing durable state or stopping the running Pi.
PI_VERSION=1.0.0 PI_WEB_UI_VERSION=0.97.0 docker compose build --pull pi

backup_dir="$(mktemp -d "$HOME/.local/state/pi-stock-upgrade.XXXXXXXX" 2>/dev/null || true)"
if [[ -z "$backup_dir" ]]; then
  mkdir -p "$HOME/.local/state"
  backup_dir="$(mktemp -d "$HOME/.local/state/pi-stock-upgrade.XXXXXXXX")"
fi
docker compose stop pi
for file in .env data/pi/agent/settings.json data/web/client-state.json; do
  if [[ -e "$file" ]]; then
    mkdir -p "$backup_dir/$(dirname "$file")"
    cp -a "$file" "$backup_dir/$file"
  fi
done
echo "[backup] $backup_dir"

# Pi is stopped so Web UI's cached settings cannot overwrite the migration.
python3 scripts/migrate-stock-settings.py "$ROOT"
docker compose up -d --no-deps --force-recreate pi
docker compose exec -T pi node /usr/local/lib/pi-docker/verify-stock-runtime.mjs
echo '[done] stock Pi 1.0 + native deferred MCP is installed.'
echo 'Start a new conversation to use the new prompt and tool policy.'
