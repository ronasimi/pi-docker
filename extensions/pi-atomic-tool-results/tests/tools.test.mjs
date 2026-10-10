import test from 'node:test';
import assert from 'node:assert/strict';
import atomicToolResults from '../index.js';
import { createStableTools, SCHEMA_ENTRY, textualCallTarget } from '../lib/tools.js';

function fixture() {
  const branch = [], handlers = new Map(), tools = new Map();
  let active = ['tool_search', 'read'];
  const api = {
    on(n, f) { handlers.set(n, f); },
    registerTool(t) { tools.set(t.name, t); if (['direct', 'model-only'].includes(t.exposure ?? 'direct')) active.push(t.name); },
    registerCommand() {},
    appendEntry(customType, data) { branch.push({ type: 'custom', customType, data }); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(n) { active = [...n]; },
  };
  for (const name of ['mcp__playwright__browser_navigate', 'mcp__playwright__browser_snapshot', 'mcp__memory__search_nodes', ...Array.from({ length: 11 }, (_, i) => `mcp__fixture__operation_${i}`)]) {
    tools.set(name, { name, description: `Exact operation ${name}`, parameters: { type: 'object', properties: { query: { type: 'string' } } }, exposure: 'deferred' });
  }
  const ctx = { sessionManager: { getBranch: () => branch } };
  atomicToolResults(api);
  function discover(names, id, isError = false) {
    active.push(...names);
    return handlers.get('tool_result')({ type: 'tool_result', toolName: 'tool_search', toolCallId: id, content: [{ type: 'text', text: 'Loaded tools' }], input: { query: names[0] ?? id }, details: { loaded: names }, isError }, ctx);
  }
  return { branch, handlers, tools, api, ctx, discover };
}
const execCtx = f => ({ ...f.ctx, executeTool: async (name, params) => ({ toolCall: { id: `call:${name}` }, result: { content: [{ type: 'text', text: JSON.stringify(params) }], details: {} }, isError: false }) });

// Invariants: nine grants, one new schema per discovery, no earlier tool result
// rewrites, unchanged provider declarations, FIFO persistence across branches.
test('nine-tool FIFO retains prior grants, evicts oldest and never activates deferred declarations', async () => {
  const f = fixture();
  f.handlers.get('session_start')({}, f.ctx);
  const invoke = f.tools.get('tool_invoke');
  const stable = JSON.stringify(f.api.getActiveTools());
  const names = Array.from({ length: 10 }, (_, i) => `mcp__fixture__operation_${i}`);
  const messages = [];
  let prefix = '';
  for (let i = 0; i < 9; i++) {
    const patch = f.discover([names[i]], `search-${i}`);
    assert.equal(patch.isError, false);
    const result = { role: 'toolResult', toolName: 'tool_search', toolCallId: `search-${i}`, ...patch };
    messages.push(result);
    assert.equal(JSON.parse(result.content[0].text).tools.length, 1);
    assert.equal(JSON.stringify(f.api.getActiveTools()), stable);
    const provider = f.handlers.get('context')({ messages }, f.ctx);
    assert.equal(provider, undefined, 'No schema projection should rewrite old discovery results');
    const serial = JSON.stringify(messages);
    assert(serial.startsWith(prefix.slice(0, -1)), 'Earlier results must remain an immutable prefix');
    prefix = serial;
  }
  assert.equal(f.branch.findLast(x => x.customType === SCHEMA_ENTRY).data.queue.length, 9);
  assert(!JSON.stringify(f.branch.at(-1).data).includes('parameters'), 'Durable FIFO stores hashes/names, not repeated full schemas');
  await invoke.execute('x', { name: names[0], arguments: { query: 'first' } }, undefined, undefined, execCtx(f));
  const tenth = f.discover([names[9]], 'search-9');
  assert.deepEqual(JSON.parse(tenth.content[0].text).evicted, [names[1]]);
  await assert.doesNotReject(invoke.execute('x', { name: names[1], arguments: {} }, undefined, undefined, execCtx(f)));
  await invoke.execute('x', { name: names[0], arguments: { query: 'promoted lease' } }, undefined, undefined, execCtx(f));
  assert.equal(f.branch.findLast(x => x.customType === SCHEMA_ENTRY).data.queue.length, 9);
});

test('rediscovery is bounded, refreshes FIFO recency and emits no duplicate schemas', async () => {
  const f = fixture();
  const names = Array.from({ length: 9 }, (_, i) => `mcp__fixture__operation_${i}`);
  names.forEach((n, i) => f.discover([n], `s${i}`));
  const hook = f.handlers.get('tool_call');
  assert.equal(hook({ toolName: 'tool_search', input: { query: 'too many' } }), undefined);
  await f.tools.get('tool_invoke').execute('x', { name: names[1], arguments: { query: 'new evidence' } }, undefined, undefined, execCtx(f));
  const same = f.discover([names[1]], 'repeated');
  const marker = JSON.parse(same.content[0].text);
  assert.equal(marker.discovery, 'reused');
  assert.deepEqual(marker.tools, []);
  assert.deepEqual(marker.reused, [names[1]]);
  const tenth = f.discover(['mcp__fixture__operation_9'], 's9');
  assert.deepEqual(JSON.parse(tenth.content[0].text).evicted, [names[0]]);
  assert(f.branch.findLast(x => x.customType === SCHEMA_ENTRY).data.queue.some(x => x.name === names[1]));
});

test('schema absent after compaction is re-emitted on demand without rewriting old provider messages', () => {
  const f = fixture(), name = 'mcp__memory__search_nodes';
  const original = f.discover([name], 'orig');
  const saved = { role: 'toolResult', toolName: 'tool_search', toolCallId: 'orig', ...original };
  // Original schema remains visible initially; repeated search returns a reference.
  f.handlers.get('context')({ messages: [saved] }, f.ctx);
  const reuse = f.discover([name], 'reuse');
  assert.equal(JSON.parse(reuse.content[0].text).discovery, 'reused');
  assert.equal(JSON.parse(reuse.content[0].text).tools.length, 0);
  // Pi compaction can drop earlier schema messages while retaining branch state.
  f.handlers.get('context')({ messages: [] }, f.ctx);
  const again = f.discover([name], 'again');
  assert.equal(JSON.parse(again.content[0].text).discovery, 'ready');
  assert.equal(JSON.parse(again.content[0].text).tools.length, 1);
  assert.equal(JSON.parse(saved.content[0].text).tools.length, 1, 'Original prefix must remain unchanged');
});

test('failed or empty discovery preserves existing FIFO and branch navigation restores current grants', async () => {
  const f = fixture(), invoke = f.tools.get('tool_invoke');
  f.discover(['mcp__memory__search_nodes'], 'good');
  const prior = [...f.branch];
  const empty = f.discover([], 'empty');
  assert.equal(JSON.parse(empty.content[0].text).discovery, 'empty');
  const failed = f.discover([], 'failed', true);
  assert.equal(JSON.parse(failed.content[0].text).discovery, 'failed');
  await invoke.execute('x', { name: 'mcp__memory__search_nodes', arguments: {} }, undefined, undefined, execCtx(f));
  f.branch.splice(0, f.branch.length, ...prior);
  f.handlers.get('session_tree')({}, f.ctx);
  await invoke.execute('x', { name: 'mcp__memory__search_nodes', arguments: {} }, undefined, undefined, execCtx(f));
  f.branch.splice(0);
  f.handlers.get('session_tree')({}, f.ctx);
  await assert.rejects(invoke.execute('x', { name: 'mcp__memory__search_nodes', arguments: {} }, undefined, undefined, execCtx(f)), /undiscovered|schema changed/);
});

test('invoker forwards concrete arguments and propagates nested errors', async () => {
  const f = fixture();
  f.discover(['mcp__memory__search_nodes'], 'memory');
  const invoke = f.tools.get('tool_invoke');
  let called;
  const signal = new AbortController().signal, update = () => {};
  const ctx = { ...f.ctx, executeTool: async (...args) => { called = args; return { toolCall: { id: 'outer/1' }, result: { content: [{ type: 'text', text: 'empty' }], details: {} }, isError: false }; } };
  await assert.rejects(invoke.execute('outer', { name: 'mcp__playwright__browser_snapshot', arguments: {} }, signal, update, ctx), /undiscovered|schema changed/);
  const args = { query: 'Pi Docker' };
  const result = await invoke.execute('outer', { name: 'mcp__memory__search_nodes', arguments: args }, signal, update, ctx);
  assert.deepEqual(called, ['mcp__memory__search_nodes', args, { signal, onUpdate: update }]);
  assert.equal(result.details.atomicInvocation.ref, 'result:outer/1');
  const nested = { type: 'tool_result', toolName: 'mcp__memory__search_nodes', toolCallId: 'outer/1', parentToolCallId: 'outer', input: { query: 10 }, content: [{ type: 'text', text: 'query must be a string' }], details: {}, isError: true };
  f.handlers.get('tool_result')(nested, f.ctx);
  const bad = await invoke.execute('outer', { name: nested.toolName, arguments: nested.input }, undefined, undefined, { ...f.ctx, executeTool: async () => ({ toolCall: { id: nested.toolCallId }, result: { content: nested.content, details: nested.details }, isError: true }) });
  const outer = f.handlers.get('tool_result')({ toolName: 'tool_invoke', toolCallId: 'outer', input: { name: nested.toolName, arguments: nested.input }, ...bad, isError: false }, f.ctx);
  assert.equal(outer.isError, true);
  assert.equal(outer.details.resultRef, 'result:outer/1');
});

test('native searches admit one schema regardless of FIFO size and preserve invalid limits for native validation', () => {
  const f = fixture(), hook = f.handlers.get('tool_call');
  for (const [limit, expected] of [[undefined, 1], [20, 1], [0, 0], [-1, -1], [1.5, 1.5]]) {
    f.handlers.get('before_agent_start')(); // independent provider request, not repeated batching
    const e = { toolName: 'tool_search', input: { query: 'snapshot', ...(limit === undefined ? {} : { limit }) } };
    hook(e);
    assert.equal(e.input.limit, expected);
  }
});

test('schema digest changes require rediscovery before tool invocation', async () => {
  const f = fixture(), name = 'mcp__memory__search_nodes';
  f.discover([name], 'first');
  f.tools.get(name).parameters = { type: 'object', properties: { term: { type: 'string' } } };
  await assert.rejects(f.tools.get('tool_invoke').execute('x', { name, arguments: {} }, undefined, undefined, execCtx(f)), /schema changed/);
  const patch = f.discover([name], 'second');
  assert.equal(JSON.parse(patch.content[0].text).tools.length, 1);
  await f.tools.get('tool_invoke').execute('x', { name, arguments: { term: 'updated' } }, undefined, undefined, execCtx(f));
});

test('serialization repair continues only once and never executes assistant text', () => {
  const f = fixture(); f.discover(['mcp__memory__search_nodes'], 'memory');
  const event = { outcome: 'completed', context: { canContinue: true, contextMessages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'call:mcp__memory__search_nodes{query:Pi Docker}<tool_call>' }] }] } };
  const hook = f.handlers.get('agent_before_settle');
  assert.equal(hook({ ...event, outcome: 'aborted' }), undefined);
  const repair = hook(event);
  assert.equal(repair.continue, true);
  assert.match(repair.entries[0].content, /nothing executed/);
  assert.equal(hook(event), undefined);
  assert.equal(textualCallTarget([{ type: 'text', text: 'Example: call:mcp__memory__search_nodes{}' }], ['mcp__memory__search_nodes']), undefined);
});

