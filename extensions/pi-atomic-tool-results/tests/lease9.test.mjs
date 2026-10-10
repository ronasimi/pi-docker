import test from 'node:test';
import assert from 'node:assert/strict';
import { createStableTools, SCHEMA_ENTRY } from '../lib/tools.js';
import { loadConfig } from '../lib/config.js';

function fixture() {
  const tools = new Map();
  const entries = [];
  const active = ['tool_search','read','tool_invoke','result_get','result_list'];
  for (let i = 0; i < 11; i++) {
    const name = `mcp__fixture__operation_${i}`;
    tools.set(name, { name, description: `Exact operation ${name}`, parameters: {type:'object', properties:{query:{type:'string'}}}, exposure:'deferred' });
  }
  const api = {
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(next) { active.splice(0,active.length,...next); },
    appendEntry(customType, data) { entries.push({type:'custom',customType,data}); },
    on() {},
  };
  const manager = createStableTools(api, {enabled:true,stableTools:true,leaseCapacity:9,maxSchemas:1,maxTurnCalls:120});
  const ctx = {sessionManager:{getBranch:()=>entries},executeTool:async (name, args)=>({toolCall:{id:`nested:${name}`},result:{content:[{type:'text',text:'{"state":"ok"}'}]},isError:false})};
  manager.restore(ctx);
  const discover = (i) => {
    const name = `mcp__fixture__operation_${i}`;
    const response = manager.searchResult({toolName:'tool_search',toolCallId:`discovery-${i}`,input:{query:name},details:{loaded:[name]},isError:false},ctx);
    return JSON.parse(response.content[0].text);
  };
  const names = () => entries.findLast(e=>e.customType===SCHEMA_ENTRY)?.data.queue.map(x=>x.name) ?? [];
  return {api,ctx,manager,discover,names,entries,invoke:()=>tools.get('tool_invoke')};
}

test('nine independent tool grants occupy nine slots; the tenth evicts oldest', async () => {
  const f=fixture();
  for (let i=0;i<9;i++) assert.equal(f.discover(i).discovery,'ready');
  assert.equal(f.names().length,9);
  assert.deepEqual(f.discover(9).evicted,['mcp__fixture__operation_0']);
  assert.deepEqual(f.names(),Array.from({length:9},(_,i)=>`mcp__fixture__operation_${i+1}`));
  await assert.doesNotReject(f.invoke().execute('x',{name:'mcp__fixture__operation_0',arguments:{}},undefined,undefined,f.ctx));
});

test('successful tool_invoke promotes an old grant and persists it over session restore', async () => {
  const f=fixture();
  for (let i=0;i<9;i++) f.discover(i);
  const originalTools=JSON.stringify(f.api.getActiveTools());
  await f.invoke().execute('x',{name:'mcp__fixture__operation_0',arguments:{query:'check'}},undefined,undefined,f.ctx);
  assert.equal(f.names().at(-1),'mcp__fixture__operation_0');
  assert.equal(JSON.stringify(f.api.getActiveTools()),originalTools);
  assert(!JSON.stringify(f.entries.at(-1).data).includes('parameters'));
  assert.deepEqual(f.discover(9).evicted,['mcp__fixture__operation_1']);
  f.manager.restore(f.ctx);
  assert.equal(f.names().includes('mcp__fixture__operation_0'),true);
  await f.invoke().execute('again',{name:'mcp__fixture__operation_0',arguments:{}},undefined,undefined,f.ctx);
  await assert.doesNotReject(f.invoke().execute('x',{name:'mcp__fixture__operation_1',arguments:{}},undefined,undefined,f.ctx));
});

test('unsuccessful tool_invoke does not promote; direct results do not consume leases', async () => {
  const f=fixture();
  for(let i=0;i<9;i++) f.discover(i);
  const before=f.names();
  const failedCtx={...f.ctx,executeTool:async name=>({toolCall:{id:`bad:${name}`},result:{content:[{type:'text',text:'denied'}]},isError:true})};
  await f.invoke().execute('bad',{name:'mcp__fixture__operation_0',arguments:{}},undefined,undefined,failedCtx);
  assert.deepEqual(f.names(),before);
  assert.deepEqual(f.discover(9).evicted,['mcp__fixture__operation_0']);
});

test('environment default and maximum lease capacity are nine; schema limit remains one',()=>{
  const before=process.env.PI_ATOMIC_RESULTS_LEASE_CAPACITY;
  try {
    delete process.env.PI_ATOMIC_RESULTS_LEASE_CAPACITY;
    assert.equal(loadConfig().leaseCapacity,9);
    assert.equal(loadConfig().maxSchemas,1);
    process.env.PI_ATOMIC_RESULTS_LEASE_CAPACITY='99';
    assert.equal(loadConfig().leaseCapacity,9);
    process.env.PI_ATOMIC_RESULTS_LEASE_CAPACITY='5';
    assert.equal(loadConfig().leaseCapacity,5);
  } finally { if(before===undefined) delete process.env.PI_ATOMIC_RESULTS_LEASE_CAPACITY; else process.env.PI_ATOMIC_RESULTS_LEASE_CAPACITY=before; }
});
