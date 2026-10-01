export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'bash', 'mcp_search', 'mcp_call'];
export const LIMITS = Object.freeze({ results: 3, discoveryBytes: 16384, grants: 64, searches: 6, calls: 24, queryChars: 200, serverCandidates: 96, globalCandidates: 100 });
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
    let aliasScore = overlap * 12;
    if (q === a) aliasScore += 120;
    else {
      if (q.includes(a)) aliasScore += 45;
      if (a.includes(q)) aliasScore += 30;
    }
    if (qTokens.size) aliasScore += 25 * (overlap / qTokens.size);
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
    this.connected = new Set();
    this.beginTurn();
  }
  beginTurn() {
    this.searches = 0;
    this.calls = 0;
  }
  enabled(server) {
    return Object.hasOwn(this.config.mcpServers ?? {}, server) && this.config.mcpServers[server].disabled !== true;
  }
  remember(tool, server) {
    if (typeof tool !== 'string' || !tool || tool.length > 256 || typeof server !== 'string' || !this.enabled(server)) return;
    this.grants.delete(tool);
    this.grants.set(tool, server);
    while (this.grants.size > LIMITS.grants) this.grants.delete(this.grants.keys().next().value);
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
              if (item?.inputSchema && typeof item.inputSchema === 'object' && !Array.isArray(item.inputSchema)) this.remember(item.tool, item.server);
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
  async search(params, signal) {
    if (signal?.aborted) throw signal.reason;
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query || query.length > LIMITS.queryChars) failure('mcp_search requires a specific capability query of 1–200 characters.');
    if (++this.searches > LIMITS.searches) failure('MCP search budget reached for this user turn (6). Use a discovered tool or report the concrete blocker.');
    const limit = Math.min(LIMITS.results, Math.max(1, Math.floor(Number(params.limit) || LIMITS.results)));
    const offset = Math.min(1000, Math.max(0, Math.floor(Number(params.offset) || 0)));
    const servers = Object.keys(this.config.mcpServers ?? {}).filter(name => this.config.mcpServers[name].disabled !== true);
    if (params.server && !servers.includes(params.server)) failure(`Unknown or disabled MCP server. Available: ${servers.join(', ')}.`);
    const targets = params.server ? [params.server] : servers;
    const errors = [];
    // Connect only on first discovery (including an empty metadata cache).
    // Do not treat an offline server as an empty catalog or permanently cache it.
    await Promise.all(targets.map(async server => {
      try {
        await this.connect(server, signal);
      } catch (error) {
        errors.push({ server, error: String(error.message ?? error).slice(0, 400) });
      }
    }));
    if (signal?.aborted) throw signal.reason;
    const candidateLimit = params.server ? LIMITS.serverCandidates : LIMITS.globalCandidates;
    const found = await this.invoke({ search: query, server: params.server, limit: candidateLimit, offset: 0, includeSchemas: false, searchMode: 'lexical' }, signal);
    if (failed(found)) failure(`MCP discovery failed: ${textOf(found).slice(0, 1500)}`);
    const ranked = rankDiscoveryMatches(this.config, query, found.details?.matches ?? []);
    const output = { tools: [], errors, omitted: [], hasMore: false, nextOffset: null,
      instruction: 'Call mcp_call with the exact tool and an args object matching inputSchema. These names are MCP targets, not native functions.' };
    let cursor = offset;
    while (cursor < ranked.length && output.tools.length < limit) {
      const match = ranked[cursor++];
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
      // A truncated schema is unsafe to call. Admit only complete schemas within
      // a hard response budget; a narrower search can fit more of the budget.
      if (bytes({ ...output, tools: [...output.tools, item] }) > LIMITS.discoveryBytes - 1536) {
        output.omitted.push({ tool: match.tool, reason: 'Complete schema exceeds this response budget. Search its exact name with limit:1; if still omitted, simplify the server schema.' });
        continue;
      }
      output.tools.push(item);
    }
    output.hasMore = cursor < ranked.length || Boolean(found.details?.hasMore);
    output.nextOffset = output.hasMore ? cursor : null;
    if (!output.tools.length) output.instruction = errors.length
      ? 'Discovery is incomplete because a server is unavailable. Report the error or try another configured MCP server.'
      : 'No callable match. Refine the capability query or server filter; never invent a tool name.';
    // Errors and descriptors are bounded above, but keep the whole envelope bounded too.
    while (bytes(output) > LIMITS.discoveryBytes && output.errors.length) output.errors.pop();
    while (bytes(output) > LIMITS.discoveryBytes && output.omitted.length) output.omitted.pop();
    while (bytes(output) > LIMITS.discoveryBytes && output.tools.length) output.tools.pop();
    for (const item of output.tools) this.remember(item.tool, item.server);
    return data(output);
  }
  async call(params, signal) {
    if (signal?.aborted) throw signal.reason;
    const server = this.grants.get(params.tool);
    if (!server) failure(`Tool not discovered in this conversation (or evicted from the ${LIMITS.grants}-tool cache). Run mcp_search for the requested capability, then retry mcp_call with an exact returned name. This is a discovery requirement, not a target or service failure.`);
    if (!this.enabled(server)) {
      this.grants.delete(params.tool);
      failure('The discovered MCP server is no longer enabled. Use mcp_search for an available capability.');
    }
    let args = params.args ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { failure('args must be a JSON object or a string encoding one.'); }
    }
    if (!args || Array.isArray(args) || typeof args !== 'object') failure('args must be a JSON object.');
    if (++this.calls > LIMITS.calls) failure('MCP call budget reached for this user turn (24). Report progress and the remaining work.');
    let result;
    try {
      // Resumed sessions reconnect before the adapter validates and executes.
      await this.connect(server, signal);
      if (signal?.aborted) throw signal.reason;
      result = await this.invoke({ tool: params.tool, server, args }, signal);
      if (failed(result)) failure(textOf(result).slice(0, 2500) || 'MCP operation failed.');
    } catch (error) {
      // Let a subsequent explicit call reconnect and retry. Never replay a
      // failed invocation automatically: it may already have changed state.
      this.connected.delete(server);
      throw error;
    }
    this.remember(params.tool, server);
    // The adapter's output guard preserves large results in a local spill file.
    // Do not duplicate its bounded raw MCP details into the model context.
    return { content: dedupeContent(result.content), details: { server, tool: params.tool, ...(result.details?.outputGuard ? { outputGuard: result.details.outputGuard } : {}) } };
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
