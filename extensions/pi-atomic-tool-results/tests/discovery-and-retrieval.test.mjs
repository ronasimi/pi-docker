import test from 'node:test';
import assert from 'node:assert/strict';
import atomic from '../index.js';
import {relevantDiscovery} from '../lib/progress.js';
import {EvidenceLedger} from '../lib/evidence.js';
import {makeArchive,CUSTOM_TYPE} from '../lib/archive.js';
import {compactOrInlineContent} from '../lib/compact.js';
import {validateArguments} from '../lib/validate.js';
const tool=(name,description,parameters={type:'object',properties:{},additionalProperties:false})=>({name,description,parameters,exposure:'deferred',annotations:{readOnlyHint:true,idempotentHint:true}});
const catalogue=[tool('mcp__memory__search_nodes','Search persistent memory nodes.'),tool('mcp__searxng__search','Search the web for official documentation.'),tool('mcp__system__openwrt_status','OpenWrt router status: board, firmware, interfaces and routes.'),tool('mcp__system__openwrt_targets','Discover configured SSH target aliases.'),tool('mcp__system__openwrt_logread','Read recent router logs.'),tool('mcp__system__host_snapshot','Host OS, CPU, memory and disk capacity.'),tool('mcp__system__host_disk_usage','Host disk usage.'),tool('mcp__security__get_host_interface_info','Host network interfaces and routes.'),tool('mcp__playwright__browser_resize','Resize browser page content.'),tool('mcp__playwright__browser_snapshot','Get current browser page content.'),tool('mcp__playwright__browser_navigate','Navigate browser to URL.'),tool('mcp__security__discover_mdns_subnets','Passive mDNS host discovery.'),tool('mcp__security__observe_broadcast_multicast','Passive ARP, mDNS, SSDP and LLMNR packet observations.')];
const best=query=>catalogue.map(t=>({name:t.name,...relevantDiscovery(query,t)})).filter(t=>t.ok).sort((a,b)=>b.score-a.score)[0]?.name;
test('replays shared logged discovery queries against competing plausible catalogue matches',()=>{for(const q of ['system host inventory','system info','system os cpu memory','system host info','system cpu memory disk usage','system host health cpu memory kernel'])assert.equal(best(q),'mcp__system__host_snapshot',q);for(const q of ['passive network discovery openwrt router','openwrt router anansi arachne discovery'])assert.equal(best(q),'mcp__system__openwrt_status',q);assert.equal(best('openwrt target discovery'),'mcp__system__openwrt_targets');for(const q of ['playwright browser get content','playwright get page content'])assert.equal(best(q),'mcp__playwright__browser_snapshot',q);assert.equal(best('passive network discovery ssdp llmnr'),'mcp__security__observe_broadcast_multicast');assert.equal(best('openwrt logs'),'mcp__system__openwrt_logread');assert.equal(best('google search playwright browser'),'mcp__searxng__search');});
test('aliases and historical logs never count as current router-state evidence',()=>{const e=new EvidenceLedger();const ok=value=>({content:[{type:'text',text:JSON.stringify(value)}]});for(const target of ['anansi','arachne']){e.record('mcp__system__openwrt_targets',{target},ok({aliases:[target]}),'alias'+target);e.record('mcp__system__openwrt_logread',{target},ok({logs:['old interfaces up']}),'logs'+target);}assert.deepEqual(e.routerCoverage(),{anansi:false,arachne:false});e.record('mcp__system__openwrt_status',{target:'anansi'},ok({board:{model:'router'},interfaces:[],evidence_available:true}),'live');assert.deepEqual(e.routerCoverage(),{anansi:true,arachne:false});});
function harness(branch=[]){const handlers=new Map(),tools=new Map(catalogue.map(t=>[t.name,t]));let active=[],calls=0;const api={on(n,fn){const list=handlers.get(n)??[];list.push(fn);handlers.set(n,list);},registerTool(t){tools.set(t.name,t);},getAllTools(){return [...tools.values()]},getActiveTools(){return active},setActiveTools(x){active=x},registerCommand(){},appendEntry(customType,data){branch.push({type:'custom',customType,data})}};const ctx={sessionManager:{getBranch:()=>branch},ui:{notify(){}},async executeTool(name,args){validateArguments(tools.get(name).parameters,args);calls++;return{toolCall:{id:'nested'+calls},isError:false,result:{content:[{type:'text',text:JSON.stringify({name,args})}]}}}};atomic(api);return{tools,ctx,calls:()=>calls,async emit(n,event){let patch;for(const h of handlers.get(n)??[])patch=(await h(event,ctx))??patch;return patch}};}
test('parallel router log retrieval shares a bounded model-step budget while previous slices remain durable',async()=>{const branch=['anansi','arachne'].map(target=>({type:'custom',customType:CUSTOM_TYPE,data:makeArchive({toolCallId:target,toolName:'mcp__system__openwrt_logread',content:[{type:'text',text:'router log "\n'.repeat(5000)}]})}));const f=harness(branch);await f.emit('turn_start',{});const get=f.tools.get('result_get');const replies=await Promise.all(['anansi','arachne','anansi'].map(ref=>get.execute(ref,{result_ref:'result:'+ref,selector:'content.0.text',max_chars:8192},null,null,f.ctx)));const texts=replies.map(x=>x.content[0].text);assert.ok(texts.slice(0,2).reduce((n,x)=>n+x.length,0)<=4096);assert.match(texts[2],/retrieval_budget/);assert.equal(JSON.parse(texts[0]).truncated,true);await f.emit('turn_start',{});const next=await get.execute('page',{result_ref:'result:anansi',selector:'content.0.text',offset:JSON.parse(texts[0]).nextOffset,max_chars:1024},null,null,f.ctx);assert.ok(JSON.parse(next.content[0].text).nextOffset>JSON.parse(texts[0]).nextOffset);const messages=[{role:'user',content:'read logs'},{role:'assistant',content:[{type:'toolCall',id:'a',name:'result_get',arguments:{result_ref:'result:anansi'}}]},{role:'toolResult',toolName:'result_get',toolCallId:'a',content:replies[0].content}];const context=await f.emit('context',{messages});assert.deepEqual((context?.messages??messages).find(m=>m.role==='toolResult').content,replies[0].content);});
test('a server-spilled capture advertises the separate saved artifact retrieval boundary',()=>{const archive=makeArchive({toolCallId:'capture',toolName:'mcp__security__observe_broadcast_multicast',content:[{type:'text',text:JSON.stringify({truncated:true,output_file:'.security-results/capture.json',observation_path:'.security-results/observations/capture.json',preview:'x'.repeat(5000)})}]});const value=JSON.parse(compactOrInlineContent(archive).content[0].text).atomic_result;assert.equal(value.server_truncated,true);assert.equal(value.artifact_retrieval.discover,'security read_security_result');assert.equal(value.artifact_retrieval.path,'.security-results/capture.json');assert.match(value.artifact_retrieval.next,/cannot expand/);});
test('omitted wrapper arguments execute only schema-valid empty-input operations',async()=>{const f=harness();await f.emit('tool_call',{toolName:'tool_search',toolCallId:'search',input:{query:'system host info'}});await f.emit('tool_result',{toolName:'tool_search',toolCallId:'search',input:{query:'system host info'},content:[],details:{loaded:['mcp__system__host_snapshot']}});const invoke=f.tools.get('tool_invoke');validateArguments(invoke.parameters,{name:'mcp__system__host_snapshot'});await invoke.execute('invoke',{name:'mcp__system__host_snapshot'},null,null,f.ctx);assert.equal(f.calls(),1);const target=f.tools.get('mcp__system__openwrt_status');target.parameters={type:'object',properties:{target:{type:'string'}},required:['target']};await f.emit('tool_call',{toolName:'tool_search',toolCallId:'router',input:{query:'openwrt router status'}});await f.emit('tool_result',{toolName:'tool_search',toolCallId:'router',input:{query:'openwrt router status'},content:[],details:{loaded:[target.name]}});await assert.rejects(invoke.execute('invalid',{name:target.name},null,null,f.ctx),/missing target/);assert.equal(f.calls(),1);});

