import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, BoundedGate, gateConfig, dedupeContent, inferServerForQuery, LIMITS, networkStageForCapabilityQuery, normalizeSearchParams, rankDiscoveryMatches } from '../gate.mjs';

function fixture(options = {}) {
  const calls = [];
  const config = { mcpServers: { playwright: {}, searxng: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return options.offline === params.connect ? { details: { error: 'offline' }, content: [{ type: 'text', text: 'offline' }] } : { details: {} };
    if ('search' in params) return { details: { matches: Array.from({ length: 10 }, (_, i) => ({ server: params.server || 'playwright', tool: `${params.search}_${i + (Number(params.offset) || 0)}` })), hasMore: true, nextOffset: params.offset + params.limit } };
    if (params.describe) return { details: { tool: { description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'x'.repeat(options.schemaSize || 5) } }, required: ['url'] } } } };
    if (options.fail) return { details: { error: 'tool_error' }, content: [{ type: 'text', text: 'bridge unavailable' }] };
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  });
  return { gate, calls };
}


test('normalizes mcp_search queries compatibility input without enabling batched discovery', () => {
  assert.deepEqual(
    normalizeSearchParams({ queries: ['host network interface state'], server: 'security', limit: 1 }),
    { query: 'host network interface state', server: 'security', limit: 1 },
  );
  assert.deepEqual(
    normalizeSearchParams({ queries: ['host network interface state', 'network discovery'], server: 'security' }),
    { query: 'host network interface state', server: 'security' },
  );
  assert.deepEqual(
    normalizeSearchParams({ query: 'network status', queries: ['network status', 'wireless assessment'], server: 'security' }),
    { query: 'network status', server: 'security' },
  );
  assert.throws(() => normalizeSearchParams({ queries: [] }), /1–6 strings/i);
  assert.throws(() => normalizeSearchParams({ queries: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] }), /1–6 strings/i);
  assert.throws(() => normalizeSearchParams({ queries: ['one', 2] }), /strings only/i);
  assert.throws(
    () => normalizeSearchParams({ query: 'network status', queries: ['host interfaces', 'wireless'] }),
    /conflicting query and queries\[0\]/i,
  );
  assert.throws(() => normalizeSearchParams({}), /requires a specific capability query/i);
});

test('mcp_search executes only the first queries alias entry and reports deferred capabilities', async () => {
  const { gate, calls } = fixture();
  const result = JSON.parse((await gate.search({ queries: ['navigate', 'screenshot', 'click'], server: 'playwright', limit: 1 })).content[0].text);
  assert.equal(result.tools.length, 1);
  const searches = calls.filter(call => Object.hasOwn(call, 'search'));
  assert.equal(searches.length, 1, 'compatibility recovery must never fan out into batched discovery');
  assert.equal(searches[0].search, 'navigate');
  assert.equal(searches[0].server, 'playwright');
  assert.deepEqual(result.compatibilityRecovery, {
    executedQuery: 'navigate', deferredQueries: ['screenshot', 'click'], batched: false,
  });
  assert.match(result.instruction, /remaining entries were NOT searched/i);
});

test('family-aware discovery prevents broad server terms from outranking the requested capability', () => {
  const config = {
    mcpServers: {
      system: {
        searchKeywords: {
          docker_list_containers: ['docker containers', 'docker ps'],
          document_list: ['list documents', 'files'],
          openwrt_status: ['router status', 'anansi', 'arachne'],
          openwrt_clients: ['router clients', 'connected devices', 'dhcp leases', 'wifi clients', 'lan clients'],
          local_daily_briefing: ['london weather and news', 'london daily briefing', 'weather and headlines', 'cbc london headlines'],
        },
      },
      google: {
        searchKeywords: {
          gmail_search: ['gmail search', 'email search', 'inbox'],
          calendar_list_events: ['calendar events', 'schedule', 'meetings'],
          drive_search: ['drive search', 'google drive files'],
        },
      },
    },
  };
  const systemMatches = [
    { server: 'system', tool: 'system_docker_list_containers' },
    { server: 'system', tool: 'system_document_list' },
    { server: 'system', tool: 'system_openwrt_status' },
    { server: 'system', tool: 'system_openwrt_clients' },
  ];
  assert.deepEqual(
    rankDiscoveryMatches(config, 'what clients are connected to my router - anansi', systemMatches).map(x => x.tool),
    ['system_openwrt_clients', 'system_openwrt_status'],
  );
  assert.equal(
    rankDiscoveryMatches(config, 'check anansi router status', systemMatches)[0].tool,
    'system_openwrt_status',
  );
  const briefingMatches = [
    { server: 'system', tool: 'system_docker_list_containers' },
    { server: 'system', tool: 'system_openwrt_status' },
    { server: 'system', tool: 'system_local_daily_briefing' },
  ];
  assert.equal(
    rankDiscoveryMatches(config, 'london weather and news', briefingMatches)[0].tool,
    'system_local_daily_briefing',
  );
  const googleMatches = [
    { server: 'google', tool: 'google_drive_search' },
    { server: 'google', tool: 'google_calendar_list_events' },
    { server: 'google', tool: 'google_gmail_search' },
  ];
  assert.deepEqual(
    rankDiscoveryMatches(config, 'search my gmail inbox', googleMatches).map(x => x.tool),
    ['google_gmail_search'],
  );
});


