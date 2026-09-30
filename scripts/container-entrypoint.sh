#!/usr/bin/env bash
set -u

log() { printf '[pi] %s\n' "$*" >&2; }
warn() { printf '[pi] WARNING: %s\n' "$*" >&2; }

MODELS_FILE="${PI_MODELS_FILE:-$PI_CODING_AGENT_DIR/models.json}"
FALLBACK_MODELS="${PI_MODELS_FALLBACK:-/etc/pi/models-fallback.json}"

# A recoverable initialization problem must never kill the Web UI and trigger
# Docker's restart policy. Report it, preserve the last known-good state, then
# start pi-web-ui so the user can inspect/fix the container.
if ! mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WEB_DATA_DIR" "$HOME/.config/mcp"; then
  warn "could not create one or more persistent state directories"
fi

log "Synchronizing Ollama model catalog..."
if node /usr/local/lib/pi-docker/sync-ollama-models.mjs; then
  log "Ollama model catalog synchronized."
else
  warn "Ollama model discovery failed; continuing with the last known-good catalog."
fi

# Guarantee a syntactically valid model catalog even on first boot when Ollama
# discovery fails. Existing/generated state always wins over the fallback.
if ! jq -e '.providers.ollama.models | type == "array" and length > 0' "$MODELS_FILE" >/dev/null 2>&1; then
  warn "No valid generated models.json is available."
  if [[ -r "$FALLBACK_MODELS" ]]; then
    if cp "$FALLBACK_MODELS" "$MODELS_FILE" 2>/dev/null; then
      log "Installed fallback Gemma 64K model catalog."
    else
      warn "Could not write fallback model catalog to $MODELS_FILE"
    fi
  fi
fi

# Dependencies are baked into the image. No npm installation during startup.
# A malformed state file must be fixed, not silently overwritten or allowed to
# launch the old unbounded tool surface. Backups are made before migration.
if ! node /usr/local/lib/pi-docker/configure-tool-policy.mjs; then
  warn "Tool policy migration failed. Check settings/client-state JSON and permissions; original files are preserved."
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- pi-web-ui --no-browser
fi

log "Starting: $*"
exec "$@"