test('schema persistence failure fails closed and recovers ambiguous append', async () => {
  const f = fixture();
  f.api.appendEntry = () => { throw new Error('disk'); };
  const patch = f.discover(['mcp__memory__search_nodes'], 'fail');
  assert.equal(patch.isError, true);
  await assert.rejects(f.tools.get('tool_invoke').execute('x', { name: 'mcp__memory__search_nodes', arguments: {} }, undefined, undefined, f.ctx), /undiscovered|schema changed/);
  const g = fixture();
  g.api.appendEntry = (customType, data) => { g.branch.push({ type: 'custom', customType, data }); if (customType === SCHEMA_ENTRY) throw new Error('after append'); };
  const recovered = g.discover(['mcp__memory__search_nodes'], 'ok');
  assert.equal(recovered.isError, false);
});

test('v1 leases resume safely for a single tool without putting its schema into provider tools', async () => {
  const f = fixture();
  f.branch.push({ type: 'custom', customType: SCHEMA_ENTRY, data: { version: 1, callId: 'legacy', tools: [{ name: 'mcp__memory__search_nodes', description: 'legacy' }] } });
  f.handlers.get('session_tree')({}, f.ctx);
  await f.tools.get('tool_invoke').execute('x', { name: 'mcp__memory__search_nodes', arguments: {} }, undefined, undefined, execCtx(f));
});

