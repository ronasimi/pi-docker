import { createHash } from 'node:crypto';

export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'bash', 'mcp_search', 'mcp_call'];
export const LIMITS = Object.freeze({ results: 3, discoveryBytes: 16384, grants: 8, searches: 6, calls: 24, queryChars: 200 });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const textOf = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const failed = result => Boolean(result?.isError || result?.details?.error);
const data = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {} });
function failure(message) { throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
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
    this.connected = new Set();
    this.queue = Promise.resolve();
    this.reset();
  }
  reset() {
    this.grants = new Map();
    this.failures = new Set();
    this.repeated = new Map();
    this.searches = 0;
    this.calls = 0;
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
      if (this.connected.has(server)) return;
      try {
        const connected = await this.invoke({ connect: server }, signal);
        if (failed(connected)) throw new Error(textOf(connected));
        this.connected.add(server);
      } catch (error) {
        errors.push({ server, error: String(error.message ?? error).slice(0, 400) });
      }
    }));
    if (signal?.aborted) throw signal.reason;
    const found = await this.invoke({ search: query, server: params.server, limit, offset, includeSchemas: false, searchMode: 'lexical' }, signal);
    if (failed(found)) failure(`MCP discovery failed: ${textOf(found).slice(0, 1500)}`);
    const output = { tools: [], errors, omitted: [], hasMore: Boolean(found.details?.hasMore), nextOffset: found.details?.nextOffset ?? null,
      instruction: 'Call mcp_call with the exact tool and an args object matching inputSchema. These names are MCP targets, not native functions.' };
    for (const match of (found.details?.matches ?? []).slice(0, limit)) {
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
      this.grants.delete(match.tool);
      this.grants.set(match.tool, match.server);
      while (this.grants.size > LIMITS.grants) this.grants.delete(this.grants.keys().next().value);
    }
    if (!output.tools.length) output.instruction = errors.length
      ? 'Discovery is incomplete because a server is unavailable. Report the error or try another configured MCP server.'
      : 'No callable match. Refine the capability query or server filter; never invent a tool name.';
    // Errors and descriptors are bounded above, but keep the whole envelope bounded too.
    while (bytes(output) > LIMITS.discoveryBytes && output.errors.length) output.errors.pop();
    while (bytes(output) > LIMITS.discoveryBytes && output.omitted.length) output.omitted.pop();
    while (bytes(output) > LIMITS.discoveryBytes && output.tools.length) {
      this.grants.delete(output.tools.pop().tool);
    }
    return data(output);
  }
  async call(params, signal) {
    if (signal?.aborted) throw signal.reason;
    const server = this.grants.get(params.tool);
    if (!server) failure('Tool not discovered in this user turn (or evicted from the 8-tool cache). Call mcp_search first, then use an exact returned tool name.');
    let args = params.args ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { failure('args must be a JSON object or a string encoding one.'); }
    }
    if (!args || Array.isArray(args) || typeof args !== 'object') failure('args must be a JSON object.');
    const key = createHash('sha256').update(JSON.stringify([server, params.tool, canonical(args)])).digest('hex');
    if (this.failures.has(key)) failure('Identical MCP call already failed this turn. Change the arguments, discover an alternative, or report the blocker.');
    if (++this.calls > LIMITS.calls) failure('MCP call budget reached for this user turn (24). Report progress and the remaining work.');
    let result;
    try {
      result = await this.invoke({ tool: params.tool, server, args }, signal);
      if (failed(result)) failure(textOf(result).slice(0, 2500) || 'MCP operation failed.');
    } catch (error) {
      this.failures.add(key);
      // An idle-disconnected server can refresh on a new search/user turn.
      this.connected.delete(server);
      throw error;
    }
    const signature = createHash('sha256').update(textOf(result)).digest('hex');
    const previous = this.repeated.get(key);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    this.repeated.set(key, { signature, count });
    if (count >= 2) this.failures.add(key);
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