test('comprehensive network workflow reranking prefers high-level recon tools over lower-level primitives', () => {
  const config = { mcpServers: { security: { searchKeywords: {
    network_discover: ['network discovery', 'discover hosts'],
    perform_network_discovery: ['comprehensive network discovery', 'scan ports and services', 'network inventory'],
    analyze_network_topology: ['network topology'],
    analyze_wireless_environment: ['wireless analysis'],
    generate_graphical_network_map: ['graphical network map'],
  } } } };
  const context = 'Perform comprehensive network reconnaissance, network discovery and enumeration, topology, wireless assessment, and a graphical network map.';
  const matches = [
    { server: 'security', tool: 'security_network_discover' },
    { server: 'security', tool: 'security_perform_network_discovery' },
    { server: 'security', tool: 'security_port_scan' },
  ];
  assert.equal(
    rankDiscoveryMatches(config, 'port scan and service fingerprinting', matches, context)[0].tool,
    'security_perform_network_discovery',
  );
  assert.equal(networkStageForCapabilityQuery('passive wireless environment assessment').tool, 'security_analyze_wireless_environment');
  assert.equal(networkStageForCapabilityQuery('graphical network map').tool, 'security_generate_graphical_network_map');
});

test('strong capability queries infer the narrow MCP server when the model omits a filter', () => {
  const config = { mcpServers: { security: {}, system: {}, google: {}, playwright: {}, searxng: {}, memory: {} } };
  assert.equal(inferServerForQuery(config, 'discover live hosts on my LAN'), 'security');
  assert.equal(inferServerForQuery(config, 'run a nuclei vulnerability scan'), 'security');
  assert.equal(inferServerForQuery(config, 'show connected clients on router anansi'), 'system');
  assert.equal(inferServerForQuery(config, 'search my Gmail inbox'), 'google');
  assert.equal(inferServerForQuery(config, 'open this URL in the browser'), 'playwright');
  assert.equal(inferServerForQuery(config, 'search the web for current news'), 'searxng');
  assert.equal(inferServerForQuery(config, 'remember this in durable memory'), 'memory');
});

test('omitted security filter is recovered before discovery touches unrelated servers', async () => {
  const calls = [];
  const config = { mcpServers: { security: {}, system: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) return { details: { matches: [{ server: 'security', tool: 'security_network_discover' }], hasMore: false, nextOffset: null } };
    if (params.describe) return { details: { tool: { description: 'Discover live hosts in an authorized target CIDR.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } } } };
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  });
  const result = JSON.parse((await gate.search({ query: 'discover live hosts on my LAN' })).content[0].text);
  assert.equal(result.routedServer, 'security');
  assert.equal(result.tools[0].tool, 'security_network_discover');
  assert.deepEqual(calls.filter(c => c.connect).map(c => c.connect), ['security']);
  assert.equal(calls.find(c => c.search).server, 'security');
});

test('bounded continuation fetches the next upstream page instead of replaying offset zero', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) {
      const offset = Number(params.offset) || 0;
      const pages = {
        0: [{ server: 'security', tool: 'security_alpha' }, { server: 'security', tool: 'security_beta' }],
        2: [{ server: 'security', tool: 'security_gamma' }, { server: 'security', tool: 'security_delta' }],
      };
      return { details: { matches: pages[offset] ?? [], hasMore: offset === 0, nextOffset: offset === 0 ? 2 : null } };
    }
    if (params.describe) return { details: { tool: { description: params.describe, inputSchema: { type: 'object', properties: {} } } } };
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  });
  const first = JSON.parse((await gate.search({ query: 'security audit', server: 'security', limit: 2 })).content[0].text);
  assert.deepEqual(first.tools.map(t => t.tool), ['security_alpha', 'security_beta']);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  const second = JSON.parse((await gate.search({ query: 'security audit', server: 'security', limit: 2, offset: first.nextOffset })).content[0].text);
  assert.deepEqual(second.tools.map(t => t.tool), ['security_gamma', 'security_delta']);
  assert.equal(second.hasMore, false);
  assert.deepEqual(calls.filter(c => Object.hasOwn(c, 'search')).map(c => c.offset), [0, 2]);
});

