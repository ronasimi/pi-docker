# Pi Docker — stock Pi 1.0 + Pi Web UI

This repository runs the official `@earendil-works/pi-coding-agent` 1.0.0 package with `pi-web-ui` 0.97.0. The Pi agent loop, MCP integration, tool search, and tool activation are upstream Pi features; the Pi npm package is unmodified and the retired custom MCP orchestration layer is removed. A version- and SHA-256-checked Web UI compatibility adjustment registers the official Pi MCP/tool-search SDK factories and preserves deferred tools when Web UI settings are replayed. It contains no custom search, routing, loop guard, or execution middleware.

## Runtime architecture

The model starts with Pi's normal file/shell tools plus the built-in `tool_search` loader:

- `read`
- `bash`
- `edit`
- `write`
- `tool_search`

Pi's upstream `builtin:mcp` extension reads `config/mcp.json`. Pi CLI loads built-ins automatically; the Web UI SDK integration explicitly registers the same upstream factories. Every configured MCP server uses `exposure: "deferred"`, so MCP schemas remain outside the normal active tool set until Pi's built-in discovery loads a matching tool.

The MCP servers own capability boundaries, target authorization, input bounds, tool descriptions, aliases, overlap metadata, and result handling. `APPEND_SYSTEM.md` contains only compact behavioral/evidence guidance and the temporary domain-routing section.

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

Run `scripts/configure-web-ui-native-mcp.mjs /path/to/pi-web-ui` once on the pristine Web UI package first. The smoke test connects all three owned MCP servers over stdio, checks that their 142 tools remain deferred, verifies native discovery of the daily briefing/wireless/unread-email tools, and replays the actual Web UI settings function. It makes no model requests or network scans.

The Web UI compatibility adjustment is pinned to 0.97.0. A different source hash stops the build for review; it never silently applies to another release. Pi remains the official 1.0.0 package.
