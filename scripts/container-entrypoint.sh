#!/usr/bin/env bash
set -Eeuo pipefail

mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WEB_DATA_DIR" "$HOME/.config/mcp"

# pi_data is a runtime volume, so seed the MCP extension into that volume on
# first boot. Subsequent starts do not contact npm unless the package is absent.
SETTINGS="$PI_CODING_AGENT_DIR/settings.json"
if ! jq -e '.packages // [] | index("npm:pi-mcp-adapter") != null' "$SETTINGS" >/dev/null 2>&1; then
  echo "[pi] Installing token-efficient MCP adapter into persistent Pi data..."
  pi install npm:pi-mcp-adapter
fi

exec "$@"
