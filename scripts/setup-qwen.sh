#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PI_PROJECT_DIR="$PWD"
SELECTOR="${1:-all}"
MODE="${2:---add}"
if [[ "$SELECTOR" == --restore ]]; then MODE=--restore; SELECTOR=all; fi
if [[ "$SELECTOR" == --status ]]; then MODE=--status; SELECTOR=all; fi
if [[ "$SELECTOR" == --compare ]]; then MODE=--compare; SELECTOR=all; fi
[[ "$SELECTOR" == all || "$SELECTOR" == 4b || "$SELECTOR" == distill ]] || { echo 'Use all, 4b or distill' >&2; exit 2; }
[[ "$MODE" == --add || "$MODE" == --activate || "$MODE" == --restore || "$MODE" == --probe || "$MODE" == --status || "$MODE" == --compare ]] || { echo 'Use --add, --activate, --probe, --status or --restore, --compare' >&2; exit 2; }
[[ "$MODE" != --activate || "$SELECTOR" != all ]] || { echo 'Select 4b or distill for activation' >&2; exit 2; }
if [[ "$MODE" == --status || "$MODE" == --compare ]]; then
  python3 "scripts/configure-qwen-trial.py" "${MODE#--}" "$PI_PROJECT_DIR" "$SELECTOR"
  exit 0
fi
if [[ "$MODE" != --restore ]]; then python3 scripts/configure-qwen-trial.py check-options; fi
docker compose config --quiet
stopped=0
tmp="$(mktemp)"
cleanup() {
  rm -f "$tmp"
  if [[ "$stopped" == 1 ]]; then docker compose up -d --force-recreate pi >&2 || true; fi
}
trap cleanup EXIT
if [[ "$MODE" == --restore ]]; then
  docker compose stop pi
  stopped=1
  python3 scripts/configure-qwen-trial.py restore "$PI_PROJECT_DIR"
  docker compose up -d --force-recreate pi
  stopped=0
  bash scripts/validate-image.sh
  exit 0
fi
bash scripts/validate-image.sh
if [[ "$SELECTOR" == all ]]; then models=(4b distill); else models=("$SELECTOR"); fi
failed=0
for model in "${models[@]}"; do
  if [[ "$MODE" != --probe ]]; then
    echo "Preparing Qwen $model..." >&2
    # Failed pull/preparation does not replace profiles or defaults.
    if ! docker compose exec -T pi node /usr/local/lib/pi-docker/prepare-qwen-trial.mjs "$model" > "$tmp"; then
      failed=1
      continue
    fi
    docker compose stop pi
    stopped=1
    python3 scripts/configure-qwen-trial.py profile "$PI_PROJECT_DIR" "$model" < "$tmp"
    docker compose up -d --force-recreate pi
    stopped=0
    bash scripts/validate-image.sh
  fi
  if ! docker compose exec -T -e "PI_QWEN_PROBE_TIMEOUT_MS=${PI_QWEN_PROBE_TIMEOUT_MS:-600000}" -e "PI_QWEN_PROBE_ROUNDS=${PI_QWEN_PROBE_ROUNDS:-2}" pi node /usr/local/lib/pi-docker/probe-qwen-trial.mjs "$model"; then
    echo "Qwen $model probe failed; saved default model selections were not changed." >&2
    failed=1
    continue
  fi
  if [[ "$MODE" == --activate ]]; then
    docker compose stop pi
    stopped=1
    python3 scripts/configure-qwen-trial.py activate "$PI_PROJECT_DIR" "$model"
    docker compose up -d --force-recreate pi
    stopped=0
    bash scripts/validate-image.sh
    echo "Qwen $model selected for new Pi and Web UI sessions."
  elif [[ "$MODE" == --probe ]]; then
    echo "Qwen $model re-tested. Saved profiles and selections are unchanged."
  else
    echo "Qwen $model tested and added to the model picker. Saved selections are unchanged."
  fi
done
exit "$failed"
