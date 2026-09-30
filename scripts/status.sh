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
echo '== MCP TCP endpoints from Pi container =='
for port in 8888 8931 8932; do
  if docker compose exec -T pi bash -lc "exec 3<>/dev/tcp/mcp-gateway/$port" >/dev/null 2>&1; then
    echo "mcp-gateway:$port reachable"
  else
    echo "mcp-gateway:$port unreachable"
  fi
done

echo
echo '== Pi models =='
docker compose exec -T pi pi --list-models 2>/dev/null | grep -E 'ollama' || true
echo
echo '== Generated Ollama catalog =='
docker compose exec -T pi jq -r '.providers.ollama.models[]? | "\(.id)  ctx=\(.contextWindow) reasoning=\(.reasoning) input=\(.input|join(","))"' /home/pi/.pi/agent/models.json 2>/dev/null || true
echo
echo '== MCP-first routing prompt =='
docker compose exec -T pi bash -lc 'test -r "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md" && echo "APPEND_SYSTEM.md loaded from $PI_CODING_AGENT_DIR/APPEND_SYSTEM.md" || echo "APPEND_SYSTEM.md missing"' || true

echo
echo '== MCP routing configuration =='
docker compose exec -T pi jq -r '
  .mcpServers.searxng as $s |
  "searxng lifecycle=\($s.lifecycle // \"lazy\") directTools=\($s.directTools|tojson)"
' /home/pi/.config/mcp/mcp.json 2>/dev/null || true
echo 'Expected hot-path direct tool: searxng_search'

