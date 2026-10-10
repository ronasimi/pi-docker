import test from "node:test";
import assert from "node:assert/strict";
import { compactEnvelope, compactOrInlineContent, leaseExpiredEnvelope } from "../lib/compact.js";

test("compactEnvelope extracts deterministic JSON shape without model inference", () => {
  const archive = {
    resultRef: "result:c1",
    toolName: "discover_mdns_subnets",
    isError: false,
    sizeBytes: 12000,
    content: [{ type: "text", text: JSON.stringify({ status: "observed", coverage: "complete", report_host_count: 8, hosts: new Array(8).fill({}) }) }],
  };
  const rendered = JSON.parse(compactEnvelope(archive)[0].text);
  assert.equal(rendered.atomic_result.ref, "result:c1");
  assert.equal(rendered.atomic_result.summary.status, "observed");
  assert.equal(rendered.atomic_result.summary.report_host_count, 8);
  assert.equal(rendered.atomic_result.summary.hosts_count, 8);
});

test("normal compact envelope is deterministic and byte-stable", () => {
  const archive = {
    resultRef: "result:stable",
    toolName: "clock",
    isError: false,
    sizeBytes: 12,
    content: [{ type: "text", text: "12:34" }],
  };
  assert.equal(compactEnvelope(archive)[0].text, compactEnvelope(archive)[0].text);
  assert.match(compactEnvelope(archive)[0].text, /result:stable/);
});

test("historical compatibility envelope remains bounded when explicitly requested", () => {
  const archive = {
    resultRef: "result:c2",
    toolName: "huge_tool",
    isError: false,
    sizeBytes: 50000,
    content: [{ type: "text", text: "x".repeat(5000) }],
  };
  const text = compactEnvelope(archive, { historical: true, historicalEnvelopeChars: 320 })[0].text;
  assert.ok(text.length <= 320);
  assert.match(text, /result:c2/);
});

test("expired rehydration is represented by a tiny lease marker", () => {
  const text = leaseExpiredEnvelope("result_get", "lease-1", { atomicSourceRef: "result:c3" })[0].text;
  const payload = JSON.parse(text);
  assert.equal(payload.atomic_result_lease.status, "expired");
  assert.equal(payload.atomic_result_lease.source_ref, "result:c3");
});


test("large structured envelopes include bounded evidence, paths and a concrete result_get call", () => {
  const archive = {
    resultRef: "result:docker",
    toolName: "mcp__system__docker_list_containers",
    isError: false,
    sizeBytes: 14000,
    content: [{ type: "text", text: JSON.stringify({
      count: 9,
      containers: [
        { name: "pi", state: "running", status: "healthy", image: "local/pi:latest" },
        { name: "mcp-google", state: "running", status: "healthy", image: "local/google:latest" },
        { name: "mcp-security", state: "running", status: "healthy", image: "local/security:latest" },
        { name: "ollama", state: "running", status: "healthy", image: "ollama:latest" },
      ],
      padding: "x".repeat(5000),
    }) }],
  };
  const text = compactEnvelope(archive, { previewChars: 1200 })[0].text;
  const rendered = JSON.parse(text).atomic_result;
  assert.ok(text.length <= 1200);
  assert.equal(rendered.truncated, true);
  assert.deepEqual(rendered.evidence.containers.map((c) => c.name), ["pi", "mcp-google", "mcp-security"]);
  assert.ok(rendered.available_paths.includes("json.containers"));
  assert.equal(rendered.rehydrate.tool, "result_get");
  assert.equal(rendered.rehydrate.args.result_ref, "result:docker");
  assert.equal(rendered.rehydrate.args.selector, "json.containers");
});