test('all upstream direct tools and scripting are disabled without mutating source config', () => {
  const original = { mcpServers: { x: { directTools: ['search'], disabled: true } }, settings: { scriptMode: true } };
  const gated = gateConfig(original);
  assert.equal(gated.mcpServers.x.directTools, false);
  assert.equal(gated.mcpServers.x.disabled, true);
  assert.equal(gated.settings.scriptMode, false);
  assert.deepEqual(original.mcpServers.x.directTools, ['search']);
  assert.equal(ALLOWED_TOOLS.length, 6);
});
test('cold search connects selected server, clamps limit, returns complete schemas and uses exact routing', async () => {
  const { gate, calls } = fixture();
  const result = await gate.search({ query: 'navigate', server: 'playwright', limit: 999 });
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.tools.length, 3);
  assert.deepEqual(value.tools[0].inputSchema.required, ['url']);
  assert.equal(value.resultScope, 'query_matches_not_server_catalog');
  assert.equal(value.catalogComplete, false);
  assert.match(value.instruction, /not a server catalog/i);
  assert.match(value.instruction, /different outstanding capability/i);
  assert.equal(calls.filter(c => c.connect).length, 1);
  assert.equal(calls.find(c => c.search).limit, LIMITS.serverCandidates);
  await gate.call({ tool: value.tools[0].tool, args: '{"url":"https://example.com"}' });
  assert.deepEqual(calls.at(-1), { server: 'playwright', tool: 'navigate_0', args: { url: 'https://example.com' } });
  await gate.search({ query: 'navigate', server: 'playwright' });
  assert.equal(calls.filter(c => c.connect).length, 1);
});
test('normalizes a small-model empty-args suffix only for an already discovered exact tool', async () => {
  const { gate, calls } = fixture();
  await gate.search({ query: 'navigate', server: 'playwright', limit: 1 });
  await gate.call({ tool: 'navigate_0{}' });
  assert.deepEqual(calls.at(-1), { server: 'playwright', tool: 'navigate_0', args: {} });
  await assert.rejects(gate.call({ tool: 'invented{}' }), /not discovered/);
  await assert.rejects(gate.call({ tool: 'navigate_0{\"url\":\"x\"}' }), /not discovered/);
});


test('recovers a missing mcp_call tool only when discovered schema matching is unambiguous', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const schemas = {
    security_get_host_interface_info: {
      type: 'object',
      properties: { interface: { type: 'string' }, internet_check: { type: 'boolean' } },
      additionalProperties: false,
    },
    security_perform_network_discovery: {
      type: 'object',
      properties: {
        cidrs: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        interface: { type: 'string' },
      },
      additionalProperties: false,
    },
    security_network_interfaces: { type: 'object', properties: {}, additionalProperties: false },
  };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) return { details: { matches: Object.keys(schemas).map(tool => ({ server: 'security', tool })), hasMore: false, nextOffset: null } };
    if (params.describe) return { details: { tool: { description: params.describe, inputSchema: schemas[params.describe] } } };
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  });
  await gate.search({ query: 'host network state', server: 'security' });
  await gate.call({ args: { cidrs: ['192.168.1.0/24'], interface: 'wlp3s0' } });
  assert.deepEqual(calls.at(-1), {
    server: 'security',
    tool: 'security_perform_network_discovery',
    args: { cidrs: ['192.168.1.0/24'], interface: 'wlp3s0' },
  });
});

