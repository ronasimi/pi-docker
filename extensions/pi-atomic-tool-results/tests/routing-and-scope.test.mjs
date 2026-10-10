import test from 'node:test';
import assert from 'node:assert/strict';
import atomicToolResults from '../index.js';
import { CapabilityTracker, capabilityForQuery } from '../lib/capabilities.js';
import { EvidenceLedger } from '../lib/evidence.js';
import { createOllamaInventoryTool } from '../lib/ollama.js';
import { relevantDiscovery, containerHostCommandRisk } from '../lib/progress.js';
const ok = data=>({content:[{type:'text',text:JSON.stringify(data)}]});

test('synonym-swapped Ollama discovery exhausts one shared per-capability budget',()=>{
 const t=new CapabilityTracker({maxMisses:3});
 assert.equal(capabilityForQuery('ollama list models'),'ollama_inventory');
 for(const query of ['ollama list models','ollama inventory available models','installed ollama models']) t.discovered(query,null);
 assert.equal(t.unavailable('ollama model list').state,'unavailable');
 assert.equal(t.unavailable('host cpu'),null);
 t.discovered('host cpu','mcp__system__host_snapshot');
 assert.equal(t.state('host_inventory').state,'ready');
 t.executed('mcp__system__host_snapshot',true);
 assert.equal(t.state('host_inventory').state,'executed');
 t.reset(); assert.equal(t.unavailable('ollama model list'),null);
});

test('failed Ollama operations exhaust a capability; unrelated host discovery remains available',()=>{
 const t=new CapabilityTracker({maxMisses:2});
 t.discovered('ollama list models','ollama_api_inventory');
 t.failedExecution('ollama_api_inventory'); t.failedExecution('ollama_api_inventory');
 assert.equal(t.unavailable('ollama models'),null);
 assert.equal(Object.values(t.summary()).filter(x=>x.state==='unavailable').length,1);
 assert.equal(t.unavailable('system kernel'),null);
});

test('cross-namespace network interfaces and Ollama direct API tool win over wrong catalog resources',()=>{
 assert.equal(relevantDiscovery('system network interfaces',{name:'mcp__security__network_interfaces',description:'List physical interface IPv4 and routes'}).ok,true);
 const tool=createOllamaInventoryTool({baseUrl:'http://ollama:11434',fetchImpl: async()=>{throw Error('offline')}});
 assert.equal(relevantDiscovery('ollama list models',tool).ok,true);
 assert.equal(relevantDiscovery('ollama models',{name:'mcp__system__list_mcp_resources',description:'Ollama resources'}).ok,false);
});

test('read-only Ollama inventory makes GET-only requests and models come from Ollama API',async()=>{
 const urls=[]; const replies = {
  '/api/tags':{models:[{name:'gemma4:e4b',size:123,digest:'abc'}]},
  '/api/version':{version:'0.9'},
  '/api/ps':{models:[{name:'qwen3.5:4b',size:42}]},
 };
 const fetchImpl=async(url,opts)=>{urls.push([url,opts.method]);return {ok:true,text:async()=>JSON.stringify(replies[new URL(url).pathname])};};
 const t=createOllamaInventoryTool({baseUrl:'http://ollama:11434',fetchImpl});
 const result=await t.execute('id',{});
 assert.equal(result.isError,undefined);
 const data=JSON.parse(result.content[0].text);
 assert.deepEqual(data.installed_models.map(x=>x.name),['gemma4:e4b']);
 assert.deepEqual(data.running_models.map(x=>x.name),['qwen3.5:4b']);
 assert.deepEqual(urls.map(x=>x[1]),['GET','GET','GET']);
 assert.equal(t.exposure,'deferred');
});

test('invalid API endpoint reports unavailable without crashing the Pi extension',async()=>{
 const t=createOllamaInventoryTool({baseUrl:'file:///etc/passwd'});
 const result=await t.execute('id',{});
 assert.equal(result.isError,true);
 assert.match(result.content[0].text,/unavailable/);
});

