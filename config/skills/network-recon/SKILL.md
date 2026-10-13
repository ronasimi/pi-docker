---
name: network-recon
description: Assess an authorized LAN using Security MCP host interfaces, passive observations, permitted discovery, topology, wireless analysis and maps.
---

# Network reconnaissance

Read this file; a skill is not a tool. `bash` and System `host_snapshot` do not provide physical LAN interface evidence.

## Exact Security MCP operations

1. `mcp__security__get_host_interface_info`: start with `{}` for physical interfaces, prefixes and routes.
2. `mcp__security__observe_broadcast_multicast`: passive ARP/mDNS/LLMNR/SSDP collection, if capture is available.
3. `mcp__security__perform_network_discovery`: **active probes**; require explicit authorization in this user turn AND runtime active-probe opt-in. “Network recon” alone is not consent.
4. `mcp__security__analyze_network_topology`: analyze actual current observations.
5. `mcp__security__analyze_wireless_environment`: use cached observations, `rescan:false`.
6. `mcp__security__generate_graphical_network_map`: render collected observation paths only.

Search the exact operation name using `tool_search` with `limit:1`; inspect its schema before invoking. If blocked/irrelevant/empty, refine **once** with `security` + action + object, then record BLOCKED/NOT TESTED and continue independent passive steps. Never search bare `security` or `mcp__security`, repeat rejected queries, or substitute unrelated tools. Denial does not mean MCP is offline.

Keep `next_offset`/`host_offset` and scope consistent across pages. Recover truncated Pi evidence via `result_get` and saved Security data via `read_security_result`. Report coverage, paths and missing stages precisely. For detailed procedures and map guidance, read only the needed sections of `PROCEDURES.md` in this directory; runtime authorization policy always takes precedence.
