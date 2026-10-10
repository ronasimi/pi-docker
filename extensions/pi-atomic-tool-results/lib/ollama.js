// Minimal *Pi-owned* deferred read-only Ollama API operation. It is discoverable
// through the same fixed tool_search/tool_invoke surface, but is NOT an MCP
// gateway server operation. The endpoint comes from operator configuration,
// never from model arguments. No write endpoints or shell fallback.
export const OLLAMA_INVENTORY_NAME = 'ollama_api_inventory';
export function createOllamaInventoryTool({ baseUrl = process.env.PI_OLLAMA_INVENTORY_URL || process.env.OLLAMA_BASE_URL || 'http://ollama:11434', fetchImpl = fetch } = {}) {
  let root, endpointError = null;
  try {
    const u = new URL(baseUrl);
    if (u.pathname === '/v1' || u.pathname === '/v1/') u.pathname = '/';
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error();
    root = u.origin;
  } catch { endpointError = 'PI_OLLAMA_INVENTORY_URL must be an HTTP(S) origin without credentials or path'; }
  return {
    name: OLLAMA_INVENTORY_NAME,
    label: 'List Ollama Models and API Health',
    description: 'Ollama API list installed and running models with read-only /api/tags, /api/ps and /api/version. Real Ollama model inventory, never Docker container names or generic MCP resources. No shell, no changes.',
    exposure: 'deferred', annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _args = {}, signal) {
      async function read(path) {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 4500);
        const cancel = () => ctrl.abort();
        signal?.addEventListener?.('abort', cancel, { once: true });
        try {
          const res = await fetchImpl(root + path, { method: 'GET', signal: ctrl.signal, headers: { accept: 'application/json' } });
          if (!res.ok) throw Error(`HTTP ${res.status}`);
          const raw = await res.text(); if (raw.length > 1_000_000) throw Error('Ollama response too large');
          return JSON.parse(raw);
        } finally { clearTimeout(timeout); signal?.removeEventListener?.('abort', cancel); }
      }
      try {
        if (endpointError) throw new Error(endpointError);
        const tags = await read('/api/tags');
        const version = await read('/api/version').catch(e => ({ unavailable: e.message }));
        const running = await read('/api/ps').catch(e => ({ unavailable: e.message }));
        const installed = Array.isArray(tags.models) ? tags.models.map(m => ({ name: m.name ?? m.model, size_bytes: m.size ?? null,  })) : [];
        const loaded = Array.isArray(running.models) ? running.models.map(m => ({ name: m.name ?? m.model, size_bytes: m.size ?? null })) : [];
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', source: 'ollama_api', version: version.version ?? null, installed_models: installed, running_models: loaded, running_status: running.unavailable ? 'unavailable' : 'ok' }) }] };
      } catch(e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', source: 'ollama_api', error: String(e?.message ?? e).slice(0,200) }) }] }; }
    },
  };
}