test("host-network compact summary promotes exact selected addresses and gateway", () => {
  const archive = {
    resultRef: "result:host",
    toolName: "mcp__security__get_host_interface_info",
    isError: false,
    sizeBytes: 6600,
    content: [{ type: "text", text: JSON.stringify({
      scope: "host-network",
      selected_interface: "wlp3s0",
      connection_type: "wifi",
      interfaces: [
        { name: "wlp3s0", state: "UP", type: "wifi", mac: "02:00:00:00:00:01", addresses: [
          { family: "inet", address: "192.168.1.208", prefixlen: 24, scope: "global" },
          { family: "inet6", address: "fd60:203c:2e52::9f9", prefixlen: 128, scope: "global" },
        ] },
      ],
      default_routes: [{ interface: "wlp3s0", gateway: "192.168.1.1" }],
      internet: { status: "online" },
      ignored_virtual_interfaces: new Array(20).fill({ name: "veth", reason: "virtual" }),
    }) }],
  };
  const rendered = JSON.parse(compactEnvelope(archive, { previewChars: 1200 })[0].text).atomic_result;
  assert.deepEqual(rendered.summary.selected_addresses, ["192.168.1.208/24", "fd60:203c:2e52::9f9/128"]);
  assert.equal(rendered.summary.default_gateway, "192.168.1.1");
  assert.equal(rendered.summary.selected_mac, "02:00:00:00:00:01");
  assert.equal(rendered.summary.internet_status, "online");
});

test("calendar evidence keeps bounded upcoming event titles and starts", () => {
  const archive = {
    resultRef: "result:calendar",
    toolName: "mcp__google__calendar_list_events",
    isError: false,
    sizeBytes: 8400,
    content: [{ type: "text", text: JSON.stringify({
      time_zone: "America/Toronto",
      effective_time_min: "2026-10-07T01:50:52.964Z",
      events: [
        { summary: "Dr Adejokun", status: "confirmed", start: { dateTime: "2026-10-13T11:15:00-04:00" }, end: { dateTime: "2026-10-13T12:15:00-04:00" }, description: "x".repeat(500) },
        { summary: "Hired by DependableIT", status: "confirmed", start: { dateTime: "2026-10-20T09:00:00-04:00" }, end: { dateTime: "2026-10-20T10:00:00-04:00" } },
        { summary: "Arden's Birthday", status: "confirmed", start: { date: "2026-10-28" }, end: { date: "2026-10-29" } },
      ],
    }) }],
  };
  const text = compactEnvelope(archive, { previewChars: 1200 })[0].text;
  const rendered = JSON.parse(text).atomic_result;
  assert.ok(text.length <= 1200);
  assert.deepEqual(rendered.evidence.events.map((e) => e.summary), ["Dr Adejokun", "Hired by DependableIT", "Arden's Birthday"]);
  assert.equal(rendered.evidence.events[0].start.dateTime, "2026-10-13T11:15:00-04:00");
});

test("tiny results remain exactly inline when the archive envelope would cost more", () => {
  const archive = {
    resultRef: "result:tiny",
    toolName: "clock",
    isError: false,
    sizeBytes: 5,
    content: [{ type: "text", text: "12:34" }],
  };
  const rendered = compactOrInlineContent(archive, { previewChars: 1200 });
  assert.equal(rendered.inlineRaw, true);
  assert.equal(rendered.content[0].text, "12:34");
});

test("truncated envelopes declare opaque result refs and mandatory rehydration semantics", () => {
  const archive = {
    resultRef: "result:opaque-mdns",
    toolName: "mcp__security__discover_mdns_subnets",
    isError: false,
    sizeBytes: 20000,
    content: [{ type: "text", text: JSON.stringify({
      status: "observed",
      report_hosts: new Array(8).fill(0).map((_, i) => ({ hostname: `host-${i}.local`, addresses: [`192.168.1.${i + 10}`] })),
      padding: "x".repeat(5000),
    }) }],
  };
  const rendered = JSON.parse(compactEnvelope(archive, { previewChars: 1200 })[0].text).atomic_result;
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.result_ref_is_not_a_path, true);
  assert.match(rendered.required_rehydration, /call result_get/i);
  assert.match(rendered.required_rehydration, /do not infer/i);
  assert.ok(rendered.available_paths.includes("json.report_hosts"));
});

