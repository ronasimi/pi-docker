# Map output and capture fixes — 2026-10-04

Map output basenames are normalized under .security-results, the provisioned Security writer/Pi reader directory. A request for recon-session-1/network-map now writes .security-results/recon-session-1/network-map.{dot,svg,html}. Absolute paths, traversal and symlink output directories/files are rejected. New result subdirectories retain setgid and group-read/traverse permissions; output files remain group-readable. Existing workspace permissions are unchanged.

The host helper installer supplies HOME, XDG_CONFIG_HOME and WIRESHARK_CONFIG_DIR under its private StateDirectory and creates them before startup. ProtectHome=true remains enabled. Reinstalling the helper is required; the complete installer does this automatically.

L2 results now separate capture_completed, exit_code, observation_status and packet_count. observed means matching packets were returned, not merely that the process exited successfully. Successful zero-packet captures remain complete with no_matching_packets; diagnostics are preserved separately. This does not establish absence of switches or discovery protocols.

The network-recon skill preserves exact hostnames, separates vendors, reports bounded discovery and cached Wi-Fi visibility, and retries older map permission failures under .security-results using saved observations.

Validation: 64 gateway tests passed, one skipped; catalog validation passed (132 tools). Shell and Node syntax checks passed. Native Pi skill loading passed. Live systemd/Docker capture was not available here. No new network scans were performed.

Suggested commits:

mcp-gateway: fix: confine map outputs and clarify host capture results
- Normalize map paths under writable Security results; reject path/symlink escapes.
- Preserve Pi-readable directories and map files.
- Isolate Wireshark configuration from protected root home.
- Distinguish successful empty capture from failed capture and diagnostics.
- Add map confinement and capture outcome regression coverage.

pi-docker: fix: clarify recon map recovery and evidence reporting
- Reuse saved observations after map permission errors.
- Interpret capture status separately from diagnostics.
- Preserve observed hostnames and qualify scan/cache coverage.

Deploy with the bundled installer, then start a new Pi conversation. Existing observations can be reused to generate the failed map; rescanning is unnecessary.
