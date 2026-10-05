# E4B regression fixes — 2026-10-04

Implemented:
- Wireless analysis is now passive-only. rescan=true is rejected before host delegation. This deliberately removes active rescanning from this analysis tool. Cached snapshots report no timed observation; duration applies only to airodump capture.
- Truncated results retain observation_path, storage errors, completion/pagination and map metadata. Saved raw reports are group-readable by Pi.
- Renderer accepts canonical/aliased aggregates and recognized raw recon JSON. Empty, unknown and ambiguous inputs fail instead of disappearing. It reports included and missing observations and partial-input warnings. It never auto-loads unrelated historical observations.
- Topology uses null plus an explicit unavailable/not_tested status for unavailable mDNS reflection evidence. Segmentation remains not_tested because virtual interfaces are excluded.
- Maps label OS fingerprints as estimates and retain unknown attachment labels. HTML now has zoom-in/out/reset controls and scrollable content, missing-input warnings and evidence limits.
- Both Pi prompt copies preserve every workflow observation, inspect renderer warnings, and distinguish measurements from unsupported role, connection, mDNS and VLAN claims. Initialization uses loaded instructions rather than an assumed .init file.

Validation: 61 passing gateway tests, one UID-switch skip (including five new E4B regression tests). Catalog validation passed (132 owned tools). No live Docker or fresh model run was available. Prompt adherence still requires a new E4B run; deterministic tests cover tool behavior and data handoff, not free-form model claims.

Suggested commits:
- mcp-gateway: fix passive recon, preserve artifact handoffs, and expose map evidence gaps
- pi-docker: tighten recon evidence reporting and artifact completeness guidance

Install using the bundled installer and start a new Pi conversation. The installer updates the host helper as well as rebuilding containers. This revision includes the repository-local workspace and all previous cumulative fixes.
