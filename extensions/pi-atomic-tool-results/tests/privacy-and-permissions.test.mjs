import test from 'node:test';
import assert from 'node:assert/strict';
import {redact} from '../lib/redact.js';
import {makeArchive} from '../lib/archive.js';
import {prepareMessages,requestManifest} from '../lib/request.js';
import {Scheduler} from '../lib/scheduler.js';
import {executeBatch} from '../lib/batch.js';
import {relevantDiscovery,ProgressGuard} from '../lib/progress.js';
import {boundValue} from '../lib/retrieve.js';
import {EvidenceLedger} from '../lib/evidence.js';

test('redacts UCI, nested JSON, authorization and error strings before archive',()=>{
 const input={content:[{type:'text',text:JSON.stringify({stdout:"wireless.default_radio0.key='wifi-secret'",password:'secret2',nested:{psk:'secret3'},version:'0.35.0'})}],details:{error:'Authorization: Bearer token123'}};
 const a=makeArchive({toolCallId:'a',toolName:'mcp__system__openwrt_uci_get',...input});
 assert.doesNotMatch(JSON.stringify(a),/wifi-secret|secret2|secret3|token123/);assert.match(JSON.stringify(a),/0.35.0/);
 assert.equal(input.details.error,'Authorization: Bearer token123');
});
test('failed model retries retain user, exact tool pairs and stable manifest',()=>{
 const user={role:'user',content:'Assess passive network'};
 const messages=[{role:'assistant',content:[{type:'toolCall',id:'a',name:'result_get'},{type:'toolCall',id:'missing'}]},{role:'toolResult',toolCallId:'a',content:[{type:'text',text:'fact'}]},{role:'toolResult',toolCallId:'orphan',content:[]}];
 const a=prepareMessages(messages,user),b=prepareMessages(a,user);assert.deepEqual(a,b);assert.equal(a[0],user);assert.equal(a.length,3);assert.equal(a[1].content.length,1);assert.deepEqual(requestManifest(a),requestManifest(b));
});
test('queue limits concurrency, deduplicates inflight reads and supports refresh',async()=>{
 const s=new Scheduler({concurrency:2});let active=0,peak=0,runs=0;
 const run=async()=>{runs++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return {value:42};};
 const values=await Promise.all(Array.from({length:8},(_,i)=>s.submit('read'+i,run,{cacheable:true})));
 assert.equal(values.length,8);assert.equal(peak,2);
 await Promise.all([s.submit('same',run,{cacheable:true}),s.submit('same',run,{cacheable:true})]);assert.equal(runs,9);
 await s.submit('same',run,{cacheable:true});assert.equal(runs,9);
 await s.submit('same',run,{cacheable:true,refresh:true});assert.equal(runs,10);
});
test('batch validates all dependencies before executing and skips failed branches',async()=>{
 let runs=0;await assert.rejects(executeBatch([{id:'a',name:'read',depends_on:['b']},{id:'b',name:'read',depends_on:['a']}],()=>{runs++;}),/cycle/);assert.equal(runs,0);
 const out=await executeBatch([{id:'a',name:'read',arguments:{}},{id:'b',name:'read',arguments:{},depends_on:['a']},{id:'c',name:'read',arguments:{}}],async c=>{runs++;return {isError:c.id==='a',content:[{type:'text',text:'{}'}]};});
 assert.equal(out[1].status,'dependency_failed');assert.equal(out[2].status,'ok');assert.equal(runs,2);
});
test('logged discovery queries accept targets and Ollama; passive queries reject browser',()=>{
 assert.equal(relevantDiscovery('system openwrt targets list',{name:'mcp__system__openwrt_targets',description:'List configured router targets'}).ok,true);
 assert.equal(relevantDiscovery('Ollama status inventory',{name:'ollama_api_inventory',description:'Ollama status and installed models'}).ok,true);
 assert.equal(relevantDiscovery('passive network multicast',{name:'mcp__playwright__browser_network_requests',description:'Network requests'}).ok,false);
});
test('array pagination never advances past unread items; object offsets advance',()=>{
 const a=boundValue(['a'.repeat(50),'b'.repeat(50),'c'],{maxChars:70});assert.deepEqual(a.value,['a'.repeat(50)]);assert.equal(a.nextOffset,1);
 const b=boundValue([{large:'x'.repeat(500)}],{maxChars:70});assert.equal(b.nextOffset,0);assert(b.error);
 const value={large:'x'.repeat(500)};const first=boundValue(value,{maxChars:100});const next=boundValue(value,{maxChars:100,offset:first.nextOffset});assert.notEqual(first.value,next.value);
});
test('native successful unchanged file reads trigger no-progress protection',()=>{
 const p=new ProgressGuard({repeatLimit:3});const event={toolName:'bash',input:{command:'cat report.json'}};
 for(let i=0;i<3;i++){assert.equal(p.beforeCall(event),undefined);p.invocationCompleted('bash',event.input,{content:[{type:'text',text:'same'}]});}
 assert.equal(p.beforeCall(event).block,true);
});
test('facts and uncertainty survive checkpoint without crediting health from a handshake',()=>{
 const l=new EvidenceLedger();l.setScope('Assess network');l.record('ollama_api_inventory',{}, {content:[{type:'text',text:'{"version":"0.35.0","running_models":[]}'}]},'a');
 l.defineRequirement('version',['version']);l.inspect('result:a',['version']);assert.equal(l.requirements.get('version').stage,'sufficient');
 const restored=new EvidenceLedger();restored.restore(l.checkpoint());assert.match(restored.report(),/0.35.0/);assert.equal(restored.requirements.get('version').stage,'sufficient');
 l.record('mcp_endpoint_health',{}, {content:[{type:'text',text:'{"checked":1,"verified":1,"endpoints":[{"state":"handshake_ok"}]}'}]},'b');assert.equal(l.has('mcp_health'),false);
});

