import test from 'node:test';
import assert from 'node:assert/strict';
import atomicToolResults from '../index.js';
import {activeNetworkRisk, relevantDiscovery, parseDiscoveryQuery} from '../lib/progress.js';
import {CapabilityTracker} from '../lib/capabilities.js';
import {EvidenceLedger} from '../lib/evidence.js';
import {createMcpEndpointHealthTool} from '../lib/mcp-health.js';

const evidence = body => ({content:[{type:'text',text:typeof body==='string'?body:JSON.stringify(body)}],isError:false});
function fixture(){
 const handlers=new Map(), registered=new Map(), branch=[],commands=new Map();let active=['tool_search','bash'];
 const pi={on:(name,fn)=>handlers.set(name,fn),registerTool:t=>{registered.set(t.name,t);if(['direct','model-only'].includes(t.exposure))active.push(t.name);},registerCommand:(n,d)=>commands.set(n,d),getAllTools:()=>[...registered.values()],getActiveTools:()=>[...active],setActiveTools:v=>{active=[...v]},appendEntry:(name,data)=>branch.push({type:'custom',customType:name,data})};
 pi.registerTool=pi.registerTool.bind(pi);atomicToolResults(pi);
 const ctx={sessionManager:{getBranch:()=>branch},ui:{notify:()=>{}}};
 const search=(q,id)=>{
  const event={toolName:'tool_search',toolCallId:id,input:{query:q,limit:1}};
  const blocked=handlers.get('tool_call')(event,ctx);
  return {blocked,event, finish:()=>handlers.get('tool_result')({...event,isError:false,details:{loaded:[]},content:[]},ctx)};
 };
 return {handlers,registered,branch,ctx,search,commands};
}

test('authorization denies the actual ARP, UPnP and DNS-SD followup operations',()=>{
 for(const n of ['mcp__security__arp_discover','mcp__security__upnp_discover','mcp__security__perform_network_discovery','mcp__security__ssdp_search','mcp__security__mdns_discover'])
   assert.match(activeNetworkRisk(n,{}),/Active network/,n);
 assert.equal(activeNetworkRisk('mcp__security__mdns_passive_capture',{duration:8}),null);
 assert.equal(activeNetworkRisk('mcp__security__network_interfaces',{}),null);
 assert.match(activeNetworkRisk('mcp__system__execute_shell',{command:'which nmap; nmap -sS 192.168.1.1'}),/Active network/);
});

test('user consent cannot enable active probes without operator opt-in; passive-only overrides both',()=>{
 const f=fixture(); f.registered.set('mcp__security__arp_discover',{name:'mcp__security__arp_discover',exposure:'deferred',description:'ARP sweep',parameters:{type:'object'}});
 f.handlers.get('before_agent_start')({prompt:'I explicitly authorize active ARP scanning'});
 assert.match(f.handlers.get('tool_call')({toolName:'tool_invoke',input:{name:'mcp__security__arp_discover',arguments:{target:'192.168.20.0/24'}}},f.ctx).reason,/Active network/);
 // Nested calls must also be blocked, independent of the outer wrapper.
 assert.match(f.handlers.get('tool_call')({toolName:'mcp__security__arp_discover',parentToolCallId:'outer',input:{target:'192.168.20.0/24'}},f.ctx).reason,/Active network/);
});

test('capability unavailable state is monotonic across blocked attempts and late discoveries',()=>{
 const c=new CapabilityTracker({maxMisses:3});
 for(let i=0;i<3;i++)c.discovered('openwrt router status',null);
 assert.deepEqual([c.state('routers').state,c.state('routers').misses],['unavailable',3]);
 for(let i=0;i<10;i++)c.discovered('router state',i%2===0?'mcp__system__openwrt_router_status':null);
 c.executed('mcp__system__openwrt_router_status',true);
 assert.deepEqual([c.state('routers').state,c.state('routers').misses],['unavailable',3]);
});

test('MCP endpoint health matches only true health operations and plain system namespace is a hint',()=>{
 const tool=name=>({name,description:name});
 assert.equal(relevantDiscovery('mcp service health',tool('mcp__security__mdns_observe')).ok,false);
 assert.equal(relevantDiscovery('mcp service health',tool('mcp_endpoint_health')).ok,true);
 assert.equal(parseDiscoveryQuery('system network interfaces').explicitServer,null);
 assert.equal(relevantDiscovery('system network interfaces',tool('mcp__security__network_interfaces')).ok,true);
 assert.equal(relevantDiscovery('mcp__system__network_interfaces',tool('mcp__security__network_interfaces')).ok,false);
});

