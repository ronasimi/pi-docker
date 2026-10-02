#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PI_TARGET="${PI_VERSION_TARGET:-1.0.0}"
WEB_TARGET="${PI_WEB_UI_VERSION_TARGET:-0.97.0}"
ENV_FILE="${PI_ENV_FILE:-$ROOT/.env}"

python3 - "$ENV_FILE" "$PI_TARGET" "$WEB_TARGET" <<'PY'
from pathlib import Path
import re, sys, time
p=Path(sys.argv[1]); pi_target=sys.argv[2]; web_target=sys.argv[3]
text=p.read_text() if p.exists() else ''
if p.exists():
    backup=p.with_name(p.name+f'.bak.{time.strftime("%Y%m%d-%H%M%S")}')
    backup.write_text(text)

def ver(v):
    m=re.match(r'^(\d+)\.(\d+)\.(\d+)', v or '')
    return tuple(map(int,m.groups())) if m else (0,0,0)

def set_min(text,key,target):
    pat=re.compile(rf'(?m)^{re.escape(key)}=(.*)$')
    m=pat.search(text)
    if m and ver(m.group(1).strip()) >= ver(target):
        return text
    line=f'{key}={target}'
    if m: return text[:m.start()]+line+text[m.end():]
    if text and not text.endswith('\n'): text+='\n'
    return text+line+'\n'

text=set_min(text,'PI_VERSION',pi_target)
text=set_min(text,'PI_WEB_UI_VERSION',web_target)
p.write_text(text)
print(f'[pi] build pins: PI_VERSION>={pi_target}, PI_WEB_UI_VERSION>={web_target} ({p})')
PY

node --test \
  extensions/mcp-gate/test/gate.test.mjs \
  extensions/mcp-gate/test/runtime-guards.test.mjs \
  extensions/mcp-gate/test/policy.test.mjs

docker compose build --pull pi
docker compose up -d --no-deps --force-recreate pi

docker exec pi node /usr/local/lib/pi-docker/verify-pi-runtime.mjs
docker compose ps pi
