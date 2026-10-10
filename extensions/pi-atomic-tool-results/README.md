# Atomic tool/results

**Version 0.2.3 · external extension for stock Pi 1.1.0**

This extension owns bounded operation scheduling, authorization grants, selective result archives and evidence reporting. The separate native-services bridge uses Pi's public MCP and tool-search factories.

With `PI_ATOMIC_RESULTS_FIXED_PROVIDER_TOOLS=true`, provider declarations stay fixed at `read`, `bash`, `edit`, `write`, `tool_search`, `tool_invoke`, `result_get` and `result_list`. Hidden operations execute through authorized discovery and invocation; native target schemas still apply. Cache eviction does not revoke grants.

Results are redacted before storage and projection. Retrieved evidence retains its original execution provenance, including across retries. Execution success, observation completeness and task sufficiency remain separate. Independent read-only batches validate nested permissions before running.

The shared contract is `config/APPEND_SYSTEM.md`. `/atomic-version` displays the loaded fingerprint; `/atomic-report` displays the assessment ledger. Standalone installation is available through `scripts/install-local.sh`.

Use the root runtime test gate for actual SDK/Web UI integration. See [development](../../docs/DEVELOPMENT.md) and [operations](../../docs/OPERATIONS.md).

Discovery results remain archived, but default `result_list` and `result_search` exclude `tool_search`. Use an explicit `tool: "tool_search"` filter for diagnostics; known refs remain readable through `result_get`.
