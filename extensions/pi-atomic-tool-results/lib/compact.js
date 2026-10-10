import { jsonBytes } from "./archive.js";

const IMPORTANT_SCALAR = /^(status|state|available|complete|coverage|selected_interface|interface|connection_type|host_count|report_host_count|candidate_network_count|outside_subnet_advertisement_count|possible_reflection|reflector_confirmed|reflection_status|queries_sent|query_limit|queries_suppressed_by_limit|count|total|number_of_results|messages_unread|threads_unread|effective_time_min|time_min_defaulted|time_zone|id|name|hostname|path|url|title|summary|gateway|gateway_mac|cidr|address|family|prefixlen|scope|health|image|packets_sent|matching_packets_seen|addresses_probed|recursion_requested|proxy_arp_confirmed|isolation_failure_confirmed)$/i;
const SKIP_SCALAR = /(markdown|raw|records|html|body|snapshot|stack|trace)/i;
const ARRAY_PRIORITY = [
  "containers",
  "results",
  "events",
  "report_hosts",
  "report_candidate_networks",
  "outside_subnet_advertisements",
  "observations",
  "responses",
  "proxy_arp_candidate_ips",
  "shared_responder_macs",
  "hosts",
  "candidate_networks",
  "default_routes",
  "local_subnets",
  "interfaces",
  "addresses",
];
const OBJECT_PRIORITY = ["protocol_packet_counts", "internet", "dns"];
const ARTIFACT_PRIORITY = ["report_path", "observation_path", "artifact_path", "output_file", "output_path", "svg_path", "html_path"];
const REPORT_TEXT_PRIORITY = [
  "host_table_markdown",
  "candidate_table_markdown",
  "outside_subnet_summary_markdown",
  "reflection_summary_markdown",
  "collection_summary_markdown",
  "report_markdown",
];
const ROW_FIELD_PRIORITY = [
  "name", "title", "summary", "hostname", "address", "url", "state", "status", "health", "image",
  "gateway", "cidr", "interface", "mac", "type", "family", "prefixlen", "scope", "classification", "basis",
  "packet_source_address", "packet_source_mac", "claimed_ip", "responder_mac", "matches_gateway_mac",
  "range_start", "range_end", "address_count", "observed_host_count", "observed_address_count",
  "dateTime", "date", "timeZone", "content", "description", "messages_unread", "threads_unread", "start", "end",
  "ipv4_addresses", "ipv6_addresses", "addresses", "link", "compose_project", "compose_service",
];

