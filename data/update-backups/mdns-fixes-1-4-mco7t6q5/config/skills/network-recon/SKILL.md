---
name: network-recon
description: Assess an authorized laptop LAN using Security MCP host state, network discovery, topology, passive Wi-Fi analysis, and SVG/HTML maps. When selected by name, read this skill before MCP discovery; the skill name itself is not a tool_search query. Use for local network reconnaissance, device inventory, wireless assessment, or a complete network map.
---

# Network reconnaissance

Complete the requested stages using Security MCP. Restrict discovery to user-owned or explicitly authorized networks. Existing authorization for the connected LAN is sufficient for ordinary bounded discovery. Keep wireless analysis passive. Use current observations, not remembered devices or example addresses.

## Stage transitions

For a complete LAN assessment, execute host state → discovery → topology → passive wireless assessment → maps → report. Do not substitute discovery or host association data for a later stage.

| Returned outcome | Next action |
| --- | --- |
| Host state collected | Search `perform_network_discovery` with `limit: 1`. |
| Discovery page complete and `next_offset` is an integer | Call discovery with exactly that offset and the same scope; retain each page. |
| Discovery `complete: true` and `next_offset: null` | Finish discovery for this scope. Search `analyze_network_topology` with `limit: 1`. |
| Discovery phases incomplete | Follow the returned retry guidance with narrower targets; preserve partial coverage and continue independent stages. |
| Topology attempted and outcome recorded | Search `analyze_wireless_environment` with `limit: 1` if Wi-Fi exists. Otherwise record wireless as not applicable. |
| Wireless attempted and outcome recorded, or no Wi-Fi confirmed | Search `generate_graphical_network_map` with `limit: 1`. |
| Maps returned | Check missing observations and warnings, then report actual coverage and exact output paths. |

Before every call, choose the pending stage and confirm that the tool name matches it. If its tool is not loaded, call `tool_search` for that exact operation. Never call a previously loaded discovery tool as a substitute for an unloaded topology, wireless or map tool. Announcing map generation requires searching for or calling the map tool; another scan does not generate a map.

Do not repeat a successful completed scan of the same scope unless the user explicitly requests a refresh. Omitted `host_offset` and `host_offset: 0` are the same first page, not a continuation. Retain the existing observation path and advance. Allow returned pagination offsets, recovery from incomplete phases, other authorized scopes and explicitly requested refreshes.

## Tool discovery and recovery

Use Pi's native `tool_search` followed by direct calls to the exact returned tool. Older instructions mentioning `mcp_search`/`mcp_call` refer to this native sequence.

For each new capability, search its exact operation name with `limit: 1`, inspect the schema, and call the returned tool. Start with:

```json
{"query":"get_host_interface_info","limit":1}
```

Call the discovered host-state tool with `{}`. Search operation names, rather than broad phrases such as “security MCP tools”. Reuse loaded tools.

If a call returns “Tool not found”, search that exact operation and retry using the returned name and schema. This means the tool was not loaded; it does not establish that host access is unavailable. If search returns an unrelated match, refine once with `security` plus the operation. Report a capability unavailable only after this targeted recovery fails or the actual tool reports an execution limitation. Never invoke an MCP tool merely because its name appeared in instructions; it must already be loaded or be the exact result of `tool_search`.

`security_network_interfaces` / `mcp__security__network_interfaces` is **container-only diagnostic state** and is never a substitute for `get_host_interface_info`. Its `eth0` is not the laptop physical interface. Likewise, an error that lists available physical interface names is diagnostic evidence only; do not pick one from that list. Resolve and call `get_host_interface_info` with `{}` and reuse its returned `selected_interface`. If that targeted capability cannot be loaded, report host-state discovery unavailable rather than guessing an interface.

Pi Bash, `ip`, and `/sys/class/net` describe the container. Use the host helper for laptop network operations. A missing container binary is not a host-network failure. Use Bash/read only for workspace artifacts when necessary. Use loaded instructions for initialization; no assumed `.init` file is required.