test('disabled stable mode keeps the existing atomic-only behavior', () => {
  assert.equal(createStableTools({}, { enabled: true, stableTools: false }), undefined);
});

test('runtime permits bounded batched discovery, rejects mismatched catalog tools, and permits search → invoke', async () => {
  const f = fixture();
  f.tools.set('mcp__system__list_mcp_resources', {name:'mcp__system__list_mcp_resources', exposure:'deferred', description:'List MCP server resource templates', parameters:{type:'object',properties:{}}});
  const hook = f.handlers.get('tool_call');
  const query = 'system docker list containers';
  assert.equal(hook({ toolName:'tool_search', input:{query} }), undefined);
  assert.equal(hook({ toolName:'tool_search', input:{query:'system host memory info'} }), undefined);
  const mismatch = f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:'s1',input:{query:'system docker list containers'},details:{loaded:['mcp__system__list_mcp_resources']},content:[],isError:false},f.ctx);
  assert.equal(JSON.parse(mismatch.content[0].text).discovery,'irrelevant');
  assert.equal(hook({toolName:'tool_search', input:{query:'mcp__fixture__operation_0'}}),undefined);
  const found = f.discover(['mcp__fixture__operation_0'],'s2');
  assert.equal(JSON.parse(found.content[0].text).discovery,'ready');
  assert.equal(hook({toolName:'tool_search',input:{query:'memory search nodes'}}), undefined, 'A more specific query can reject a bad match');
  f.handlers.get('tool_result')({toolName:'tool_search', toolCallId:'s3', input:{query:'memory search nodes'}, details:{loaded:['mcp__memory__search_nodes']}, content:[],isError:false},f.ctx);
  assert.equal(hook({toolName:'tool_invoke',input:{name:'mcp__memory__search_nodes',arguments:{value:'ok'}}}),undefined);
  await f.tools.get('tool_invoke').execute('x',{name:'mcp__memory__search_nodes',arguments:{value:'ok'}},undefined,undefined,execCtx(f));
  assert.equal(hook({toolName:'tool_search',input:{query:'memory search nodes'}}),undefined);
  assert.equal(f.api.getActiveTools().some(n=>n.startsWith('mcp__')),false);
});