function textOf(content) {
  return (content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function tryJson(text) {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function trunc(value, max = 180) {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function primitiveArray(value, maxItems = 4) {
  if (!Array.isArray(value) || value.some((v) => v != null && typeof v === "object")) return undefined;
  const out = value.slice(0, maxItems).map((v) => trunc(v, 120));
  if (value.length > out.length) out.push(`... +${value.length - out.length} more`);
  return out;
}

function shallowObject(value, depth = 0, maxFields = 8) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  const keys = Object.keys(value);
  const ordered = [
    ...ROW_FIELD_PRIORITY.filter((key) => Object.hasOwn(value, key)),
    ...keys.filter((key) => !ROW_FIELD_PRIORITY.includes(key)),
  ];
  for (const key of ordered) {
    if (Object.keys(out).length >= maxFields) break;
    // Prefer semantically useful fields. Only fall back to arbitrary scalars when
    // the object would otherwise contain too little evidence (for example the
    // booleans inside an `internet` status object).
    const isPreferred = ROW_FIELD_PRIORITY.includes(key);
    if (!isPreferred && Object.keys(out).length >= 3) continue;
    const child = value[key];
    if (child == null || ["string", "number", "boolean"].includes(typeof child)) {
      out[key] = trunc(child, key === "content" || key === "description" ? 90 : 140);
      continue;
    }
    if (Array.isArray(child)) {
      const primitives = primitiveArray(child);
      if (primitives !== undefined) {
        out[key] = primitives;
      } else if (key === "addresses" && depth < 1) {
        out[key] = child.slice(0, 4).map((item) => shallowObject(item, depth + 1, 6));
        if (child.length > 4) out[`${key}_truncated`] = child.length - 4;
      } else {
        out[`${key}_count`] = child.length;
      }
      continue;
    }
    if (typeof child === "object" && depth < 1 && ["start", "end", "internet", "dns", "link"].includes(key)) {
      out[key] = shallowObject(child, depth + 1, 6);
    }
  }
  return out;
}

function shallowSummary(value, budget = 24) {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (!value || typeof value !== "object") return value;
  const summary = {};
  const entries = Object.entries(value);
  const scalarEntries = entries.filter(([, child]) => child == null || ["string", "number", "boolean"].includes(typeof child));
  const importantScalars = scalarEntries.filter(([key]) => IMPORTANT_SCALAR.test(key) && !SKIP_SCALAR.test(key));
  for (const [key, child] of importantScalars) {
    if (Object.keys(summary).length >= budget) break;
    summary[key] = trunc(child, 180);
  }
  // If a result has no recognized scalar fields at all, retain a very small
  // deterministic fallback instead of serializing arbitrary metadata.
  if (Object.keys(summary).length === 0) {
    for (const [key, child] of scalarEntries) {
      if (SKIP_SCALAR.test(key)) continue;
      summary[key] = trunc(child, 120);
      if (Object.keys(summary).length >= 3) break;
    }
  }
  for (const [key, child] of entries) {
    if (Object.keys(summary).length >= budget) break;
    if (Array.isArray(child)) summary[`${key}_count`] = child.length;
  }

  // Common host-network results keep their actionable values nested. Promote the
  // selected interface addresses, default gateway, and connectivity state so a
  // small model can answer the usual follow-up without rehydrating the full blob.
  if (value.selected_interface && Array.isArray(value.interfaces)) {
    const selected = value.interfaces.find((item) => item?.name === value.selected_interface || item?.interface === value.selected_interface);
    if (typeof selected?.mac === "string") summary.selected_mac = selected.mac;
    if (selected?.addresses?.length) {
      summary.selected_addresses = selected.addresses.slice(0, 8).map((a) => {
        if (!a || typeof a !== "object") return String(a);
        const address = a.address ?? a.local;
        return address == null ? undefined : `${address}${a.prefixlen == null ? "" : `/${a.prefixlen}`}`;
      }).filter(Boolean);
    }
    const route = Array.isArray(value.default_routes)
      ? value.default_routes.find((r) => r?.interface === value.selected_interface) ?? value.default_routes[0]
      : undefined;
    if (route?.gateway) summary.default_gateway = route.gateway;
    if (value.internet?.status) summary.internet_status = value.internet.status;
  }
  return summary;
}

function prioritizedKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const keys = Object.keys(value);
  return [
    ...REPORT_TEXT_PRIORITY.filter((key) => keys.includes(key)),
    ...ARRAY_PRIORITY.filter((key) => keys.includes(key)),
    ...OBJECT_PRIORITY.filter((key) => keys.includes(key)),
    ...ARTIFACT_PRIORITY.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !REPORT_TEXT_PRIORITY.includes(key) && !ARRAY_PRIORITY.includes(key) && !OBJECT_PRIORITY.includes(key) && !ARTIFACT_PRIORITY.includes(key) && !/^ignored_|raw_|records$/i.test(key)),
  ];
}

function artifactPaths(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const paths = {};
  for (const key of ARTIFACT_PRIORITY) {
    if (typeof value[key] !== "string" || !value[key]) continue;
    const next = { ...paths, [key]: value[key] };
    // Filenames must stay exact. Oversized paths are recoverable by selector;
    // never turn them into misleading clipped filesystem paths.
    if (JSON.stringify(next).length <= 320) paths[key] = value[key];
  }
  return Object.keys(paths).length ? paths : undefined;
}

function sampleArray(key, value, root) {
  let items = value;
  if (key === "interfaces" && root?.selected_interface) {
    const selected = value.find((item) => item?.name === root.selected_interface || item?.interface === root.selected_interface);
    if (selected) items = [selected, ...value.filter((item) => item !== selected)];
  }
  const maxItems = key === "interfaces" && root?.selected_interface ? 1 : /^(containers|results|events)$/i.test(key) ? 3 : 2;
  return items.slice(0, maxItems).map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) return shallowObject(item, 0, 9);
    return trunc(item, 160);
  });
}

function buildEvidence(value, maxChars = 700) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3).map((item) => item && typeof item === "object" ? shallowObject(item, 0, 8) : trunc(item, 160));
    return sample.length ? sample : undefined;
  }
  if (typeof value !== "object") return undefined;

  const evidence = {};
  const keys = prioritizedKeys(value);
  for (const key of keys) {
    const child = value[key];
    if (child == null) continue;
    let candidate;
    if (REPORT_TEXT_PRIORITY.includes(key) && typeof child === "string" && child.length) candidate = child;
    else if (Array.isArray(child) && child.length) candidate = sampleArray(key, child, value);
    else if (typeof child === "object" && !Array.isArray(child) && OBJECT_PRIORITY.includes(key)) candidate = shallowObject(child, 0, 8);
    else continue;

    const trial = { ...evidence, [key]: candidate };
    if (JSON.stringify(trial).length <= maxChars) {
      evidence[key] = candidate;
      continue;
    }

    // Report/table strings are authoritative whole blocks. Never clip one into
    // the compact evidence preview, because a partial Markdown table can look
    // complete to a small model. If it does not fit, available_paths plus the
    // rehydration contract require an explicit result_get call.
    if (REPORT_TEXT_PRIORITY.includes(key)) continue;

    // Try one representative row before skipping the field entirely.
    if (Array.isArray(candidate) && candidate.length > 1) {
      const one = { ...evidence, [key]: candidate.slice(0, 1) };
      if (JSON.stringify(one).length <= maxChars) evidence[key] = candidate.slice(0, 1);
    }
  }
  return Object.keys(evidence).length ? evidence : undefined;
}

