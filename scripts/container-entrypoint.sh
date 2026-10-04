#!/usr/bin/env bash
set -u

log() { printf '[pi] %s\n' "$*" >&2; }
warn() { printf '[pi] WARNING: %s\n' "$*" >&2; }

MODELS_FILE="${PI_MODELS_FILE:-$PI_CODING_AGENT_DIR/models.json}"
FALLBACK_MODELS="${PI_MODELS_FALLBACK:-/etc/pi/models-fallback.json}"

if ! mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WEB_DATA_DIR" "$HOME/.config/mcp"; then
  warn "could not create one or more persistent state directories"
fi

# First-run defaults only; existing state is migrated explicitly on the host.
if [[ ! -e "$PI_CODING_AGENT_DIR/settings.json" ]]; then
  install -m 0600 /etc/pi/default-settings.json "$PI_CODING_AGENT_DIR/settings.json" || exit 1
fi
if [[ ! -e "$PI_WEB_DATA_DIR/client-state.json" ]]; then
  (umask 077; jq '{"__settings__":{"settings":.}}' /etc/pi/default-web-settings.json > "$PI_WEB_DATA_DIR/client-state.json") || exit 1
fi

log "Synchronizing Ollama model catalog..."
if node /usr/local/lib/pi-docker/sync-ollama-models.mjs; then
  log "Ollama model catalog synchronized."
else
  warn "Ollama model discovery failed; continuing with the last known-good catalog."
fi

if ! jq -e '.providers.ollama.models | type == "array" and length > 0' "$MODELS_FILE" >/dev/null 2>&1; then
  warn "No valid generated models.json is available."
  if [[ -r "$FALLBACK_MODELS" ]]; then
    if cp "$FALLBACK_MODELS" "$MODELS_FILE" 2>/dev/null; then
      log "Installed fallback model catalog."
    else
      warn "Could not write fallback model catalog to $MODELS_FILE"
    fi
  fi
fi


if [[ $# -eq 0 ]]; then
  set -- pi-web-ui --no-browser
fi

log "Starting: $*"
exec "$@"
