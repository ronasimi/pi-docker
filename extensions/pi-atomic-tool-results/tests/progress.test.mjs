import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressGuard, relevantDiscovery, parseDiscoveryQuery, activeNetworkRisk, containerHostCommandRisk } from '../lib/progress.js';

const tool = (name, description = '') => ({ name, description });
const outcome = (body, isError = false) => ({ content: [{type:'text', text: body}], isError });

test('rejects generic MCP resources for Ollama inventory and unrelated security matches', () => {
  assert.equal(relevantDiscovery('ollama list models', tool('mcp__system__list_mcp_resources', 'List MCP resource templates')).ok, false);
  assert.equal(relevantDiscovery('ollama list models', tool('mcp__system__ollama_list_models', 'List local Ollama models')).ok, true);
  assert.equal(relevantDiscovery('security get_host_interface_info', tool('mcp__security__metasploit_info')).ok, false);
  assert.equal(relevantDiscovery('security get_host_interface_info', tool('mcp__security__get_host_interface_info')).ok, true);
  assert.equal(relevantDiscovery('mcp google', tool('mcp__google__gmail_send_draft')).ok, false);
  assert.equal(relevantDiscovery('playwright browser navigate', tool('mcp__playwright__browser_resize')).ok, false);
  assert.equal(relevantDiscovery('playwright browser navigate', tool('mcp__playwright__browser_navigate')).ok, true);
  assert.equal(relevantDiscovery('google drive list files', tool('mcp__google__drive_delete_file')).ok, false);
});

