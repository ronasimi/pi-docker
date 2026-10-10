#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

# ModelRuntime and ClientStateStore hold in-memory snapshots. Restart before
# migration to avoid racing a live Web UI writer or leaving stale selections.
docker compose restart pi
./scripts/validate-image.sh