test('identical in-flight passive captures coalesce but a later capture stays fresh',async()=>{const {Scheduler}=await import('../lib/scheduler.js');const scheduler=new Scheduler();let count=0;const run=async()=>{count++;await new Promise(r=>setTimeout(r,5));return{result:{content:[{type:'text',text:'observation-'+count}]},toolCall:{id:'capture-'+count}}};const [a,b]=await Promise.all([scheduler.submit('passive',run,{coalesce:true}),scheduler.submit('passive',run,{coalesce:true})]);assert.equal(count,1);assert.equal(a.toolCall.id,b.toolCall.id);assert.equal(b.cacheReused,true);await scheduler.submit('passive',run,{coalesce:true});assert.equal(count,2);});

test('evidence context does not duplicate the full active user request',async()=>{const f=harness();const prompt='Assess the host infrastructure. '+ 'unique user requirements '.repeat(80);await f.emit('before_agent_start',{prompt});await f.emit('tool_result',{toolName:'mcp__system__host_snapshot',toolCallId:'facts',input:{},content:[{type:'text',text:'{"hostname":"fixture-host"}'}]});const patch=await f.emit('context',{messages:[{role:'user',content:prompt}]});const hints=patch.messages.filter(m=>m.customType==='pi.atomic-evidence-context');assert.equal(hints.length,1);assert.ok(hints[0].content.includes('fixture-host'));assert.ok(!hints[0].content.includes(prompt));});