function availablePaths(archive, parsed, max = 12, artifacts) {
  const paths = [];
  if (parsed !== undefined) {
    if (Array.isArray(parsed)) paths.push("json");
    else if (parsed && typeof parsed === "object") {
      const omittedArtifacts = ARTIFACT_PRIORITY.filter(key => typeof parsed[key] === "string" && parsed[key] && !Object.hasOwn(artifacts || {}, key));
      for (const key of [...new Set([...omittedArtifacts, ...prioritizedKeys(parsed)])]) {
        paths.push(`json.${key}`);
        if (paths.length >= max) break;
      }
      if (!paths.length) paths.push("json");
    }
  } else if ((archive.content ?? []).some((part) => part?.type === "text")) {
    paths.push("content.0.text");
  }
  if (parsed === undefined) {
    if (archive.structuredContent !== undefined && paths.length < max) paths.push("structured");
    if (archive.details !== undefined && paths.length < max) paths.push("details");
    if (archive.input !== undefined && paths.length < max) paths.push("input");
  }
  return paths;
}

function suggestedSelector(parsed, paths) {
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    // Prefer authoritative pre-rendered report blocks over reconstructing the
    // same evidence from arrays. This is especially important for small models
    // and mDNS reports whose reporting contract requires verbatim tables.
    for (const key of REPORT_TEXT_PRIORITY) {
      if (typeof parsed[key] === "string" && parsed[key].length) return `json.${key}`;
    }
    for (const key of ARRAY_PRIORITY) {
      if (Array.isArray(parsed[key]) && parsed[key].length) return `json.${key}`;
    }
    for (const key of OBJECT_PRIORITY) {
      if (parsed[key] && typeof parsed[key] === "object") return `json.${key}`;
    }
  }
  return paths[0] || "content";
}

