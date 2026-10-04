# Changelog

## 2026-10-03 — Stock Pi 1.0 migration

- Upgrade the runtime to official `@earendil-works/pi-coding-agent` 1.0.0 and `pi-web-ui` 0.97.0.
- Remove the custom bounded MCP gate, Pi-side MCP adapter, old Web UI policy patch, workflow guards, custom discovery grants, and Pi-side ranking/recovery code.
- Enable upstream `builtin:mcp` and `builtin:tool-search`; start with `read`, `bash`, `edit`, `write`, and `tool_search`.
- Configure all existing MCP servers through native `mcp.json` with deferred exposure.
- Replace the large procedural addendum with a compact positive-action prompt while retaining domain routing.
- Preserve Docker service identity and bind-mounted Pi/Web UI state so sessions and settings survive the migration.

# 2026-10-02 — Runtime no-progress and thinking-only continuation guards
- Fix the thinking-only `agent_before_settle` continuation guard: the pre-draft boundary normally reports `canContinue=false` when the current final role is assistant. The guard now appends its hidden custom message first and lets Pi recompute/validate continuation, so thinking-only stops actually receive the promised one-shot continuation.

- Block repeated successful **read-only** MCP calls with equivalent arguments inside one user turn. All-optional tools also treat an immediate empty/default replay after a successful explicit call as equivalent, preventing expensive operations such as network discovery from running twice.
- Keep status/health/poll-style tools repeatable and allow fresh reruns when the user explicitly asks to rerun/recheck/refresh/repeat the operation. Failed calls are still retryable and are never auto-replayed.
- Add a one-shot `agent_before_settle` continuation guard for assistant messages that contain reasoning/thinking but no visible text or tool call. It appends a hidden continuation message and requests exactly one more provider turn.
- Preserve the existing missing-tool recovery, query-scoped MCP discovery, evidence-grounding rules, per-turn budgets, and discovery grant LRU.
- Validation in this archive: 29/29 gate/runtime-guard unit tests pass; policy tests pass with environment-only cases skipped. SDK integration/reasoning tests still require the Pi development dependency when run outside the built image.

# 2026-10-02 — Small-model missing MCP tool-name recovery

- Diagnose a Gemma 4 E2B serialization failure where `mcp_call` emitted a valid `args` object but omitted the required `tool` field, causing Pi-side validation to reject the call before the bounded gate could recover it.
- Make the model-facing `tool` field syntactically optional so malformed small-model calls reach the compatibility layer, while keeping exact discovered tool names as the required semantic behavior.
- Retain discovered input schemas internally and infer an omitted tool only when the arguments match exactly one recently discovered schema (or exactly one retained grant). Ambiguous or unmatched calls fail closed; no fuzzy name repair or invented tool selection is allowed.
- Preserve the existing `tool{}` empty-argument normalization and discovery/LRU/security bounds.
- Add regression coverage for the observed `security_perform_network_discovery` call shape and for ambiguous-schema rejection.
- Validation in this archive: 23/23 bounded-gate unit tests pass. Full SDK integration/reasoning tests still require the Pi development dependency that is not installed in this editing environment.

- Add a multi-step MCP completion contract: each explicitly requested capability must either complete successfully or receive its own exhausted discovery before the model may finalize.
- Mark every `mcp_search` result as query-scoped (`catalogComplete: false`) and explicitly warn that a search result is not a complete server catalog.
- Add evidence-grounding rules for unknown/not-tested states and network-specific inference errors (remote wired/wireless attachment, L2 observation, Wi-Fi HE/NSS/GI, single-sample stability).
# 2026-10-01 — WhiteRabbitNeo bounded discovery continuation hardening
- Harden `mcp_call` for small local models that serialize an empty argument object as an exact discovered tool name plus `{}`; normalize only that unambiguous suffix and keep arbitrary/fuzzy tool-name repair disabled.

- Route strong security, System/OpenWrt, Google, browser, web-search, and memory capability queries to the matching MCP server when a small model omits the filter; security prompts still require explicit `server=security`.
- Make `mcp_search` and `mcp_call` sequential at the Pi tool layer so dependent discovery/execution calls cannot race as sibling tool calls.
- Cache and page the locally reranked discovery stream, following the adapter's upstream `nextOffset` for up to four bounded pages instead of replaying offset zero.
- Require schema-fit validation and continuation on `hasMore/nextOffset` before refining a search or concluding that a capability is missing.
- Down-weight one-token entity aliases in longer capability queries so `clients on router anansi` ranks `openwrt_clients` ahead of generic router status while `check anansi router status` still ranks status first.
- Synchronize the Pi catalog with the gateway's per-tool System/Google/Security aliases, removing broad wildcard aliases while preserving Pi-specific transport timeouts and restrictions.
- Clarify that `security_network_interfaces` is the security-container namespace only; authorized LAN enumeration uses `security_network_discover` with the actual target CIDR.
- Add regressions for omitted security routing, multi-page discovery continuation, exact Anansi client ranking, and security network scope.
- Validation in this archive: 20 runnable gate tests passed (2 policy tests skipped by environment guards) and all 14 security-gateway tests passed.

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