// local custom test note

test('direct result tools stay active and outside nine-slot FIFO, including stale Web UI settings', async () => {
  const f = fixture(), invoke = f.tools.get('tool_invoke');
  f.api.setActiveTools(['read', 'tool_search', 'tool_invoke']);
  f.handlers.get('before_agent_start')();
  assert(f.api.getActiveTools().includes('result_get'));
  assert(f.api.getActiveTools().includes('result_list'));
  const names = Array.from({ length: 10 }, (_, i) => `mcp__fixture__operation_${i}`);
  names.forEach((name, i) => f.discover([name], `direct-test-${i}`));
  const fifo = f.branch.findLast(x => x.customType === SCHEMA_ENTRY).data.queue.map(x => x.name);
  assert.equal(fifo.length, 9);
  assert(!fifo.includes('result_get'));
  assert(!fifo.includes('result_list'));
  const calls = [];
  const ctx = { ...f.ctx, executeTool: async (name, args) => {
    calls.push({ name, args });
    return { toolCall: { id: `nested-${name}` }, result: { content: [{ type: 'text', text: '{"status":"ok"}' }], details: {} }, isError: false };
  } };
  for (const [name, args] of [['result_get', { result_ref: 'result:abc', selector: 'content' }], ['result_list', { limit: 3 }]]) {
    const result = await invoke.execute(`call-${name}`, { name, arguments: args }, undefined, undefined, ctx);
    assert.equal(result.details.atomicInvocation.tool, name);
    assert.equal(result.details.atomicInvocation.internal, true);
  }
  assert.deepEqual(calls.map(x => x.name), ['result_get', 'result_list']);
  assert.equal(f.branch.findLast(x => x.customType === SCHEMA_ENTRY).data.queue.length, 9);
  // A genuine evicted MCP tool must STILL fail rather than bypass authorization.
  await assert.doesNotReject(invoke.execute('bad', { name: names[0], arguments: {} }, undefined, undefined, ctx));
});