test('same query cannot be recycled by unrelated invocation with unchanged evidence', () => {
  const g = new ProgressGuard({ maxCalls: 120 });
  for (let i=0;i<2;i++) {
    assert.equal(g.beforeCall({toolName:'tool_search',input:{query:'ollama list models'}}), undefined);
    g.searchCompleted('ollama list models');
    assert.equal(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__system__list_mcp_resources',arguments:{}}}), undefined);
    g.invocationCompleted('mcp__system__list_mcp_resources',{},outcome('same MCP resource listing'));
  }
  assert.match(g.beforeCall({toolName:'tool_search',input:{query:'ollama list models'}}).reason,/Repeated discovery/);
  assert.equal(g.snapshot().repeatedOutcomes, 1);
});

test('irrelevant matches cannot repeatedly consume search budget', () => {
  const g = new ProgressGuard();
  g.beforeCall({toolName:'tool_search',input:{query:'mcp google'}});
  g.searchCompleted('mcp google',{rejected:true});
  assert.match(g.beforeCall({toolName:'tool_search',input:{query:'mcp google'}}).reason,/no relevant operation/);
});

test('repeated browser navigation failures are blocked without disabling new destinations', () => {
  const g = new ProgressGuard();
  const args = {url:'https://openwrt.org/docs/start'};
  for(let i=0;i<2;i++) {
    assert.equal(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__playwright__browser_navigate',arguments:args}}),undefined);
    g.invocationCompleted('mcp__playwright__browser_navigate',args,outcome('ERR_CONNECTION_REFUSED',true));
  }
  assert.match(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__playwright__browser_navigate',arguments:args}}).reason,/Repeated navigation/);
  assert.equal(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__playwright__browser_navigate',arguments:{url:'https://openwrt.org/another'}}}),undefined);
});

test('identical successful results are not progress even with interleaved queries', () => {
  const g = new ProgressGuard();
  const args = {context:'all'};
  for(let i=0;i<3;i++) {
    assert.equal(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__system__docker_list_containers',arguments:args}}),undefined);
    g.invocationCompleted('mcp__system__docker_list_containers',args,outcome('{"containers":[]}'));
  }
  assert.equal(g.snapshot().uniqueEvidence,1);
  assert.match(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__system__docker_list_containers',arguments:args}}).reason,/identical results/);
  assert.equal(g.beforeCall({toolName:'tool_invoke',input:{name:'mcp__system__docker_list_containers',arguments:{context:'subset'}}}),undefined);
});

test('turn budget blocks all further operations and resets for new user turns', () => {
  const g = new ProgressGuard({maxCalls:3});
  for(let i=0;i<3;i++) assert.equal(g.beforeCall({toolName:'tool_invoke',input:{name:'foo',arguments:{i}}}),undefined);
  assert.match(g.beforeCall({toolName:'result_get',input:{result_ref:'a'}}).reason,/budget exhausted/);
  assert.equal(g.snapshot().blocked,1); g.reset();
  assert.equal(g.beforeCall({toolName:'tool_search',input:{query:'system docker list containers'}}),undefined);
});


test('explicit server routing does not confuse system RAM with persistent memory MCP', () => {
  assert.equal(parseDiscoveryQuery('system host cpu memory').explicitServer, null);
  assert.equal(parseDiscoveryQuery('host cpu memory').explicitServer, null);
  assert.equal(parseDiscoveryQuery('memory search nodes').explicitServer, null);
  assert.equal(relevantDiscovery('system host cpu memory', tool('mcp__system__host_snapshot', 'Host CPU memory RAM inventory')).ok, true);
  assert.equal(relevantDiscovery('host cpu memory', tool('mcp__system__host_snapshot', 'Host CPU memory RAM inventory')).ok, true);
  assert.equal(relevantDiscovery('system host cpu memory', tool('mcp__memory__search_nodes', 'Persistent knowledge memory')).ok, false);
});

test('exact action ranking rejects container stats for list containers', () => {
  const query='system docker list containers';
  const stats=relevantDiscovery(query, tool('mcp__system__docker_container_stats', 'Container CPU memory stats'));
  const listing=relevantDiscovery(query, tool('mcp__system__docker_list_containers', 'List Docker containers'));
  assert.equal(stats.ok,false);
  assert.equal(listing.ok,true);
  assert(listing.score>stats.score);
});

test('active network operations and shell commands require runtime opt-in', () => {
  assert.match(activeNetworkRisk('mcp__security__probe_gateway_proxy_arp', {subnet:'192.168.1.0/24'}), /Active network/);
  assert.match(activeNetworkRisk('mcp__security__arp_sweep', {}), /Active network/);
  assert.match(activeNetworkRisk('mcp__system__execute_shell', {command:'nmap -sS 192.168.1.0/24'}), /Active network/);
  assert.match(activeNetworkRisk('bash', {command:'ping -c 1 192.168.1.10'}), /Active network/);
  assert.equal(activeNetworkRisk('mcp__security__get_host_interface_info', {}),null);
  assert.equal(activeNetworkRisk('mcp__security__passive_mdns_capture', {seconds:5}),null);
});

test('discovery prefers read-only host/kernel and router inventory over unrelated actions', () => {
  assert.equal(relevantDiscovery('system os kernel version',tool('mcp__system__host_snapshot','Host overview')).ok,true);
  assert.equal(relevantDiscovery('system openwrt router query',tool('mcp__system__openwrt_package_query','OpenWrt packages')).ok,false);
  assert.equal(relevantDiscovery('system docker list containers',tool('mcp__system__docker_container_action','Perform container operation')).ok,false);
  assert.equal(relevantDiscovery('ollama models',tool('mcp__system__host_cpu_info','Ollama CPU information')).ok,false);
  assert.equal(relevantDiscovery('system docker list images',tool('mcp__system__docker_list_containers','List containers')).ok,false);
  assert.equal(relevantDiscovery('system docker list images',tool('mcp__system__docker_list_images','List images')).ok,true);
});

test('static scanner availability checks are not active probes', () => {
  for (const cmd of ['which netstat ss nmap','command -v nmap','type -a nmap','echo nmap','printf nmap'])
    assert.equal(activeNetworkRisk('bash',{command:cmd}),null,cmd);
  for (const cmd of ['nmap -sT 192.168.1.1','which nmap && nmap -sS 192.168.1.1','bash -lc "nmap -sV 192.168.1.1"','sudo -n nmap -sV 192.168.1.1','timeout 10 nmap -sT 192.168.1.1'])
    assert.match(activeNetworkRisk('bash',{command:cmd}),/Active network/,cmd);
  assert.equal(containerHostCommandRisk('mcp__system__execute_shell',{command:'ip addr'}),null,'Remote host tools are not Pi bash');
});
