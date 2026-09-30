#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T pi node /usr/local/lib/pi-docker/sync-ollama-models.mjs

echo
echo "Generated Pi Ollama models:"
docker compose exec -T pi jq -r '.providers.ollama.models[] | "\(.id)\tctx=\(.contextWindow)\treasoning=\(.reasoning)\tinput=\(.input|join(","))"' /home/pi/.pi/agent/models.json 2>/dev/null || true

echo
echo "Restart Pi/Web UI if the model selector is already open:"
echo "  docker compose restart pi"