test('searching for direct results is rejected, and native accidental discovery cannot lease them', () => {
  const f = fixture();
  const guard = f.handlers.get('tool_call');
  for (const query of ['result get', 'result_get', 'result list', 'list results']) {
    const block = guard({ toolName: 'tool_search', input: { query, limit: 1 } });
    assert.equal(block?.block, true, query);
    assert.match(block.reason, /permanent direct tools/);
  }
  const pre = f.branch.length;
  const patch = f.discover(['result_list'], 'native-stale-search');
  const marker = JSON.parse(patch.content[0].text);
  assert.equal(marker.discovery, 'direct');
  assert.deepEqual(marker.direct, ['result_list']);
  assert.deepEqual(marker.buffered, []);
  assert.equal(f.branch.slice(pre).filter(entry => entry.customType === SCHEMA_ENTRY).length, 0, 'Direct tools must never receive a persisted FIFO lease');
  assert(f.api.getActiveTools().includes('result_list'));
});

test('wrapped result_get gets the same one-request ephemeral hydration lease as direct result_get', async () => {
  const f = fixture(), invoke = f.tools.get('tool_invoke');
  const ctx = { ...f.ctx, executeTool: async () => ({
    toolCall: { id: 'nested-get' },
    result: { content: [{ type: 'text', text: '{"status":"ok","value":"secret evidence"}' }], details: {} },
    isError: false,
  }) };
  const result = await invoke.execute('wrapped-get', { name: 'result_get', arguments: { result_ref: 'result:abc' } }, undefined, undefined, ctx);
  const patch = f.handlers.get('tool_result')({ type: 'tool_result', toolName: 'tool_invoke', toolCallId: 'wrapped-get', input: { name: 'result_get', arguments: { result_ref: 'result:abc' } }, ...result, isError: false }, f.ctx);
  assert.equal(patch.details.atomicDurable, true);
  assert.equal(JSON.parse(patch.content[0].text).status, 'ok');
  assert(JSON.stringify(patch.content).includes('secret evidence'));
});