test('deterministic report includes bounded collected facts with their actual result references',()=>{const e=new EvidenceLedger();e.record('mcp__system__host_snapshot',{}, {content:[{type:'text',text:'{"hostname":"fixture-host","kernel":"linux-fixture"}'}]},'host-observation');const report=e.report();assert.match(report,/fixture-host/);assert.match(report,/result:host-observation/);assert.match(report,/observations, not inferred conclusions/);});

test('control-only assessment settlement gets one continuation, then a measured partial report',async()=>{const f=harness();await f.emit('before_agent_start',{prompt:'TASK 1 — Assess the host infrastructure and report findings'});await f.emit('tool_result',{toolName:'mcp__system__host_snapshot',toolCallId:'host',input:{},content:[{type:'text',text:'{"hostname":"fixture-host"}'}]});const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:'</request>\n'}]};assert.equal(await f.emit('message_end',{message}),undefined);const repair=await f.emit('agent_before_settle',{outcome:'completed',context:{pendingMessages:[],contextMessages:[message]}});assert.equal(repair.continue,true);assert.equal(repair.entries[0].customType,'pi.atomic-empty-settlement-repair');assert.match(repair.entries[0].content,/Do not repeat successful/);const final=await f.emit('message_end',{message});assert.match(final.message.content[0].text,/fixture-host/);assert.match(final.message.content[0].text,/Partial observations/);assert.equal(await f.emit('agent_before_settle',{outcome:'completed',context:{pendingMessages:[],contextMessages:[final.message]}}),undefined);});

test('runtime fingerprint records the loaded revision and does not repair requested literal markers',async()=>{const f=harness();await f.emit('session_start',{});const {RUNTIME_FINGERPRINT}=await import('../lib/runtime.js');assert.equal(RUNTIME_FINGERPRINT.release,'r24');assert.equal(RUNTIME_FINGERPRINT.atomicVersion,'0.2.5');assert.match(RUNTIME_FINGERPRINT.extensionSha256,/^[a-f0-9]{64}$/);await f.emit('before_agent_start',{prompt:'Print the literal </request> marker'});const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:'</request>'}]};assert.equal(await f.emit('agent_before_settle',{outcome:'completed',context:{pendingMessages:[],contextMessages:[message]}}),undefined);assert.equal(await f.emit('message_end',{message}),undefined);});


test('router synonyms and explicit subjects select the matching read operation',()=>{
 const names=['status','wifi_status','clients','targets','logread','uci_show','uci_get','uci_set','ubus_call','package_query','service_action'];
 const tools=names.map(name=>tool('mcp__system__openwrt_'+name,'OpenWrt router '+name.replaceAll('_',' ')+' observations.'));
 const ranked=query=>tools.map(t=>({name:t.name,...relevantDiscovery(query,t)})).filter(t=>t.ok).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
 for(const query of ['router','routers','system router','openwrt','anansi','arachne','router status'])assert.equal(ranked(query)[0]?.name,'mcp__system__openwrt_status',query);
 for(const query of ['router clients','router client','openwrt clients','router list clients','openwrt list clients'])assert.deepEqual(ranked(query).map(t=>t.name),['mcp__system__openwrt_clients'],query);
 for(const [query,name] of [['router wifi','wifi_status'],['router wireless','wifi_status'],['router targets','targets'],['router logs','logread'],['router ubus','ubus_call'],['router package','package_query']])assert.equal(ranked(query)[0]?.name,'mcp__system__openwrt_'+name,query);
 assert.deepEqual(new Set(ranked('router config').map(t=>t.name)),new Set(['mcp__system__openwrt_uci_get','mcp__system__openwrt_uci_show']));
 assert.equal(relevantDiscovery('router',tool('mcp__memory__search_nodes','Router observations in durable memory.')).ok,false);
 assert.equal(relevantDiscovery('mcp__security__router',tools[0]).ok,false);
 assert.equal(relevantDiscovery('router',tools.at(-1)).ok,false);
});


