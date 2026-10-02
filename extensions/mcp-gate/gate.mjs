export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'bash', 'mcp_search', 'mcp_call'];
export const LIMITS = Object.freeze({ results: 3, discoveryBytes: 16384, grants: 64, searches: 6, calls: 24, queryChars: 200, serverCandidates: 96, globalCandidates: 100, discoveryPages: 4 });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const textOf = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const failed = result => Boolean(result?.isError || result?.details?.error);
const data = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {} });
function failure(message) { throw new Error(message); }

const STOP_WORDS = new Set(['a','an','and','are','for','from','get','give','how','i','in','is','me','my','of','on','please','show','the','to','what','which','with']);

function normalized(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_/.:()+-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function canonicalToken(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}
function tokenSet(value) {
  return new Set(normalized(value).split(' ').filter(token => token && !STOP_WORDS.has(token)).map(canonicalToken));
}
function localToolName(match) {
  const prefix = `${match.server}_`;
  return typeof match.tool === 'string' && match.tool.startsWith(prefix) ? match.tool.slice(prefix.length) : String(match.tool ?? '');
}
export function inferServerForQuery(config, query) {
  const q = normalized(query);
  const enabled = name => Object.hasOwn(config.mcpServers ?? {}, name) && config.mcpServers[name].disabled !== true;
  const rules = [
    ['security', /\b(security|cybersecurity|pentest|red team|blue team|vulnerability|vulnerabilities|cve|nuclei|nikto|ffuf|subfinder|amass|searchsploit|sqlmap|metasploit|suricata|yara|osquery|radare2|malware|forensics|pcap|packet capture|ids|sast|sbom|secret scan|host discovery|discover hosts|live hosts|subnet scan|port scan|service detection|tls audit|web server audit)\b/],
    ['google', /\b(gmail|google mail|mailbox|inbox|google calendar|calendar event|free busy|google drive|google doc|google sheet|google slide|oauth|google auth)\b/],
    ['system', /\b(openwrt|router|uci|ubus|anansi|arachne|docker|container|host network|host interfaces|host routes|linux host|local daily briefing|london daily briefing|image processing|document processing)\b/],
    ['playwright', /\b(browser|navigate page|open url|known page|website interaction|click|fill form|page snapshot|browser screenshot)\b/],
    ['searxng', /\b(web search|search the web|internet search|current news|latest news|find sources|find url|public web)\b/],
    ['memory', /\b(durable memory|remember|recall memory|memory graph|store memory|retrieve memory)\b/],
  ];
  for (const [server, pattern] of rules) if (enabled(server) && pattern.test(q)) return server;
  return null;
}

function preferredFamily(server, query) {
  const q = normalized(query);
  if (server === 'system') {
    if (/\b(openwrt|router|uci|ubus|anansi|arachne)\b/.test(q) || /\b(connected devices|dhcp leases|lan clients|wifi clients)\b/.test(q)) return 'openwrt';
    if (/\b(docker|container|compose)\b/.test(q)) return 'docker';
    if (/\b(pdf|document|docx|xlsx|pptx|epub|pandoc)\b/.test(q)) return 'document';
    if (/\b(photo|picture|png|jpe?g|webp|exif|thumbnail|crop|resize)\b/.test(q)) return 'image';
    if (/\b(host|linux|cpu|ram|swap|process|filesystem|disk|mount)\b/.test(q)) return 'host';
    if (/\b(dns|ping|traceroute|trace route|tcp|port|cidr|network interface|http probe)\b/.test(q)) return 'network';
  }
  if (server === 'google') {
    if (/\b(oauth|auth|authorization|credentials?|token status|account connected)\b/.test(q)) return 'auth';
    if (/\b(gmail|email|mailbox|inbox|message|thread|unread|draft|send mail|archive mail)\b/.test(q)) return 'gmail';
    if (/\b(calendar|schedule|meeting|event|appointment|free busy|availability)\b/.test(q)) return 'calendar';
    if (/\b(drive|google doc|google sheet|google slide|folder|document|file)\b/.test(q)) return 'drive';
  }
  return null;
}
function inFamily(server, tool, family) {
  if (!family) return true;
  const local = localToolName({ server, tool });
  if (server === 'system') return local.startsWith(`${family}_`);
  if (server === 'google') return family === 'auth' ? local === 'google_auth_status' : local.startsWith(`${family}_`);
  return true;
}
function overlapCount(a, b) {
  let n = 0;
  for (const token of a) if (b.has(token)) n++;
  return n;
}
function scoreDiscoveryMatch(config, query, match, index) {
  const local = localToolName(match);
  const q = normalized(query);
  const qTokens = tokenSet(query);
  const toolTokens = tokenSet(local);
  const keywords = config.mcpServers?.[match.server]?.searchKeywords ?? {};
  const aliases = Array.isArray(keywords[local]) ? keywords[local] : [];
  let score = Math.max(0, 1 - index / 1000);
  score += overlapCount(qTokens, toolTokens) * 7;
  let bestAlias = 0;
  for (const alias of aliases) {
    const a = normalized(alias);
    if (!a) continue;
    const aTokens = tokenSet(a);
    const overlap = overlapCount(qTokens, aTokens);
    // A one-token entity alias such as a router hostname is useful for server
    // discovery, but must not outrank the actual capability in a longer query
    // (for example "clients on router anansi" -> openwrt_clients, not status).
    const entityOnly = aTokens.size === 1 && qTokens.size > 1;
    let aliasScore = overlap * (entityOnly ? 3 : 12);
    if (q === a) aliasScore += 120;
    else {
      if (q.includes(a)) aliasScore += entityOnly ? 5 : 45;
      if (a.includes(q)) aliasScore += entityOnly ? 3 : 30;
    }
    if (qTokens.size) aliasScore += (entityOnly ? 5 : 25) * (overlap / qTokens.size);
    bestAlias = Math.max(bestAlias, aliasScore);
  }
  return score + bestAlias;
}

// The adapter's lexical search is intentionally asked for a larger metadata-only
// candidate set. We then apply per-tool aliases and family hints locally before
// exposing at most three complete schemas to the model. This prevents broad
// server aliases (for example "router" on the system server) from making an
// unrelated Docker/document tool outrank openwrt_clients.
export function rankDiscoveryMatches(config, query, matches = []) {
  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    if (!match || typeof match.tool !== 'string' || typeof match.server !== 'string') continue;
    const key = `${match.server}\0${match.tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(match);
  }

  const familyAvailability = new Map();
  for (const match of unique) {
    const family = preferredFamily(match.server, query);
    if (!family) continue;
    const key = `${match.server}\0${family}`;
    if (inFamily(match.server, match.tool, family)) familyAvailability.set(key, true);
  }

  return unique
    .map((match, index) => {
      const family = preferredFamily(match.server, query);
      const restrict = family && familyAvailability.get(`${match.server}\0${family}`);
      return { match, index, keep: !restrict || inFamily(match.server, match.tool, family), score: scoreDiscoveryMatch(config, query, match, index) };
    })
    .filter(row => row.keep)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(row => row.match);
}


function primitiveTypeMatches(type, value) {
  if (!type) return true;
  if (Array.isArray(type)) return type.some(t => primitiveTypeMatches(t, value));
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return true;
}

function schemaValueMatches(schema, value) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(s => schemaValueMatches(s, value));
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter(s => schemaValueMatches(s, value)).length === 1;
  if (Array.isArray(schema.enum) && !schema.enum.some(v => Object.is(v, value))) return false;
  if (!primitiveTypeMatches(schema.type, value)) return false;

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) return false;
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => schemaValueMatches(schema.items, item))) return false;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key) && !schemaValueMatches(properties[key], item)) return false;
    }
  }
  return true;
}

export function schemaAcceptsArgs(schema, args) {
  return schemaValueMatches(schema ?? { type: 'object' }, args);
}

function normalizeForStableJson(value, schema = undefined) {
  if (Array.isArray(value)) return value.map(item => normalizeForStableJson(item, schema?.items));
  if (!value || typeof value !== 'object') return value;
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const childSchema = properties[key];
    const normalizedValue = normalizeForStableJson(value[key], childSchema);
    if (childSchema && Object.hasOwn(childSchema, 'default') && Object.is(normalizedValue, childSchema.default)) continue;
    out[key] = normalizedValue;
  }
  return out;
}

export function canonicalArgs(args, schema = undefined) {
  return JSON.stringify(normalizeForStableJson(args ?? {}, schema));
}

const MUTATING_TOOL_WORDS = /(?:^|_)(?:create|add|send|write|edit|update|patch|set|change|delete|remove|move|rename|upload|install|uninstall|start|stop|restart|enable|disable|reboot|shutdown|execute|shell|command|apply|deploy)(?:_|$)/i;
const STATUS_TOOL_WORDS = /(?:^|_)(?:status|health|poll|wait|watch|monitor|progress|tail|logs?|output)(?:_|$)/i;

export function isLikelyReadOnlyTool(tool, description = '') {
  if (STATUS_TOOL_WORDS.test(String(tool ?? ''))) return true;
  if (MUTATING_TOOL_WORDS.test(String(tool ?? ''))) return false;
  const text = normalized(description);
  if (/\b(create|send|write|edit|update|delete|remove|restart|reboot|install|upload|modify|change state|state changing)\b/.test(text)) return false;
  return true;
}

export function promptExplicitlyRequestsSuccessfulRepeat(prompt = '') {
  const text = normalized(prompt);
  return /\b(rerun|recheck|repeat|refresh)\b/.test(text)
    || /\b(run|check|scan|call|do|perform|read|fetch|open)\b.{0,24}\bagain\b/.test(text)
    || /\b(twice|two times|second pass)\b/.test(text);
}


const NETWORK_RECON_RESULT_KEYS = Object.freeze({
  security_get_host_interface_info: 'get_host_interface_info',
  security_perform_network_discovery: 'perform_network_discovery',
  security_analyze_network_topology: 'analyze_network_topology',
  security_analyze_wireless_environment: 'analyze_wireless_environment',
});
const NETWORK_MAP_TOOL = 'security_generate_graphical_network_map';

export function requestedNetworkWorkflowStages(prompt = '') {
  const text = normalized(prompt);
  const stages = [];
  const add = (stage, tool, pattern) => { if (pattern.test(text)) stages.push({ stage, tool }); };
  add('host network state', 'security_get_host_interface_info', /\b(host network state|physical network interfaces?|active connection|ipv4|ipv6|default gateway|link speed|internet connectivity)\b/);
  add('network discovery', 'security_perform_network_discovery', /\b(network discovery|network enumeration|host enumeration|live hosts?|open ports?|service detection|smb|nfs|media services?)\b/);
  add('network topology', 'security_analyze_network_topology', /\b(network topology|topology|vlans?|lldp|cdp|client isolation|routing relationships?|access points?|switches?)\b/);
  add('wireless environment', 'security_analyze_wireless_environment', /\b(wireless environment|wireless assessment|wi fi|wifi|ssid|bssid|signal strength|channels?|channel overlap|security modes?)\b/);
  return stages;
}

function parseStructuredResultObject(result) {
  for (const block of result?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    let raw = block.text.trim();
    if (raw.startsWith('structuredContent:\n')) raw = raw.slice('structuredContent:\n'.length).trim();
    try {
      let value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'result')) {
        value = value.result;
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch { /* retain string */ }
        }
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* not structured JSON */ }
  }
  return null;
}
export function repeatArgsEquivalent(schema, previousArgs, nextArgs) {
  const prev = previousArgs ?? {};
  const next = nextArgs ?? {};
  if (canonicalArgs(prev, schema) === canonicalArgs(next, schema)) return true;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  // A common small-model no-progress pattern is a successful explicit call
  // followed by the same all-optional tool with `{}`. The second invocation
  // simply re-applies server defaults and usually repeats the same expensive
  // operation. Treat that as equivalent within one user turn. Going from an
  // empty/default call to new explicit arguments remains allowed.
  if (required.length === 0 && Object.keys(next).length === 0 && Object.keys(prev).length > 0) return true;
  return false;
}


// Keep the real adapter's transports, argument validation, approval handling,
// reconnect logic, and output guard. Only its model-facing surface is replaced.
export function gateConfig(input) {
  const config = structuredClone(input);
  for (const server of Object.values(config.mcpServers ?? {})) {
    server.directTools = false;
    server.exposeResources = false;
  }
  config.settings = {
    ...config.settings, directTools: false, namespaceProxyTools: false,
    scriptMode: false, allowInstall: false, exposeResources: false,
    hostConfigDiscovery: 'off', disableProxyTool: false,
    outputGuard: { maxBytes: 12288, maxLines: 300, detailsMaxBytes: 2048 },
  };
  return config;
}

export class BoundedGate {
  constructor(config, invoke) {
    this.config = config;
    this.invoke = invoke;
    this.queue = Promise.resolve();
    this.reset();
  }
  reset() {
    this.grants = new Map();
    this.grantSchemas = new Map();
    this.grantMeta = new Map();
    this.recentSearchTools = [];
    this.connected = new Set();
    this.discoveryCache = new Map();
    this.beginTurn();
  }
  beginTurn(prompt = '') {
    this.searches = 0;
    this.calls = 0;
    this.currentPrompt = String(prompt ?? '');
    this.successfulCallsThisTurn = new Map();
    this.successfulResultsThisTurn = new Map();
  }
  latestSuccessfulResult(tool) {
    const rows = this.successfulResultsThisTurn.get(tool) ?? [];
    return rows.at(-1)?.result ?? null;
  }
  outstandingNetworkStages() {
    return requestedNetworkWorkflowStages(this.currentPrompt).filter(({ tool }) => !this.latestSuccessfulResult(tool));
  }
  prepareNetworkMapArgs(args = {}) {
    const missing = this.outstandingNetworkStages();
    if (missing.length) {
      const labels = missing.map(x => x.stage).join(', ');
      const next = missing[0];
      failure(`Network-map generation is blocked because requested workflow stages are still incomplete: ${labels}. Complete ${next.stage} first using ${this.grants.has(next.tool) ? `mcp_call with ${next.tool}` : `a dedicated mcp_search on server=\"security\" followed by the matching call`}. Do not substitute host/discovery data for a dedicated wireless or topology assessment.`);
    }

    const aggregated = {};
    for (const [tool, key] of Object.entries(NETWORK_RECON_RESULT_KEYS)) {
      const result = this.latestSuccessfulResult(tool);
      if (result) aggregated[key] = result;
    }
    const supplied = args.data && typeof args.data === 'object' && !Array.isArray(args.data) ? args.data : {};
    const directData = { ...supplied, ...aggregated };
    if (!Object.keys(directData).length) {
      if (args.input_path) {
        failure('Do not pass a native Pi workspace path to security_generate_graphical_network_map: Pi and mcp-security use different workspaces. Pass aggregated recon results directly in args.data, or run the recon stages in this user turn so the bounded gate can inject them automatically.');
      }
      failure('No structured reconnaissance data is available for the network map. Run the requested host/discovery/topology/wireless stages first, then call the map tool.');
    }
    const next = { ...args, data: directData };
    delete next.input_path;
    return next;
  }
  enabled(server) {
    return Object.hasOwn(this.config.mcpServers ?? {}, server) && this.config.mcpServers[server].disabled !== true;
  }
  remember(tool, server, schema = undefined, meta = undefined) {
    if (typeof tool !== 'string' || !tool || tool.length > 256 || typeof server !== 'string' || !this.enabled(server)) return;
    this.grants.delete(tool);
    this.grants.set(tool, server);
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) this.grantSchemas.set(tool, schema);
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) this.grantMeta.set(tool, { ...this.grantMeta.get(tool), ...meta });
    while (this.grants.size > LIMITS.grants) {
      const evicted = this.grants.keys().next().value;
      this.grants.delete(evicted);
      this.grantSchemas.delete(evicted);
      this.grantMeta.delete(evicted);
    }
  }
  // Restore only successful discovery on the active branch, including sessions
  // recorded by the old gate. Retain identifiers, not schemas or tool outputs.
  restore(entries = []) {
    this.reset();
    for (const entry of entries) {
      const message = entry.type === 'message' ? entry.message : undefined;
      if (message?.role !== 'toolResult' || message.isError) continue;
      if (message.toolName === 'mcp_search') {
        for (const block of message.content ?? []) {
          if (block.type !== 'text' || typeof block.text !== 'string' || Buffer.byteLength(block.text) > LIMITS.discoveryBytes) continue;
          try {
            const value = JSON.parse(block.text);
            if (!Array.isArray(value?.tools)) continue;
            for (const item of value.tools.slice(0, LIMITS.results)) {
              if (item?.inputSchema && typeof item.inputSchema === 'object' && !Array.isArray(item.inputSchema)) this.remember(item.tool, item.server, item.inputSchema, { description: item.description });
            }
          } catch { /* Ignore non-discovery or malformed historical output. */ }
        }
      } else if (message.toolName === 'mcp_call' && this.grants.has(message.details?.tool) && this.grants.get(message.details.tool) === message.details.server) {
        this.remember(message.details.tool, message.details.server);
      }
    }
  }
  async connect(server, signal) {
    if (this.connected.has(server)) return;
    const result = await this.invoke({ connect: server }, signal);
    if (failed(result)) failure(textOf(result) || 'MCP server connection failed.');
    this.connected.add(server);
  }
  // Pi can issue sibling tools concurrently. Serializing gateway operations
  // prevents search grants and browser state from racing.
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  discoveryKey(query, server) {
    return `${server ?? '*'}\0${normalized(query)}`;
  }
  async fetchDiscoveryPage(state, query, server, signal) {
    if (!state.upstreamHasMore || state.pages >= LIMITS.discoveryPages) return;
    const candidateLimit = server ? LIMITS.serverCandidates : LIMITS.globalCandidates;
    const currentOffset = state.upstreamOffset;
    const found = await this.invoke({ search: query, server, limit: candidateLimit, offset: currentOffset, includeSchemas: false, searchMode: 'lexical' }, signal);
    if (failed(found)) failure(`MCP discovery failed: ${textOf(found).slice(0, 1500)}`);
    const rawMatches = Array.isArray(found.details?.matches) ? found.details.matches : [];
    const ranked = rankDiscoveryMatches(this.config, query, rawMatches);
    for (const match of ranked) {
      const key = `${match.server}\0${match.tool}`;
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      state.matches.push(match);
    }
    state.pages++;
    state.upstreamHasMore = Boolean(found.details?.hasMore);
    const reported = Number(found.details?.nextOffset);
    const fallback = currentOffset + Math.max(rawMatches.length, candidateLimit);
    state.upstreamOffset = Number.isFinite(reported) && reported > currentOffset ? reported : fallback;
    if (state.upstreamOffset <= currentOffset) state.upstreamHasMore = false;
  }
  async search(params, signal) {
    if (signal?.aborted) throw signal.reason;
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query || query.length > LIMITS.queryChars) failure('mcp_search requires a specific capability query of 1–200 characters.');
    if (++this.searches > LIMITS.searches) failure('MCP search budget reached for this user turn (6). Use a discovered tool or report the concrete blocker.');
    const limit = Math.min(LIMITS.results, Math.max(1, Math.floor(Number(params.limit) || LIMITS.results)));
    const offset = Math.min(1000, Math.max(0, Math.floor(Number(params.offset) || 0)));
    const servers = Object.keys(this.config.mcpServers ?? {}).filter(name => this.config.mcpServers[name].disabled !== true);
    if (params.server && !servers.includes(params.server)) failure(`Unknown or disabled MCP server. Available: ${servers.join(', ')}.`);
    const inferredServer = params.server ? null : inferServerForQuery(this.config, query);
    const effectiveServer = params.server || inferredServer || undefined;
    const targets = effectiveServer ? [effectiveServer] : servers;
    const errors = [];
    // Connect only the explicit or strongly inferred server when possible. This
    // prevents a security capability search from being diluted by unrelated
    // System/Google/browser catalogs when the model forgets a server filter.
    await Promise.all(targets.map(async server => {
      try {
        await this.connect(server, signal);
      } catch (error) {
        errors.push({ server, error: String(error.message ?? error).slice(0, 400) });
      }
    }));
    if (signal?.aborted) throw signal.reason;

    const key = this.discoveryKey(query, effectiveServer);
    let state = this.discoveryCache.get(key);
    if (!state) {
      state = { matches: [], seen: new Set(), upstreamOffset: 0, upstreamHasMore: true, pages: 0 };
      this.discoveryCache.set(key, state);
    }
    // Pagination is over the locally ranked, deduplicated candidate stream. When
    // the caller reaches the end of a cached page, fetch the next upstream page
    // instead of replaying offset=0 and returning the same nextOffset forever.
    while (offset >= state.matches.length && state.upstreamHasMore && state.pages < LIMITS.discoveryPages) {
      await this.fetchDiscoveryPage(state, query, effectiveServer, signal);
    }

    const output = { tools: [], errors, omitted: [], hasMore: false, nextOffset: null,
      resultScope: 'query_matches_not_server_catalog', catalogComplete: false,
      ...(inferredServer ? { routedServer: inferredServer } : {}),
      instruction: 'These are ranked matches for this capability query only, not a server catalog. Validate schema fit before calling. If none fits and hasMore is true, continue the same query/server with offset=nextOffset; otherwise refine this capability once. For a different outstanding capability in a multi-step request, run a separate mcp_search before claiming it is unavailable. Call mcp_call only with an exact returned tool and matching args.' };
    let cursor = offset;
    while (output.tools.length < limit) {
      if (cursor >= state.matches.length) {
        if (state.upstreamHasMore && state.pages < LIMITS.discoveryPages) {
          await this.fetchDiscoveryPage(state, query, effectiveServer, signal);
          if (cursor >= state.matches.length) break;
        } else break;
      }
      const match = state.matches[cursor++];
      if (typeof match.tool !== 'string' || match.tool.length > 256) {
        output.omitted.push({ reason: 'Server returned an invalid or oversized tool name.' });
        continue;
      }
      if (!targets.includes(match.server) || !this.connected.has(match.server)) continue;
      const described = await this.invoke({ describe: match.tool, server: match.server }, signal);
      if (failed(described) || !described.details?.tool) {
        output.omitted.push({ tool: match.tool, reason: 'Schema unavailable; retry discovery after reconnecting.' });
        continue;
      }
      const meta = described.details.tool;
      const item = { tool: match.tool, server: match.server, description: String(meta.description ?? '').slice(0, 700),
        inputSchema: meta.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
      if (bytes({ ...output, tools: [...output.tools, item] }) > LIMITS.discoveryBytes - 1536) {
        output.omitted.push({ tool: match.tool, reason: 'Complete schema exceeds this response budget. Search its exact capability with limit:1; if still omitted, simplify the server schema.' });
        continue;
      }
      output.tools.push(item);
    }
    output.hasMore = cursor < state.matches.length || (state.upstreamHasMore && state.pages < LIMITS.discoveryPages);
    output.nextOffset = output.hasMore ? cursor : null;
    if (!output.tools.length) output.instruction = errors.length
      ? 'Discovery is incomplete because the selected MCP server is unavailable. Report the concrete server error or try another configured server.'
      : output.hasMore
        ? 'No callable schema in this slice. Continue with the same query/server and offset=nextOffset before refining the query; never invent a tool name.'
        : 'No callable match. Refine the capability query once or choose the correct server filter; never invent a tool name.';
    while (bytes(output) > LIMITS.discoveryBytes && output.errors.length) output.errors.pop();
    while (bytes(output) > LIMITS.discoveryBytes && output.omitted.length) output.omitted.pop();
    while (bytes(output) > LIMITS.discoveryBytes && output.tools.length) output.tools.pop();
    this.recentSearchTools = output.tools.map(item => ({ tool: item.tool, server: item.server, inputSchema: item.inputSchema, description: item.description }));
    for (const item of output.tools) this.remember(item.tool, item.server, item.inputSchema, { description: item.description, query });
    return data(output);
  }
  async call(params, signal) {
    if (signal?.aborted) throw signal.reason;
    let tool = params.tool;
    let args = params.args;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { failure('args must be a JSON object or a string encoding one.'); }
    }
    args ??= {};
    if (!args || Array.isArray(args) || typeof args !== 'object') failure('args must be a JSON object.');

    // Small local models can occasionally omit the `tool` field while still
    // emitting a valid argument object. Recover only when schema matching makes
    // the intended already-discovered tool unambiguous. Prefer the most recent
    // search slice; fall back to all retained grants only when that also yields
    // exactly one match. Never fuzzy-match names or choose among ambiguities.
    if (tool == null || tool === '') {
      const matching = candidates => candidates.filter(item =>
        this.grants.get(item.tool) === item.server && schemaAcceptsArgs(item.inputSchema, args));
      let candidates = matching(this.recentSearchTools);
      if (candidates.length !== 1) {
        candidates = matching([...this.grantSchemas.entries()].map(([name, inputSchema]) => ({
          tool: name, server: this.grants.get(name), inputSchema,
        })));
      }
      if (candidates.length !== 1) {
        failure(`mcp_call omitted the required tool name and safe recovery was ${candidates.length ? 'ambiguous' : 'not possible'}. Run mcp_search for the capability and retry with {tool: "exact_returned_name", args: {...}}.`);
      }
      tool = candidates[0].tool;
    }

    // Some small local models occasionally serialize an empty argument object as
    // part of the tool-name string (for example `security_status{}`). Accept only
    // this exact, unambiguous suffix when the stripped name is already granted.
    // Do not perform fuzzy matching or repair arbitrary tool names.
    if (typeof tool === 'string' && tool.endsWith('{}') && !this.grants.has(tool) && Object.keys(args).length === 0) {
      const stripped = tool.slice(0, -2);
      if (this.grants.has(stripped)) {
        tool = stripped;
        args = {};
      }
    }
    const server = this.grants.get(tool);
    if (!server) failure(`Tool not discovered in this conversation (or evicted from the ${LIMITS.grants}-tool cache). Run mcp_search for the requested capability, then retry mcp_call with an exact returned name. Pass empty arguments separately as args: {}; never append {} to the tool name. This is a discovery requirement, not a target or service failure.`);

    if (tool === NETWORK_MAP_TOOL) args = this.prepareNetworkMapArgs(args);

    const schema = this.grantSchemas.get(tool);
    const meta = this.grantMeta.get(tool) ?? {};
    const successes = this.successfulCallsThisTurn.get(tool) ?? [];
    const statusLike = STATUS_TOOL_WORDS.test(tool);
    const explicitRepeat = promptExplicitlyRequestsSuccessfulRepeat(this.currentPrompt);
    if (isLikelyReadOnlyTool(tool, meta.description) && !statusLike && !explicitRepeat) {
      const duplicate = successes.find(previous => repeatArgsEquivalent(schema, previous.args, args));
      if (duplicate) {
        const capability = meta.query ? ` for capability query "${String(meta.query).slice(0, 120)}"` : '';
        failure(`No-progress MCP call blocked: ${tool}${capability} already completed successfully in this user turn with equivalent arguments. Do not repeat the completed read-only operation. Continue with the next outstanding capability, or summarize the existing result. If the user explicitly requests a fresh rerun, start a new user turn or ask them to request it explicitly.`);
      }
    }
    if (!this.enabled(server)) {
      this.grants.delete(tool);
      failure('The discovered MCP server is no longer enabled. Use mcp_search for an available capability.');
    }
    if (++this.calls > LIMITS.calls) failure('MCP call budget reached for this user turn (24). Report progress and the remaining work.');
    let result;
    try {
      // Resumed sessions reconnect before the adapter validates and executes.
      await this.connect(server, signal);
      if (signal?.aborted) throw signal.reason;
      result = await this.invoke({ tool, server, args }, signal);
      if (failed(result)) failure(textOf(result).slice(0, 2500) || 'MCP operation failed.');
    } catch (error) {
      // Let a subsequent explicit call reconnect and retry. Never replay a
      // failed invocation automatically: it may already have changed state.
      this.connected.delete(server);
      throw error;
    }
    this.remember(tool, server);
    const successList = this.successfulCallsThisTurn.get(tool) ?? [];
    successList.push({ args: structuredClone(args), at: Date.now() });
    this.successfulCallsThisTurn.set(tool, successList.slice(-8));
    const structuredResult = parseStructuredResultObject(result);
    if (structuredResult) {
      const rows = this.successfulResultsThisTurn.get(tool) ?? [];
      rows.push({ result: structuredClone(structuredResult), at: Date.now() });
      this.successfulResultsThisTurn.set(tool, rows.slice(-4));
    }
    // The adapter's output guard preserves large results in a local spill file.
    // Do not duplicate its bounded raw MCP details into the model context.
    return { content: dedupeContent(result.content), details: { server, tool, ...(result.details?.outputGuard ? { outputGuard: result.details.outputGuard } : {}) } };
  }
}

export function dedupeContent(content = []) {
  const seen = new Set();
  return content.filter(block => {
    if (block.type !== 'text') return true;
    if (seen.has(block.text)) return false;
    if (block.text.startsWith('structuredContent:\n')) {
      try {
        let value = JSON.parse(block.text.slice('structuredContent:\n'.length));
        if (value && typeof value === 'object' && Object.keys(value).length === 1 && 'result' in value) value = value.result;
        if (typeof value !== 'string') value = JSON.stringify(value);
        if ([...seen].some(text => {
          try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(value)); } catch { return text === value; }
        })) return false;
      } catch { /* Preserve non-JSON server output. */ }
    }
    seen.add(block.text);
    return true;
  });
}