test('missing mcp_call tool fails closed when schema matching is ambiguous', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) return { details: { matches: [
      { server: 'security', tool: 'security_alpha' },
      { server: 'security', tool: 'security_beta' },
    ], hasMore: false, nextOffset: null } };
    if (params.describe) return { details: { tool: { description: params.describe, inputSchema: {
      type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false,
    } } } };
    return { content: [{ type: 'text', text: 'should-not-run' }], details: {} };
  });
  await gate.search({ query: 'scan target', server: 'security' });
  await assert.rejects(gate.call({ args: { target: '192.168.1.1' } }), /safe recovery was ambiguous/);
  assert.equal(calls.filter(c => c.tool).length, 0);
});
test('discovery survives follow-up turns but a new conversation requires discovery', async () => {
  const { gate, calls } = fixture();
  await assert.rejects(gate.call({ tool: 'invented' }), /not discovered/);
  await gate.search({ query: 'navigate' });
  gate.beginTurn();
  assert.equal(gate.searches, 0);
  await gate.call({ tool: 'navigate_0' });
  gate.reset();
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /not discovered/);
  assert.equal(calls.filter(c => c.tool).length, 1);
});
test('an explicit identical retry reaches the server after recovery without automatic replay', async () => {
  const options = { fail: true };
  const { gate, calls } = fixture(options);
  await gate.search({ query: 'navigate' });
  await assert.rejects(gate.call({ tool: 'navigate_0', args: { url: 'x', a: 1 } }), /bridge unavailable/);
  assert.equal(calls.filter(c => c.tool).length, 1);
  options.fail = false;
  await gate.call({ tool: 'navigate_0', args: { a: 1, url: 'x' } });
  assert.equal(calls.filter(c => c.tool).length, 2);
  assert.equal(calls.filter(c => c.connect === 'playwright').length, 2);
});
test('unchanged successful status results can be polled repeatedly', async () => {
  const { gate, calls } = fixture();
  await gate.search({ query: 'status' });
  for (let i = 0; i < 4; i++) await gate.call({ tool: 'status_0' });
  assert.equal(calls.filter(c => c.tool).length, 4);
});

test('blocks a repeated successful read-only call with equivalent arguments in one user turn', async () => {
  const { gate, calls } = fixture();
  gate.beginTurn('Discover the network, then continue with topology and wireless analysis.');
  await gate.search({ query: 'navigate', server: 'playwright', limit: 1 });
  await gate.call({ tool: 'navigate_0', args: { url: 'https://example.com' } });
  await assert.rejects(
    gate.call({ tool: 'navigate_0', args: { url: 'https://example.com' } }),
    /No-progress MCP call blocked/,
  );
  assert.equal(calls.filter(c => c.tool).length, 1);
});

test('blocks all-optional empty-default replay after a successful explicit read-only call', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) return { details: { matches: [{ server: 'security', tool: 'security_perform_network_discovery' }], hasMore: false, nextOffset: null } };
    if (params.describe) return { details: { tool: { description: 'Read-only comprehensive network discovery.', inputSchema: {
      type: 'object', properties: { cidrs: { type: 'array', items: { type: 'string' } }, interface: { type: 'string' } }, required: [], additionalProperties: false,
    } } } };
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  });
  gate.beginTurn('Discover the network, then analyze topology.');
  await gate.search({ query: 'network discovery', server: 'security', limit: 1 });
  await gate.call({ tool: 'security_perform_network_discovery', args: { cidrs: ['192.168.1.0/24'], interface: 'wlp3s0' } });
  await assert.rejects(gate.call({ tool: 'security_perform_network_discovery' }), /No-progress MCP call blocked/);
  assert.equal(calls.filter(c => c.tool).length, 1);
});