function envelopeObject(archive, { previewChars = 1200, historical = false, historicalEnvelopeChars = 480 } = {}) {
  const text = textOf(archive.content);
  const parsed = tryJson(text);
  const summary = parsed === undefined ? undefined : shallowSummary(parsed);
  const maxChars = historical ? Math.min(previewChars, historicalEnvelopeChars) : previewChars;
  const artifacts = historical ? undefined : artifactPaths(parsed);
  const paths = availablePaths(archive, parsed, historical ? 4 : 6, artifacts);
  const selector = suggestedSelector(parsed, paths);
  const evidenceBudget = Math.max(220, Math.floor(maxChars * 0.55));
  let evidence = historical ? undefined : buildEvidence(parsed, evidenceBudget);
  if (!historical && !evidence && parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    const firstArrayKey = ARRAY_PRIORITY.find((key) => Array.isArray(parsed[key]) && parsed[key].length);
    if (firstArrayKey) evidence = { [firstArrayKey]: sampleArray(firstArrayKey, parsed[firstArrayKey], parsed).slice(0, 1) };
  }
  const preview = parsed === undefined && text ? trunc(text, Math.max(128, Math.floor(maxChars * 0.55))) : undefined;
  const atomic = {
    ref: archive.resultRef,
    tool: archive.toolName,
    status: archive.isError ? "error" : "success",
    bytes: archive.sizeBytes ?? jsonBytes(archive.content ?? []),
    ...(summary && Object.keys(summary).length ? { summary } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(parsed?.truncated === true && /^mcp__security__/.test(archive.toolName) && typeof parsed.output_file === 'string' ? { server_truncated:true, artifact_retrieval:{discover:'security read_security_result',path:parsed.output_file,next:'Select a field in the saved file. result_get cannot expand a server-side spill.'} } : {}),
    ...(evidence ? { evidence } : {}),
    ...(evidence ? { evidence_partial: true } : {}),
    ...(preview ? { preview } : {}),
    truncated: true,
    result_ref_is_not_a_path: true,
    ...(paths.length ? { available_paths: paths } : {}),
    required_rehydration: "Omitted evidence: call result_get before reporting. Previews are partial; counts are not answers. Do not infer.",
    rehydrate: {
      tool: "result_get",
      args: {
        result_ref: archive.resultRef,
        selector,
        ...(selector.startsWith("json.") && parsed?.[selector.slice(5)] && Array.isArray(parsed[selector.slice(5)]) ? { limit: 5 } : {}),
      },
    },
  };
  return { atomic_result: atomic };
}

function renderEnvelopeWithinBudget(archive, options = {}) {
  const maxChars = options.historical
    ? Math.min(options.previewChars ?? 1200, options.historicalEnvelopeChars ?? 480)
    : options.previewChars ?? 1200;
  const envelope = envelopeObject(archive, options);
  let rendered = JSON.stringify(envelope);
  if (rendered.length <= maxChars) return rendered;

  const a = envelope.atomic_result;
  if (a.evidence) {
    // First collapse multi-row evidence to one row per key.
    const collapsed = {};
    for (const [key, value] of Object.entries(a.evidence)) collapsed[key] = Array.isArray(value) ? value.slice(0, 1) : value;
    a.evidence = collapsed;
    rendered = JSON.stringify(envelope);
  }
  if (rendered.length > maxChars && a.available_paths?.length > 5) {
    a.available_paths = a.available_paths.slice(0, 5);
    rendered = JSON.stringify(envelope);
  }
  if (rendered.length > maxChars && a.evidence) {
    // Before dropping evidence entirely, retain only authoritative report blocks
    // if they fit. Report strings remain whole; otherwise they are rehydrated.
    const reportEvidence = Object.fromEntries(
      Object.entries(a.evidence).filter(([key]) => REPORT_TEXT_PRIORITY.includes(key)),
    );
    if (Object.keys(reportEvidence).length) {
      a.evidence = reportEvidence;
      rendered = JSON.stringify(envelope);
    }
    if (rendered.length > maxChars || !Object.keys(reportEvidence).length) {
      delete a.evidence;
      delete a.evidence_partial;
      rendered = JSON.stringify(envelope);
    }
  }
  if (rendered.length > maxChars && a.summary) {
    const keep = {};
    // Host scope is required by downstream operations, so retain these exact
    // promoted fields before dropping less actionable aggregate counts.
    for (const key of ["selected_interface", "selected_mac", "selected_addresses", "default_gateway", "gateway", "gateway_mac", "cidr"]) {
      if (Object.hasOwn(a.summary, key)) keep[key] = a.summary[key];
    }
    for (const [key, value] of Object.entries(a.summary)) {
      if (Object.keys(keep).length >= 8) break;
      keep[key] = value;
    }
    a.summary = keep;
    rendered = JSON.stringify(envelope);
  }
  if (rendered.length > maxChars && a.available_paths?.length > 3) {
    a.available_paths = a.available_paths.slice(0, 3);
    rendered = JSON.stringify(envelope);
  }
  if (rendered.length > maxChars) {
    const minimal = {
      atomic_result: {
        ref: archive.resultRef,
        tool: archive.toolName,
        status: archive.isError ? "error" : "success",
        bytes: archive.sizeBytes,
        truncated: true,
        result_ref_is_not_a_path: true,
        ...(a.artifacts ? { artifacts: a.artifacts } : {}),
        ...(a.artifact_retrieval ? {server_truncated:true,artifact_retrieval:a.artifact_retrieval} : {}),
        required_rehydration: "Omitted evidence requires result_get; do not infer.",
        rehydrate: { tool: "result_get", args: { result_ref: archive.resultRef, selector: suggestedSelector(tryJson(textOf(archive.content)), availablePaths(archive, tryJson(textOf(archive.content)), 1)) } },
      },
    };
    if (JSON.stringify(minimal).length > maxChars) delete minimal.atomic_result.artifacts;
    rendered = JSON.stringify(minimal);
  }
  return rendered;
}

export function compactEnvelope(archive, options = {}) {
  return [{ type: "text", text: renderEnvelopeWithinBudget(archive, options) }];
}

function contentWireChars(content) {
  try { return JSON.stringify(content ?? []).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

export function compactOrInlineContent(archive, options = {}) {
  // Structured MCP data is the canonical body, not a second preview wrapper.
  const compact = compactEnvelope(archive, options);
  const raw = archive.content ?? [];
  if (!options.historical && contentWireChars(raw) <= contentWireChars(compact)) {
    return { content: raw, inlineRaw: true };
  }
  return { content: compact, inlineRaw: false };
}

export function leaseExpiredEnvelope(toolName, toolCallId, details) {
  const sourceRef = details?.atomicSourceRef || details?.resultRef;
  return [{
    type: "text",
    text: JSON.stringify({
      atomic_result_lease: {
        tool: toolName,
        tool_call_id: toolCallId,
        status: "expired",
        ...(sourceRef ? { source_ref: sourceRef } : {}),
        hint: toolName === "result_get" ? "Call result_get again if this slice is needed." : "Re-run this lookup if needed.",
      },
    }),
  }];
}
