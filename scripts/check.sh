#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/test-runtime.mjs "$@"
python3 tests/qwen-host-modes.test.py