test('explicit user request for a fresh successful rerun bypasses the no-progress guard', async () => {
  const { gate, calls } = fixture();
  gate.beginTurn('Read the same page again to refresh it.');
  await gate.search({ query: 'navigate', server: 'playwright', limit: 1 });
  const params = { tool: 'navigate_0', args: { url: 'https://example.com' } };
  await gate.call(params);
  await gate.call(params);
  assert.equal(calls.filter(c => c.tool).length, 2);
});
test('oversized schema is never truncated into a callable grant', async () => {
  const { gate } = fixture({ schemaSize: LIMITS.discoveryBytes + 10 });
  const result = await gate.search({ query: 'navigate' });
  assert.ok(Buffer.byteLength(result.content[0].text) <= LIMITS.discoveryBytes);
  assert.equal(JSON.parse(result.content[0].text).tools.length, 0);
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /not discovered/);
});
test('offline servers are errors and cannot grant stale cached schemas', async () => {
  const { gate } = fixture({ offline: 'playwright' });
  const result = JSON.parse((await gate.search({ query: 'navigate', server: 'playwright' })).content[0].text);
  assert.equal(result.tools.length, 0);
  assert.equal(result.errors[0].server, 'playwright');
});
test('per-turn budgets and argument types remain bounded with identical calls', async () => {
  const { gate, calls } = fixture();
  for (let i = 0; i < LIMITS.searches; i++) await gate.search({ query: 'nav' + i });
  await assert.rejects(gate.search({ query: 'more' }), /budget/);
  await assert.rejects(gate.call({ tool: 'nav5_0', args: [] }), /JSON object/);
  for (let i = 0; i < LIMITS.calls; i++) await gate.call({ tool: 'nav5_0', args: { url: `https://example.com/${i}` } });
  await assert.rejects(gate.call({ tool: 'nav5_0', args: { url: 'https://example.com/overflow' } }), /budget/);
  assert.equal(calls.filter(c => c.tool).length, LIMITS.calls);
  gate.beginTurn();
  await gate.call({ tool: 'nav5_0', args: { url: 'https://example.com/after-reset' } });
});
test('failed retries also consume the per-turn execution budget', async () => {
  const { gate, calls } = fixture({ fail: true });
  await gate.search({ query: 'navigate' });
  for (let i = 0; i < LIMITS.calls; i++) await assert.rejects(gate.call({ tool: 'navigate_0' }), /bridge unavailable/);
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /budget/);
  assert.equal(calls.filter(c => c.tool).length, LIMITS.calls);
});
test('session discovery uses a bounded LRU refreshed by successful calls', async () => {
  const { gate } = fixture();
  for (let i = 0; i < LIMITS.grants; i++) {
    gate.beginTurn();
    await gate.search({ query: 'nav' + i, limit: 1 });
  }
  await gate.call({ tool: 'nav0_0' });
  await gate.search({ query: 'new', limit: 1 });
  assert.equal(gate.grants.size, LIMITS.grants);
  assert.ok(gate.grants.has('nav0_0'));
  await assert.rejects(gate.call({ tool: 'nav1_0' }), /not discovered/);
});
test('restoring a conversation reconnects and keeps successful historical discovery only', async () => {
  const { gate, calls } = fixture();
  const found = await gate.search({ query: 'navigate', server: 'playwright', limit: 1 });
  const entry = (role, toolName, content, extra = {}) => ({ type: 'message', message: { role, toolName, content, ...extra } });
  const invented = [{ type: 'text', text: JSON.stringify({ tools: [{ tool: 'invented', server: 'playwright', inputSchema: {} }] }) }];
  gate.restore([
    entry('toolResult', 'mcp_search', found.content),
    entry('user', 'mcp_search', invented),
    entry('toolResult', 'mcp_call', invented),
    entry('toolResult', 'mcp_search', invented, { isError: true }),
    entry('toolResult', 'mcp_search', [{ type: 'text', text: '{broken' }]),
  ]);
  assert.equal(gate.connected.size, 0);
  await gate.call({ tool: 'navigate_0' });
  assert.equal(calls.filter(c => c.connect).length, 2);
  await assert.rejects(gate.call({ tool: 'invented' }), /not discovered/);
  gate.restore([]); // Switching to an empty branch/chat cannot inherit discovery.
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /not discovered/);
});
test('cached and historical discovery cannot execute a disabled or removed server', async () => {
  const { gate, calls } = fixture();
  const found = await gate.search({ query: 'navigate', server: 'playwright' });
  gate.config.mcpServers.playwright.disabled = true;
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /no longer enabled/);
  const branch = [{ type: 'message', message: { role: 'toolResult', toolName: 'mcp_search', ...found } }];
  gate.restore(branch);
  assert.equal(gate.grants.size, 0);
  delete gate.config.mcpServers.playwright;
  gate.restore(branch);
  assert.equal(gate.grants.size, 0);
  assert.equal(calls.filter(c => c.tool).length, 0);
});
test('cancelled calls preserve discovery for a later explicit retry', async () => {
  const { gate, calls } = fixture();
  await gate.search({ query: 'navigate' });
  await assert.rejects(gate.call({ tool: 'navigate_0' }, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  await gate.call({ tool: 'navigate_0' });
  assert.equal(calls.filter(c => c.tool).length, 1);
});
test('duplicate structuredContent wrapper does not double model output', () => {
  const value = '{"results":["headline"]}';
  const blocks = [{ type: 'text', text: value }, { type: 'text', text: 'structuredContent:\n' + JSON.stringify({ result: value }) }];
  assert.equal(dedupeContent(blocks).length, 1);
});
test('aborted and empty searches do not perform network calls', async () => {
  const { gate, calls } = fixture();
  await assert.rejects(gate.search({ query: '' }), /specific capability/);
  await assert.rejects(gate.search({ query: 'navigate' }, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  assert.equal(calls.length, 0);
});
test('gateway operations serialize and recover after an execution failure', async () => {
  const { gate } = fixture();
  const order = [];
  const first = gate.serial(async () => { order.push(1); await Promise.resolve(); order.push(2); throw new Error('failed'); });
  const second = gate.serial(async () => { order.push(3); });
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(order, [1, 2, 3]);
});

test('network workflow ledger does not count lower-level host discovery as comprehensive enumeration', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) {
      const tool = params.search.includes('host network') ? 'security_get_host_interface_info' : 'security_network_discover';
      return { details: { matches: [{ server: 'security', tool }], hasMore: false, nextOffset: null } };
    }
    if (params.describe) return { details: { tool: { description: params.describe, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true } } } };
    return { content: [{ type: 'text', text: JSON.stringify({ complete: true }) }], details: {} };
  });
  gate.beginTurn('Perform HOST NETWORK STATE, NETWORK DISCOVERY AND ENUMERATION, NETWORK TOPOLOGY, WIRELESS ENVIRONMENT and a GRAPHICAL NETWORK MAP.');
  await gate.search({ query: 'host network interface state', server: 'security', limit: 1 });
  await gate.call({ tool: 'security_get_host_interface_info', args: {} });
  await gate.search({ query: 'discover live hosts', server: 'security', limit: 1 });
  await gate.call({ tool: 'security_network_discover', args: {} });
  const status = gate.networkWorkflowStatus();
  assert.equal(status.find(x => x.tool === 'security_get_host_interface_info').status, 'completed');
  assert.equal(status.find(x => x.tool === 'security_perform_network_discovery').status, 'outstanding');
  assert.match(gate.nextNetworkWorkflowGuidance().instruction, /comprehensive network discovery/i);
});

