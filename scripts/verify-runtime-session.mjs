import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';

export const ACTIVE_TOOLS = ['read', 'bash', 'edit', 'write', 'tool_search', 'tool_invoke', 'result_get', 'result_list'];
export const MCP_SERVERS = ['system', 'security', 'google', 'memory', 'playwright', 'searxng'];

export function connectedCatalogs(tools, servers = MCP_SERVERS) {
  const names = new Set(tools.map(tool => tool.name));
  const connected = servers.filter(server => [...names].some(name => name.startsWith(`mcp__${server}__`)));
  return { connected, missing: servers.filter(server => !connected.includes(server)) };
}

export async function verifySession({ sdk, agentDir, cwd, web, timeoutMs = 30000, requireMcp = true }) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const n = requests.length;
    const message = n === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'verify-search', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: 'memory search' }) } }] } : { role: 'assistant', content: 'Catalog verification complete.' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: `verify-${n}`, object: 'chat.completion.chunk', created: 1, model: 'verification' };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: n === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider('verification', { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'verification', models: [
    { id: 'verification', name: 'Offline verification', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false } },
  ] });
  let session;
  const hookErrors = [];
  try {
  const services = await sdk.createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: {} });
  assert.deepEqual(services.diagnostics, [], 'Extension diagnostics');
  // Service diagnostics only cover provider/flag setup; load failures and tool
  // collisions live in the resource loader and otherwise stay nonfatal in Pi.
  assert.deepEqual(services.resourceLoader.getExtensions().errors, [], 'Extension load/conflict diagnostics: check retained autoload copies');
  ({ session } = await sdk.createAgentSessionFromServices({ services, model: modelRuntime.getModel('verification', 'verification'), sessionManager: sdk.SessionManager.inMemory(cwd) }));
    await session.bindExtensions({ onError: error => hookErrors.push(error) });
    // Live container health must not be coupled to optional MCP endpoints.
    // Image-build integration tests still run this function with requireMcp=true
    // and six controlled MCP fixtures to test actual discovery/provider transport.
    if (requireMcp) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && connectedCatalogs(session.getAllTools()).missing.length)
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const catalog = connectedCatalogs(session.getAllTools());
    if (requireMcp) {
      for (const name of catalog.missing)
        assert.fail(`No connected catalog for ${name} (configured MCP endpoint is unreachable or returned no tools)`);
    }
    web.applyAgentToolsGating(session, [...web.AGENT_TOOL_CATALOG.map(t => t.name), 'powershell', 'ls', 'grep', 'find'], 'standard');
    // Web UI may replay its tool controls. prepareLoadout and before_agent_start
    // enforce the model surface without modifying that upstream implementation.
    // Live mode checks the tool surface and diagnostics without relying on any
    // remote MCP service. The strict fixture-backed image test below checks
    // schema leases, provider serialization, discovery and settings replay.
    if (!requireMcp) {
      assert.deepEqual(hookErrors, [], 'Extension hook errors');
      return { active: session.getActiveToolNames(), deferred: session.getAllTools().filter(t => t.exposure === 'deferred').length,
        requests: 0, connected: catalog.connected, missing: catalog.missing, discoveryChecked: false };
    }
    // The local responder exercises the real provider/tool pipeline without calling a model or executing an MCP target.
    await session.prompt('Verify the memory catalog through tool_search, then finish. Do not execute an MCP target.');
    assert.deepEqual(hookErrors, [], 'Extension hook errors');
    assert.equal(requests.length, 2);
    const search = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'tool_search');
    assert(search && !search.isError, 'Native discovery must work');
    assert.equal(search.details?.loaded?.length, 1, 'Omitted search limit must load exactly one schema');
    assert.equal(search.details.atomicSchema, true, 'Discovery must retain its schema lease metadata');
    const wireResult = requests[1].messages.find(m => m.role === 'tool' && m.tool_call_id === search.toolCallId);
    assert(wireResult, 'Provider request omitted the discovery result');
    const discovery = JSON.parse(wireResult.content);
    assert.equal(discovery.discovery, 'ready');
    assert.equal(discovery.execution, 'tool_invoke');
    assert.equal(discovery.tools?.length, 1, 'The provider must receive exactly one full schema');
    assert.deepEqual(discovery.tools.map(t => t.name), search.details.loaded);
    for (const tool of discovery.tools) {
      assert.deepEqual(tool.parameters, session.getAllTools().find(t => t.name === tool.name)?.parameters, 'Provider schema must match the native registered tool');
    }
    assert.equal(JSON.stringify(requests[0].tools), JSON.stringify(requests[1].tools), 'Provider tool declarations changed');
    assert.equal(JSON.stringify(requests[0].messages.filter(m => m.role === 'system')), JSON.stringify(requests[1].messages.filter(m => m.role === 'system')), 'Provider standing prompt changed');
    assert.deepEqual(session.getActiveToolNames().sort(), [...ACTIVE_TOOLS].sort(), 'MCP discovery must not add provider declarations');
    web.applyAgentToolsGating(session, [...web.AGENT_TOOL_CATALOG.map(t => t.name), 'powershell', 'ls', 'grep', 'find'], 'standard');
    // Verify replay at the provider boundary on a second turn.
    requests.length = 0;
    await session.prompt('Verify the memory catalog through tool_search, then finish. Do not execute an MCP target.');
    assert.deepEqual(session.getActiveToolNames().sort(), [...ACTIVE_TOOLS].sort(), 'Provider-boundary gating after settings replay');
    assert.deepEqual(requests[0].tools.map(t=>t.function.name).sort(), [...ACTIVE_TOOLS].sort(), 'Settings replay leaked extra declarations');
    return { active: session.getActiveToolNames(), deferred: session.getAllTools().filter(t => t.exposure === 'deferred').length, requests: requests.length,
      connected: catalog.connected, missing: catalog.missing, discoveryChecked: true };
  } finally {
    await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'exit' });
    session?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
