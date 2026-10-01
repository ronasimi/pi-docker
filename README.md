# Pi Docker: core tools and bounded MCP

Containerized Pi + Pi Web UI, using your existing Ollama and MCP services.

## Tool surface

The model receives exactly these tools in the standard agent preset:

| Tool | Purpose |
|---|---|
| `read`, `write`, `edit`, `bash` | Core local file and shell operations |
| `mcp_search` | Discover up to three matching MCP schemas |
| `mcp_call` | Invoke an exact discovered MCP tool |

All optional Pi Web UI tools are disabled, including `browser_page`, subagents, terminal helpers, skills, scheduling, and direct MCP tools. Installed optional Pi packages are retained but their extensions, skills, and prompts are disabled. The original settings are backed up. The Web UI remains available; this changes the model's tools.

The MCP adapter runs behind the gate. Its generic `mcp`, scripting tool, and direct server tools are never registered into the model's tool list. The separate built-in Pi MCP/codemode/tool-search extensions are disabled to avoid duplicate surfaces. Web UI gating and a Pi execution hook also reject optional tools that another extension tries to expose.

Existing restrictive agent/permission presets continue to apply. Use the standard agent preset for all six tools; an existing chat in an ask/minimal/code preset can intentionally expose fewer tools. A read-only permission preset is not changed by this update. MCP server permissions and approvals remain those of the adapter/server; discovery is a routing gate, not an authorization mechanism.

## MCP workflow

For capabilities outside exposed native tools:

```text
mcp_search({query: "browser_navigate", server: "playwright"})
mcp_call({tool: "<exact returned name>", args: {url: "https://www.cbc.ca/news"}})
```

Use the actual name returned by search. The model must not issue it as a native function. A named-page/headline request routes to Playwright and reads the live snapshot. SearXNG provides web search; search snippets alone do not prove which headlines are latest. System infrastructure, Google Workspace, and security capabilities remain behind the same bounded discovery flow; security tools are reached through the dedicated `security` server rather than generic Bash when available.

| Bound | Value |
|---|---:|
| Search results | Default and maximum 3 |
| Search response | At most 16 KiB, complete schemas only |
| Retained discovered tools | 8 per user turn, oldest evicted first |
| Search calls | 6 per user turn |
| MCP executions | 24 per user turn |
| MCP text result guard | 12 KiB / 300 lines; full output spills to a local file |

Search accepts a server filter, a smaller limit, and an offset. Oversized schemas are reported and never silently truncated into a callable tool. MCP metadata is cached by the adapter; discovery grants reset at the next user turn. Repeating a failed call with identical arguments is blocked. Two identical successful outputs also block a third identical call to stop loops without progress. This guard is local to one user turn.

Discovery uses the adapter's local keyword ranking; it does not call a second model, Jev, or an embedding service. No complete MCP catalog is injected into the standing prompt. Large previous conversations can still carry old schemas/results: start a new chat after upgrading.

## Requirements and startup

- Docker Engine and Compose plugin
- Existing Ollama publishing host port 11434
- MCP gateway running on the external Docker network `ai-local`
- Optional Gemma source models `gemma4:e2b-it-qat` and `gemma4:e4b-it-qat` for the existing 64K alias initialization

```bash
cd ~/Projects/pi-docker
./scripts/init.sh
```

Open http://127.0.0.1:8787. The image pins Pi 0.99.1, Pi Web UI 0.96.1, and MCP adapter 4.0.0. The Web UI's bundled Pi SDK is pinned as well. Existing `.env` pins override Compose defaults; the bundled upgrade installer updates these two pins.

Dependencies are installed at image build time. Container startup only applies the settings migration and synchronizes Ollama models. Model discovery failures keep the last valid model catalog. Invalid settings JSON stops startup with an explicit error rather than silently starting the old tool surface.

## Endpoints

| Service | Container URL |
|---|---|
| Ollama | `http://host.docker.internal:11434` |
| SearXNG MCP | `http://mcp-searxng:8888/mcp/` |
| Playwright MCP | `http://mcp-gateway:8931/mcp` |
| Memory MCP | `http://mcp-gateway:8932/mcp` |
| System MCP | `http://mcp-system:8933/mcp` |
| Google MCP | `http://mcp-google:8934/mcp` |
| Security MCP | `http://mcp-security:8935/mcp` |

`config/mcp.json` registers all bounded servers, including the dedicated `security` endpoint on `mcp-security:8935`. The security container must be running on the shared external `ai-local` Docker network; Pi itself does not launch or route models for it. Edit `config/mcp.json` when adding or removing configured MCP servers. Per-server `disabled` flags and adapter approval configuration are respected. The gate always forces direct tools, MCP scripting, and automatic host-config imports off. Resources are not exposed in this tool-only profile.

## State and model configuration

- `data/pi` contains persistent Pi settings, packages, and sessions.
- `data/web` contains Web UI state.
- `~/Projects` is mounted at `/workspace`.
- `config/APPEND_SYSTEM.md` contains routing instructions.
- `config/models-overrides.json` retains your model metadata overrides.

Ollama model discovery and the existing 64K aliases are unchanged. On startup, `/api/tags` and `/api/show` generate the model catalog; `PI_OLLAMA_CONTEXT_CAP` defaults to 65536 and `PI_OLLAMA_MAX_TOKENS` to 4096. The provider's context metadata does not itself change Ollama's runtime context; the existing alias script does that.

Settings backups are `data/pi/agent/settings.json.before-mcp-gate` and `data/web/client-state.json.before-mcp-gate`. Migration is idempotent and preserves chats, model settings, and permission presets. Use `scripts/migrate-volumes-to-bind.sh` first if migrating from older named volumes.

## Verify

```bash
./scripts/status.sh
# Local regression suite (includes a real Pi SDK and mock HTTP MCP/provider):
cd extensions/mcp-gate
npm ci --ignore-scripts
npm test
```

To also test the Web UI patch and state migration, set `PI_WEB_PACKAGE_DIR` to an installed Pi Web UI 0.96.1 directory after running `scripts/patch-web-tool-policy.mjs` against it. The image applies that patch during build and fails if upstream source no longer matches.

Start a **new chat** and ask:

> Browse https://www.cbc.ca/news and read five current article headlines. Use MCP discovery, open the live page, and give article links. Do not substitute search snippets for the page.

Expected: `mcp_search` → `mcp_call`; no `browser_page`, direct `searxng_search`, or `mcpScript`. If a gateway is unavailable, the response should identify that server's connection error.

See `docs/CHANGELOG.md` for the diagnosis and validation limits.
