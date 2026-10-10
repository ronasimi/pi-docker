import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger, auditInfrastructureReport } from '../lib/evidence.js';
import { ProgressGuard, activeNetworkRisk } from '../lib/progress.js';
const ok = body => ({ isError:false, content:[{type:'text', text:body}] });

test('hard loop termination counts blocked attempts; reset only starts a new user turn', () => {
  const g = new ProgressGuard({ maxCalls:120, maxRepeatedBlocks:4, maxBlocked:10 });
  const event={toolName:'tool_search',input:{query:'mcp service health'}};
  for(let i=0;i<3;i++) assert.equal(g.rejectEvent(event,'no suitable operation').hardStop,false);
  const stop=g.rejectEvent(event,'no suitable operation');
  assert.equal(stop.hardStop,true);
  assert.equal(g.snapshot().attempts,4);
  assert.equal(g.snapshot().blocked,4);
  assert.match(stop.reason,/halted/i);
  assert.equal(g.beforeCall({toolName:'result_list',input:{}}).hardStop,true);
  g.reset(); assert.equal(g.snapshot().hardStopped,false);
});

test('hard budget applies to all attempted calls including distinct denied calls', () => {
  const g=new ProgressGuard({maxCalls:5, maxBlocked:30, maxRepeatedBlocks:30});
  for(let i=0;i<4;i++) assert.equal(g.rejectEvent({toolName:'tool_search',input:{query:`missing tool ${i}`}},'unavailable').hardStop,false);
  assert.equal(g.rejectEvent({toolName:'tool_search',input:{query:'fifth'}},'unavailable').hardStop,true);
  assert.equal(g.snapshot().attempts,5);
});

test('ambiguous network discovery fails closed with omitted/default arguments', () => {
  for(const name of ['mcp__security__perform_network_discovery','mcp__security__network_discovery','mcp__security__discover_network','mcp__security__arp_scan'])
    assert.match(activeNetworkRisk(name,{}),/Active network probing/,name);
  assert.equal(activeNetworkRisk('mcp__security__get_host_interface_info',{}),null);
  assert.equal(activeNetworkRisk('bash',{command:'which nmap && command -v nmap'}),null);
});

test('a discovered schema, result_get, and container names do not prove Ollama inventory',()=>{
  const e=new EvidenceLedger();e.setScope('Perform network infrastructure assessment on routers and Ollama');
  assert.equal(e.record('tool_search',{query:'ollama'},ok('mcp__system__ollama_list_models')) ,false);
  assert.equal(e.record('result_get',{result_ref:'abc'},ok('ollama')) ,false);
  assert.equal(e.record('mcp__system__docker_list_containers',{},ok('{"names":["ollama"]}'),'docker-ref'),true);
  assert.equal(e.has('ollama_models'),false);
  const report=auditInfrastructureReport('# Technical Assessment Report\n- Ollama model inventory CONFIRMED\n- Both OpenWrt routers verified\n- 7/8 tasks completed',e);
  assert.equal(report.changed,true);
  assert(report.issues.some(x=>x.includes('Ollama')));
  assert(report.issues.some(x=>x.includes('router')));
  assert(report.issues.some(x=>x.includes('task-completion')));
  assert.doesNotMatch(report.text,/Ollama model inventory CONFIRMED/);
  assert.match(report.text,/NOT VERIFIED:/);
});

test('router evidence must include both named targets for both-router confirmation',()=>{
 const e=new EvidenceLedger(); e.setScope('Assess both OpenWrt routers');
 e.record('mcp__system__openwrt_router_status',{router:'anansi'},ok('{"status":"observed","board":{"model":"fixture"},"interfaces":[]}'),'router-a');
 const report='# Technical Assessment Report\nBoth routers CONFIRMED healthy';
 assert.equal(auditInfrastructureReport(report,e).changed,true);
 e.record('mcp__system__openwrt_router_status',{router:'arachne'},ok('{"status":"observed","board":{"model":"fixture"},"interfaces":[]}'),'router-b');
 assert.equal(auditInfrastructureReport(report,e).changed,false);
});

test('ordinary coding answer is untouched and tool errors never become evidence',()=>{
 const e=new EvidenceLedger();e.setScope('Build Pi Docker');
 e.record('mcp__system__ollama_list_models',{},ok('error: auth denied'),'error');
 assert.equal(e.has('ollama_models'),false);
 assert.equal(auditInfrastructureReport('Ollama models CONFIRMED',e).changed,false);
});