test('five distinct parallel searches accepted without rejected-batch errors; each yields at most one schema',()=>{
 const f=fixture();
 for(let i=0;i<5;i++) f.registered.set(`mcp__fixture__operation_${i}`,{name:`mcp__fixture__operation_${i}`,description:`operation ${i}`,exposure:'deferred',parameters:{type:'object',properties:{}}});
 f.handlers.get('before_agent_start')({prompt:'Audit five independent system operations'});
 const searches=Array.from({length:5},(_,i)=>f.search(`mcp__fixture__operation_${i}`,`r20-${i}`));
 assert(searches.every(s=>s.blocked===undefined));
 for(let i=0;i<5;i++){
  const marker=JSON.parse(searches[i].finish().content[0].text);
  assert.equal(marker.tools.length<=1,true);
 }
 assert.equal(f.branch.findLast(x=>x.customType==='pi.atomic-tool-schema').data.queue.length,5);
});

test('ledger distinguishes security-container network interfaces from host and prevents search-result docs verification',()=>{
 const e=new EvidenceLedger();e.setScope('Perform TASK 1 - host review; TASK 6 - verify official OpenWrt documentation');
 e.record('mcp__security__network_interfaces',{},evidence({scope:'security-container',routes:'default via 172.19.0.1 dev eth0'}),'r1');
 assert.equal(e.has('host'),false);
 assert.equal(e.summary().operations[0].scope,'container');
 e.record('mcp__searxng__web_search',{query:'OpenWrt docs'},evidence('https://www.youtube.com/watch?v=abc'),'r2');
 assert.equal(e.has('official_source'),false);
 e.record('mcp__playwright__browser_navigate',{url:'https://openwrt.org/docs/start'},evidence('page loaded'),'r3');
 assert.equal(e.has('official_source'),false);
 e.record('mcp__playwright__browser_snapshot',{},evidence('https://openwrt.org/docs/start This is a documented configuration guide with details about the network devices and routing configuration over multiple sections.'),'r4');
 assert.equal(e.has('official_source'),true);
 assert.match(e.report(),/Coverage:/);
});

test('MCP health only verifies protocol handshakes, not HTTP presence',async()=>{
 const readConfig=()=>JSON.stringify({mcpServers:{system:{url:'http://mcp-system:8933/mcp',enabled:true},security:{url:'http://mcp-security:8935/mcp',enabled:true}}});
 const fetchImpl=async(url,opts)=>{
  assert.equal(opts.method,'POST');assert.equal(JSON.parse(opts.body).method,'initialize');
  const reply = url.includes('8933') ? {jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}} : {state:'ready'};
  return {ok:true,status:200,body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify(reply)));c.close()}})};
 };
 const tool=createMcpEndpointHealthTool({readConfig,fetchImpl});
 const result=await tool.execute('x',{});const data=JSON.parse(result.content[0].text);
 assert.equal(data.checked,2);assert.equal(data.verified,1);
 assert.deepEqual(data.endpoints.map(x=>x.state),['handshake_ok','unverified_response']);
 const e=new EvidenceLedger();e.record('mcp_endpoint_health',{},result,'r5');
 assert.equal(e.has('mcp_health'),false,'a partial handshake cannot count as all configured endpoints healthy');
});

test('finished infrastructure assessments use one ledger-generated report, not contradictory model prose',()=>{
 const f=fixture();f.handlers.get('before_agent_start')({prompt:'Perform a network infrastructure assessment with TASK 1 - inventory'});
 const result=f.handlers.get('message_end')({message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'# Technical Assessment Report\n4/8 tasks completed; router status CONFIRMED'}]}});
 assert.equal(result.message.content.length,1);
 assert.match(result.message.content[0].text,/Deterministic infrastructure evidence report/);
 assert.doesNotMatch(result.message.content[0].text,/router status CONFIRMED|4\/8 tasks completed/);
 const ordinary=f.handlers.get('message_end')({message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Hello there'}]}});
 assert.equal(ordinary,undefined);
});


test('out-of-order parallel result completion retains search-request FIFO order',()=>{
 const f=fixture();
 for(let i=0;i<6;i++) f.registered.set(`mcp__fixture__operation_${i}`,{name:`mcp__fixture__operation_${i}`,description:`operation ${i}`,exposure:'deferred',parameters:{type:'object',properties:{}}});
 f.handlers.get('before_agent_start')({prompt:'Audit independent tools'});
 const calls=Array.from({length:5},(_,i)=>f.search(`mcp__fixture__operation_${i}`,`r20-order-${i}`));
 for(const index of [4,2,0,3,1]) calls[index].finish();
 const fifo=f.branch.findLast(x=>x.customType==='pi.atomic-tool-schema').data.queue.map(x=>x.name);
 assert.deepEqual(fifo,Array.from({length:5},(_,i)=>`mcp__fixture__operation_${i}`));
});
