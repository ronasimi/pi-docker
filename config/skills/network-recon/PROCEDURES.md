# Network reconnaissance: detailed procedures

These procedures supplement SKILL.md. The runtime's authorization policy always takes precedence.

## Evidence sequence
1. Discover and invoke `get_host_interface_info` to learn actual physical interfaces, assigned IPv4 prefixes, gateway and routes. Use only observed and authorized scope.
2. For passive observation, discover `observe_broadcast_multicast`. Use a bounded duration, physical interface and schema-supported limits. Lack of capture permission is BLOCKED, not zero packets.
3. `perform_network_discovery` sends probes. Do not invoke without explicit current-turn authorization **and** enabled runtime opt-in. If blocked, skip it; do not route around enforcement through bash or another scanner.
4. Topology analysis and cached wireless inspection can proceed independently when the required inputs exist. Keep `rescan:false` unless an active survey is separately authorized.
5. Pass only real `observation_path` entries to `generate_graphical_network_map`; actual SVG/HTML files must be confirmed before reporting links.

## Discovery and recovery
- Prefer an exact catalog operation query with `limit:1`; inspect the returned schema. Old documentation and alternate operation spellings are not guaranteed to match the running registry.
- A `blocked` result means policy prevented the operation; distinguish from `unavailable` (no authorized match) and `failed` (execution error). Never retry a blocked active probe under a synonym.
- For a missing/irrelevant result, perform at most one distinct, targeted server + action + object search, then move to independent stages.
- Do not substitute System host health, container network interfaces, browser network requests or another tool for physical-LAN host observation.
- Preserve the same target/interface across paginated results. Use exact `next_offset` as `host_offset` when the schema requires it. Stop when `complete:true` with no further offset.
- Use `result_get` for Pi's archived tool responses and Security `read_security_result` only for actual server-side artifacts.

## Reporting
Report host interfaces, routes, captured protocol evidence, scan scope, topology relationships and map paths only as actually observed. Separate COMPLETE, PARTIAL, BLOCKED, NOT TESTED and NOT APPLICABLE. An mDNS advertisement does not prove a subnet mask, an mDNS reflector, peer connectivity or isolation bypass. Missing data must not be described as absence of devices.