## Execution ledger

Track these stages as pending, complete, partial, unavailable, or not applicable:

1. Host network state
2. Discovery for each authorized local subnet and every page
3. Topology
4. Passive wireless assessment
5. SVG/HTML rendering
6. Evidence-based report

Retain every successful `observation_path`, including partial results and discovery pages. Preserve errors separately. A stage is complete only after its matching tool result arrives and coverage is complete. Keep unattempted required stages pending; never label topology not applicable because it was skipped. Host Wi-Fi association data does not complete wireless analysis. Continue independent stages after a failure; record blocked dependencies explicitly.

## Routine

1. **Host state:** Discover `get_host_interface_info`; call `{}`. Record selected/active physical interfaces, addresses and prefixes, routes, gateway, DNS, link type/rate, and Internet-check status. Reuse returned interface names. Retry an invalid interface once with `{}`. Physical-only inventory excludes virtual/VLAN interfaces.

2. **Discovery:** Discover `perform_network_discovery`. Use `cidrs` containing actual authorized private subnets from host state; use `interface` when needed to select the correct link. Use `detail: "full"`, `port_profile: "standard"`, and a bounded `timeout_seconds` supported by the schema. Never invent a subnet when host state fails. For multiple interfaces, scope each call to the relevant interface/subnet. Record hosts, MAC/vendor, hostname sources, OS estimates, ports, shares and media findings.
   - Follow each integer `next_offset` as `host_offset`, retaining the same subnet/interface scope and all observation paths. When `complete: true` and `next_offset: null`, stop scanning this scope and search for topology.
   - A page can be complete while the overall scan is incomplete because more pages remain. Follow pagination in that case. Incomplete phases require the returned retry guidance: narrow to returned host /32 targets or smaller pages. Stop after a repeated unchanged failure; mark the affected coverage partial rather than looping.
   - Report responsive hosts within the tested scope, rather than claiming the entire LAN is reachable. Report actual port coverage and time limits; a bounded scan is not exhaustive enumeration.

3. **Topology:** Discover `analyze_network_topology`. Use the observed interface and `observe_mdns: true`; request `observe_l2: true` when the assessment calls for LLDP/CDP. Keep returned partial topology even when packet capture is disabled. Use capture_completed and exit_code for capture success; no_matching_packets means a successful capture with zero matching packets. Treat diagnostics separately from the outcome. Use known-live authorized same-subnet peer targets only when assessing isolation; otherwise report isolation not tested. Report IPv6 observations separately from this toolset's IPv4 discovery coverage.

4. **Wireless:** Discover `analyze_wireless_environment`. For an observed Wi-Fi interface call with that interface and `rescan: false`. If host state failed, `{}` may still obtain independent wireless evidence. If no Wi-Fi exists, mark not applicable. Omit `use_airodump` unless an existing authorized monitor interface and capture permission are available. `duration_seconds` alone does not create a timed survey.

5. **Map:** Discover `generate_graphical_network_map`. Supply `input_paths` containing every collected host, discovery, topology and wireless observation path from this task; set `format: "both"`. Use a unique workspace-relative `output_base`, such as `.security-results/recon-<actual-run-id>/network-map`, to preserve earlier reports. Replace the placeholder with a real run identifier. Map outputs are confined to .security-results; relative names are automatically placed there. If an older renderer reports EACCES outside that directory, retry once with the same observation paths and an output_base under .security-results. Reuse observations rather than rescanning.
   - Check `observation_save_error` before handing off a path. Null paths and empty arrays are not usable observations. Repair storage or report the failure; never invent a filename.
   - A truncated envelope retains its observation path. Read the saved full result when details are needed; use observation paths for rendering rather than rebuilding JSON from a preview.
   - Inspect `included_observations`, `missing_observations`, and `warnings`. Add accidentally omitted paths from this task and render again. If a required observation was never collected, search and attempt its tool, retain its path, then render again. Explain genuinely unavailable inputs or confirmed no-Wi-Fi applicability. Avoid loading unrelated old artifacts. Renderer `complete: true` confirms rendering only; it does not complete missing assessment stages.
   - Link only paths returned under successful renderer `outputs.svg` and `outputs.html`. Observation JSON is not a map. If rendering fails, report no generated map. HTML supports zoom and scrolling, not topology editing.