test('better exact-action registered tool wins over irrelevant native fuzzy match', async () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  for(const [name,desc] of [
    ['mcp__system__docker_container_stats','Docker CPU and memory stats'],
    ['mcp__system__docker_list_containers','List Docker containers']])
    f.tools.set(name,{name,description:desc,exposure:'deferred',parameters:{type:'object',properties:{}}});
  const query='system docker list containers';
  assert.equal(hook({toolName:'tool_search',toolCallId:'fuzzy',input:{query}}),undefined);
  const patch=f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:'fuzzy',input:{query},details:{loaded:['mcp__system__docker_container_stats']},content:[],isError:false},f.ctx);
  const marker=JSON.parse(patch.content[0].text);
  assert.equal(marker.discovery,'ready');
  assert.equal(marker.tools[0].name,'mcp__system__docker_list_containers');
  assert.deepEqual(patch.details.loaded,['mcp__system__docker_list_containers']);
  assert.equal(f.api.getActiveTools().some(n=>n.startsWith('mcp__')),false);
});

test('unsuitable discovery can be rejected without invocation but not looped indefinitely', () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  const first='system docker container stats';
  assert.equal(hook({toolName:'tool_search',toolCallId:'s1',input:{query:first}}),undefined);
  assert.equal(hook({toolName:'tool_search',input:{query:'system docker list containers'}}),undefined);
  const p=f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:'s1',input:{query:first},details:{loaded:['mcp__fixture__operation_0']},content:[],isError:false},f.ctx);
  // An irrelevant match is automatically rejected; next search is allowed.
  assert.equal(JSON.parse(p.content[0].text).discovery,'irrelevant');
  assert.equal(hook({toolName:'tool_search',toolCallId:'s2',input:{query:'system docker list containers'}}),undefined);
});

test('passive-only default blocks ARP sweeps even if a model has a tool lease', async () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  const name='mcp__security__probe_gateway_proxy_arp';
  f.tools.set(name,{name,description:'Active proxy ARP sweep of subnet',exposure:'deferred',parameters:{type:'object',properties:{}}});
  f.discover([name],'probe-lease');
  const args={subnet:'192.168.1.0/24'};
  assert.match(hook({toolName:'tool_invoke',input:{name,arguments:args}}).reason,/Active network probing/);
  await assert.rejects(f.tools.get('tool_invoke').execute('bad',{name,arguments:args},undefined,undefined,execCtx(f)),/Active network probing/);
  assert.match(hook({toolName:'bash',input:{command:'nmap -sS 192.168.1.0/24'}}).reason,/Active network probing/);
  assert.match(hook({toolName:'bash',input:{command:'ip route show'}}).reason,/Pi bash is container-local/);
});

test('permanent result tool descriptions appear in fixed loadout', () => {
  const f=fixture(), info=f.tools.get('tool_invoke').prepareLoadout();
  assert.match(info.descriptions.result_get,/Permanent direct archive read/);
  assert.match(info.descriptions.result_list,/Permanent direct listing/);
  assert.match(info.descriptions.tool_search,/refine/i);
  assert.match(info.descriptions.bash,/container-local/);
  assert.match(info.descriptions.tool_invoke,/schema-cache eviction does not revoke discovery grants/);
});

test('older FIFO grant remains invokable after newer discovery pending', async () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  const old='mcp__fixture__operation_0', recent='mcp__fixture__operation_1';
  f.discover([old],'old'); f.discover([recent],'recent');
  assert.equal(hook({toolName:'tool_invoke',input:{name:old,arguments:{query:'needed'}}}),undefined);
  const result=await f.tools.get('tool_invoke').execute('call-old',{name:old,arguments:{query:'needed'}},undefined,undefined,execCtx(f));
  assert.equal(result.details.atomicInvocation.tool,old);
  assert.equal(f.branch.findLast(x=>x.customType===SCHEMA_ENTRY).data.queue.length,2);
  assert.equal(hook({toolName:'tool_search',input:{query:'system docker list containers'}}),undefined,'Invoking prior lease clears latest-only obligation');
});

