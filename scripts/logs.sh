#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."

echo '== Pi restart state =='
docker inspect pi --format 'status={{.State.Status}} running={{.State.Running}} restarting={{.State.Restarting}} exit={{.State.ExitCode}} restarts={{.RestartCount}} error={{.State.Error}}' 2>/dev/null || true

echo
echo '== Pi logs =='
docker compose logs --tail="${1:-200}" pi 2>&1 || true