test('replays new run routing failures without unrelated matches',async()=>{
 const {capabilityForQuery}=await import('../lib/capabilities.js');
 const tools=[...catalogue,tool('ollama_api_inventory','Ollama model inventory'),tool('mcp_endpoint_health','MCP health'),tool('mcp__security__generate_graphical_network_map','Render collected passive network discovery data into maps'),tool('mcp__playwright__browser_network_request','Browser request details')];
 const ranked=query=>tools.map(t=>({name:t.name,...relevantDiscovery(query,t)})).filter(t=>t.ok).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name))[0]?.name;
 for(const q of ['system list routers','mcp router list','router list','routers list'])assert.equal(ranked(q),'mcp__system__openwrt_targets',q);
 for(const q of ['mcp openwrt status routes firmware','system router status']){assert.equal(ranked(q),'mcp__system__openwrt_status',q);assert.equal(capabilityForQuery(q),'routers');}
 for(const q of ['mcp passive network discovery','security passive network observation mDNS ssdp','mcp passive discovery arp mDNS SSDP','security passive scan']){assert.equal(ranked(q),'mcp__security__observe_broadcast_multicast',q);assert.equal(capabilityForQuery(q),'passive_network');}
 for(const q of ['official ollama api documentation','web search ollama api documentation']){assert.equal(ranked(q),'mcp__searxng__search',q);assert.equal(capabilityForQuery(q),'web_verification');}
 assert.equal(ranked('playwright open official ollama documentation page'),'mcp__playwright__browser_navigate');
 assert.equal(ranked('mcp playwright browser tool'),'mcp__playwright__browser_snapshot');
 assert.equal(ranked('mcp health status'),'mcp_endpoint_health');
 assert.equal(ranked('ollama models inventory'),'ollama_api_inventory');
});

test('textual discovery plans get one structured-call retry and never execute invented arguments',async()=>{
 const f=harness();await f.emit('before_agent_start',{prompt:'Perform a bounded read-only assessment of my Pi Docker and network.'});
 const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:'Tool sequence to execute the above tasks:\n\n1. tool_search: system host inventory\n2. tool_invoke: invented_operation {arguments:{type:"invented"}}'}]};
 const event={outcome:'completed',context:{pendingMessages:[],contextMessages:[message]}};
 const repair=await f.emit('agent_before_settle',event);assert.equal(repair.continue,true);assert.match(repair.entries[0].content,/real structured tool_search/);assert.equal(f.calls(),0);
 assert.equal(await f.emit('agent_before_settle',event),undefined);assert.equal(f.calls(),0);
 const final=await f.emit('message_end',{message});assert.match(final.message.content[0].text,/Successful executed tool calls:\*\* 0/);assert.doesNotMatch(final.message.content[0].text,/invented_operation/);
 const example=harness();await example.emit('before_agent_start',{prompt:'Explain an example tool sequence for a network assessment.'});assert.equal(await example.emit('agent_before_settle',event),undefined);
});

test('an explicit thirty-call request bounds execution and resets on a later request',async()=>{
 const f=harness();await f.emit('before_agent_start',{prompt:'Assess host infrastructure. Use at most 30 tool calls, then report.'});
 for(let i=0;i<30;i++)assert.equal(await f.emit('tool_call',{toolName:'result_list',toolCallId:'call'+i,input:{limit:1}}),undefined);
 const blocked=await f.emit('tool_call',{toolName:'result_list',toolCallId:'overflow',input:{limit:1}});assert.equal(blocked.block,true);assert.match(blocked.reason,/30 attempted calls/);
 await f.emit('before_agent_start',{prompt:'Assess host infrastructure.'});
 for(let i=0;i<31;i++)assert.equal(await f.emit('tool_call',{toolName:'result_list',toolCallId:'next'+i,input:{limit:1}}),undefined);
});

test('assessment wording before the subject still uses the measured ledger report',async()=>{
 const f=harness();await f.emit('before_agent_start',{prompt:'Perform a bounded, read-only assessment of my Pi Docker, Ollama, MCP Gateway, and home network.'});
 await f.emit('tool_result',{toolName:'mcp__system__host_snapshot',toolCallId:'actual-host',input:{},content:[{type:'text',text:'{"hostname":"measured-host"}'}]});
 const final=await f.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Assessment Report: all tasks complete. result:invented'}]}});
 assert.match(final.message.content[0].text,/measured-host/);assert.doesNotMatch(final.message.content[0].text,/result:invented|all tasks complete/);
});


