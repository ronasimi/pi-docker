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

Router-list queries such as `system list routers` select `openwrt_targets`. `mcp openwrt status routes firmware` selects live router status; the word MCP alone does not turn router status into endpoint health.

## Passive observation and small-model behavior

Use `security passive network observation` or `security passive scan` to discover `observe_broadcast_multicast`. It listens on the physical host through the helper, sends no discovery probes, and requires capture permission and a working host helper. ARP sweeps, hairpin tests and DNS queries remain active operations. Later captures are fresh; only simultaneous identical captures coalesce.

Native file tools come first for workspace files. Use bash only as a last resort for container-local workspace tasks; host, Docker, OpenWrt and physical LAN work requires the appropriate MCP operation.

If a model prints a tool sequence as text, no calls executed. During an assessment the harness requests one real structured discovery call, then reports measured evidence if the retry also stops with a plan. This cannot repair an incompatible model template or guarantee model compliance.

Explicit limits phrased as `at most N tool calls`, `no more than N tool calls` or `maximum of N tool calls` are applied within the configured runtime ceiling. Searches, retrievals and rejected attempts count; wrappers do not hide batch operations. The limit resets for the next request.

For a latency comparison, start with one host observation and one router observation, rather than the six-part stress test. Where the model supports a reasoning toggle, compare it with the current medium setting using identical prompts. Inspect `pi.atomic-model-timing` for first-event time, total response time and output tokens. No reasoning default, context size or model template was changed in this update.

## Masscan discovery

`security masscan scan` resolves to Security `masscan_scan`, including the `massscan` spelling. Nmap and passive observation are not substitutes for explicit Masscan requests. Pi `.env` exposes `PI_ATOMIC_RESULTS_ALLOW_ACTIVE_NETWORK_PROBES`, default false. Setting it true only enables the runtime gate: explicit current-request scan authorization is still required, and read-only/passive-only requests continue to deny active operations. The gateway also requires `SECURITY_ALLOW_ACTIVE` and an authorized target. See the gateway network guide for limits.