test('evidence report counts successful actual invocations, unique operations and 8-task coverage',()=>{
 const e=new EvidenceLedger();
 e.setScope('TASK 1 — HOST AND CONTAINER INVENTORY\nTASK 2 — OPENWRT ROUTER DISCOVERY\nTASK 3 — NETWORK AND mDNS DISCOVERY\nTASK 4 — NETWORK ISOLATION ASSESSMENT\nTASK 5 — MCP INFRASTRUCTURE HEALTH\nTASK 6 — INDEPENDENT WEB VERIFICATION\nTASK 7 — CROSS-TOOL REASONING\nTASK 8 — EVIDENCE AND CONTEXT RETENTION');
 assert.equal(e.record('result_get',{},ok({status:'ok'}),'get'),false);
 assert.equal(e.record('tool_search',{},ok({status:'ok'}),'search'),false);
 assert.equal(e.record('mcp__system__docker_list_containers',{},ok({status:'ok',containers:['ollama']}),'a'),true);
 assert.equal(e.record('mcp__system__docker_list_containers',{},ok({status:'ok'}),'a'),false);
 assert.equal(e.record('mcp__system__host_snapshot',{},ok({status:'ok',kernel:'linux'}),'b'),true);
 assert.equal(e.record('mcp__system__openwrt_router_status',{router:'anansi'},ok({status:'ok'}),'c'),true);
 assert.equal(e.record('ollama_api_inventory',{},ok({status:'ok',source:'ollama_api',installed_models:[]}), 'd'),true);
 const stats=e.summary(); assert.equal(stats.successfulToolCalls,4);
 assert.equal(stats.distinctOperations,4);
 assert.equal(stats.taskCoverage.length,8);
 assert.equal(stats.taskCoverage[0].status,'PARTIAL');
 assert.equal(stats.taskCoverage[1].status,'NOT TESTED');
 const report=e.report({capabilities:{mcp_health:{state:'unavailable',misses:3}}});
 assert.match(report,/4 \(not counting tool_search/);
 assert.match(report,/mcp_health: 3 unsuccessful attempts/);
 assert.match(report,/NOT TESTED/);
 assert.doesNotMatch(report,/4\/8 tasks completed/);
});

test('skill Markdown and imaginary network-recon CLI cannot be executed as bash',()=>{
 assert.match(containerHostCommandRisk('bash',{command:'bash /workspace/skills/network-recon/SKILL.md'}),/Skill Markdown/);
 assert.match(containerHostCommandRisk('bash',{command:'network-recon start'}),/Skill Markdown/);
 assert.equal(containerHostCommandRisk('bash',{command:'grep -n tools /workspace/skills/network-recon/SKILL.md'}),null);
});

test('r19 extension registers Ollama inventory and deterministic report without altering fixed active tools',()=>{
 const handlers=new Map(), registry=new Map(), commands=new Map(); let active=['read','bash','tool_search'];
 const api={on:(n,f)=>handlers.set(n,f),registerTool:t=>{registry.set(t.name,t);if(['direct','model-only'].includes(t.exposure))active.push(t.name);},registerCommand:(n,v)=>commands.set(n,v),getAllTools:()=>[...registry.values()],getActiveTools:()=>active,setActiveTools:x=>{active=x},appendEntry:()=>{}};
 atomicToolResults(api);
 assert.equal(registry.get('ollama_api_inventory').exposure,'deferred');
 assert.equal(active.includes('ollama_api_inventory'),false);
 assert.equal(commands.has('atomic-report'),true);
});

test('r19 integrated discovery emits unavailable state then advances to independent capability',()=>{
 const handlers=new Map(),registry=new Map(),commands=new Map(),entries=[];let active=['read','bash','tool_search'];
 const tool=(name,description)=>({name,description,exposure:'deferred',parameters:{type:'object',properties:{}}});
 registry.set('mcp__system__host_snapshot',tool('mcp__system__host_snapshot','Host kernel memory CPU system status'));
 const api={on:(n,f)=>handlers.set(n,f),registerTool:t=>{registry.set(t.name,t);if(['direct','model-only'].includes(t.exposure))active.push(t.name);},registerCommand:(n,v)=>commands.set(n,v),getAllTools:()=>[...registry.values()],getActiveTools:()=>active,setActiveTools:x=>{active=x},appendEntry:(n,d)=>entries.push({type:'custom',customType:n,data:d})};
 atomicToolResults(api);
 const ctx={sessionManager:{getBranch:()=>entries},ui:{notify:()=>{}}};
 handlers.get('before_agent_start')({prompt:'Read-only infrastructure assessment'});
 for(let i=0;i<3;i++){
   const query=['openwrt router status','anansi router inventory','arachne router state'][i];
   const id='h'+i;
   assert.equal(handlers.get('tool_call')({toolName:'tool_search',toolCallId:id,input:{query,limit:1}},ctx),undefined);
   const out=handlers.get('tool_result')({toolName:'tool_search',toolCallId:id,input:{query},isError:false,details:{loaded:[]},content:[]},ctx);
   const marker=JSON.parse(out.content[0].text);
   if(i===2) assert.equal(marker.discovery,'unavailable');
 }
 const blocked=handlers.get('tool_call')({toolName:'tool_search',toolCallId:'h4',input:{query:'router status'}},ctx);
 assert.equal(blocked.block,true);assert.match(blocked.reason,/unavailable/i);
 const next=handlers.get('tool_call')({toolName:'tool_search',toolCallId:'host',input:{query:'system host snapshot'}},ctx);
 assert.equal(next,undefined,'Independent host inspection must not be globally blocked');
 const found=handlers.get('tool_result')({toolName:'tool_search',toolCallId:'host',input:{query:'system host snapshot'},isError:false,details:{loaded:[]},content:[]},ctx);
 assert.equal(JSON.parse(found.content[0].text).discovery,'ready');
});
