# Pi Docker: core tools and bounded MCP

Containerized Pi + Pi Web UI, using your existing Ollama and MCP services.

## Multi-step MCP completion

The bounded gate treats every `mcp_search` as query-scoped rather than a catalog listing. For requests with multiple explicit operations, each capability must either have a successful relevant call or its own exhausted discovery before the model finalizes. The system prompt also requires evidence-grounded synthesis: unknown and not-tested values remain unknown, and network reports may not infer remote attachment media, topology links, Wi-Fi security from HE/NSS/GI, or stability from a single sample.

Two runtime guards harden small-model orchestration: a successful read-only MCP call cannot be repeated with equivalent/default arguments in the same user turn unless the user explicitly asks for a fresh rerun (status/poll tools remain repeatable), and Pi's `agent_before_settle` boundary automatically continues **once** when a model stops with thinking/reasoning only and no visible answer or tool call. The continuation is hidden from the UI and tells the model to emit the intended tool call or continue outstanding workflow steps without replaying completed MCP work. The guard deliberately does not reject the boundary's initial `canContinue=false`: an ordinary final assistant role has that value before the hidden custom-message draft is applied; Pi recomputes continuation after the draft is appended.


## Tool surface

The model receives exactly these tools in the standard agent preset:

| Tool | Purpose |
|---|---|
| `read`, `write`, `edit`, `bash` | Core local file and shell operations |
| `mcp_search` | Discover up to three matching MCP schemas |

`mcp_search` uses singular `query` as the canonical argument. For small-model compatibility, the extension also accepts exactly one string in `queries: [...]` and normalizes it before discovery; empty/multi-item arrays and conflicting `query`/`queries[0]` values fail closed.
| `mcp_call` | Invoke an exact discovered MCP tool |

All optional Pi Web UI tools are disabled, including `browser_page`, subagents, terminal helpers, skills, scheduling, and direct MCP tools. Installed optional Pi packages are retained but their extensions, skills, and prompts are disabled. The original settings are backed up. The Web UI remains available; this changes the model's tools.

The MCP adapter runs behind the gate. Its generic `mcp`, scripting tool, and direct server tools are never registered into the model's tool list. The separate built-in Pi MCP/codemode/tool-search extensions are disabled to avoid duplicate surfaces. The bounded extension itself enforces the active-tool allowlist at session/turn boundaries, while Web UI settings disable optional tools. No pi-web-ui source patch is required.

Existing restrictive agent/permission presets continue to apply. Use the standard agent preset for all six tools; an existing chat in an ask/minimal/code preset can intentionally expose fewer tools. A read-only permission preset is not changed by this update. MCP server permissions and approvals remain those of the adapter/server; discovery is a routing gate, not an authorization mechanism.


### Network-map handoff

For comprehensive network reconnaissance, the gate stores the exact structured results of successful host-state, discovery, topology, and wireless calls for the current user turn. If `security_generate_graphical_network_map` is called, the gate requires every explicitly requested earlier network stage to have completed, then injects the stored results into `args.data`. Any native Pi `input_path` is removed rather than forwarded across containers. This avoids the `network_data.json` workspace mismatch and prevents the model from manually retyping/corrupting scan results.

If the user explicitly requests a wireless assessment, host-state Wi-Fi metadata does not satisfy that step: the dedicated `security_analyze_wireless_environment` capability must complete before map generation.

## MCP workflow

For capabilities outside exposed native tools:

```text
mcp_search({query: "browser_navigate", server: "playwright"})
mcp_call({tool: "<exact returned name>", args: {url: "https://www.cbc.ca/news"}})

For tools with no arguments, keep the empty object separate: `mcp_call({tool: "<exact returned name>", args: {}})`. The gate tolerates the narrow small-model mistake `<exact returned name>{}` only when that exact stripped tool was already discovered; arbitrary/fuzzy tool-name repair remains disabled.
```

Use the actual name returned by search. The model must not issue it as a native function. A named-page/headline request routes to Playwright and reads the live snapshot. SearXNG provides web search; search snippets alone do not prove which headlines are latest. System infrastructure, Google Workspace, and security capabilities remain behind the same bounded discovery flow; security tools are reached through the dedicated `security` server rather than generic Bash when available.