test("short deterministic mDNS report tables are preserved whole when they fit the preview budget", () => {
  const hostTable = "| Host | Addresses |\n| --- | --- |\n| Arachne.local | 192.168.1.2 |\n| Roku.local | 192.168.20.228 |";
  const candidateTable = "| CIDR | Classification | Hosts |\n| --- | --- | ---: |\n| 192.168.1.0/24 | local-interface prefix | 3 |\n| 192.168.20.0/24 | heuristic candidate range (mask unknown) | 5 |";
  const archive = {
    resultRef: "result:mdns-tables",
    toolName: "mcp__security__discover_mdns_subnets",
    isError: false,
    sizeBytes: 16000,
    content: [{ type: "text", text: JSON.stringify({
      status: "observed",
      coverage: "complete",
      report_host_count: 8,
      host_table_markdown: hostTable,
      candidate_table_markdown: candidateTable,
      outside_subnet_advertisement_count: 5,
      possible_reflection: true,
      padding: "x".repeat(6000),
    }) }],
  };
  const text = compactEnvelope(archive, { previewChars: 1200 })[0].text;
  const rendered = JSON.parse(text).atomic_result;
  assert.ok(text.length <= 1200);
  assert.equal(rendered.evidence.host_table_markdown, hostTable);
  assert.equal(rendered.evidence.candidate_table_markdown, candidateTable);
  assert.ok(rendered.available_paths.includes("json.host_table_markdown"));
  assert.ok(rendered.available_paths.includes("json.candidate_table_markdown"));
  assert.equal(rendered.rehydrate.args.selector, "json.host_table_markdown");
});

test("oversized deterministic report tables are omitted whole and advertised for result_get", () => {
  const hugeTable = `| Host | Addresses |\n| --- | --- |\n${new Array(80).fill(0).map((_, i) => `| host-${i}.local | 192.168.1.${i} |`).join("\n")}`;
  const archive = {
    resultRef: "result:mdns-huge-table",
    toolName: "mcp__security__discover_mdns_subnets",
    isError: false,
    sizeBytes: 30000,
    content: [{ type: "text", text: JSON.stringify({
      status: "observed",
      host_table_markdown: hugeTable,
      report_hosts: new Array(80).fill({ hostname: "host.local", addresses: ["192.168.1.2"] }),
    }) }],
  };
  const text = compactEnvelope(archive, { previewChars: 1200 })[0].text;
  const rendered = JSON.parse(text).atomic_result;
  assert.ok(text.length <= 1200);
  assert.notEqual(rendered.evidence?.host_table_markdown, hugeTable.slice(0, 200));
  assert.equal(rendered.evidence?.host_table_markdown, undefined);
  assert.ok(rendered.available_paths.includes("json.host_table_markdown"));
  assert.equal(rendered.result_ref_is_not_a_path, true);
  assert.match(rendered.required_rehydration, /result_get/i);
});

const assessmentArchive = value => ({
  resultRef: "result:assessment", toolName: "mcp__fixture__assessment", isError: false, sizeBytes: 20000,
  content: [{ type: "text", text: JSON.stringify(value) }],
});

test("bounded assessment envelopes preserve real artifact paths separately from opaque result refs", () => {
  const observation = ".security-results/observations/run-1/discovery.json";
  const report = ".security-results/observations/run-1/discovery-report.json";
  const archive = assessmentArchive({
    selected_interface: "wlan0", status: "observed", complete: false, coverage: "partial",
    report_host_count: 7, outside_subnet_advertisement_count: 5, possible_reflection: true,
    host_table_markdown: "| Host | Address |\n".repeat(90), candidate_table_markdown: "| CIDR | Basis |\n".repeat(90),
    report_hosts: new Array(7).fill({ hostname: "fixture.local", addresses: ["192.0.2.20"] }),
    observation_path: observation, report_path: report, padding: "x".repeat(20000),
  });
  const text = compactEnvelope(archive)[0].text, result = JSON.parse(text).atomic_result;
  assert(text.length <= 1200);
  assert.deepEqual(result.artifacts, { report_path: report, observation_path: observation });
  assert.equal(result.ref, "result:assessment");
  assert.equal(result.result_ref_is_not_a_path, true);
  assert.equal(result.rehydrate.args.selector, "json.host_table_markdown");
  assert.equal(compactEnvelope(archive)[0].text, text, "Artifact preservation must be byte-stable");
});

