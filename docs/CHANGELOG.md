# 2026-10-01 — MCP discovery precision and family reranking

- Diagnosed the Anansi `router client list` miss: the System `searchKeywords["*"]`
  bucket applied broad terms such as `router`, `network`, and `file` to every
  System tool, so unrelated Docker/document entries could rank ahead of
  `openwrt_clients`.
- Remove wildcard aliases from the heterogeneous System, Google, and Security
  catalogs while retaining high-signal per-tool aliases.
- Fetch a larger metadata-only candidate pool inside the bounded gate, then
  rerank locally before schema expansion. Model-facing discovery remains capped
  at three complete schemas and the existing 16 KiB response budget.
- Add family filtering for System (OpenWrt/Docker/host/network/image/document)
  and Google (auth/Gmail/Calendar/Drive), plus light plural normalization so
  `client` and `clients` rank together.
- Add regression coverage for router-client and Gmail family isolation.
- Validation in this editing environment: 17 gate tests passed, 2 policy tests
  skipped by their own environment guards, and all 14 security-gateway tests
  passed. Full Pi SDK/reasoning tests require dependencies not included in the
  saved archive and should be rerun in the Pi development container/host.

# 2026-10-01 — Repeated MCP calls and follow-up recovery

- The attached session's Arachne status and Anansi client calls were blocked because discovery was reset before each user message. The router tools were not attempted.
- Retain up to 64 discovered tool identifiers across follow-ups, refreshing their recency after successful calls. Restore discovery from successful searches on the active branch when a chat is reopened, reloaded or navigated; exclude unrelated chats and abandoned branches.
- Remove identical-failure and identical-output blacklists so explicit retries and status polling reach the adapter. Keep per-message budgets, live argument validation, configured approvals, and disabled-server checks. Failed operations are never automatically replayed by the gate.
- Explain missing discovery accurately and instruct the model to search and retry the requested action in the same turn.
- All 22 Pi regression tests pass, including real SDK follow-ups, repeated identical results, transient failure recovery, reload, and branch isolation. The six native tool names remain unchanged. Both calls blocked in the attached session also reach a local fixture after restoring that session's history.

# 2026-10-01 — WhiteRabbitNeo analysis and security suite

- Enable WhiteRabbitNeo's Pi thinking level on session start, model selection and turn preflight.
- Detect native Ollama thinking; V3 uses prompted analysis without unsupported reasoning API parameters.
- Respect configured Ollama `num_ctx` and add the security-agent fallback entry.
- Add discovery aliases for the 43-tool security MCP catalog; retain six native tools.
- Verify real Pi SDK outgoing requests for both prompted and native reasoning modes.

## 2026-09-30 — Security MCP registration and model-neutral routing

- Registered the bounded `security` MCP server at `http://mcp-security:8935/mcp`.
- Synced high-signal discovery metadata for security, system, Google, browser, web-search, and memory capabilities.
- Updated `APPEND_SYSTEM.md` to distinguish knowledge questions from runtime-tool execution and route security operations to `security` before generic Bash.
- Updated the native `mcp_search` description so all six server categories are discoverable to small local models.
- Extended `scripts/status.sh` to verify DNS and TCP connectivity for System, Google, and Security MCP services from inside the Pi container.
- Pi remains Dockerized and uses the existing external `ai-local` network; no systemd service or automatic security-model routing is introduced.

# Bounded MCP routing update — 2026-09-30

## Diagnosis

The supplied CBC session began with 12,070 input tokens. It exposed SearXNG directly, accepted section/search-result titles as five current headlines, and then called Pi Web UI's `browser_page` twice even though its page-picker bridge was unpaired. Playwright existed behind MCP but was never discovered. The final search also failed across upstream search engines.

## Changes

- Six stable model-facing tools: four Pi core tools plus bounded MCP search and invocation.
- Disabled all optional Web UI tools and package resources; removed the direct SearXNG pin and MCP scripting exposure.
- Enforced the allowlist both in Web UI tool gating and Pi execution hooks. Existing more restrictive presets remain effective.
- Required successful discovery before MCP invocation. Discovery returns up to three complete schemas and never registers additional native tools.
- Preserved adapter transport handling, JSON-schema validation, configured approvals, and output guards.
- Added per-turn search/call budgets, a bounded discovery cache, duplicate result suppression, and repeated-failure/no-progress guards.
- Routed page-reading/headline tasks to live Playwright snapshots and instructed the model to distinguish search snippets from current article evidence.
- Pinned package versions and installed adapter dependencies during image build. Settings migration is backed up and idempotent.

## Validation

14 regression tests passed, including a real Pi 0.99.1 SDK, adapter 4.0.0, an HTTP MCP fixture, and a streaming OpenAI-compatible provider fixture. Every captured model request contained exactly the six intended schemas. The fixture proved that undiscovered and invalid calls are errors, repeated failures are blocked, only valid calls reach MCP, and discovery grants reset for a new user turn. Other checks cover bounds, offline metadata, Web UI reactivation, restrictive presets, state preservation, and corrupt JSON handling.

Docker is unavailable in the editing workspace. The full image build, real Ollama/Gemma behavior, live CBC access, and latency/token improvements require verification on the host. Prompt instructions improve routing and evidence handling but do not guarantee model accuracy.

Suggested commit message: `fix: gate non-core tools behind bounded MCP discovery`