test('passive metadata permits read-only discovery and fresh captures while active probes stay denied',async()=>{
 const f=harness();const name='mcp__security__observe_broadcast_multicast';
 const capture=f.tools.get(name);capture.parameters={type:'object',properties:{duration_seconds:{type:'integer',minimum:1,maximum:30}},'x-pi-effect':'passive_capture'};capture.annotations={readOnlyHint:false,idempotentHint:false};
 await f.emit('before_agent_start',{prompt:'Perform a read-only passive network assessment. No active scans.'});
 const search={toolName:'tool_search',toolCallId:'capture-search',input:{query:'security passive network observation'}};
 await f.emit('tool_call',search);const ready=await f.emit('tool_result',{...search,content:[],details:{loaded:[name]}});assert.equal(JSON.parse(ready.content[0].text).discovery,'ready');
 const invoke=f.tools.get('tool_invoke');await invoke.execute('capture-one',{name,arguments:{duration_seconds:10}},null,null,f.ctx);await invoke.execute('capture-two',{name,arguments:{duration_seconds:10}},null,null,f.ctx);assert.equal(f.calls(),2,'later captures are fresh');
 const probe={name:'mcp__security__probe_gateway_proxy_arp',exposure:'deferred',description:'Active ARP probe',parameters:{type:'object',properties:{},'x-pi-effect':'active_probe'}};f.tools.set(probe.name,probe);
 const denied=await f.emit('tool_call',{toolName:'tool_invoke',toolCallId:'probe',input:{name:probe.name,arguments:{}}});assert.equal(denied.block,true);assert.equal(f.calls(),2);
});


test('Masscan discovery never substitutes Nmap or passive observation, including massscan spelling',()=>{
 const toolset=[tool('mcp__security__masscan_scan','Masscan TCP SYN port scanner.'),tool('mcp__security__port_scan','Nmap TCP port scanner.'),tool('mcp__security__observe_broadcast_multicast','Passive packet capture.')];
 for(const query of ['masscan','massscan','security masscan scan','security massscan TCP scan']){
  const ranked=toolset.map(t=>({name:t.name,...relevantDiscovery(query,t)})).filter(t=>t.ok).sort((a,b)=>b.score-a.score);assert.equal(ranked[0]?.name,'mcp__security__masscan_scan',query);assert(!ranked.some(t=>t.name==='mcp__security__port_scan'));
 }
});

test('Masscan requires runtime opt-in and scan intent; adding a tool or passive-only requests never authorize execution',async()=>{
 const variable='PI_ATOMIC_RESULTS_ALLOW_ACTIVE_NETWORK_PROBES',old=process.env[variable];
 try {
  for(const [optIn,prompt,allowed] of [['false','I explicitly authorize a Masscan scan of 192.168.1.10.',false],['true','Please add a Masscan tool.',false],['true','I authorize a Masscan scan, but keep this assessment read-only.',false],['true','Please run a masscan scan against 192.168.1.10.',true]]) {
   process.env[variable]=optIn;const f=harness(),name='mcp__security__masscan_scan';f.tools.set(name,{name,exposure:'deferred',description:'Masscan TCP SYN scan.',parameters:{type:'object',properties:{target:{type:'string'},ports:{type:'string'}},required:['target','ports'],'x-pi-effect':'active_probe'},annotations:{readOnlyHint:false,idempotentHint:false}});
   await f.emit('before_agent_start',{prompt});
   const search={toolName:'tool_search',toolCallId:'masscan-search',input:{query:'security masscan scan'}};await f.emit('tool_call',search);
   const reply=await f.emit('tool_result',{...search,content:[],details:{loaded:[name]}});assert.equal(JSON.parse(reply.content[0].text).discovery==='ready',allowed,prompt);
   if(allowed){await f.tools.get('tool_invoke').execute('scan',{name,arguments:{target:'192.168.1.10',ports:'80'}},null,null,f.ctx);assert.equal(f.calls(),1);}
   else {const denied=await f.emit('tool_call',{toolName:'tool_invoke',toolCallId:'no-scan',input:{name,arguments:{target:'192.168.1.10',ports:'80'}}});assert.equal(denied.block,true);assert.equal(f.calls(),0);}
  }
 } finally {if(old===undefined)delete process.env[variable];else process.env[variable]=old;}
});

