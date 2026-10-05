---
name: network-recon
description: Assess an authorized laptop LAN using Security MCP host state, network discovery, topology, passive Wi-Fi analysis, and SVG/HTML maps. Use for local network reconnaissance, device inventory, wireless assessment, or a complete network map.
---

# Network reconnaissance

Complete the requested stages using Security MCP. Restrict discovery to user-owned or explicitly authorized networks. Existing authorization for the connected LAN is sufficient for ordinary bounded discovery. Keep wireless analysis passive. Use current observations, not remembered devices or example addresses.

## Tool discovery and recovery

Use Pi's native `tool_search` followed by direct calls to the exact returned tool. Older instructions mentioning `mcp_search`/`mcp_call` refer to this native sequence.

For each new capability, search its exact operation name with `limit: 1`, inspect the schema, and call the returned tool. Start with:

```json
{"query":"get_host_interface_info","limit":1}
```

Call the discovered host-state tool with `{}`. Search operation names, rather than broad phrases such as “security MCP tools”. Reuse loaded tools.

If a call returns “Tool not found”, search that exact operation and retry using the returned name and schema. This means the tool was not loaded; it does not establish that host access is unavailable. If search returns an unrelated match, refine once with `security` plus the operation. Report a capability unavailable only after this targeted recovery fails or the actual tool reports an execution limitation.

Pi Bash, `ip`, and `/sys/class/net` describe the container. Use the host helper for laptop network operations. A missing container binary is not a host-network failure. Use Bash/read only for workspace artifacts when necessary. Use loaded instructions for initialization; no assumed `.init` file is required.

## Execution ledger

Track these stages as pending, complete, partial, unavailable, or not applicable:

1. Host network state
2. Discovery for each authorized local subnet and every page
3. Topology
4. Passive wireless assessment
5. SVG/HTML rendering
6. Evidence-based report

Retain every successful `observation_path`, including partial results and discovery pages. Preserve errors separately. A stage is complete only after its tool result arrives. Continue independent stages after a failure; record blocked dependencies explicitly.

## Routine

1. **Host state:** Discover `get_host_interface_info`; call `{}`. Record selected/active physical interfaces, addresses and prefixes, routes, gateway, DNS, link type/rate, and Internet-check status. Reuse returned interface names. Retry an invalid interface once with `{}`. Physical-only inventory excludes virtual/VLAN interfaces.

2. **Discovery:** Discover `perform_network_discovery`. Use `cidrs` containing actual authorized private subnets from host state; use `interface` when needed to select the correct link. Use `detail: "full"`, `port_profile: "standard"`, and a bounded `timeout_seconds` supported by the schema. Never invent a subnet when host state fails. For multiple interfaces, scope each call to the relevant interface/subnet. Record hosts, MAC/vendor, hostname sources, OS estimates, ports, shares and media findings.
   - Follow each returned `next_offset` as `host_offset`, retaining the same subnet/interface scope and all observation paths, until null.
   - `complete: false` or incomplete phases require the returned retry guidance: narrow to returned host /32 targets or smaller pages. Stop after a repeated unchanged failure; mark the affected coverage partial rather than looping.
   - Report responsive hosts within the tested scope, rather than claiming the entire LAN is reachable. Report actual port coverage and time limits; a bounded scan is not exhaustive enumeration.

3. **Topology:** Discover `analyze_network_topology`. Use the observed interface and `observe_mdns: true`; request `observe_l2: true` when the assessment calls for LLDP/CDP. Keep returned partial topology even when packet capture is disabled. Use capture_completed and exit_code for capture success; no_matching_packets means a successful capture with zero matching packets. Treat diagnostics separately from the outcome. Use known-live authorized same-subnet peer targets only when assessing isolation; otherwise report isolation not tested. Report IPv6 observations separately from this toolset's IPv4 discovery coverage.

4. **Wireless:** Discover `analyze_wireless_environment`. For an observed Wi-Fi interface call with that interface and `rescan: false`. If host state failed, `{}` may still obtain independent wireless evidence. If no Wi-Fi exists, mark not applicable. Omit `use_airodump` unless an existing authorized monitor interface and capture permission are available. `duration_seconds` alone does not create a timed survey.

5. **Map:** Discover `generate_graphical_network_map`. Supply `input_paths` containing every collected host, discovery, topology and wireless observation path from this task; set `format: "both"`. Use a unique workspace-relative `output_base`, such as `.security-results/recon-<actual-run-id>/network-map`, to preserve earlier reports. Replace the placeholder with a real run identifier. Map outputs are confined to .security-results; relative names are automatically placed there. If an older renderer reports EACCES outside that directory, retry once with the same observation paths and an output_base under .security-results. Reuse observations rather than rescanning.
   - Check `observation_save_error` before handing off a path. Null paths and empty arrays are not usable observations. Repair storage or report the failure; never invent a filename.
   - A truncated envelope retains its observation path. Read the saved full result when details are needed; use observation paths for rendering rather than rebuilding JSON from a preview.
   - Inspect `included_observations`, `missing_observations`, and `warnings`. Add accidentally omitted paths from this task and render again. Explain genuinely unavailable inputs. Avoid loading unrelated old artifacts.
   - Link only paths returned under successful renderer `outputs.svg` and `outputs.html`. Observation JSON is not a map. If rendering fails, report no generated map. HTML supports zoom and scrolling, not topology editing.

6. **Completion check:** Before the report, verify each requested stage has a concrete outcome. If a tool-backed step remains pending, perform it now. A plan, placeholder link, or statement that a tool exists is not a completed step. If blocked, identify the actual failing operation and preserve independent successful results.

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
