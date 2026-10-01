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
echo '== MCP DNS from Pi container =='
docker compose exec -T pi getent hosts mcp-searxng || echo 'mcp-searxng not found on ai-local'
docker compose exec -T pi getent hosts mcp-gateway || echo 'mcp-gateway not found on ai-local'
docker compose exec -T pi getent hosts mcp-system || echo 'mcp-system not found on ai-local'
docker compose exec -T pi getent hosts mcp-google || echo 'mcp-google not found on ai-local'
docker compose exec -T pi getent hosts mcp-security || echo 'mcp-security not found on ai-local'

echo
echo '== MCP TCP endpoints from Pi container =='
for spec in \
  'mcp-searxng|8888|SearXNG' \
  'mcp-gateway|8931|Playwright' \
  'mcp-gateway|8932|Memory' \
  'mcp-system|8933|System' \
  'mcp-google|8934|Google' \
  'mcp-security|8935|Security'; do
  IFS='|' read -r host port name <<<"$spec"
  if docker compose exec -T pi bash -lc "exec 3<>/dev/tcp/$host/$port" >/dev/null 2>&1; then
    echo "$name $host:$port reachable"
  else
    echo "$name $host:$port unreachable"
  fi
done

echo
echo '== SearXNG search from Pi container =='
code="$(docker compose exec -T pi curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --get --data-urlencode 'q=searxng' http://mcp-searxng:8888/search 2>/dev/null || true)"
echo "HTML search HTTP ${code:-000}"

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
docker compose exec -T pi jq -r '.mcpServers | to_entries[] | "\(.key): directTools=\(.value.directTools) url=\(.value.url)"' /etc/pi/mcp.json 2>/dev/null || true
echo 'Expected standard tool set: read, write, edit, bash, mcp_search, mcp_call'
docker compose exec -T pi jq '{defaultTools, extensions}' /home/pi/.pi/agent/settings.json 2>/dev/null || true
echo 'Optional Web UI tools disabled:'
docker compose exec -T pi jq '.__settings__.settings.disabledAgentTools' /home/pi/.pi-web/client-state.json 2>/dev/null || true
