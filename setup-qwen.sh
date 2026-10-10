#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_PROJECT_DIR="${1:-$HOME/Projects/pi-docker}"
SELECTOR="${2:-all}"
MODE="${3:---add}"
if [[ "$SELECTOR" == --restore ]]; then MODE=--restore; SELECTOR=all; fi
if [[ "$SELECTOR" == --status ]]; then MODE=--status; SELECTOR=all; fi
if [[ "$SELECTOR" == --compare ]]; then MODE=--compare; SELECTOR=all; fi
[[ "$SELECTOR" == all || "$SELECTOR" == 4b || "$SELECTOR" == distill ]] || { echo 'Use all, 4b or distill' >&2; exit 2; }
[[ "$MODE" == --add || "$MODE" == --activate || "$MODE" == --restore || "$MODE" == --probe || "$MODE" == --status || "$MODE" == --compare ]] || { echo 'Use --add, --activate, --probe, --status or --restore, --compare' >&2; exit 2; }
[[ "$MODE" != --activate || "$SELECTOR" != all ]] || { echo 'Select 4b or distill for activation' >&2; exit 2; }
if [[ "$MODE" == --status || "$MODE" == --compare ]]; then
  python3 "$HERE/scripts/configure-qwen-trial.py" "${MODE#--}" "$PI_PROJECT_DIR" "$SELECTOR"
  exit 0
fi
if [[ "$MODE" != --restore ]]; then
  python3 "$HERE/scripts/configure-qwen-trial.py" check-options
fi
if [[ "$MODE" == --add || "$MODE" == --activate ]]; then
  bash "$HERE/apply-update.sh" "$PI_PROJECT_DIR" --deploy
fi
bash "$PI_PROJECT_DIR/scripts/setup-qwen.sh" "$SELECTOR" "$MODE"
