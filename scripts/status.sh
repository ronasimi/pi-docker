#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."

echo '== Pi container =='
docker compose ps || true

echo
echo '== Web UI =='
curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' "http://127.0.0.1:${PI_WEB_PORT:-8787}/" || echo 'unreachable'

echo
echo '== Ollama from Pi container =='
docker compose exec -T pi curl -fsS http://host.docker.internal:11434/api/tags \
  | jq -r '.models[]?.name' 2>/dev/null || echo 'unreachable'

echo
echo '== MCP gateway DNS from Pi container =='
docker compose exec -T pi getent hosts mcp-gateway || echo 'mcp-gateway not found on ai-local'

echo
echo '== Pi models =='
docker compose exec -T pi pi --list-models 2>/dev/null | grep -E 'ollama|gemma4' || true
