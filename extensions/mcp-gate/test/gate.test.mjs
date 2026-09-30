import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, BoundedGate, gateConfig, dedupeContent, LIMITS } from '../gate.mjs';

function fixture(options = {}) {
  const calls = [];
  const config = { mcpServers: { playwright: {}, searxng: {} } };
  const gate = new BoundedGate(config, async params => {
    calls.push(params);
    if (params.connect) return options.offline === params.connect ? { details: { error: 'offline' }, content: [{ type: 'text', text: 'offline' }] } : { details: {} };
    if ('search' in params) return { details: { matches: Array.from({ length: 10 }, (_, i) => ({ server: params.server || 'playwright', tool: `${params.search}_${i}` })), hasMore: true, nextOffset: params.offset + params.limit } };
    if (params.describe) return { details: { tool: { description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'x'.repeat(options.schemaSize || 5) } }, required: ['url'] } } } };
    if (options.fail) return { details: { error: 'tool_error' }, content: [{ type: 'text', text: 'bridge unavailable' }] };
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  });
  return { gate, calls };
}

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
  assert.equal(calls.find(c => c.search).limit, 3);
  await gate.call({ tool: value.tools[0].tool, args: '{"url":"https://example.com"}' });
  assert.deepEqual(calls.at(-1), { server: 'playwright', tool: 'navigate_0', args: { url: 'https://example.com' } });
  await gate.search({ query: 'navigate', server: 'playwright' });
  assert.equal(calls.filter(c => c.connect).length, 1);
});
test('call before search and call after a new user turn fail before transport', async () => {
  const { gate, calls } = fixture();
  await assert.rejects(gate.call({ tool: 'invented' }), /not discovered/);
  await gate.search({ query: 'navigate' });
  gate.reset();
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /not discovered/);
  assert.equal(calls.filter(c => c.tool).length, 0);
});
test('failed identical call is blocked even after search and differently ordered JSON keys', async () => {
  const { gate, calls } = fixture({ fail: true });
  await gate.search({ query: 'navigate' });
  await assert.rejects(gate.call({ tool: 'navigate_0', args: { url: 'x', a: 1 } }), /bridge unavailable/);
  await gate.search({ query: 'navigate' });
  await assert.rejects(gate.call({ tool: 'navigate_0', args: { a: 1, url: 'x' } }), /already failed/);
  assert.equal(calls.filter(c => c.tool).length, 1);
});
test('unchanged successful results stop a no-progress loop on the third identical call', async () => {
  const { gate } = fixture();
  await gate.search({ query: 'navigate' });
  await gate.call({ tool: 'navigate_0' });
  await gate.call({ tool: 'navigate_0' });
  await assert.rejects(gate.call({ tool: 'navigate_0' }), /already failed/);
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
test('grant cache, per-turn budgets, and argument types are bounded', async () => {
  const { gate } = fixture();
  for (let i = 0; i < 6; i++) await gate.search({ query: 'nav' + i });
  assert.equal(gate.grants.size, 8);
  await assert.rejects(gate.search({ query: 'more' }), /budget/);
  await assert.rejects(gate.call({ tool: 'nav0_0' }), /not discovered/);
  await assert.rejects(gate.call({ tool: 'nav5_0', args: [] }), /JSON object/);
  gate.calls = 24;
  await assert.rejects(gate.call({ tool: 'nav5_0' }), /budget/);
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
