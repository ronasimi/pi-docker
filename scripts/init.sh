#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

# Host bind mounts replace opaque Docker volumes. Container user pi is UID/GID 1000.
mkdir -p data/pi/agent data/web workspace
if [[ $(id -u) -eq 0 ]]; then
  chown -R 1000:1000 data/pi data/web workspace
fi

# MCP gateway v10 exposes trusted client endpoints directly on ai-local;
# its SearXNG API key stays private between gateway containers.

if ! docker network inspect ai-local >/dev/null 2>&1; then
  docker network create ai-local >/dev/null
  echo "Created Docker network: ai-local"
fi

docker compose up -d --build --force-recreate pi
./scripts/validate-image.sh

echo
echo "Pi Web UI: http://127.0.0.1:${PI_WEB_PORT:-8787}"
echo "Ollama:    existing server at http://127.0.0.1:11434"
echo "MCP:       bounded MCP services over ai-local"
echo
echo "Use ./scripts/status.sh to verify connectivity."
