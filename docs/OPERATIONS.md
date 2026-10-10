# Operating Pi

## State and configuration

| Path | Role |
| :--- | :--- |
| `.env` | Local port, token and model settings |
| `config/settings.json`, `config/web-settings.json` | Managed startup defaults |
| `config/mcp.json` | Deferred MCP endpoints |
| `config/APPEND_SYSTEM.md` | Current tool execution contract |
| `config/models-overrides.json` | Small per-model overrides |
| `data/pi`, `data/web` | Agent and Web UI state |
| `workspace` | Dedicated agent files and shared MCP outputs |

Startup synchronizes the Ollama catalog, applies runtime policy and verifies the actual session. Both cached and generated model catalogs are capped at 32K. Compaction retains 4,096 recent tokens and reserves 8,192 tokens.

## Models and Qwen trials

```bash
bash scripts/sync-models.sh
bash scripts/setup-qwen.sh all --add
bash scripts/setup-qwen.sh 4b --probe
bash scripts/setup-qwen.sh 4b --activate
bash scripts/setup-qwen.sh --status
bash scripts/setup-qwen.sh --compare
bash scripts/setup-qwen.sh --restore
```

Use `4b` or `distill` for activation. Preparation and activation can restart Pi. A failed probe keeps saved model selections unchanged. Activation requires a current successful probe matching the prepared profile; restore preserves later manual choices. Preparation may download model weights. Trial reports live in the local state directories.

## Live checks

```bash
bash scripts/status.sh
docker compose exec -T pi node /opt/pi-app/scripts/verify-stock-runtime.mjs --sdk-only
docker compose exec -T pi node /opt/pi-app/scripts/verify-stock-runtime.mjs --config-only
docker compose exec -T pi node /opt/pi-app/scripts/verify-stock-runtime.mjs --strict-mcp
```

Normal runtime checks allow optional external MCP endpoints to be offline. `--strict-mcp` requires live endpoint connectivity; use it when all configured services are expected to run. A listening TCP port alone does not establish a working MCP child process.

## Troubleshooting

| Symptom | Check and correction |
| :--- | :--- |
| Optional tool such as `schedule` appears | Rebuild this source. `config-common.mjs` resolves symlinks before detecting CLI entrypoints, so startup policy runs through either installed script path. |
| Verifier module not found | Use `/opt/pi-app/scripts/verify-stock-runtime.mjs`; the compatibility link is `/usr/local/lib/pi-docker`. |
| Security MCP fails although healthy | Read gateway logs and run its Security startup verifier. The image needs `src/core/redact.mjs`. |
| Old tests fail on missing extension exports | Replace the extension directory from the clean source. Merging old and new test trees leaves retired implementations behind. |
| `/atomic-version` has no visible response | Check the Web UI notification and startup log; the loaded fingerprint is also recorded in session entries. |
| Ollama catalog is empty | Check `/api/tags` from Pi and the host-published Ollama port, then sync models. |
| Host/LAN data reports a Docker interface | Use System host tools or Security host-helper operations; Pi `bash` runs inside its container. |
| Assessment stops with only a control marker | r24 makes one bounded continuation attempt and then returns the measured partial report. Missing observations stay NOT TESTED. |

## Restart and update

```bash
docker compose restart pi
bash scripts/init.sh
```

Use a new conversation after extension or catalog changes. Rebuild rather than mounting writable replacements over the locked runtime. State and model weights belong to their existing bind mounts, not the source archive.

## Discovery archive visibility

Default `result_list` and `result_search` omit `tool_search` entries before sorting/limiting. They remain archived for diagnostics. Supply `tool: "tool_search"` to list/search them explicitly; `result_get` still reads existing discovery refs. This does not grant tool-invocation permission.

## Router discovery

Generic `router`, `openwrt`, `anansi` and `arachne` queries select `mcp__system__openwrt_status`. Client queries select `openwrt_clients`; Wi-Fi queries select `openwrt_wifi_status`; target/alias queries select `openwrt_targets`. Configuration reads cannot select `openwrt_uci_set`. Explicit MCP namespaces remain binding, and operation arguments still need the real router target.
