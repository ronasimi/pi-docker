#!/usr/bin/env bash
set -Eeuo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"

wait_for_ollama() {
  local tries=0
  until curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if (( tries >= 20 )); then
      echo "Ollama is not reachable at $OLLAMA_URL" >&2
      exit 1
    fi
    sleep 1
  done
}

has_model() {
  local name="$1"
  curl -fsS "$OLLAMA_URL/api/tags" | jq -e --arg n "$name" '.models[]?.name == $n' >/dev/null
}

create_alias() {
  local source="$1" target="$2"
  if has_model "$target"; then
    echo "Already exists: $target"
    return
  fi
  if ! has_model "$source"; then
    echo "Missing source model: $source" >&2
    return 1
  fi
  echo "Creating $target from $source with num_ctx=65536..."
  jq -n \
    --arg model "$target" \
    --arg from "$source" \
    '{model:$model, from:$from, parameters:{num_ctx:65536}, stream:false}' \
  | curl -fsS "$OLLAMA_URL/api/create" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null
}

wait_for_ollama
create_alias 'gemma4:e2b-it-qat' 'gemma4:e2b-it-qat-64k'
create_alias 'gemma4:e4b-it-qat' 'gemma4:e4b-it-qat-64k'

echo
echo "Configured Ollama models:"
curl -fsS "$OLLAMA_URL/api/tags" | jq -r '.models[]?.name' | grep -E 'gemma4:.*64k$|gemma4:e[24]b-it-qat$' || true
