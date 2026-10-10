#!/usr/bin/env bash
# Start ONE Pi CLI run with no Pi-side schema/lease cap and 24K compaction.
# The Web UI's bounded-schema/24K settings and saved sessions are never modified.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

docker compose config --quiet
docker compose ps -q pi | grep -q . || { echo 'The pi container must be running' >&2; exit 1; }

echo '[trial] Isolated CLI process: unbounded discovered-tool leases, 24K/32K compaction.' >&2
echo '[trial] You will see Pi thinking, tool calls and replies live in this terminal.' >&2
echo '[trial] Use /model inside Pi to choose Qwen 4B; type /exit or Ctrl+D to finish.' >&2
# Do not use `-T`: Pi's interactive CLI needs its own TTY. The environment
# variable is passed only to `docker exec`, not to the Web UI service.
docker compose exec --interactive --tty \
  -e PI_ATOMIC_RESULTS_DIAGNOSTIC_UNCAPPED=1 \
  -e PI_ATOMIC_RESULTS_DIAGNOSTIC_DEFAULT_SEARCH_LIMIT="${PI_SCHEMA_TRIAL_DEFAULT_SEARCH_LIMIT:-1}" \
  pi bash -c '
    set -Eeuo pipefail
    src="${PI_CODING_AGENT_DIR:-/home/pi/.pi/agent}"
    trial="$(mktemp -d /tmp/pi-schema-trial-XXXXXXXX)"
    chmod 700 "$trial"
    cleanup() { rm -rf -- "$trial"; }
    trap cleanup EXIT
    node /usr/local/lib/pi-docker/diagnostic-trial-config.mjs "$src" "$trial"
    export PI_CODING_AGENT_DIR="$trial"
    export PI_CODING_AGENT_SESSION_DIR="$trial/sessions"
    mkdir -m 700 -p "$PI_CODING_AGENT_SESSION_DIR"
    pi --no-session "$@"
  ' _ "$@"
