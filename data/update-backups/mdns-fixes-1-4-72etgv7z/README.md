# Pi Docker — Pi 1.0 native MCP + Pi Web UI

This repository runs `@earendil-works/pi-coding-agent` 1.0.0 with `pi-web-ui` 0.97.0. The Pi agent loop, MCP integration, tool search, and tool activation remain upstream Pi features, and the retired custom MCP orchestration layer is removed. One narrow build-time compatibility patch keeps the Web UI on the official Pi MCP/tool-search SDK factories and preserves deferred tools during settings replay. A tiny runtime extension normalizes an **omitted** `tool_search.limit` to `1` through Pi's official mutable `tool_call` hook. Explicit caller limits are unchanged. The compiled Pi package is no longer patched, avoiding brittle coupling to generated source text. There is no custom search/routing loop or MCP execution layer.

## Runtime architecture

The model starts with Pi's normal file/shell tools plus the built-in `tool_search` loader. When `limit` is omitted, the runtime guard sets it to one before execution; an explicit larger limit still requests a broader batch:

- `read`
- `bash`
- `edit`
- `write`
- `tool_search`

Pi's upstream `builtin:mcp` extension reads `config/mcp.json`. Pi CLI loads built-ins automatically; the Web UI SDK integration explicitly registers the same upstream factories. Every configured MCP server uses `exposure: "deferred"`, so MCP schemas remain outside the normal active tool set until Pi's built-in discovery loads a matching tool.

The MCP servers own capability boundaries, target authorization, input bounds, tool descriptions, aliases, overlap metadata, and result handling. `APPEND_SYSTEM.md` contains compact behavioral/evidence guidance, including the distinction between named skills and deferred tool discovery and the rule that container network interfaces never substitute for host physical-interface state.

## Persistent state

Docker identity and state paths are intentionally unchanged from the earlier deployment:

- container: `pi`
- image: `local/pi-web-ui:latest`
- Web UI: `127.0.0.1:${PI_WEB_PORT:-8787}`
- Pi state/history: `./data/pi:/home/pi/.pi`
- Web UI state: `./data/web:/home/pi/.pi-web`
- workspace: `${HOME}/Projects:/workspace`

Upgrading/recreating the container therefore preserves existing sessions, model settings, Web UI history/preferences, credentials, and package state stored in those bind mounts.

## Upgrade from the bounded-gate deployment

Run:

```bash
./scripts/upgrade-stock-pi-1.0.sh
```

The script validates inputs and builds the image, then stops Pi and saves the current `.env`, Pi settings, and Web UI client state under:

```text
~/.local/state/pi-stock-upgrade.<unique-id>/
```

It then performs a narrow one-time settings migration:

- sets startup tools to `read`, `bash`, `edit`, `write`, `tool_search`
- restores the built-in MCP/tool-search extensions if the old gate disabled them
- removes the retired `pi-mcp-gate` wiring
- removes the retired `pi-mcp-adapter` package so `builtin:mcp` is the sole MCP owner
- preserves unrelated packages, resource filters, model settings, permission presets, and UI preferences
- disables optional Web UI tools using its supported persisted settings
- seeds the same policy for fresh installations
- pins Pi to `1.0.0` and Pi Web UI to `0.97.0`
- rebuilds/recreates only the `pi` container

The migration is host-side deployment logic; it is not loaded into the Pi runtime. Start a new conversation after deployment. Existing session history is retained, including any previous tool messages. To roll back settings, stop Pi, restore the backed-up files to their original paths and recreate Pi from the previous source/image.

## Native MCP configuration

`config/mcp.json` configures these existing services with deferred exposure:

| Domain | Endpoint |
| --- | --- |
| SearXNG | `http://mcp-searxng:8888/mcp/` |
| Playwright | `http://mcp-gateway:8931/mcp` |
| Memory | `http://mcp-gateway:8932/mcp` |
| System | `http://mcp-system:8933/mcp` |
| Google | `http://mcp-google:8934/mcp` |
| Security | `http://mcp-security:8935/mcp` |

The corresponding services must share the external Docker network `ai-local`.

## Common commands

```bash
./scripts/init.sh
./scripts/status.sh
./scripts/logs.sh
./scripts/down.sh
```

To resynchronize the local Ollama model catalog:

```bash
./scripts/sync-models.sh
```

## Validation

After the migration, `scripts/status.sh` reports the native MCP endpoints, Pi model catalog, `APPEND_SYSTEM.md`, and the stock tool policy. The expected startup tool set is:

```text
read, bash, edit, write, tool_search
```

Use Pi's `/mcp` UI to inspect native MCP connection status and `/tools`/configuration surfaces supplied by upstream Pi as appropriate.

## Offline integration checks

`python3 -m unittest discover -s tests -p '*test.py'` checks state preservation and idempotence.

After installing the pinned upstream packages in an isolated directory, run:

```bash
node tests/native-mcp-smoke.mjs /path/to/pi-coding-agent /path/to/pi-web-ui /path/to/mcp-gateway
```

Run `scripts/configure-web-ui-native-mcp.mjs /path/to/pi-web-ui` once on the pristine Web UI package first. The smoke test connects all three owned MCP servers over stdio, checks that all owned tools remain deferred, verifies the omitted-limit one-result regression plus explicit bounded searches, every canonical tool name, and the failed run’s exact discovery query, and replays the actual Web UI settings function. It makes no model requests or network scans.

The Web UI compatibility adjustment is pinned to 0.97.0. `config/extensions/tool-search-default-limit.js` is the sole `tool_search` default-limit compatibility layer: the updater mounts only that file into Pi's standard global extension directory, preserving any other user extensions, and the post-deploy verifier exercises both omitted and explicit limits. No generated Pi SDK files are modified.

## 2026-10-04 recon completion update

Topology preserves partial results when capture is unavailable. Wireless units are explicit. Host observation artifacts feed map input_paths directly. mDNS subnet discovery returns compact report rows and keeps full raw DNS audit evidence in a separate observation artifact to avoid context blowups. Pi builds now verify the ESM SDK import before deployment. See the bundle RECON-COMPLETION-FIXES.md for validation and limits.

## Dedicated agent workspace

Pi uses `pi-docker/workspace` as `/workspace`. The complete installer aligns the MCP workspace and retains files in the old location. See `docs/WORKSPACE-UPDATE.md`.

## Network recon skill

The bundled native Pi skill is mounted from `config/skills/network-recon`. Start a new conversation after deploying and invoke `/skill:network-recon I am authorized to assess this laptop’s connected LAN. Complete the assessment and generate SVG and HTML maps.` A named skill must be read from its skill path before MCP discovery; the skill name is not itself a `tool_search` query. For host/LAN work, the skill requires targeted discovery of `get_host_interface_info {}` and forbids using Security-container `eth0` or an interface name merely listed in an error. It uses deferred Security MCP tools, tracks all stages and saved observations, and reports evidence limitations.
