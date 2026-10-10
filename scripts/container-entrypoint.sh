#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[pi] %s\n' "$*" >&2; }
warn() { printf '[pi] WARNING: %s\n' "$*" >&2; }

MODELS_FILE="${PI_MODELS_FILE:-$PI_CODING_AGENT_DIR/models.json}"
FALLBACK_MODELS="${PI_MODELS_FALLBACK:-/etc/pi/models-fallback.json}"

mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WEB_DATA_DIR" "$HOME/.config/mcp"

log "Synchronizing Ollama model catalog..."
node /usr/local/lib/pi-docker/sync-ollama-models.mjs

node /usr/local/lib/pi-docker/apply-runtime-policy.mjs
node /usr/local/lib/pi-docker/verify-stock-runtime.mjs --config-only


if [[ $# -eq 0 ]]; then
  set -- pi-web-ui --no-browser
fi

log "Starting: $*"
exec "$@"