test("passive capture hints recover observations before status scalars", () => {
  const archive = assessmentArchive({
    status: "observed", complete: true, coverage: "bounded_window", packets_sent: 0,
    matching_packets_seen: 41, protocol_packet_counts: { mdns: 38, ssdp: 1 },
    observations: new Array(15).fill({ protocol: "mdns", packet_source_address: "192.0.2.10", packet_source_mac: "02:00:00:00:00:10" }),
    isolation_failure_confirmed: false, observation_path: "observations/passive.json",
  });
  const text = compactEnvelope(archive)[0].text, result = JSON.parse(text).atomic_result;
  assert(text.length <= 1200);
  assert.equal(result.summary.packets_sent, 0);
  assert.equal(result.summary.matching_packets_seen, 41);
  assert.equal(result.summary.isolation_failure_confirmed, false);
  assert.equal(result.available_paths[0], "json.observations");
  assert(result.available_paths.includes("json.protocol_packet_counts"));
  assert.equal(result.rehydrate.args.selector, "json.observations");
});

test("ARP recovery exposes responder evidence and exact gateway MAC", () => {
  const archive = assessmentArchive({
    status: "observed", complete: true, gateway: "192.0.2.1", gateway_mac: "02:00:00:00:00:01",
    cidr: "192.0.2.0/24", addresses_probed: 252,
    responses: new Array(5).fill({ claimed_ip: "192.0.2.20", responder_mac: "02:00:00:00:00:20", matches_gateway_mac: false }),
    proxy_arp_candidate_ips: [], shared_responder_macs: [], proxy_arp_confirmed: false,
    observation_path: "observations/arp.json",
  });
  const result = JSON.parse(compactEnvelope(archive)[0].text).atomic_result;
  assert.equal(result.summary.gateway_mac, "02:00:00:00:00:01");
  assert.equal(result.summary.addresses_probed, 252);
  assert.equal(result.summary.responses_count, 5);
  assert.equal(result.rehydrate.args.selector, "json.responses");
  assert(result.available_paths.includes("json.proxy_arp_candidate_ips"));
  assert(result.available_paths.includes("json.shared_responder_macs"));
});

test("DNS previews label partial evidence and direct retrieval to samples instead of inferring answers from counts", () => {
  const archive = assessmentArchive({
    status: "observed", complete: true, server: "192.0.2.1", recursion_requested: false,
    results: ["router.test", "nas.test", "example.test"].map(name => ({ name, samples: [
      { status: "response", response_ms: 1.5, authoritative: true, answers: [{ type: "A", ttl: 0, advertised_address: "192.0.2.20" }] },
      { status: "timeout" }, { status: "timeout" },
    ], querying_client_identified: false })), observation_path: "observations/dns.json",
  });
  const text = compactEnvelope(archive)[0].text, result = JSON.parse(text).atomic_result;
  assert(text.length <= 1200);
  assert.equal(result.rehydrate.args.selector, "json.results");
  assert.equal(result.summary.results_count, 3);
  if (result.evidence) assert.equal(result.evidence_partial, true);
  assert.match(result.required_rehydration, /counts are not answers/);
  assert.equal(result.artifacts.observation_path, "observations/dns.json");
});

test("oversized artifact paths are omitted whole and have an exact recovery selector", () => {
  const path = `observations/${"long-".repeat(100)}report.json`;
  const result = JSON.parse(compactEnvelope(assessmentArchive({ status: "ok", observation_path: path, padding: "x".repeat(1000) }))[0].text).atomic_result;
  assert.equal(result.artifacts?.observation_path, undefined);
  assert(result.available_paths.includes("json.observation_path"));
  assert.equal(result.rehydrate.args.selector, "json.observation_path");
});