test('dedicated exhausted network capability search is recorded as an explicit limitation', async () => {
  const config = { mcpServers: { security: {} } };
  const gate = new BoundedGate(config, async params => {
    if (params.connect) return { details: {} };
    if ('search' in params) return { details: { matches: [], hasMore: false, nextOffset: null } };
    return { details: {} };
  });
  gate.beginTurn('Perform a WIRELESS ENVIRONMENT assessment.');
  const result = JSON.parse((await gate.search({ query: 'passive wireless environment assessment', server: 'security' })).content[0].text);
  assert.equal(result.hasMore, false);
  const status = gate.networkWorkflowStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].status, 'unavailable');
  assert.match(status[0].limitation.reason, /No callable wireless environment assessment capability/i);
  assert.equal(gate.outstandingNetworkStages().length, 0);
});

test('network map waits for explicitly requested recon stages and injects exact prior results as direct data', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const descriptions = {
    security_get_host_interface_info: 'Host network state inventory.',
    security_perform_network_discovery: 'Read-only comprehensive network discovery.',
    security_analyze_network_topology: 'Analyze network topology.',
    security_analyze_wireless_environment: 'Passive wireless environment assessment.',
    security_generate_graphical_network_map: 'Generate graphical network map.',
  };
  const schemas = Object.fromEntries(Object.keys(descriptions).map(name => [name, {
    type: 'object', properties: {}, required: [], additionalProperties: true,
  }]));
  const byQuery = query => {
    const q = String(query).toLowerCase();
    if (q.includes('host')) return 'security_get_host_interface_info';
    if (q.includes('discovery')) return 'security_perform_network_discovery';
    if (q.includes('topology')) return 'security_analyze_network_topology';
    if (q.includes('wireless')) return 'security_analyze_wireless_environment';
    return 'security_generate_graphical_network_map';
  };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) {
      const tool = byQuery(params.search);
      return { details: { matches: [{ server: 'security', tool }], hasMore: false, nextOffset: null } };
    }
    if (params.describe) return { details: { tool: { description: descriptions[params.describe], inputSchema: schemas[params.describe] } } };
    const resultByTool = {
      security_get_host_interface_info: { selected_interface: 'wlp3s0', connection_type: 'wifi' },
      security_perform_network_discovery: { cidrs: ['192.168.1.0/24'], hosts: [{ address: '192.168.1.1' }] },
      security_analyze_network_topology: { local_subnets: ['192.168.1.0/24'] },
      security_analyze_wireless_environment: { interface: 'wlp3s0', current_connection: { ssid: 'test' } },
      security_generate_graphical_network_map: { outputs: { svg: '.security-results/network-map.svg' }, complete: true },
    };
    return { content: [{ type: 'text', text: JSON.stringify(resultByTool[params.tool]) }], details: {} };
  });

  gate.beginTurn('Collect HOST NETWORK STATE, NETWORK DISCOVERY, NETWORK TOPOLOGY, WIRELESS ENVIRONMENT and generate a GRAPHICAL NETWORK MAP.');
  for (const [query, tool] of [
    ['host network state', 'security_get_host_interface_info'],
    ['network discovery', 'security_perform_network_discovery'],
    ['network topology', 'security_analyze_network_topology'],
    ['wireless environment assessment', 'security_analyze_wireless_environment'],
    ['graphical network map', 'security_generate_graphical_network_map'],
  ]) {
    await gate.search({ query, server: 'security', limit: 1 });
    assert.ok(gate.grants.has(tool));
  }

  await gate.call({ tool: 'security_get_host_interface_info', args: {} });
  await gate.call({ tool: 'security_perform_network_discovery', args: {} });
  await gate.call({ tool: 'security_analyze_network_topology', args: {} });
  await assert.rejects(
    gate.call({ tool: 'security_generate_graphical_network_map', args: { input_path: 'network_data.json', format: 'both' } }),
    /wireless environment/i,
  );

  await gate.call({ tool: 'security_analyze_wireless_environment', args: {} });
  await gate.call({ tool: 'security_generate_graphical_network_map', args: { input_path: 'network_data.json', data: {}, format: 'both' } });
  const mapCall = calls.filter(c => c.tool === 'security_generate_graphical_network_map').at(-1);
  assert.equal(mapCall.args.input_path, undefined, 'native Pi workspace path must never be forwarded to mcp-security');
  assert.equal(mapCall.args.format, 'both');
  assert.equal(mapCall.args.data.get_host_interface_info.selected_interface, 'wlp3s0');
  assert.equal(mapCall.args.data.perform_network_discovery.hosts[0].address, '192.168.1.1');
  assert.deepEqual(mapCall.args.data.analyze_network_topology.local_subnets, ['192.168.1.0/24']);
  assert.equal(mapCall.args.data.analyze_wireless_environment.current_connection.ssid, 'test');
});

test('network map rejects a native Pi input_path when no direct recon data exists', async () => {
  const calls = [];
  const config = { mcpServers: { security: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return { details: {} };
    if ('search' in params) return { details: { matches: [{ server: 'security', tool: 'security_generate_graphical_network_map' }], hasMore: false, nextOffset: null } };
    if (params.describe) return { details: { tool: { description: 'Generate graphical network map.', inputSchema: { type: 'object', properties: { data: { type: 'object' }, input_path: { type: 'string' } }, required: [], additionalProperties: false } } } };
    return { content: [{ type: 'text', text: '{}' }], details: {} };
  });
  gate.beginTurn('Generate a graphical network map from my existing results.');
  await gate.search({ query: 'graphical network map', server: 'security', limit: 1 });
  await assert.rejects(
    gate.call({ tool: 'security_generate_graphical_network_map', args: { input_path: 'network_data.json' } }),
    /different workspaces/i,
  );
  assert.equal(calls.filter(c => c.tool).length, 0);
});