test('batch reports missing selectors, bounds aggregate failures and distinguishes domain unavailable',async()=>{
 const calls=Array.from({length:16},(_,i)=>({id:String(i),name:'read',arguments:{},select:['json.missing']}));
 const rows=await executeBatch(calls,async()=>({content:[{type:'text',text:'{"value":42}'}]}),{maxChars:2048});
 assert(JSON.stringify({results:rows}).length<=2048);
 assert(rows.every(r=>r.status==='ok'));assert(rows.some(r=>r.selections?.some(s=>s.ok===false)));
 const failed=await executeBatch(calls,async()=>({isError:true,content:[{type:'text',text:'password=supersecret '+ 'x'.repeat(20000)}]}),{maxChars:2048});
 assert(JSON.stringify({results:failed}).length<=2048);assert.doesNotMatch(JSON.stringify(failed),/supersecret/);
 const absent=await executeBatch([{id:'a',name:'read',arguments:{}},{id:'b',name:'read',arguments:{},depends_on:['a']}],async()=>({content:[{type:'text',text:'{"available":false}'}]}));
 assert.equal(absent[0].status,'unavailable');assert.equal(absent[1].status,'dependency_failed');
});
test('failed reads are not cached and stale branch outcomes are discarded',async()=>{
 const scheduler=new Scheduler();let attempts=0;
 const fail=()=>{attempts++;return {result:{content:[{type:'text',text:'{"available":false}'}]},toolCall:{id:'a'}};};
 await scheduler.submit('same',fail,{cacheable:true});await scheduler.submit('same',fail,{cacheable:true});assert.equal(attempts,2);
 let release;const pending=scheduler.submit('old',()=>new Promise(r=>{release=r;}),{cacheable:true});
 await Promise.resolve();scheduler.reset();release({result:{content:[{type:'text',text:'{}'}]}});
 await assert.rejects(pending,/discarded/);assert.equal(scheduler.cache.size,0);
});
test('redaction covers UCI option syntax and restored fact paths; incomplete observations remain partial evidence',()=>{
 assert.doesNotMatch(JSON.stringify(redact({stdout:"option key 'wifi-private'",facts:[{path:'wireless.radio0.key',value:'wifi-private'}]})),/wifi-private/);
 const ledger=new EvidenceLedger();ledger.record('mcp__security__network_interfaces',{}, {content:[{type:'text',text:'{"complete":false,"interfaces":[{"name":"eth0"}]}'}]},'p');
 assert.equal(ledger.records.length,1);assert.equal(ledger.records[0].complete,false);assert.match(ledger.report(),/eth0/);assert.doesNotMatch(ledger.report(),/Tasks with all required evidence categories/);
});

test('retrieval budgets include escaped text and wrapper metadata',async()=>{
 const {renderBoundedSelection,renderArchiveSelections}=await import('../lib/retrieve.js');
 const archive={resultRef:'result:a',toolName:'read',content:[{type:'text',text:'"\\\n'.repeat(1000)}]};
 const single=renderBoundedSelection(archive,'content.0.text',{maxChars:512});assert(JSON.stringify(single).length<=512);assert(single.nextOffset>0);
 const multiple=renderArchiveSelections(archive,['content.0.text','content'],{maxChars:512});assert(JSON.stringify(multiple).length<=512);
});
test('declared active effect is enforced even when the operation name is unfamiliar',async()=>{
 const {activeNetworkRisk}=await import('../lib/progress.js');
 assert.match(activeNetworkRisk({name:'mcp__fixture__inspect',parameters:{'x-pi-effect':'active_probe'}},{}),/denied/);
 assert.equal(activeNetworkRisk({name:'mcp__fixture__inspect',parameters:{'x-pi-effect':'config_read'}},{}),null);
});
