export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'bash', 'mcp_search', 'mcp_call'];
export const LIMITS = Object.freeze({ results: 3, discoveryBytes: 16384, grants: 64, searches: 6, calls: 24, queryChars: 200 });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const textOf = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const failed = result => Boolean(result?.isError || result?.details?.error);
const data = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {} });
function failure(message) { throw new Error(message); }

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
    }
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
