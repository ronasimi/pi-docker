#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DEST="$AGENT_DIR/extensions/pi-atomic-tool-results"
mkdir -p "$AGENT_DIR/extensions"
if [[ -e "$DEST" && ! -L "$DEST" ]]; then
  echo "Refusing to replace non-symlink: $DEST" >&2
  exit 1
fi
ln -sfn "$ROOT" "$DEST"
echo "Installed development symlink: $DEST -> $ROOT"
echo "Restart Pi or use /reload to load the extension."