test('parallel discovery gives each distinct query its own independently verified match', () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  f.tools.set('mcp__system__openwrt_package_query',{name:'mcp__system__openwrt_package_query',description:'Query installed packages',exposure:'deferred',parameters:{type:'object',properties:{}}});
  f.tools.set('mcp__system__docker_list_containers',{name:'mcp__system__docker_list_containers',description:'List Docker containers',exposure:'deferred',parameters:{type:'object',properties:{}}});
  assert.equal(hook({toolName:'tool_search',toolCallId:'batch',input:{query:'system openwrt router query'}}),undefined);
  assert.equal(hook({toolName:'tool_search',toolCallId:'batch2',input:{query:'system docker list containers'}}),undefined);
  const first=f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:'batch',input:{query:'system openwrt router query'},details:{loaded:['mcp__system__openwrt_package_query']},content:[],isError:false},f.ctx);
  const marker1=JSON.parse(first.content[0].text);
  assert.equal((marker1.tools ?? []).length,0);
  const second=f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:'batch2',input:{query:'system docker list containers'},details:{loaded:['mcp__system__docker_list_containers']},content:[],isError:false},f.ctx);
  const marker2=JSON.parse(second.content[0].text);
  assert.equal(marker2.tools.length,1);
  assert.equal(marker2.tools[0].name,'mcp__system__docker_list_containers');
  assert.equal(f.api.getActiveTools().some(n=>n.startsWith('mcp__')),false);
});

test('host inventory commands route to MCP; workspace shell and harmless scanner checks are allowed', () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  for (const command of ['docker ps','ip addr show','uname -a','cat /proc/meminfo','ollama ls'])
    assert.match(hook({toolName:'bash',input:{command}}).reason,/Pi bash is container-local/,command);
  for (const command of ['pwd','ls -la /workspace','cat ./README.md','which netstat ss nmap','command -v nmap'])
    assert.equal(hook({toolName:'bash',input:{command}}),undefined,command);
  assert.match(hook({toolName:'bash',input:{command:'which nmap; nmap -sS 192.168.1.2'}}).reason,/Active network probing/);
});

test('r18 refusal ceiling requests turn abort once and persists evidence-only checkpoint', () => {
  const f=fixture(), calls=[], ctx={...f.ctx, abort:()=>{calls.push('abort');}, ui:{notify:(s)=>calls.push(s)}};
  f.handlers.get('before_agent_start')({prompt:'Please conduct a passive-only network assessment'});
  const event={toolName:'tool_search',input:{query:'mcp service health'}};
  const hook=f.handlers.get('tool_call');
  // An empty/failed catalog is not a reason to keep retrying a denied operation.
  let last;
  for(let i=0;i<4;i++) {
    const gate = i===0 ? hook(event,ctx) : hook(event,ctx);
    // First call is accepted by progress and pending. Simulate tool result.
    if(i===0) f.handlers.get('tool_result')({toolName:'tool_search',toolCallId:'test-r18',input:event.input,content:[{type:'text',text:'none'}],details:{loaded:[]},isError:false},f.ctx);
    last=gate;
  }
  // Further blocked calls must force a stop with a durable summary.
  for(let i=0;i<125;i++) last=hook(event,ctx);
  assert.equal(calls.filter(x=>x==='abort').length,0);
  assert.equal(last?.block,true);
  assert(f.branch.some(x=>x.customType==='pi.atomic-hard-stop'));
});

test('r18 requires operator flag AND explicit current-turn permission for active network discovery', () => {
  const f=fixture(), hook=f.handlers.get('tool_call');
  f.tools.set('mcp__security__perform_network_discovery',{name:'mcp__security__perform_network_discovery',description:'Scan network hosts',parameters:{type:'object',properties:{}},exposure:'deferred'});
  const event={toolName:'tool_invoke',input:{name:'mcp__security__perform_network_discovery',arguments:{}}};
  f.handlers.get('before_agent_start')({prompt:'Do passive-only network assessment'});
  assert.match(hook(event,f.ctx).reason,/Active network probing/);
});
