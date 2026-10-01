import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, BoundedGate, gateConfig, dedupeContent, inferServerForQuery, LIMITS, rankDiscoveryMatches } from '../gate.mjs';

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
  assert.equal(calls.filter(c => c.connect).length, 1);
  assert.equal(calls.find(c => c.search).limit, LIMITS.serverCandidates);
  await gate.call({ tool: value.tools[0].tool, args: '{"url":"https://example.com"}' });
  assert.deepEqual(calls.at(-1), { server: 'playwright', tool: 'navigate_0', args: { url: 'https://example.com' } });
  await gate.search({ query: 'navigate', server: 'playwright' });
  assert.equal(calls.filter(c => c.connect).length, 1);
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
  await gate.search({ query: 'navigate' });
  for (let i = 0; i < 4; i++) await gate.call({ tool: 'navigate_0' });
  assert.equal(calls.filter(c => c.tool).length, 4);
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
  for (let i = 0; i < LIMITS.calls; i++) await gate.call({ tool: 'nav5_0' });
  await assert.rejects(gate.call({ tool: 'nav5_0' }), /budget/);
  assert.equal(calls.filter(c => c.tool).length, LIMITS.calls);
  gate.beginTurn();
  await gate.call({ tool: 'nav5_0' });
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
