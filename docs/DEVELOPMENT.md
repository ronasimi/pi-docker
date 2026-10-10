# Development and verification

## Source boundaries

- `runtime/`: exact package versions and dependency lock.
- `extensions/pi-native-services/`: public MCP and search factory bridge.
- `extensions/pi-atomic-tool-results/`: scheduling, grants, schema cache, result archives and evidence.
- `scripts/`: startup policy, model synchronization, probes and verifiers.
- `tests/`: SDK/Web UI integration and configuration contracts.

Upstream Pi and Web UI files remain untouched. The image installs dependencies as root, records their hashes, removes write permission, and runs as UID/GID 1000. Web UI's best-effort vendor patchers cannot alter those files.

## One check command

Inside the built container:

```bash
docker compose exec -T pi bash /opt/pi-app/scripts/check.sh
```

For local development, install `runtime/package-lock.json` into a separate runtime directory, rebuild `node-pty`, record upstream integrity, then set dependency paths:

```bash
export PI_RUNTIME_ROOT=/absolute/path/to/runtime
export PI_SDK_ROOT="$PI_RUNTIME_ROOT/node_modules/@earendil-works/pi-coding-agent"
export PI_WEB_UI_ROOT="$PI_RUNTIME_ROOT/node_modules/pi-web-ui"
node scripts/upstream-integrity.mjs "$PI_RUNTIME_ROOT" --record
bash scripts/check.sh --read-only-runtime
```

`--read-only-runtime` uses Node's permission sandbox to emulate immutable dependencies when running as root. The runner reads only `*.test.mjs` files from the current extension and root test directories and verifies upstream integrity before and after. It also runs the Python host-mode tests. Required SDK/Web UI tests must not silently skip.

## Test map

| Suite | Contract |
| :--- | :--- |
| `tests/cli.integration.test.mjs` | Stock CLI extension loading |
| `tests/runtime.integration.test.mjs` | Actual SDK session, Web UI replay and symlinked startup CLI |
| `tests/clean-base.test.mjs` | One SDK, public factories and immutable upstream files |
| Root Qwen suites | Model preparation, probes, selection persistence and restore |
| Extension `routing-and-scope`, `assessment-policy` | Domain routing, operation scope and report sufficiency |
| Extension `lifecycle`, `privacy-and-permissions` | Startup, replay, retries, grants and redaction |
| Extension `discovery-and-retrieval`, `evidence-policy` | Exact selection, bounded evidence and reporting |
| Other extension suites | Archives, pagination, progress, compaction, schemas and actual provider wire behavior |

Historical revision names were replaced with capability names. Useful regressions remain; tests for retired extension files are not shipped. Fixtures include explicit legacy state only where needed to verify upgrades.

## Changes included in this clean snapshot

- Fixed eight-tool provider surface after CLI/Web UI settings replay.
- Discovery handles remain authorized independently of cache eviction.
- Durable selective retrieval, redaction and original execution provenance.
- Bounded read reuse, independent batches, retry and settlement recovery.
- Host/router inventory and passive protocol intent selection corrections.
- Loaded runtime fingerprint and symlink-safe startup policy execution.

Offline fixtures establish software behavior. They do not establish live model quality, multicast delivery, router state or endpoint connectivity. Docker image builds and live deployment remain host checks.