| Bound | Value |
|---|---:|
| Search results | Default and maximum 3 |
| Search response | At most 16 KiB, complete schemas only |
| Retained discovered tools | 64 identifiers per conversation branch, least recently used evicted first |
| Search calls | 6 per user turn |
| MCP executions | 24 per user turn |
| MCP text result guard | 12 KiB / 300 lines; full output spills to a local file |

Search accepts a server filter, a smaller limit, and an offset. Oversized schemas are reported and never silently truncated into a callable tool. Discovery survives follow-up messages and is restored from successful search results on the active conversation branch when a chat is reopened or reloaded. A new chat starts with no discovered tools. Only identifiers are retained; no extra schemas are added to the standing prompt. Disabled or removed servers remain unavailable.

Repeated status calls, unchanged successful results, and explicit retries are allowed. The gate never automatically replays a failed operation, which could already have changed state. Search and execution budgets still reset for each user message; failures count toward the execution budget. The adapter continues to validate arguments and enforce configured approvals. If discovery has been evicted, search for the requested action and retry in the same turn; that error is not evidence of a target failure.

Discovery uses the adapter's local keyword ranking; it does not call a second model, Jev, or an embedding service. No complete MCP catalog is injected into the standing prompt. Existing chats can be reopened after upgrading; their successful historical discovery is restored. Start a new chat if you want to discard old context.

## Requirements and startup

- Docker Engine and Compose plugin
- Existing Ollama publishing host port 11434
- MCP gateway running on the external Docker network `ai-local`
- Optional Gemma source models `gemma4:e2b-it-qat` and `gemma4:e4b-it-qat` for the existing 64K alias initialization

```bash
cd ~/Projects/pi-docker
./scripts/init.sh
```

Open http://127.0.0.1:8787. The image pins Pi 1.0.0, Pi Web UI 0.97.0, and MCP adapter 4.0.0. The Web UI's nested Pi SDK is pinned to the same Pi version. The build runs `scripts/verify-pi-runtime.mjs` and fails if `agent_before_settle` is unavailable or the nested/global Pi versions diverge. Existing `.env` pins override Compose defaults; run `./scripts/upgrade-upstream-runtime.sh` to raise old pins and rebuild safely.

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

Ollama model discovery retains the existing 64K aliases and now respects configured `num_ctx` values. On startup, `/api/tags` and `/api/show` generate the model catalog; `PI_OLLAMA_CONTEXT_CAP` defaults to 65536 and `PI_OLLAMA_MAX_TOKENS` to 4096. The provider's context metadata does not itself change Ollama's runtime context; the existing alias script does that.

Settings backups are `data/pi/agent/settings.json.before-mcp-gate` and `data/web/client-state.json.before-mcp-gate`. Migration is idempotent and preserves chats, model settings, and permission presets. Use `scripts/migrate-volumes-to-bind.sh` first if migrating from older named volumes.

## Verify

```bash
./scripts/status.sh
# Local regression suite (includes a real Pi SDK and mock HTTP MCP/provider):
cd extensions/mcp-gate
npm ci --ignore-scripts
npm test
```

To test the Web UI state migration against an installed package, set `PI_WEB_PACKAGE_DIR` to a Pi Web UI 0.97.x directory and run the policy tests. The image no longer patches pi-web-ui source; bounded tool enforcement stays in the Pi extension plus persisted Web UI disabled-tool settings.

Start a **new chat** and ask:

> Browse https://www.cbc.ca/news and read five current article headlines. Use MCP discovery, open the live page, and give article links. Do not substitute search snippets for the page.

Expected: `mcp_search` → `mcp_call`; no `browser_page`, direct `searxng_search`, or `mcpScript`. If a gateway is unavailable, the response should identify that server's connection error.

See `docs/CHANGELOG.md` for the diagnosis and validation limits.

## WhiteRabbitNeo reasoning

WhiteRabbitNeo V3 uses the prompted-analysis fallback; it has no native Ollama thinking channel. Pi enables its reasoning level and avoids unsupported API flags. Models advertising native thinking use it. See [configuration and verification](docs/WHITERABBIT-REASONING.md).