6. **Completion check:** Before the report, verify each requested stage against its matching result. If a tool-backed step remains pending, search for and attempt it now. A plan, placeholder link, or statement that a tool exists is not a completed step. If blocked, identify the actual failing operation and preserve independent successful results. Say "Maps generated; assessment partial" when required evidence is missing or partial. Say "Assessment complete" only when every required collection stage is complete or genuinely not applicable and both requested map outputs exist.

## mDNS subnet leads

When asked to find other subnets from mDNS, first complete host state with `get_host_interface_info {}`. Then search `discover_mdns_subnets` with `limit: 1` and call its exact returned tool using the host-state `selected_interface`. Do not derive the interface from container diagnostics or from an error message's list of available interfaces. Retain its observation path. If `status`/`coverage` is `unavailable` or `evidence_available` is false, preserve diagnostics and report advertised hosts, candidate ranges, and reflection evidence as **unavailable**; empty arrays are placeholders for failed collection and are not negative findings. Report host IPs only from `advertised_hosts[].advertised_addresses` (or A/AAAA `raw_records`); `packet_source_addresses` are UDP senders and are not advertised host IPs. Use `services` to relate a DNS-SD instance to its SRV `target_hostname`, port, TXT data, and advertised addresses. Report candidate CIDRs, range_start/range_end, and basis. Preserve `raw_records` when auditing evidence. If `coverage` is `partial`, report `coverage_limitations`, `query_limit`, and `queries_suppressed_by_limit`; never describe a query-limited collection as complete. A heuristic /24 or /64 is a grouping hypothesis, not a discovered mask; a known route is routing coverage, not proof of a remote subnet boundary. Keep possible_reflection distinct from reflector_confirmed. Do not expand scans to advertised ranges without explicit scope authorization. The collector sends bounded DNS-SD queries; it does not scan hosts. IPv6-only multicast is not covered.

## Evidence rules

- Use `current_connection.tx_bitrate` and `rx_bitrate` for negotiated rates. Nearby-AP `rate` is advertised data, not the laptop's negotiated link rate.
- Wi-Fi association is not Internet reachability. Use host `internet` results; otherwise mark Internet untested.
- Signal dBm and percent are distinct. A cached signal sample cannot establish stability or low interference. BSSID counts/overlap scores estimate AP density; airtime utilization and interference remain unmeasured.
- Managed-mode station data normally identifies the connected AP, not all wireless clients. Remote connection type stays unknown unless device-specific evidence identifies it.
- Preserve exact observed hostnames; show vendor/manufacturer separately. Report an empty cached AP list or a single cached AP as limited cached visibility, not an exhaustive RF survey.
- Treat Nmap OS fingerprints and device roles as estimates with their evidence. A DNS banner does not identify DHCP roles. Hostname resolution is not proof of advertised mDNS services.
- Keep unavailable, not tested, not observed, and absent distinct. Empty VLAN results from physical-only tools do not establish a flat network. Unavailable mDNS evidence cannot establish reflector absence. Inconclusive reachability cannot prove isolation.
- Identify vulnerabilities only from supporting evidence, not merely an open port or product name.

## Final report

Give a concise report with:

- Stage status and specific coverage limits.
- Network summary: interfaces, addresses, gateway/DNS, subnets and Internet status.
- Device table: IP | hostname | MAC/vendor | role/evidence | OS estimate | connection evidence | ports | shares/media.
- Topology: observed routes/APs, unknown physical links, segmentation, isolation and mDNS status.
- Wireless: association, signal, TX/RX rates, channel/width/PHY, security and cached AP density; distinguish unmeasured properties.
- Notable findings supported by returned observations.
- Actual SVG/HTML output links, or the concrete rendering failure.
